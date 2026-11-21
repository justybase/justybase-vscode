import * as vscode from 'vscode';
import {
    clearRuntimeErrorDiagnostic,
    publishRuntimeErrorDiagnostic,
    resetRuntimeErrorDiagnostics,
} from '../providers/runtimeErrorDiagnostics';

function createDocument(text: string, uri = 'file:///runtime-error.sql'): vscode.TextDocument {
    return {
        uri: vscode.Uri.parse(uri),
        getText: () => text,
        positionAt: (offset: number) => {
            const before = text.slice(0, offset);
            const lines = before.split('\n');
            return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
        },
    } as unknown as vscode.TextDocument;
}

function setOpenDocuments(documents: vscode.TextDocument[]): void {
    (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = documents;
}

function lastCollection(): vscode.DiagnosticCollection {
    const results = (vscode.languages.createDiagnosticCollection as jest.Mock).mock.results;
    return results[results.length - 1]?.value as vscode.DiagnosticCollection;
}

describe('runtime PostgreSQL error diagnostics', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resetRuntimeErrorDiagnostics();
        setOpenDocuments([]);
    });

    afterAll(() => {
        resetRuntimeErrorDiagnostics();
        setOpenDocuments([]);
    });

    it('publishes a diagnostic at the reported one-based position', () => {
        const sql = 'SELECT *\nFROM itmes';
        const document = createDocument(sql);
        setOpenDocuments([document]);

        publishRuntimeErrorDiagnostic(
            document.uri.toString(),
            sql,
            'relation "itmes" does not exist',
            { code: '42P01', severity: 'ERROR', position: 15, hint: 'Check the table name.' },
            'postgresql',
        );

        const diagnostics = lastCollection().get(document.uri);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics?.[0]?.message).toContain('relation "itmes" does not exist');
        expect(diagnostics?.[0]?.message).toContain('HINT: Check the table name.');
        expect(diagnostics?.[0]?.source).toBe('PostgreSQL');
        expect(diagnostics?.[0]?.code).toBe('42P01');
        expect(diagnostics?.[0]?.range.start.line).toBe(1);
        expect(diagnostics?.[0]?.range.start.character).toBe(5);
    });

    it('skips errors without a position or from another dialect', () => {
        const sql = 'SELECT * FROM items';
        const document = createDocument(sql);
        setOpenDocuments([document]);

        publishRuntimeErrorDiagnostic(document.uri.toString(), sql, 'boom', { code: 'P0001' }, 'postgresql');
        publishRuntimeErrorDiagnostic(document.uri.toString(), sql, 'boom', { code: '42601', position: 1 }, 'netezza');
        publishRuntimeErrorDiagnostic(document.uri.toString(), sql, 'boom', { code: '42601', position: 500 }, 'postgresql');

        expect(vscode.languages.createDiagnosticCollection).not.toHaveBeenCalled();
    });

    it('skips an ambiguous duplicate statement instead of guessing', () => {
        const sql = 'SELECT 1';
        const document = createDocument(`${sql};\n${sql};`);
        setOpenDocuments([document]);

        publishRuntimeErrorDiagnostic(document.uri.toString(), sql, 'boom', { code: '42601', position: 8 }, 'postgresql');

        expect(vscode.languages.createDiagnosticCollection).not.toHaveBeenCalled();

        publishRuntimeErrorDiagnostic(
            document.uri.toString(),
            sql,
            'boom',
            { code: '42601', position: 8 },
            'postgresql',
            1,
        );

        const diagnostics = lastCollection().get(document.uri);
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics?.[0]?.range.start.line).toBe(1);
    });

    it('clears the diagnostic for a document', () => {
        const sql = 'SELECT *';
        const document = createDocument(sql);
        setOpenDocuments([document]);
        publishRuntimeErrorDiagnostic(document.uri.toString(), sql, 'boom', { code: '42601', position: 8 }, 'postgresql');
        expect(lastCollection().get(document.uri)).toHaveLength(1);

        clearRuntimeErrorDiagnostic(document.uri.toString());

        expect(lastCollection().get(document.uri)).toBeUndefined();
    });
});
