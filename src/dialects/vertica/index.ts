import { createStubDialect } from '../stubDialectFactory';

export const verticaDialect = createStubDialect('vertica', 'Vertica', 5433, {
    connectionFormOptions: {
        userPlaceholder: 'Vertica user',
    },
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'lower',
        },
    },
});
