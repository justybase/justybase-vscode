import { createDatabaseDialectTraits } from '@justybase/contracts';

export const duckdbDialectTraits = createDatabaseDialectTraits({
    identifiers: {
        unquotedIdentifierPattern: /^[A-Za-z_][A-Za-z0-9_$]*$/,
        generatedNameCase: 'lower'
    },
    qualification: {
        databaseOnlyReferenceStyle: 'omit'
    },
    completion: {
        singleDotPathNamespace: 'schema'
    }
});
