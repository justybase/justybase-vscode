import { createDatabaseDialectTraits } from '../../contracts/database';

export const sqliteDialectTraits = createDatabaseDialectTraits({
    identifiers: {
        unquotedIdentifierPattern: /^[A-Za-z_][A-Za-z0-9_]*$/
    },
    qualification: {
        twoPartNameStyle: 'database-object',
        twoPartContainerPreference: 'schema-over-database',
        supportsThreePartName: false,
        databaseOnlyReferenceStyle: 'single-dot'
    },
    completion: {
        singleDotPathNamespace: 'database'
    }
});
