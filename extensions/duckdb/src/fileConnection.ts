/**
 * File SQL connection: opens an in-memory DuckDB, loads the required
 * extensions (xlsx / avro) and registers read_* views over the configured
 * data file so it behaves like a table. XLSB workbooks are converted to CSV
 * (via @justybase/spreadsheet-tasks) in a per-connection temporary directory
 * and read back with read_csv.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { DatabaseConnectionConfig } from '@justybase/contracts';
import { DuckDbConnection, loadDuckDb } from './duckdbConnection';
import { convertXlsbToCsvs } from './xlsbConversion';
import {
    buildFileWorkspaceViewSetupSql,
    buildEditableTableSql,
    buildFileViewSetupSql,
    detectFileDataFormat,
    getFileWorkspacePaths,
    requiredDuckDbExtensions,
    type FileDataFormat,
    type FileViewSetupResult,
    type FileWorkspaceViewSource,
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
    private _tempDir: string | undefined;

    public constructor(public readonly config: DatabaseConnectionConfig) {
        super({
            ...config,
            database: ':memory:',
            options: { ...(config.options ?? {}), mode: 'memory' },
        });
    }

    public override async close(): Promise<void> {
        await super.close();
        if (this._tempDir) {
            try {
                fs.rmSync(this._tempDir, { recursive: true, force: true });
            } catch {
                // Ignore temp-dir cleanup failures; the OS will reclaim them eventually.
            }
            this._tempDir = undefined;
        }
    }

    private _ensureTempDir(): string {
        this._tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-xlsb-'));
        return this._tempDir;
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
                `Unsupported data file '${filePath}'. Supported formats: .xlsx, .xlsb, .csv, .tsv, .parquet, .avro`,
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

        let setup: FileViewSetupResult;
        if (format === 'xlsx') {
            const sheets = sheetOption ? undefined : this._discoverSheets(filePath);
            setup = buildFileViewSetupSql(filePath, format, { sheet: sheetOption, discoveredSheets: sheets });
        } else if (format === 'xlsb') {
            const converted = await convertXlsbToCsvs(filePath, this._ensureTempDir(), { sheet: sheetOption });
            setup = buildFileViewSetupSql(filePath, format, {
                sheet: sheetOption,
                discoveredSheets: converted.sheetNames,
                convertedTo: converted.firstCsvPath,
                sheetCsvPaths: converted.sheetCsvPaths,
            });
        } else {
            setup = buildFileViewSetupSql(filePath, format, { sheet: sheetOption });
        }

        for (const statement of setup.statements) {
            await connection.run(statement);
        }

        if (this.config.options?.editable === true) {
            await connection.run(buildEditableTableSql(filePath));
        }
    }

    private async _setupWorkspaceViews(filePaths: readonly string[]): Promise<void> {
        if (filePaths.length === 0) {
            throw new Error('The File SQL workspace does not contain any data files.');
        }

        const sources: FileWorkspaceViewSource[] = [];
        for (const filePath of filePaths) {
            const format = detectFileDataFormat(filePath);
            if (!format) {
                throw new Error(
                    `Unsupported data file '${filePath}'. Supported formats: .xlsx, .xlsb, .csv, .tsv, .parquet, .avro`,
                );
            }
            if (!fs.existsSync(filePath)) {
                throw new Error(`Data file does not exist: '${filePath}'.`);
            }
            if (format === 'xlsx') {
                sources.push({ filePath, format, discoveredSheets: this._discoverSheets(filePath) });
            } else if (format === 'xlsb') {
                const converted = await convertXlsbToCsvs(filePath, this._ensureTempDir());
                sources.push({
                    filePath,
                    format,
                    discoveredSheets: converted.sheetNames,
                    convertedTo: converted.firstCsvPath,
                    sheetCsvPaths: converted.sheetCsvPaths,
                });
            } else {
                sources.push({ filePath, format });
            }
        }

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
