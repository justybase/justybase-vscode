import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import type { ConnectionManager } from '../core/connectionManager';
import { exportResultSetToFile } from '../export/resultExporter';
import type { ConnectionDetails, ResultSet } from '../types';
import type { ExportMetadata } from '../export/exportManager';
import { getConnectionForDocument } from '../core/queryRunnerHelpers';
import { streamingManager } from '../core/queryCancellation';
import { getQueryConfig, createDropSessionCallback } from '../core/queryBatchExecutor';
import type { StreamingChunk } from '../core/streaming';
import { escapeSqlIdentifier } from '../utils/sqlUtils';

const DUCKDB_BRIDGE_CONNECTION_NAME = 'DuckDB Bridge';
const DUCKDB_BRIDGE_DATABASE_FILE = 'justybase-duckdb-bridge.duckdb';
const DUCKDB_BRIDGE_TABLE_NAME = 'results';

type BridgeConnectionManager = Pick<ConnectionManager, 'getConnection' | 'saveConnection' | 'setDocumentConnection'>;

interface DuckDbResultBridgeDependencies {
    createConnection?: typeof createConnectedDatabaseConnectionFromDetails;
    exportResultSet?: typeof exportResultSetToFile;
    openTextDocument?: typeof vscode.workspace.openTextDocument;
    showTextDocument?: typeof vscode.window.showTextDocument;
    deleteFile?: typeof fs.promises.unlink;
    tmpDir?: () => string;
    now?: () => number;
}

// Use escapeSqlLiteral from sqlUtils for proper escaping (imported as escapeSqlLiteralFromUtils)
// Local helper for file paths that need single-quote escaping without wrapping
function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeDuckDbFilePath(filePath: string): string {
  // Resolve the path and convert backslashes to forward slashes for DuckDB
  // DuckDB expects forward slashes even on Windows
  let resolved = path.resolve(filePath);
  
  // On Windows, path.resolve returns paths with backslashes (e.g., C:\Users\...)
  // DuckDB requires forward slashes for file paths in SQL statements
  // Convert all backslashes to forward slashes
  resolved = resolved.replace(/\\/g, '/');
  
  // Ensure the path doesn't start with a double slash (which would be interpreted as UNC)
  // On Windows, a path like C:/tmp/file.duckdb is valid, but //tmp/file.duckdb is a UNC path
  if (resolved.startsWith('//')) {
    resolved = resolved.substring(1);
  }
  
  return resolved;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function formatValue(val: unknown, type?: string): string {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) {
        const y = val.getUTCFullYear();
        const m = String(val.getUTCMonth() + 1).padStart(2, '0');
        const d = String(val.getUTCDate()).padStart(2, '0');

        const lowerType = (type || '').toLowerCase();
        if (lowerType === 'date') {
            return `${y}-${m}-${d}`;
        } else if (lowerType.includes('timestamp') || lowerType.includes('datetime') || lowerType.includes('time')) {
            const hh = String(val.getUTCHours()).padStart(2, '0');
            const mm = String(val.getUTCMinutes()).padStart(2, '0');
            const ss = String(val.getUTCSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
        }
        try {
            return val.toISOString().replace('T', ' ').substring(0, 19);
        } catch {
            return String(val);
        }
    }

    if (typeof val === 'object' && val !== null) {
        const str = String(val);
        if (str !== '[object Object]') return str;

        const v = val as { hours?: number; minutes?: number; seconds?: number };
        if ('hours' in v || 'minutes' in v || 'seconds' in v) {
            const hh = String(v.hours || 0).padStart(2, '0');
            const mm = String(v.minutes || 0).padStart(2, '0');
            const ss = String(v.seconds || 0).padStart(2, '0');
            return `${hh}:${mm}:${ss}`;
        }
    }

    return String(val);
}

function buildDuckDbLoadSql(csvFilePath: string): string {
  const normalizedFilePath = normalizeDuckDbFilePath(csvFilePath);
  return `CREATE OR REPLACE TABLE ${DUCKDB_BRIDGE_TABLE_NAME} AS SELECT * FROM read_csv_auto('${escapeSingleQuotes(normalizedFilePath)}', HEADER = TRUE);`;
}

function createBridgeConnectionDetails(databasePath: string): ConnectionDetails & { name: string } {
  // Normalize the database path for cross-platform compatibility
  // DuckDB driver expects forward slashes even on Windows
  const normalizedPath = normalizeDuckDbFilePath(databasePath);
  
  return {
    name: DUCKDB_BRIDGE_CONNECTION_NAME,
    host: 'localhost',
    database: normalizedPath,
    user: 'duckdb',
    password: '',
    dbType: 'duckdb',
    options: {
      mode: 'file',
    },
  };
}

export class DuckDbResultBridge {
    private readonly _createConnection: typeof createConnectedDatabaseConnectionFromDetails;
    private readonly _exportResultSet: typeof exportResultSetToFile;
    private readonly _openTextDocument: typeof vscode.workspace.openTextDocument;
    private readonly _showTextDocument: typeof vscode.window.showTextDocument;
    private readonly _deleteFile: typeof fs.promises.unlink;
    private readonly _tmpDir: () => string;
    private readonly _now: () => number;

    constructor(
        private readonly _resultsMap: Map<string, ResultSet[]>,
        private readonly _connectionManager: BridgeConnectionManager,
        dependencies: DuckDbResultBridgeDependencies = {}
    ) {
        this._createConnection = dependencies.createConnection ?? createConnectedDatabaseConnectionFromDetails;
        this._exportResultSet = dependencies.exportResultSet ?? exportResultSetToFile;
        this._openTextDocument = dependencies.openTextDocument ?? vscode.workspace.openTextDocument.bind(vscode.workspace);
        this._showTextDocument = dependencies.showTextDocument ?? vscode.window.showTextDocument.bind(vscode.window);
        this._deleteFile = dependencies.deleteFile ?? fs.promises.unlink.bind(fs.promises);
        this._tmpDir = dependencies.tmpDir ?? os.tmpdir;
        this._now = dependencies.now ?? Date.now;
    }

    public async queryLocally(metadata: ExportMetadata): Promise<void> {
        const resultSet = this._resolveResultSet(metadata);
        if (!resultSet) {
            vscode.window.showErrorMessage('DuckDB bridge failed: Result set not found.');
            return;
        }

        if (resultSet.isLog || resultSet.columns.length === 0) {
            vscode.window.showErrorMessage('DuckDB bridge failed: The active result set is not a tabular query result.');
            return;
        }

        const csvFilePath = path.join(this._tmpDir(), `justybase-duckdb-bridge-${this._now()}.csv`);

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'Loading result set into local DuckDB...',
                    cancellable: false,
                },
                async () => {
                    await this._exportResultSet(resultSet, csvFilePath, {
                        format: 'csv',
                    });

                    const bridgeConnection = await this._ensureBridgeConnection();
                    const connection = await this._createConnection(bridgeConnection);

                    try {
                        await connection.createCommand(buildDuckDbLoadSql(csvFilePath)).execute();
                    } finally {
                        await connection.close();
                    }

                    const document = await this._openTextDocument({
                        content: `SELECT * FROM ${DUCKDB_BRIDGE_TABLE_NAME} LIMIT 100;`,
                        language: 'sql',
                    });

                    await this._showTextDocument(document, { preview: false });

                    this._connectionManager.setDocumentConnection(
                        document.uri.toString(),
                        DUCKDB_BRIDGE_CONNECTION_NAME,
                    );
                }
            );

            vscode.window.showInformationMessage(
                `Loaded the active result set into DuckDB table "${DUCKDB_BRIDGE_TABLE_NAME}".`,
            );
        } catch (error) {
            vscode.window.showErrorMessage(`DuckDB bridge failed: ${getErrorMessage(error)}`);
        } finally {
            await this._deleteFile(csvFilePath).catch(() => undefined);
        }
    }

    private _resolveResultSet(metadata: ExportMetadata): ResultSet | undefined {
        if (!metadata.sourceUri || metadata.resultSetIndex === undefined) {
            return undefined;
        }

        return this._resultsMap.get(metadata.sourceUri)?.[metadata.resultSetIndex];
    }

    public async streamToDuckDb(
        query: string,
        fullConnectionManager: ConnectionManager,
        connectionName: string,
        targetTable: string,
        mode: 'overwrite' | 'append',
        documentUri?: string
    ): Promise<void> {

        const { connection: tempConn, shouldCloseConnection } = await getConnectionForDocument(
            fullConnectionManager,
            connectionName,
            true, // use persistent connection if available
            documentUri
        );

        const csvFilePath = path.join(this._tmpDir(), `justybase-duckdb-stream-${this._now()}.csv`);
        let writeStream: fs.WriteStream | undefined;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: `Streaming query results to DuckDB table '${targetTable}'...`,
                    cancellable: false,
                },
                async (progress) => {
                    writeStream = fs.createWriteStream(csvFilePath, { encoding: 'utf8' });
                    const { queryTimeout } = getQueryConfig();
                    
                    let csvHeadersWritten = false;

                    const result = await streamingManager.executeWithStreaming(
                        tempConn,
                        query,
                        999999999, // practically unlimited
                        50000,
                        queryTimeout,
                        documentUri,
                        (chunk: StreamingChunk) => {
                            if (!csvHeadersWritten && chunk.columns.length > 0) {
                                writeStream!.write(chunk.columns.map(c => escapeCsv(c.name)).join(',') + '\n');
                                csvHeadersWritten = true;
                            }

                            for (const row of chunk.rows) {
                                const line = chunk.columns.map((c, idx) => escapeCsv(formatValue(row[idx], c.type))).join(',') + '\n';
                                writeStream!.write(line);
                            }

                            progress.report({ message: `Streamed ${chunk.totalRowsSoFar} rows...`, increment: 0 });
                        },
                        undefined, // sessionId - streamingManager fetches it
                        undefined,
                        undefined, // maxRows
                        createDropSessionCallback(fullConnectionManager, documentUri)
                    );

                    if (result.error) {
                        throw result.error;
                    }

                    // Wait for flush
                    await new Promise<void>((resolve, reject) => {
                        if (!writeStream) { resolve(); return; }
                        writeStream.end();
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });
                    writeStream = undefined;

                    progress.report({ message: `Loading ${result.totalRows} rows into DuckDB...` });

                    const bridgeConnection = await this._ensureBridgeConnection();
                    const localConn = await this._createConnection(bridgeConnection);

                    try {
                      const normalizedFilePath = normalizeDuckDbFilePath(csvFilePath);
                      let loadSql = '';
                      if (mode === 'overwrite') {
                        loadSql = `CREATE OR REPLACE TABLE ${escapeSqlIdentifier(targetTable)} AS SELECT * FROM read_csv_auto('${escapeSingleQuotes(normalizedFilePath)}', HEADER = TRUE);`;
                      } else {
                        loadSql = `CREATE TABLE IF NOT EXISTS ${escapeSqlIdentifier(targetTable)} AS SELECT * FROM read_csv_auto('${escapeSingleQuotes(normalizedFilePath)}', HEADER = TRUE) WHERE 1=0; ` +
                          `INSERT INTO ${escapeSqlIdentifier(targetTable)} SELECT * FROM read_csv_auto('${escapeSingleQuotes(normalizedFilePath)}', HEADER = TRUE);`;
                      }
                  
                      // Run the load query
                      const cmd = localConn.createCommand(loadSql);
                      cmd.commandTimeout = 0; // DuckDB load can take time
                      await cmd.execute();
                    } finally {
                      await localConn.close();
                    }
                  
                    const document = await this._openTextDocument({
                      content: `SELECT * FROM ${escapeSqlIdentifier(targetTable)} LIMIT 100;`,
                      language: 'sql',
                    });

                    await this._showTextDocument(document, { preview: false });

                    this._connectionManager.setDocumentConnection(
                        document.uri.toString(),
                        bridgeConnection.name || DUCKDB_BRIDGE_CONNECTION_NAME,
                    );
                }
            );

            vscode.window.showInformationMessage(
                `Successfully loaded query results into DuckDB table "${targetTable}".`,
            );
        } catch (error) {
            vscode.window.showErrorMessage(`DuckDB stream failed: ${getErrorMessage(error)}`);
        } finally {
            if (writeStream) {
                writeStream.end();
            }
            if (shouldCloseConnection && tempConn) {
                await tempConn.close().catch(() => undefined);
            }
            await this._deleteFile(csvFilePath).catch(() => undefined);
        }
    }

    private async _ensureBridgeConnection(): Promise<ConnectionDetails & { name: string }> {
        const existing = await this._connectionManager.getConnection(DUCKDB_BRIDGE_CONNECTION_NAME);
        const bridgeDatabasePath = path.join(this._tmpDir(), DUCKDB_BRIDGE_DATABASE_FILE);

        if (existing && existing.dbType && existing.dbType !== 'duckdb') {
            throw new Error(
                `Connection "${DUCKDB_BRIDGE_CONNECTION_NAME}" already exists but is configured for ${existing.dbType}. Rename or delete it, then try again.`,
            );
        }

        const shouldReplaceExisting =
            !existing
            || existing.dbType !== 'duckdb'
            || existing.database.trim() === ':memory:'
            || existing.options?.mode === 'memory';

        const bridgeConnection = shouldReplaceExisting
            ? createBridgeConnectionDetails(bridgeDatabasePath)
            : {
                ...existing,
                name: existing.name || DUCKDB_BRIDGE_CONNECTION_NAME,
            };

        if (shouldReplaceExisting) {
            await this._connectionManager.saveConnection(bridgeConnection);
        }

        return bridgeConnection;
    }
}
