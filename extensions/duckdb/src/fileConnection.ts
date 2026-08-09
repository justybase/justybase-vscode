/**
 * File SQL connection: opens an in-memory DuckDB, loads the required
 * extensions (xlsx / avro) and registers read_* views over the configured
 * data file so it behaves like a table.
 */

import * as path from 'path';
import * as fs from 'fs';
import type { DatabaseConnectionConfig } from '@justybase/contracts';
import { DuckDbConnection, loadDuckDb } from './duckdbConnection';
import {
    buildFileWorkspaceViewSetupSql,
    buildEditableTableSql,
    buildFileViewSetupSql,
    detectFileDataFormat,
    getFileWorkspacePaths,
    requiredDuckDbExtensions,
    type FileDataFormat,
} from './fileSqlSetup';
import { listXlsxSheetNames } from './xlsxSheets';

function inferFileExtension(config: DatabaseConnectionConfig): FileDataFormat | undefined {
    const filePath = config.database?.trim();
    if (!filePath) {
        return undefined;
    }
    return detectFileDataFormat(filePath);
}

export class FileDuckDbConnection extends DuckDbConnection {
    public constructor(public readonly config: DatabaseConnectionConfig) {
        super({
            ...config,
            database: ':memory:',
            options: { ...(config.options ?? {}), mode: 'memory' },
        });
    }

    public override async connect(): Promise<void> {
        if (this._connected) {
            return;
        }

        const duckdb = await loadDuckDb();
        const instance = await duckdb.DuckDBInstance.create(undefined);

        try {
            const connection = await instance.connect();
            this._instance = instance;
            this._connection = connection;
            this._connected = true;

            await this._setupFileViews();
            await this.refreshSessionContext();
        } catch (error) {
            try {
                instance.closeSync();
            } catch {
                // Ignore cleanup failures while surfacing the original error.
            }
            this._instance = undefined;
            this._connection = undefined;
            this._connected = false;
            throw new Error(
                `Failed to connect to data file: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
            );
        }
    }

    private async _setupFileViews(): Promise<void> {
        const filePath = this.config.database?.trim();
        if (!filePath) {
            throw new Error('No data file path configured for the File SQL connection.');
        }

        const workspacePaths = getFileWorkspacePaths(this.config.options);
        if (workspacePaths) {
            if (this.config.options?.editable === true) {
                throw new Error('Multi-file SQL workspaces are read-only and cannot use an editable copy.');
            }
            await this._setupWorkspaceViews(workspacePaths);
            return;
        }

        const format = inferFileExtension(this.config);
        if (!format) {
            throw new Error(
                `Unsupported data file '${filePath}'. Supported formats: .xlsx, .csv, .tsv, .parquet, .avro`,
            );
        }

        const connection = this.requireConnection();
        const extensions = requiredDuckDbExtensions(format);
        for (const extension of extensions) {
            try {
                await connection.run(`INSTALL ${extension}`);
                await connection.run(`LOAD ${extension}`);
            } catch (error) {
                throw new Error(
                    `DuckDB extension '${extension}' could not be loaded for '${path.basename(filePath)}'. ` +
                    'Extensions are downloaded from the internet once — check your network connection and retry.',
                    { cause: error },
                );
            }
        }

        const sheetOption = typeof this.config.options?.sheet === 'string' ? this.config.options.sheet : undefined;

        if (format === 'xlsx' && !sheetOption) {
            const sheets = this._discoverSheets(filePath);
            const setup = buildFileViewSetupSql(filePath, format, { discoveredSheets: sheets });
            for (const statement of setup.statements) {
                await connection.run(statement);
            }
        } else {
            const setup = buildFileViewSetupSql(filePath, format, { sheet: sheetOption });
            for (const statement of setup.statements) {
                await connection.run(statement);
            }
        }

        if (this.config.options?.editable === true) {
            await connection.run(buildEditableTableSql(filePath));
        }
    }

    private async _setupWorkspaceViews(filePaths: readonly string[]): Promise<void> {
        if (filePaths.length === 0) {
            throw new Error('The File SQL workspace does not contain any data files.');
        }

        const sources = filePaths.map(filePath => {
            const format = detectFileDataFormat(filePath);
            if (!format) {
                throw new Error(
                    `Unsupported data file '${filePath}'. Supported formats: .xlsx, .csv, .tsv, .parquet, .avro`,
                );
            }
            if (!fs.existsSync(filePath)) {
                throw new Error(`Data file does not exist: '${filePath}'.`);
            }
            return {
                filePath,
                format,
                discoveredSheets: format === 'xlsx' ? this._discoverSheets(filePath) : undefined,
            };
        });

        const extensionNames = new Set(sources.flatMap(source => requiredDuckDbExtensions(source.format)));
        const connection = this.requireConnection();
        for (const extension of extensionNames) {
            try {
                await connection.run(`INSTALL ${extension}`);
                await connection.run(`LOAD ${extension}`);
            } catch (error) {
                throw new Error(
                    `DuckDB extension '${extension}' could not be loaded for the File SQL workspace. ` +
                    'Extensions are downloaded from the internet once — check your network connection and retry.',
                    { cause: error },
                );
            }
        }

        const setup = buildFileWorkspaceViewSetupSql(sources);
        for (const statement of setup.statements) {
            await connection.run(statement);
        }
    }

    /**
     * Sheet names read directly from the xlsx archive (xl/workbook.xml).
     * Returns [] for archives without a workbook (callers then default to
     * the first sheet).
     */
    private _discoverSheets(filePath: string): string[] {
        try {
            return listXlsxSheetNames(filePath);
        } catch {
            return [];
        }
    }
}
