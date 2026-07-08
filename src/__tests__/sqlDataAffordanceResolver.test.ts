jest.unmock('chevrotain');

import * as vscode from 'vscode';
import { SqlDataAffordanceResolver } from '../providers/sqlDataAffordanceResolver';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import { DocumentParseSession } from '../sqlParser/documentParseSession';
import * as parsingRuntime from '../sqlParser/parsingRuntime';

function createDocument(text: string, languageId = 'sql', uri = 'file:///resolver.sql'): vscode.TextDocument {
    const lines = text.split('\n');

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
        languageId,
        version: 1,
        uri: { toString: () => uri } as vscode.Uri,
        getText: jest.fn(() => text),
        positionAt: jest.fn((offset: number) => positionAt(offset)),
        offsetAt: jest.fn((position: vscode.Position) => {
            let offset = 0;
            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                if (lineIndex < position.line) {
                    offset += lines[lineIndex].length + 1;
                    continue;
                }
                if (lineIndex === position.line) {
                    return offset + position.character;
                }
            }
            return offset;
        }),
    } as unknown as vscode.TextDocument;
}

describe('SqlDataAffordanceResolver', () => {
    const mockConnectionManager = {
        getConnectionForExecution: jest.fn().mockReturnValue('CONN1'),
        getActiveConnectionName: jest.fn().mockReturnValue('CONN1'),
        getEffectiveDatabase: jest.fn().mockResolvedValue('DB1')
    } as unknown as ConnectionManager;

    const objectRows = {
        DB1: [
            { schema: 'ADMIN', item: { OBJNAME: 'USERS', objType: 'TABLE', kind: 6 }, description: 'Users table' },
            { schema: 'SALES', item: { OBJNAME: 'CUSTOMERS', objType: 'TABLE', kind: 6 }, description: 'Customers table' }
        ],
        APPDB: [
            { schema: 'PUBLIC', item: { OBJNAME: 'ORDERS', objType: 'VIEW', kind: 18 }, description: 'Orders view' }
        ]
    };

    const mockMetadataCache = {
        getObjectsWithSchema: jest.fn((connectionName: string, dbName: string) => {
            if (connectionName !== 'CONN1') {
                return [];
            }
            return objectRows[dbName as keyof typeof objectRows] || [];
        }),
        getColumns: jest.fn((_connectionName: string, key: string) => {
            if (key.endsWith('.USERS')) {
                return [
                    { ATTNAME: 'ID', FORMAT_TYPE: 'INT', label: 'ID', detail: 'INT', kind: 5 },
                    { ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(50)', label: 'NAME', detail: 'VARCHAR(50)', kind: 5 }
                ];
            }
            if (key.endsWith('.CUSTOMERS')) {
                return [{ ATTNAME: 'CUSTOMER_ID', FORMAT_TYPE: 'INT', label: 'CUSTOMER_ID', detail: 'INT', kind: 5 }];
            }
            if (key.endsWith('.ORDERS')) {
                return [{ ATTNAME: 'ORDER_ID', FORMAT_TYPE: 'INT', label: 'ORDER_ID', detail: 'INT', kind: 5 }];
            }
            return undefined;
        }),
        getColumnsAnySchema: jest.fn()
    } as unknown as MetadataCache;

    beforeEach(() => {
        jest.clearAllMocks();
        (mockConnectionManager.getConnectionForExecution as jest.Mock).mockReturnValue('CONN1');
        (mockConnectionManager.getActiveConnectionName as jest.Mock).mockReturnValue('CONN1');
        (mockConnectionManager.getEffectiveDatabase as jest.Mock).mockResolvedValue('DB1');
    });

    it('resolves all supported Netezza object notation variants', async () => {
        const resolver = new SqlDataAffordanceResolver(mockMetadataCache, mockConnectionManager);

        const fullyQualified = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM DB1.ADMIN.USERS;', 'sql', 'file:///resolver-1.sql')
        );
        const databaseImpliedSchema = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM APPDB..ORDERS;', 'sql', 'file:///resolver-2.sql')
        );
        const schemaQualified = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM SALES.CUSTOMERS;', 'sql', 'file:///resolver-3.sql')
        );
        const unqualified = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM USERS;', 'sql', 'file:///resolver-4.sql')
        );
        const quoted = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM "DB1"."ADMIN"."USERS";', 'sql', 'file:///resolver-5.sql')
        );

        expect(fullyQualified[0].commandArgs).toEqual({
            documentUri: 'file:///resolver-1.sql',
            databaseName: 'DB1',
            schemaName: 'ADMIN',
            tableName: 'USERS'
        });
        expect(databaseImpliedSchema[0].commandArgs).toEqual({
            documentUri: 'file:///resolver-2.sql',
            databaseName: 'APPDB',
            schemaName: 'PUBLIC',
            tableName: 'ORDERS'
        });
        expect(schemaQualified[0].commandArgs).toEqual({
            documentUri: 'file:///resolver-3.sql',
            databaseName: 'DB1',
            schemaName: 'SALES',
            tableName: 'CUSTOMERS'
        });
        expect(unqualified[0].commandArgs).toEqual({
            documentUri: 'file:///resolver-4.sql',
            databaseName: 'DB1',
            schemaName: 'ADMIN',
            tableName: 'USERS'
        });
        expect(quoted[0].commandArgs).toEqual({
            documentUri: 'file:///resolver-5.sql',
            databaseName: 'DB1',
            schemaName: 'ADMIN',
            tableName: 'USERS'
        });
    });

    it('ignores comment, string, and CTE false positives', async () => {
        const resolver = new SqlDataAffordanceResolver(mockMetadataCache, mockConnectionManager);

        const sql = `
-- USERS should not resolve here
SELECT 'USERS' AS literal_value FROM DB1.ADMIN.USERS;
WITH USERS AS (SELECT 1 AS ID)
SELECT * FROM USERS;
`;

        const references = await resolver.getResolvedReferences(createDocument(sql));

        expect(references).toHaveLength(1);
        expect(references[0].resolvedPath).toBe('DB1.ADMIN.USERS');
    });

    it('keeps nested CTE names shadowing unqualified object references', async () => {
        const resolver = new SqlDataAffordanceResolver(mockMetadataCache, mockConnectionManager);

        const sql = `WITH USERS AS (
    SELECT 1 AS ID
)
SELECT * FROM USERS;`;

        const references = await resolver.getResolvedReferences(createDocument(sql, 'sql', 'file:///resolver-cte-shadow.sql'));

        expect(references).toEqual([]);
    });

    it('supports MSSQL documents for data affordance resolution', async () => {
        const resolver = new SqlDataAffordanceResolver(mockMetadataCache, mockConnectionManager);

        const references = await resolver.getResolvedReferences(
            createDocument('SELECT * FROM DB1.ADMIN.USERS;', 'mssql', 'file:///resolver-mssql.sql')
        );

        expect(references).toHaveLength(1);
        expect(references[0].resolvedPath).toBe('DB1.ADMIN.USERS');
    });

    it('getReferenceAtPosition resolves only the hovered reference', async () => {
        const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
        const session = new DocumentParseSession();
        const resolver = new SqlDataAffordanceResolver(
            mockMetadataCache,
            mockConnectionManager,
            session,
        );
        const sql = [
            'SELECT * FROM DB1.ADMIN.USERS;',
            'SELECT * FROM SALES.CUSTOMERS;',
        ].join('\n');
        const document = createDocument(sql, 'sql', 'file:///resolver-hover-one.sql');
        const customersOffset = sql.indexOf('CUSTOMERS');

        try {
            const reference = await resolver.getReferenceAtPosition(
                document,
                document.positionAt(customersOffset),
            );
            expect(reference?.tableName).toBe('CUSTOMERS');
            expect(parseSpy.mock.calls.length).toBeGreaterThan(0);

            parseSpy.mockClear();
            await resolver.getReferenceAtPosition(
                document,
                document.positionAt(customersOffset),
            );
            expect(parseSpy).not.toHaveBeenCalled();
        } finally {
            parseSpy.mockRestore();
        }
    });

    it('skips affordance resolution for very large documents on hover', async () => {
        const resolver = new SqlDataAffordanceResolver(mockMetadataCache, mockConnectionManager);
        const sql = `SELECT * FROM DB1.ADMIN.USERS;${' '.repeat(150_001)}`;
        const document = createDocument(sql, 'sql', 'file:///resolver-large.sql');

        const reference = await resolver.getReferenceAtPosition(
            document,
            document.positionAt(sql.indexOf('USERS')),
        );

        expect(reference).toBeUndefined();
    });
});
