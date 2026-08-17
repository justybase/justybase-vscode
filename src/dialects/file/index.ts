import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect,
} from '../../contracts/database';
import { createDatabaseCapabilities, createDatabaseDialectTraits } from '../../contracts/database';

const INSTALL_HINT =
    'Install the optional "JustyBase SQL Editor (DuckDB + Files)" extension to use Excel / CSV / Parquet / Avro (DuckDB) connections.';

/**
 * Stub for the 'file' dialect (Excel/CSV/Parquet/Avro via DuckDB).
 * Registered so the login panel shows the option with a file picker and an
 * install hint; the real dialect is registered by the DuckDB companion
 * extension.
 */
export const fileDialectStub: DatabaseDialect = {
    kind: 'file',
    displayName: 'Excel (XLSX/XLSB) / CSV / Parquet / Avro (DuckDB)',
    capabilities: createDatabaseCapabilities(),
    connectionForm: {
        fields: [
            {
                key: 'filePath',
                label: 'Data File',
                type: 'file',
                storage: 'topLevel',
                required: true,
                placeholder: 'Select an .xlsx, .xlsb, .csv, .parquet or .avro file',
                description:
                    'Data file queried with SQL through an in-memory DuckDB. Excel sheets appear as tables.',
                layout: 'full'
            },
            {
                key: 'editable',
                label: 'Editable copy',
                type: 'checkbox',
                storage: 'options',
                defaultValue: false,
                description:
                    'Materialize an editable table (<file>_edit) supporting INSERT/UPDATE/DELETE. Use "JustyBase: Save File Edits" to write changes back.',
                layout: 'full'
            }
        ]
    },
    traits: createDatabaseDialectTraits({
        identifiers: {
            generatedNameCase: 'preserve',
        },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadataProvider: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sqlAuthoring: { dialects: { file: {} } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    advancedFeatures: {} as any,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        throw new Error(INSTALL_HINT);
    },
    createConnection(_config: DatabaseConnectionConfig): DatabaseConnection {
        throw new Error(INSTALL_HINT);
    },
};
