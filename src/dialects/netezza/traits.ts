import { createDatabaseDialectTraits } from '../../contracts/database';
import { NETEZZA_UNQUOTED_IDENTIFIER_PATTERN } from './identifierPattern';

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
