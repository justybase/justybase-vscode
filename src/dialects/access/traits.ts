import { createDatabaseDialectTraits } from '../../contracts/database';

export const accessDialectTraits = createDatabaseDialectTraits({
    identifiers: {
        unquotedIdentifierPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
        generatedNameCase: 'preserve'
    },
    qualification: {
        twoPartNameStyle: 'database-object',
        twoPartContainerPreference: 'schema-over-database',
        supportsThreePartName: false,
        databaseOnlyReferenceStyle: 'single-dot'
    },
    completion: {
        singleDotPathNamespace: 'database'
    },
    objects: {
        supportsIndexes: false
    }
});
