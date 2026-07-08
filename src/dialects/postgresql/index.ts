import { createStubDialect } from '../stubDialectFactory';

export const postgresqlDialect = createStubDialect('postgresql', 'PostgreSQL', 5432, {
    connectionFormOptions: {
        userPlaceholder: 'PostgreSQL user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'lower',
        },
        completion: {
            singleDotPathNamespace: 'schema',
            supportsDoubleDotPath: false,
        },
    },
});
