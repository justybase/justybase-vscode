import { createDatabaseDialectTraits } from '@justybase/contracts';
import { NETEZZA_UNQUOTED_IDENTIFIER_PATTERN } from '@justybase/sql-core/netezza/identifierPattern';

export const netezzaDialectTraits = createDatabaseDialectTraits({
    identifiers: {
        unquotedIdentifierPattern: NETEZZA_UNQUOTED_IDENTIFIER_PATTERN,
        generatedNameCase: 'upper',
    },
    completion: {
        singleDotPathNamespace: 'schema',
        supportsDoubleDotPath: true,
    },
});
