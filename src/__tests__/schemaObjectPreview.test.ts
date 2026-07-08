import { MetadataCache } from '../metadataCache';
import { buildSchemaObjectPreview } from '../services/schemaObjectPreview';

describe('schemaObjectPreview', () => {
    it('includes PK and distribution columns in table preview', () => {
        const cache = new MetadataCache({} as unknown as import('vscode').ExtensionContext);
        cache.setColumns('conn1', 'MYDB.ADMIN.DIM_ACCOUNT', [
            {
                ATTNAME: 'ACCOUNTKEY',
                label: 'ACCOUNTKEY',
                FORMAT_TYPE: 'BIGINT',
                isPk: true,
                isDistributionKey: true,
            },
            {
                ATTNAME: 'NAME',
                label: 'NAME',
                FORMAT_TYPE: 'VARCHAR(100)',
            },
        ]);

        const preview = buildSchemaObjectPreview(
            cache,
            {
                NAME: 'DIM_ACCOUNT',
                SCHEMA: 'ADMIN',
                DATABASE: 'MYDB',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME',
            },
            { connectionName: 'conn1', databaseKind: 'netezza' },
        );

        expect(preview).toContain('Primary key: ACCOUNTKEY');
        expect(preview).toContain('Distribution: ACCOUNTKEY');
        expect(preview).toContain('ACCOUNTKEY (BIGINT)');
    });

    it('returns undefined when columns are not loaded and there is no object description', () => {
        const cache = new MetadataCache({} as unknown as import('vscode').ExtensionContext);

        const preview = buildSchemaObjectPreview(
            cache,
            {
                NAME: 'NEW_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'MYDB',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: '',
                MATCH_TYPE: 'NAME',
            },
            { connectionName: 'conn1', databaseKind: 'netezza' },
        );

        expect(preview).toBeUndefined();
    });

    it('returns description-only preview when columns are not loaded', () => {
        const cache = new MetadataCache({} as unknown as import('vscode').ExtensionContext);

        const preview = buildSchemaObjectPreview(
            cache,
            {
                NAME: 'NEW_TABLE',
                SCHEMA: 'ADMIN',
                DATABASE: 'MYDB',
                TYPE: 'TABLE',
                PARENT: '',
                DESCRIPTION: 'Billing dimension',
                MATCH_TYPE: 'OBJ_DESC',
            },
            { connectionName: 'conn1', databaseKind: 'netezza' },
        );

        expect(preview).toContain('Billing dimension');
        expect(preview).not.toContain('not loaded in cache');
    });
});
