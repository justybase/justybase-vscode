import { createStubDialect } from '../stubDialectFactory';

export const mysqlDialect = createStubDialect('mysql', 'MySQL', 3306, {
    connectionFormOptions: {
        databasePlaceholder: 'Database name',
        userPlaceholder: 'MySQL user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'lower',
            quoteStyle: 'backtick',
            unquotedIdentifierPattern: /^[a-z_][a-z0-9_]*$/i,
        },
        qualification: {
            twoPartNameStyle: 'schema-object',
            supportsThreePartName: false,
        },
    },
});
