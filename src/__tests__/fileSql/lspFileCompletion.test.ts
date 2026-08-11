/**
 * Regression: File SQL autocomplete in the LSP server process.
 * The server builds the completion request context via getDatabaseSqlAuthoring
 * ('file' must resolve — previously threw "No SQL authoring registered").
 * Reproduces the server flow: engine + DocumentParseSession + real Chevrotain.
 */

jest.unmock('chevrotain');

import {
    LspCompletionEngine,
} from '../../server/completionEngine';
import { DocumentParseSession } from '../../sqlParser/documentParseSession';
import { CompletionTriggerKind } from 'vscode-languageserver/node';
import { getDatabaseSqlAuthoring } from '../../core/sqlAuthoringRegistry';
import type { CompletionItem, Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

function labels(items: CompletionItem[]): string[] {
    return items.map(item => typeof item.label === 'string' ? item.label : String((item.label as { label?: unknown }).label ?? ''));
}

function createDoc(sqlWithCursor: string): { document: TextDocument; position: Position } {
    const cursorIndex = sqlWithCursor.indexOf('|');
    const text = sqlWithCursor.slice(0, cursorIndex) + sqlWithCursor.slice(cursorIndex + 1);
    const line = text.slice(0, cursorIndex).split('\n').length - 1;
    const character = cursorIndex - text.slice(0, cursorIndex).lastIndexOf('\n') - 1;
    return {
        document: {
            uri: { toString: () => 'file:///diag.sql' } as never,
            languageId: 'sql',
            version: 1,
            getText: () => text,
            positionAt: () => ({ line, character }) as never,
            offsetAt: () => cursorIndex,
            lineCount: text.split('\n').length,
            lineAt: () => ({ text: text.split('\n')[line] ?? '' }) as never,
        } as unknown as TextDocument,
        position: { line, character } as Position,
    };
}

class MockProvider {
    public effectiveDatabase: string | undefined = 'memory';
    public effectiveSchema: string | undefined = undefined;
    public netezzaSchemasEnabled: boolean | undefined = undefined;
    public databaseKind = 'file' as const;
    private columns = new Map<string, string[]>();
    public getColumns: jest.Mock;

    constructor() {
        this.getColumns = jest.fn(async (_uri: string, database: string, table: string, _schema?: string): Promise<unknown[]> => {
            const cols = this.columns.get(`${database}|${table}`) ?? [];
            return cols.map(name => ({ name, type: 'VARCHAR' }));
        });
    }

    public setColumns(database: string, table: string, columns: string[]): void {
        this.columns.set(`${database}|${table}`, columns);
    }

    public getTables = jest.fn(async () => []);
    public getViews = jest.fn(async () => []);
    public getDatabases = jest.fn(async () => [{ label: 'memory', DATABASE: 'memory' }]);
    public getSchemas = jest.fn(async () => []);
    public getProcedures = jest.fn(async () => []);
    public getNetezzaDefaultSchema = undefined;
    public getContext = jest.fn(async () => ({
        connectionName: 'file-test',
        effectiveDatabase: this.effectiveDatabase,
        effectiveSchema: this.effectiveSchema,
        databaseKind: this.databaseKind,
        netezzaSchemasEnabled: undefined,
    }));
}

describe('file dialect LSP completion (server flow)', () => {
    it('resolves SQL authoring for the file kind (regression: threw in LSP server)', () => {
        expect(getDatabaseSqlAuthoring('file')).toBeDefined();
        expect(() => getDatabaseSqlAuthoring('file')).not.toThrow();
    });

    it('resolves alias columns with DocumentParseSession like the LSP server', async () => {
        const provider = new MockProvider();
        provider.setColumns('memory', 'data1', ['DATEKEY', 'AMOUNT']);
        const engine = new LspCompletionEngine(provider as never, new DocumentParseSession());

        const { document, position } = createDoc('SELECT * FROM "data1" d WHERE d.|');
        const items = await engine.provideCompletionItems(document, position, CompletionTriggerKind.TriggerCharacter);

        expect(provider.getColumns).toHaveBeenCalledWith(
            expect.anything(),
            'memory',
            'data1',
            'main',
        );
        expect(labels(items)).toEqual(expect.arrayContaining(['DATEKEY', 'AMOUNT']));
    });

    it('resolves alias columns for a full File SQL workspace path and a shorthand view', async () => {
        const provider = new MockProvider();
        const fullPath = '/home/dusko/source/sql_samples/data1.xlsx';
        provider.setColumns('memory', fullPath, ['DATEKEY', 'AMOUNT']);
        provider.setColumns('memory', 'data1', ['DATEKEY', 'AMOUNT']);
        const fullPathEngine = new LspCompletionEngine(provider as never, new DocumentParseSession());
        const shorthandEngine = new LspCompletionEngine(provider as never, new DocumentParseSession());
        const fullPathRequest = createDoc(`SELECT * FROM "${fullPath}" x WHERE x.|`);

        const fullPathResult = await fullPathEngine.provideCompletionItems(
            fullPathRequest.document,
            fullPathRequest.position,
            CompletionTriggerKind.TriggerCharacter,
        );
        const shorthand = createDoc('SELECT * FROM data1 x WHERE x.|');
        const shorthandResult = await shorthandEngine.provideCompletionItems(
            shorthand.document,
            shorthand.position,
            CompletionTriggerKind.TriggerCharacter,
        );

        expect(labels(fullPathResult)).toEqual(expect.arrayContaining(['DATEKEY', 'AMOUNT']));
        expect(labels(shorthandResult)).toEqual(expect.arrayContaining(['DATEKEY', 'AMOUNT']));
        expect(provider.getColumns).toHaveBeenCalledWith(
            expect.anything(),
            'memory',
            fullPath,
            'main',
        );
    });

    it('filters columns by prefix for a full File SQL workspace path', async () => {
        const provider = new MockProvider();
        const fullPath = '/home/dusko/source/sql_samples/data1.xlsx';
        provider.setColumns('memory', fullPath, ['DATEKEY', 'AMOUNT']);
        const engine = new LspCompletionEngine(provider as never, new DocumentParseSession());
        const request = createDoc(`SELECT * FROM "${fullPath}" x WHERE x.DAT|`);

        const items = await engine.provideCompletionItems(
            request.document,
            request.position,
            CompletionTriggerKind.TriggerCharacter,
        );

        expect(labels(items)).toEqual(['DATEKEY']);
    });
});
