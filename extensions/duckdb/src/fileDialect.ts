/**
 * 'file' dialect: query Excel/CSV/Parquet/Avro files with SQL through an
 * in-memory DuckDB. Reuses the DuckDB traits, metadata provider and SQL
 * authoring so files behave like tables in the schema explorer.
 */

import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseConnectionStaticConstructor,
    DatabaseDialect
} from '@justybase/contracts';
import { createDatabaseCapabilities } from '@justybase/contracts';
import { duckdbDialectTraits } from '../../../src/dialects/duckdb/traits';
import { FileDuckDbConnection } from './fileConnection';
import { duckdbMetadataProvider } from './duckdbSchemaProvider';
import { fileSqlAuthoring } from '../../../src/dialects/file/sql/authoring';

const fileConnectionConstructor = FileDuckDbConnection as unknown as DatabaseConnectionStaticConstructor;

export const fileDialect: DatabaseDialect = {
    kind: 'file',
    displayName: 'Excel / CSV / Parquet / Avro (DuckDB)',
    capabilities: createDatabaseCapabilities({}),
    connectionForm: {
        fields: [
            {
                key: 'filePath',
                label: 'Data File',
                type: 'file',
                storage: 'topLevel',
                required: true,
                placeholder: 'Select an .xlsx, .csv, .parquet or .avro file',
                description: 'Data file queried with SQL through an in-memory DuckDB. Excel sheets appear as tables.',
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
    traits: duckdbDialectTraits,
    metadataProvider: duckdbMetadataProvider,
    sqlAuthoring: fileSqlAuthoring,
    getConnectionConstructor(): DatabaseConnectionStaticConstructor {
        return fileConnectionConstructor;
    },
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection {
        return new FileDuckDbConnection(config);
    }
};
