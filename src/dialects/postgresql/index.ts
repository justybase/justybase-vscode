import { createStubDialect } from '../stubDialectFactory';

export const postgresqlDialect = createStubDialect('postgresql', 'PostgreSQL', 5432, {
    connectionFormOptions: {
        userPlaceholder: 'PostgreSQL user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'lower',
        },
        qualification: {
            supportsThreePartName: false,
            threePartNamePrefix: 'none',
            twoPartContainerPreference: 'schema-over-database',
            databaseOnlyReferenceStyle: 'omit',
        },
        completion: {
            singleDotPathNamespace: 'schema',
            supportsDoubleDotPath: false,
        },
    },
});
