import { createDatabaseDialectTraits } from '../../contracts/database';

/** Identifier and qualification rules for the ClickHouse HTTP SQL dialect. */
export const clickhouseDialectTraits = createDatabaseDialectTraits({
    identifiers: {
        quoteStyle: 'backtick',
        unquotedIdentifierPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
        generatedNameCase: 'preserve',
    },
    qualification: {
        twoPartNameStyle: 'database-object',
        twoPartContainerPreference: 'database-over-schema',
        supportsThreePartName: false,
        threePartNamePrefix: 'none',
        databaseOnlyReferenceStyle: 'single-dot',
    },
    completion: {
        singleDotPathNamespace: 'database',
        supportsDoubleDotPath: false,
    },
    objects: {
        supportsIndexes: false,
    },
});
