import { createStubDialect } from '../stubDialectFactory';

export const duckdbDialect = createStubDialect('duckdb', 'DuckDB', undefined, {
    connectionFormFields: [
        {
            key: 'mode',
            label: 'Mode',
            type: 'select',
            storage: 'options',
            defaultValue: 'file',
            options: [
                { value: 'file', label: 'File path' },
                { value: 'memory', label: 'In-memory (:memory:)' },
            ],
            description: 'Choose a DuckDB file or an in-memory database.',
            layout: 'full',
        },
        {
            key: 'database',
            label: 'Database File',
            type: 'file',
            storage: 'topLevel',
            required: true,
            placeholder: 'Select or enter a DuckDB database file path',
            description: 'Select an existing database file or enter a path for a new file.',
            layout: 'full',
        },
        {
            key: 'schema',
            label: 'Schema',
            type: 'text',
            storage: 'options',
            placeholder: 'Optional default schema (for example main)',
            description: 'Optional schema selected after connecting. Defaults to DuckDB\'s main schema.',
            layout: 'half',
        },
    ],
    traitsOverrides: {
        identifiers: {
            generatedNameCase: 'preserve',
        },
    },
});
