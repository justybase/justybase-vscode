import { createStubDialect } from '../stubDialectFactory';

export const oracleDialect = createStubDialect('oracle', 'Oracle', 1521, {
    connectionFormOptions: {
        databasePlaceholder: 'SID or service name',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'upper',
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
