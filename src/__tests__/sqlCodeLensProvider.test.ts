/**
 * Unit tests for SqlCodeLensProvider
 */

import { SqlCodeLensProvider } from '../providers/sqlCodeLensProvider';
import { SqlLexer } from '../sqlParser/lexer';
import * as vscode from 'vscode';

// Helper: create a mock TextDocument
function createMockDocument(text: string, languageId = 'sql'): vscode.TextDocument {
    const lines = text.split('\n');
    return {
        getText: jest.fn(() => text),
        languageId,
        uri: vscode.Uri.file('/test.sql'),
        positionAt: jest.fn((offset: number) => {
            let line = 0;
            let remaining = offset;
            for (let i = 0; i < lines.length; i++) {
                const lineLen = lines[i].length + 1; // +1 for \n
                if (remaining < lineLen) {
                    return new vscode.Position(i, remaining);
                }
                remaining -= lineLen;
                line = i + 1;
            }
            return new vscode.Position(line, remaining);
        }),
    } as unknown as vscode.TextDocument;
}

const mockCancellationToken: vscode.CancellationToken = {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn() as unknown as vscode.CancellationToken['onCancellationRequested'],
};

const TOP_LEVEL_COUNT = 8;
const PER_STATEMENT_COUNT = 4;
const FIRST_PER_STATEMENT = TOP_LEVEL_COUNT;

async function getLenses(
    provider: SqlCodeLensProvider,
    document: vscode.TextDocument
): Promise<vscode.CodeLens[]> {
    return (await Promise.resolve(provider.provideCodeLenses(document, mockCancellationToken))) || [];
}

describe('SqlCodeLensProvider', () => {
    let provider: SqlCodeLensProvider;

    function createProvider(statementsEnabled = true): SqlCodeLensProvider {
        return new SqlCodeLensProvider(undefined, {
            get: <T>(_key: string, defaultValue?: T) => {
                if (_key === 'codeLens.statements') return statementsEnabled as unknown as T;
                return defaultValue as T;
            },
            update: jest.fn(),
        } as unknown as vscode.Memento);
    }

    beforeEach(() => {
        // Reset config mock to return true for codeLens.enabled
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
        });
        provider = createProvider();
    });

    it('should return statement CodeLens entries for execution and flow', async () => {
        const doc = createMockDocument('SELECT 1; SELECT 2;');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + 2 * PER_STATEMENT_COUNT);
    });

    it('should return correct command IDs', async () => {
        const doc = createMockDocument('SELECT 1;');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + PER_STATEMENT_COUNT);
        // Top-level
        expect(lenses[0].command?.command).toBe('netezza.runQuery');
        expect(lenses[1].command?.command).toBe('netezza.runQueryBatch');
        expect(lenses[2].command?.command).toBe('netezza.exportQueryAndOpenXlsb');
        expect(lenses[3].command?.command).toBe('netezza.exportWithFormatPicker');
        expect(lenses[4].command?.command).toBe('netezza.exportToMdFile');
        expect(lenses[5].command?.command).toBe('netezza.importWithPicker');
        expect(lenses[6].command?.command).toBe('netezza.explainQuery');
    });

    it('should include statement SQL in command arguments', async () => {
        const doc = createMockDocument('SELECT 1;');
        const lenses = await getLenses(provider, doc);
        expect(lenses[FIRST_PER_STATEMENT].command?.arguments?.[1]).toBe('SELECT 1');
    });

    it('should include document URI in command arguments', async () => {
        const doc = createMockDocument('SELECT 1;');
        const lenses = await getLenses(provider, doc);
        expect(lenses[FIRST_PER_STATEMENT].command?.arguments?.[0]).toBe(doc.uri);
    });

    it('should have correct titles', async () => {
        const doc = createMockDocument('SELECT 1;');
        const lenses = await getLenses(provider, doc);
        // Top-level actions
        expect(lenses[0].command?.title).toBe('$(debug-start) Run');
        expect(lenses[1].command?.title).toBe('$(run-all) Run Batch');
        expect(lenses[2].command?.title).toBe('$(file-binary) Open as XLSB');
        expect(lenses[3].command?.title).toBe('$(export) Export');
        expect(lenses[4].command?.title).toBe('$(markdown) MD');
        expect(lenses[5].command?.title).toBe('$(cloud-upload) Import');
        expect(lenses[6].command?.title).toBe('$(info) Explain');
    });

    it('should return top-level file lenses even for empty document', async () => {
        const doc = createMockDocument('');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT);
        expect(lenses.map(l => l.command?.command)).toEqual([
            'netezza.runQuery',
            'netezza.runQueryBatch',
            'netezza.exportQueryAndOpenXlsb',
            'netezza.exportWithFormatPicker',
            'netezza.exportToMdFile',
            'netezza.importWithPicker',
            'netezza.explainQuery',
            'netezza.toggleStatementCodeLens',
        ]);
    });

    it('should return top-level file lenses plus per-statement lenses', async () => {
        const doc = createMockDocument('SELECT 1;');
        const lenses = await getLenses(provider, doc);
        expect(lenses.slice(0, TOP_LEVEL_COUNT).map(l => l.command?.command)).toEqual([
            'netezza.runQuery',
            'netezza.runQueryBatch',
            'netezza.exportQueryAndOpenXlsb',
            'netezza.exportWithFormatPicker',
            'netezza.exportToMdFile',
            'netezza.importWithPicker',
            'netezza.explainQuery',
            'netezza.toggleStatementCodeLens',
        ]);
    });

    it('should return top-level file lenses for whitespace-only document', async () => {
        const doc = createMockDocument('   \n\n  ');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT);
    });

    it('should handle single statement without semicolon', async () => {
        const doc = createMockDocument('SELECT * FROM users');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + PER_STATEMENT_COUNT);
        expect(lenses[FIRST_PER_STATEMENT].command?.arguments?.[1]).toBe('SELECT * FROM users');
    });

    it('should return only top-level file lenses when statement CodeLens is disabled', async () => {
        provider = new SqlCodeLensProvider();
        const doc = createMockDocument('SELECT 1; SELECT 2;');
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT);
        expect(lenses.map(l => l.command?.command)).toEqual([
            'netezza.runQuery',
            'netezza.runQueryBatch',
            'netezza.exportQueryAndOpenXlsb',
            'netezza.exportWithFormatPicker',
            'netezza.exportToMdFile',
            'netezza.importWithPicker',
            'netezza.explainQuery',
            'netezza.toggleStatementCodeLens',
        ]);
    });

    it('should handle multiline statements', async () => {
        const sql = 'SELECT id,\n  name\nFROM users;\nSELECT * FROM orders;';
        const doc = createMockDocument(sql);
        const lenses = await getLenses(provider, doc);
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + 2 * PER_STATEMENT_COUNT);
        expect(lenses[FIRST_PER_STATEMENT].command?.arguments?.[1]).toBe('SELECT id,\n  name\nFROM users');
    });

    it('should add Compile Procedure CodeLens for a full BEGIN_PROC block', async () => {
        const sql = `-- comment before procedure
CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET_JS()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;

SELECT 1;`;
        const doc = createMockDocument(sql);
        const lenses = await getLenses(provider, doc);
        const compileLens = lenses.find(
            lens => lens.command?.command === 'netezza.compileProcedureFromLens',
        );

        expect(compileLens?.command?.title).toBe('$(run-all) Compile Procedure');
        expect(compileLens?.range.start.line).toBe(1);
        expect(compileLens?.command?.arguments?.[0]).toBe(doc.uri);
        expect(compileLens?.command?.arguments?.[1]).toBe(
            sql.substring(sql.indexOf('CREATE'), sql.indexOf('END_PROC;') + 'END_PROC;'.length),
        );
    });

    it('should not add per-statement CodeLens entries inside procedure bodies', async () => {
        const sql = `CREATE PROCEDURE PROC_NAME()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  INSERT INTO LOG_TABLE VALUES (1);
  RETURN 1;
END;
END_PROC;`;
        const doc = createMockDocument(sql);
        const lenses = await getLenses(provider, doc);

        expect(lenses.map(lens => lens.command?.command)).toEqual([
            'netezza.compileProcedureFromLens',
            'netezza.runQuery',
            'netezza.runQueryBatch',
            'netezza.exportQueryAndOpenXlsb',
            'netezza.exportWithFormatPicker',
            'netezza.exportToMdFile',
            'netezza.importWithPicker',
            'netezza.explainQuery',
            'netezza.toggleStatementCodeLens',
        ]);
    });

    it('should add one procedure CodeLens per nearest END_PROC block', async () => {
        const firstProcedure = `CREATE PROCEDURE PROC_ONE()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`;
        const secondProcedure = `CREATE OR REPLACE PROCEDURE PROC_TWO()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 2;
END;
END_PROC;`;
        const sql = `${firstProcedure}

${secondProcedure}`;
        const doc = createMockDocument(sql);
        const lenses = await getLenses(provider, doc);
        const compileLenses = lenses.filter(
            lens => lens.command?.command === 'netezza.compileProcedureFromLens',
        );

        expect(compileLenses).toHaveLength(2);
        expect(compileLenses[0].command?.arguments?.[1]).toBe(firstProcedure);
        expect(compileLenses[1].command?.arguments?.[1]).toBe(secondProcedure);
    });

    it('should show procedure CodeLens even when global CodeLens is disabled', async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, defaultValue?: unknown) =>
                key === 'codeLens.enabled' ? false : defaultValue,
            ),
        });
        provider = createProvider(false);
        const sql = `CREATE PROCEDURE PROC_NAME()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`;
        const doc = createMockDocument(sql);
        const lenses = await getLenses(provider, doc);

        expect(lenses.map(lens => lens.command?.command)).toEqual([
            'netezza.compileProcedureFromLens',
        ]);
    });

    it('should not add CodeLens entries for declarations or assignments', async () => {
        const doc = createMockDocument('X INTEGER; X := 10; SELECT 1; DROP TABLE T;');
        const lenses = await getLenses(provider, doc);

        // 7 top-level + SELECT (4 per-statement) + DROP (1 per-statement) = 12
        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + PER_STATEMENT_COUNT + 1);
        expect(lenses.map(lens => lens.command?.title)).toEqual([
            '$(debug-start) Run',
            '$(run-all) Run Batch',
            '$(file-binary) Open as XLSB',
            '$(export) Export',
            '$(markdown) MD',
            '$(cloud-upload) Import',
            '$(info) Explain',
            '$(check) Statements',
            '$(debug-start) Run',
            '$(info) Explain',
            '$(graph) Visualize Query Flow',
            '$(export) Export',
            '$(debug-start) Run'
        ]);
        expect(lenses.every(lens => {
            const sql = lens.command?.arguments?.[1];
            return sql !== 'X INTEGER' && sql !== 'X := 10';
        })).toBe(true);
    });

    it('should expose only Run for non-query executable statements', async () => {
        const doc = createMockDocument('DROP TABLE T;');
        const lenses = await getLenses(provider, doc);

        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + 1);
        expect(lenses[FIRST_PER_STATEMENT].command?.title).toBe('$(debug-start) Run');
    });

    it('should not add View Data CodeLens entries for resolved table references', async () => {
        const doc = createMockDocument('SELECT * FROM USERS;');
        const lenses = await getLenses(provider, doc);

        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + PER_STATEMENT_COUNT);
        expect(lenses.every(lens => lens.command?.command !== 'netezza.action.viewTableData')).toBe(true);
    });

    it('should return CodeLens entries for MSSQL documents', async () => {
        const doc = createMockDocument('SELECT 1;', 'mssql');
        const lenses = await getLenses(provider, doc);

        expect(lenses).toHaveLength(TOP_LEVEL_COUNT + PER_STATEMENT_COUNT);
    });

    it('tokenizes each statement at most once per CodeLens pass', async () => {
        const tokenizeSpy = jest.spyOn(SqlLexer, 'tokenize');
        try {
            const doc = createMockDocument('SELECT 1; SELECT 2;');
            await getLenses(provider, doc);

            const perStatementCalls = (statementSql: string) =>
                tokenizeSpy.mock.calls.filter((call) => call[0] === statementSql).length;

            expect(perStatementCalls('SELECT 1')).toBe(1);
            expect(perStatementCalls('SELECT 2')).toBe(1);
        } finally {
            tokenizeSpy.mockRestore();
        }
    });
});
