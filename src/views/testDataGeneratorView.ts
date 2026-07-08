import * as vscode from 'vscode';
import type {
    ColumnGenerationConfig,
    DataGenerationConfig,
    TestDataGeneratorBootstrapState,
    TestDataGeneratorWebviewToHostMessage,
} from '../contracts/webviews/testDataGeneratorContracts';
import { ConnectionManager, ConnectionDetails } from '../core/connectionManager';
import { executeQueryHelper, quoteNameIfNeeded } from '../ddl/helpers';
import { Logger } from '../utils/logger';
import { NzConnection as NzConnectionType } from '../types';
import { createNzConnection } from '../core/nzConnectionFactory';
import { MetadataCache } from '../metadataCache';

async function createAndConnectNzConnection(details: ConnectionDetails): Promise<NzConnectionType> {
    const connection = createNzConnection({
        host: details.host,
        port: details.port,
        database: details.database,
        user: details.user,
        password: details.password
    });
    await connection.connect();
    return connection as unknown as NzConnectionType;
}

interface TableColumn {
    name: string;
    type: string;
    fullType: string;
    nullable: boolean;
    defaultValue?: string;
}

function getNonce(): string {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export class TestDataGeneratorView {
    public static readonly viewType = 'netezza.testDataGenerator';
    private static _currentPanel: TestDataGeneratorView | undefined;

    public static async createOrShow(
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        metadataCache: MetadataCache,
        connectionName: string,
        database: string,
        schema: string,
        table: string
    ): Promise<void> {
        const column = vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.One;

        // Fetch table columns (from cache or database)
        const columns = await TestDataGeneratorView.fetchTableColumns(
            connectionManager,
            metadataCache,
            connectionName,
            database,
            schema,
            table
        );

        if (TestDataGeneratorView._currentPanel) {
            TestDataGeneratorView._currentPanel._panel.reveal(column);
            TestDataGeneratorView._currentPanel._setState(connectionName, database, schema, table, columns);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            TestDataGeneratorView.viewType,
            `Test Data Generator: ${database}.${schema}.${table}`,
            column,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist'),
                ],
                retainContextWhenHidden: true
            }
        );

        TestDataGeneratorView._currentPanel = new TestDataGeneratorView(
            panel,
            extensionUri,
            connectionManager,
            connectionName,
            database,
            schema,
            table,
            columns
        );
    }

    private static async fetchTableColumns(
        connectionManager: ConnectionManager,
        metadataCache: MetadataCache,
        connectionName: string,
        database: string,
        schema: string,
        table: string
    ): Promise<TableColumn[]> {
        // Validate identifiers to prevent SQL injection
        const validIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
        if (!validIdentifier.test(database) || !validIdentifier.test(schema) || !validIdentifier.test(table)) {
            throw new Error('Invalid database, schema, or table name');
        }

        // Try to get columns from cache first
        const cacheKey = `${database}.${schema}.${table}`;
        const cachedColumns = metadataCache.getColumns(connectionName, cacheKey);
        if (cachedColumns && cachedColumns.length > 0) {
            return cachedColumns.map(col => ({
                name: col.ATTNAME,
                type: col.FORMAT_TYPE,
                fullType: col.FORMAT_TYPE,
                nullable: !col.IS_NOT_NULL,
                defaultValue: (col.COLDEFAULT as string) || undefined
            }));
        }

        // Fall back to database query
        try {
            const connectionDetails = await connectionManager.getConnection(connectionName);
            if (!connectionDetails) {
                throw new Error(`Connection '${connectionName}' not found`);
            }

            const connection = await createAndConnectNzConnection(connectionDetails);

            try {
                const query = `
                    SELECT
                        X.ATTNAME AS NAME,
                        X.FORMAT_TYPE AS TYPE,
                        X.FORMAT_TYPE AS FULLTYPE,
                        CASE WHEN X.ATTNOTNULL THEN 0 ELSE 1 END AS NULLABLE,
                        X.COLDEFAULT AS DEFAULTVALUE
                    FROM
                        ${database}.._V_RELATION_COLUMN X
                    INNER JOIN
                        ${database}.._V_OBJECT_DATA O ON X.OBJID = O.OBJID
                    WHERE
                        UPPER(O.OBJNAME) = UPPER('${table}')
                        AND UPPER(O.DBNAME) = UPPER('${database}')
                        AND UPPER(O.SCHEMA) = UPPER('${schema}')
                    ORDER BY
                        X.ATTNUM
                `;

                const results = await executeQueryHelper<{
                    NAME: string;
                    TYPE: string;
                    FULLTYPE: string;
                    NULLABLE: number;
                    DEFAULTVALUE: string | null;
                }>(connection, query);

                const columns: TableColumn[] = results.map(row => ({
                    name: row.NAME,
                    type: row.TYPE,
                    fullType: row.FULLTYPE,
                    nullable: row.NULLABLE === 1,
                    defaultValue: row.DEFAULTVALUE || undefined
                }));

                return columns;
            } finally {
                await connection.close?.();
            }
        } catch (error) {
            Logger.getInstance().error('Failed to fetch table columns for test data generator', error);
            vscode.window.showErrorMessage(`Failed to fetch table columns: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }

    private _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private readonly _connectionManager: ConnectionManager;
    private _connectionName: string;
    private _database: string;
    private _schema: string;
    private _table: string;
    private _columns: TableColumn[];
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        connectionManager: ConnectionManager,
        connectionName: string,
        database: string,
        schema: string,
        table: string,
        columns: TableColumn[]
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._connectionManager = connectionManager;
        this._connectionName = connectionName;
        this._database = database;
        this._schema = schema;
        this._table = table;
        this._columns = columns;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message: TestDataGeneratorWebviewToHostMessage) => {
                switch (message.command) {
                    case 'generateData':
                        if (message.config) {
                            await this._handleGenerateData(message.config);
                        }
                        break;
                    case 'copyToClipboard':
                        if (message.sql) {
                            await vscode.env.clipboard.writeText(message.sql);
                            vscode.window.showInformationMessage('SQL copied to clipboard');
                        }
                        break;
                    case 'openInEditor':
                        if (message.sql) {
                            const doc = await vscode.workspace.openTextDocument({
                                content: message.sql,
                                language: 'sql'
                            });
                            await vscode.window.showTextDocument(doc);
                        }
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _setState(
        connectionName: string,
        database: string,
        schema: string,
        table: string,
        columns: TableColumn[]
    ): void {
        this._connectionName = connectionName;
        this._database = database;
        this._schema = schema;
        this._table = table;
        this._columns = columns;
        this._update();
    }

    private async _handleGenerateData(config: DataGenerationConfig): Promise<void> {
        try {
            const sql = this._generateInsertSQL(config);

            // Open in editor instead of executing directly for safety
            const doc = await vscode.workspace.openTextDocument({
                content: sql,
                language: 'sql'
            });
            await vscode.window.showTextDocument(doc);

            const executeNow = await vscode.window.showInformationMessage(
                `Generated INSERT statements for ${config.rowCount} rows. Execute now?`,
                'Execute',
                'Cancel'
            );

            if (executeNow === 'Execute') {
                const connectionDetails = await this._connectionManager.getConnection(this._connectionName);
                if (!connectionDetails) {
                    throw new Error('Connection not found');
                }

                const connection = await createAndConnectNzConnection(connectionDetails);

                try {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Window,
                        title: `Inserting ${config.rowCount} rows...`,
                        cancellable: false
                    }, async () => {
                        await executeQueryHelper(connection, sql);
                    });

                    vscode.window.showInformationMessage(`Successfully inserted ${config.rowCount} rows into ${this._schema}.${this._table}`);
                } finally {
                    await connection.close();
                }
            }
        } catch (error) {
            Logger.getInstance().error('Failed to generate test data', error);
            vscode.window.showErrorMessage(`Failed to generate test data: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private _generateInsertSQL(config: DataGenerationConfig): string {
        const { rowCount, batchSize, useTransaction, columns } = config;
        const qualifiedTable = `${quoteNameIfNeeded(this._database)}.${quoteNameIfNeeded(this._schema)}.${quoteNameIfNeeded(this._table)}`;

        let sql = '';

        if (useTransaction) {
            sql += 'BEGIN;\n\n';
        }

        const columnNames = columns.map(c => quoteNameIfNeeded(c.name)).join(', ');
        const batches = Math.ceil(rowCount / batchSize);

        for (let batch = 0; batch < batches; batch++) {
            const startRow = batch * batchSize;
            const endRow = Math.min(startRow + batchSize, rowCount);

            for (let rowIdx = startRow; rowIdx < endRow; rowIdx++) {
                const rowValues = columns.map(col => this._generateValue(col, rowIdx));
                sql += `INSERT INTO ${qualifiedTable} (${columnNames}) VALUES (${rowValues.join(', ')});\n`;
            }

            sql += '\n';
        }

        if (useTransaction) {
            sql += 'COMMIT;';
        }

        return sql;
    }

    private _generateValue(column: ColumnGenerationConfig, rowIndex: number): string {
        const { strategy, type, params = {} } = column;

        switch (strategy) {
            case 'null':
                return 'NULL';

            case 'fixed':
                return this._escapeSqlValue(params.value, type);

            case 'sequence':
                const start = (params.start as number) || 1;
                const step = (params.step as number) || 1;
                const value = start + rowIndex * step;
                return String(value);

            case 'faker':
                return this._generateFakerValue(params.category as string, type);

            case 'random':
            default:
                return this._generateRandomValue(type, params);
        }
    }

    private _generateRandomValue(type: string, params: Record<string, unknown>): string {
        const upperType = type.toUpperCase();

        // Integer types
        if (upperType.includes('INT') || upperType.includes('SERIAL') || upperType.includes('NUMERIC') || upperType.includes('DECIMAL')) {
            const min = (params.min as number) ?? 1;
            const max = (params.max as number) ?? 1000000;
            return String(Math.floor(Math.random() * (max - min + 1)) + min);
        }

        // Float/Double types
        if (upperType.includes('FLOAT') || upperType.includes('DOUBLE') || upperType.includes('REAL')) {
            const min = (params.min as number) ?? 0;
            const max = (params.max as number) ?? 1000;
            const value = Math.random() * (max - min) + min;
            const precision = (params.precision as number) ?? 2;
            return value.toFixed(precision);
        }

        // Date types
        if (upperType.includes('DATE') && !upperType.includes('TIME')) {
            const start = new Date('2020-01-01').getTime();
            const end = new Date('2025-12-31').getTime();
            const randomDate = new Date(start + Math.random() * (end - start));
            return `'${randomDate.toISOString().split('T')[0]}'`;
        }

        // Timestamp types
        if (upperType.includes('TIMESTAMP') || upperType.includes('TIME')) {
            const start = new Date('2020-01-01').getTime();
            const end = new Date('2025-12-31').getTime();
            const randomDate = new Date(start + Math.random() * (end - start));
            return `'${randomDate.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23)}'`;
        }

        // Boolean
        if (upperType.includes('BOOL')) {
            return Math.random() > 0.5 ? 'TRUE' : 'FALSE';
        }

        // UUID
        if (upperType.includes('UUID')) {
            return `'${this._generateUUID()}'`;
        }

        // Default to string
        const length = (params.length as number) ?? 20;
        return `'${this._generateRandomString(length)}'`;
    }

    /**
     * Extract max length from column type (e.g., VARCHAR(17) -> 17, CHAR(10) -> 10)
     */
    private _getMaxLengthFromType(type: string): number {
        if (!type) return 255;
        const match = type.match(/\((\d+)\)/);
        return match ? parseInt(match[1], 10) : 255;
    }

    /**
     * Truncate string to fit within max length
     */
    private _fitStringToLength(str: string, maxLength: number): string {
        if (str.length <= maxLength) return str;
        return str.substring(0, maxLength);
    }

    private _generateFakerValue(category: string, type: string): string {
        const upperCategory = (category || 'STRING').toUpperCase();
        const maxLength = this._getMaxLengthFromType(type);

        const firstNames = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen'];
        const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];
        const cities = ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Philadelphia', 'San Antonio', 'San Diego', 'Dallas', 'San Jose', 'Austin', 'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte', 'San Francisco', 'Indianapolis', 'Seattle', 'Denver', 'Washington'];
        const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'company.com', 'enterprise.net', 'business.org'];
        const departments = ['Sales', 'Marketing', 'Engineering', 'HR', 'Finance', 'Operations', 'IT', 'Support', 'Research', 'Legal'];
        const products = ['Widget', 'Gadget', 'Tool', 'Device', 'Component', 'Part', 'Accessory', 'Module', 'System', 'Unit'];

        switch (upperCategory) {
            case 'NAME': {
                const name = `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
                return `'${this._fitStringToLength(name, maxLength)}'`;
            }
            case 'FIRST_NAME': {
                const fname = firstNames[Math.floor(Math.random() * firstNames.length)];
                return `'${this._fitStringToLength(fname, maxLength)}'`;
            }
            case 'LAST_NAME': {
                const lname = lastNames[Math.floor(Math.random() * lastNames.length)];
                return `'${this._fitStringToLength(lname, maxLength)}'`;
            }
            case 'EMAIL': {
                const fname = firstNames[Math.floor(Math.random() * firstNames.length)].toLowerCase();
                const lname = lastNames[Math.floor(Math.random() * lastNames.length)].toLowerCase();
                const domain = domains[Math.floor(Math.random() * domains.length)];
                const email = `${fname}.${lname}@${domain}`;
                return `'${this._fitStringToLength(email, maxLength)}'`;
            }
            case 'PHONE': {
                const phone = `(${Math.floor(Math.random() * 900) + 100}) ${Math.floor(Math.random() * 900) + 100}-${Math.floor(Math.random() * 9000) + 1000}`;
                return `'${this._fitStringToLength(phone, maxLength)}'`;
            }
            case 'CITY': {
                const city = cities[Math.floor(Math.random() * cities.length)];
                return `'${this._fitStringToLength(city, maxLength)}'`;
            }
            case 'DEPARTMENT': {
                const dept = departments[Math.floor(Math.random() * departments.length)];
                return `'${this._fitStringToLength(dept, maxLength)}'`;
            }
            case 'PRODUCT': {
                const product = products[Math.floor(Math.random() * products.length)];
                const sku = Math.floor(Math.random() * 90000) + 10000;
                const productStr = `${product}-${sku}`;
                return `'${this._fitStringToLength(productStr, maxLength)}'`;
            }
            case 'ADDRESS': {
                const num = Math.floor(Math.random() * 9000) + 100;
                const street = ['Main St', 'Oak Ave', 'Park Rd', 'Elm St', 'Cedar Ln', 'Maple Dr', 'Washington Ave', 'Lake St'][Math.floor(Math.random() * 8)];
                const addr = `${num} ${street}`;
                return `'${this._fitStringToLength(addr, maxLength)}'`;
            }
            case 'STRING':
            default:
                return `'${this._generateRandomString(Math.min(20, maxLength))}'`;
        }
    }

    private _generateRandomString(length: number): string {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    private _generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    private _escapeSqlValue(value: unknown, type: string): string {
        if (value === null || value === undefined) {
            return 'NULL';
        }

        const upperType = type.toUpperCase();

        if (upperType.includes('INT') || upperType.includes('FLOAT') || upperType.includes('DOUBLE') || upperType.includes('NUMERIC') || upperType.includes('DECIMAL') || upperType.includes('REAL') || upperType.includes('SERIAL') || upperType.includes('BOOL')) {
            return String(value);
        }

        const strValue = String(value).replace(/'/g, "''");
        return `'${strValue}'`;
    }

    private _update(): void {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    private _getHtmlForWebview(): string {
        const scriptUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'testDataGenerator.js')
        );
        const styleUri = this._panel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'testDataGenerator.css')
        );

        const nonce = getNonce();

        const bootstrapState: TestDataGeneratorBootstrapState = {
            connectionName: this._connectionName,
            database: this._database,
            schema: this._schema,
            table: this._table,
            columns: this._columns
        };

        const stateJson = JSON.stringify(bootstrapState).replace(/</g, '\\u003c');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Test Data Generator</title>
</head>
<body>
    <div class="container">
        <header class="header">
            <h2>🎲 Test Data Generator</h2>
            <div class="header-subtitle">${this._database}.${this._schema}.${this._table}</div>
        </header>

        <div class="main-content">
            <section class="config-section">
                <h3>Generation Settings</h3>
                
                <div class="form-row">
                    <div class="form-group">
                        <label for="rowCount">Number of Rows</label>
                        <input type="number" id="rowCount" value="1000" min="1" max="1000000" step="100">
                    </div>
                    
                    <div class="form-group">
                        <label for="batchSize">Batch Size</label>
                        <select id="batchSize">
                            <option value="100">100</option>
                            <option value="500" selected>500</option>
                            <option value="1000">1,000</option>
                            <option value="5000">5,000</option>
                            <option value="10000">10,000</option>
                        </select>
                    </div>
                </div>

                <div class="form-row">
                    <div class="form-group checkbox-group">
                        <label>
                            <input type="checkbox" id="useTransaction" checked>
                            <span>Wrap in Transaction</span>
                        </label>
                    </div>
                </div>
            </section>

            <section class="columns-section">
                <h3>Column Configuration</h3>
                <div class="columns-table-wrapper">
                    <table class="columns-table" id="columnsTable">
                        <thead>
                            <tr>
                                <th>Column</th>
                                <th>Type</th>
                                <th>Strategy</th>
                                <th>Parameters</th>
                            </tr>
                        </thead>
                        <tbody id="columnsTableBody">
                            <!-- Populated by JS -->
                        </tbody>
                    </table>
                </div>
            </section>

            <section class="preview-section">
                <h3>SQL Preview</h3>
                <div class="preview-toolbar">
                    <button id="generatePreviewBtn" class="btn btn-primary">🔄 Generate Preview</button>
                    <span class="preview-info" id="previewInfo"></span>
                </div>
                <pre class="sql-preview" id="sqlPreview"><code>-- Click "Generate Preview" to see the SQL</code></pre>
            </section>

            <section class="actions-section">
                <button id="copyToClipboardBtn" class="btn btn-secondary">📋 Copy to Clipboard</button>
                <button id="openInEditorBtn" class="btn btn-secondary">📄 Open in Editor</button>
                <button id="generateAndExecuteBtn" class="btn btn-primary">▶️ Generate & Execute</button>
            </section>
        </div>
    </div>

    <script nonce="${nonce}">
        window.testDataGeneratorState = ${stateJson};
    </script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose(): void {
        TestDataGeneratorView._currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
