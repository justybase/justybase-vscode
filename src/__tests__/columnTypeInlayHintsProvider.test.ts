import * as vscode from 'vscode';
import { NetezzaColumnTypeInlayHintsProvider } from '../providers/columnTypeInlayHintsProvider';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { parseSemanticScopeWithParser } from '../providers/parsers/parserSqlContext';
import { SqlParser } from '../sql/sqlParser';

jest.mock('../providers/parsers/parserSqlContext', () => ({
    parseSemanticScopeWithParser: jest.fn()
}));

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        splitStatementsWithPositions: jest.fn()
    }
}));

function createDocument(text: string): vscode.TextDocument {
    const lines = text.split('\n');

    const offsetAt = (position: vscode.Position): number => {
        let offset = 0;
        for (let index = 0; index < position.line; index++) {
            offset += lines[index].length + 1;
        }
        return offset + position.character;
    };

    const positionAt = (offset: number): vscode.Position => {
        let remaining = offset;
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const lineLength = lines[lineIndex].length;
            if (remaining <= lineLength) {
                return new vscode.Position(lineIndex, remaining);
            }
            remaining -= lineLength + 1;
        }
        const lastLineIndex = lines.length - 1;
        return new vscode.Position(lastLineIndex, lines[lastLineIndex].length);
    };

    return {
        uri: { toString: () => 'file:///test.sql' } as vscode.Uri,
        getText: jest.fn((range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            const start = offsetAt(range.start);
            const end = offsetAt(range.end);
            return text.substring(start, end);
        }),
        offsetAt: jest.fn((position: vscode.Position) => offsetAt(position)),
        positionAt: jest.fn((offset: number) => positionAt(offset))
    } as unknown as vscode.TextDocument;
}

describe('NetezzaColumnTypeInlayHintsProvider', () => {
    const mockConnectionManager = {
        getConnectionForExecution: jest.fn(),
        getActiveConnectionName: jest.fn(),
        getEffectiveDatabase: jest.fn(),
        getExecutionDatabaseKind: jest.fn()
    } as unknown as ConnectionManager;

    const mockMetadataCache = {
        getColumns: jest.fn(),
        getColumnsAnySchema: jest.fn()
    } as unknown as MetadataCache;

    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
            get: jest.fn((key: string, defaultValue?: unknown) => {
                if (section === 'justybase.sql' && key === 'showInlineTypeHints') {
                    return true;
                }
                return defaultValue;
            })
        }));

        (mockConnectionManager.getConnectionForExecution as jest.Mock).mockReturnValue('CONN1');
        (mockConnectionManager.getActiveConnectionName as jest.Mock).mockReturnValue('CONN1');
        (mockConnectionManager.getEffectiveDatabase as jest.Mock).mockResolvedValue('DB');
        (mockConnectionManager.getExecutionDatabaseKind as jest.Mock).mockReturnValue('postgresql');
    });

    it('provides inline hints for resolved qualified columns', async () => {
        const sql = 'SELECT U.ID, U.NAME FROM DB..USERS U WHERE U.ID > 0';
        const document = createDocument(sql);
        const provider = new NetezzaColumnTypeInlayHintsProvider(mockMetadataCache, mockConnectionManager);

        (SqlParser.splitStatementsWithPositions as jest.Mock).mockReturnValue([
            {
                sql,
                startOffset: 0,
                endOffset: sql.length
            }
        ]);

        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['U', { db: 'DB', table: 'USERS' }]
            ])
        });

        (mockMetadataCache.getColumns as jest.Mock).mockImplementation((_connectionName: string, key: string) => {
            if (key === 'DB..USERS') {
                return [
                    { ATTNAME: 'ID', FORMAT_TYPE: 'INT8' },
                    { ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(100)' }
                ];
            }
            return undefined;
        });

        const range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(sql.length));
        const hints = await provider.provideInlayHints(document, range, { isCancellationRequested: false } as vscode.CancellationToken);

        expect(hints.length).toBe(3);
        const labels = hints.map(hint => hint.label);
        expect(labels).toEqual(expect.arrayContaining([' INT8', ' VARCHAR(100)']));
        expect(parseSemanticScopeWithParser).toHaveBeenCalledWith(sql, undefined, 'postgresql');
    });

    it('returns no hints when inline type hints are disabled', async () => {
        (vscode.workspace.getConfiguration as jest.Mock).mockImplementation((section?: string) => ({
            get: jest.fn((key: string, defaultValue?: unknown) => {
                if (section === 'justybase.sql' && key === 'showInlineTypeHints') {
                    return false;
                }
                return defaultValue;
            })
        }));

        const sql = 'SELECT U.ID FROM DB..USERS U';
        const document = createDocument(sql);
        const provider = new NetezzaColumnTypeInlayHintsProvider(mockMetadataCache, mockConnectionManager);
        const range = new vscode.Range(new vscode.Position(0, 0), document.positionAt(sql.length));

        const hints = await provider.provideInlayHints(document, range, { isCancellationRequested: false } as vscode.CancellationToken);

        expect(hints).toHaveLength(0);
        expect(mockMetadataCache.getColumns).not.toHaveBeenCalled();
    });
});
