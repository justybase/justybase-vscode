import { createStubDialect } from '../stubDialectFactory';

export const duckdbDialect = createStubDialect('duckdb', 'DuckDB', undefined, {
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'preserve',
        },
    },
});
