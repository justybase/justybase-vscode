import { normalizeDatabaseKind, type DatabaseKind } from '../../../contracts/database';
import type { DatabaseImportWizardAdapter } from './DatabaseImportWizardAdapter';
import { db2ImportWizardAdapter } from './Db2ImportWizardAdapter';
import { duckDbImportWizardAdapter } from './DuckDbImportWizardAdapter';
import { msSqlImportWizardAdapter } from './MsSqlImportWizardAdapter';
import { mySqlImportWizardAdapter } from './MySqlImportWizardAdapter';
import { netezzaImportWizardAdapter } from './NetezzaImportWizardAdapter';
import { oracleImportWizardAdapter } from './OracleImportWizardAdapter';
import { postgreSqlImportWizardAdapter } from './PostgreSqlImportWizardAdapter';
import { snowflakeImportWizardAdapter } from './SnowflakeImportWizardAdapter';
import { sqliteImportWizardAdapter } from './SqliteImportWizardAdapter';
import { verticaImportWizardAdapter } from './VerticaImportWizardAdapter';

const IMPORT_WIZARD_ADAPTERS: Readonly<Record<DatabaseKind, DatabaseImportWizardAdapter>> = {
    netezza: netezzaImportWizardAdapter,
    postgresql: postgreSqlImportWizardAdapter,
    vertica: verticaImportWizardAdapter,
    db2: db2ImportWizardAdapter,
    mssql: msSqlImportWizardAdapter,
    snowflake: snowflakeImportWizardAdapter,
    oracle: oracleImportWizardAdapter,
    mysql: mySqlImportWizardAdapter,
    sqlite: sqliteImportWizardAdapter,
    duckdb: duckDbImportWizardAdapter,
};

export function getImportWizardAdapter(kind?: string | DatabaseKind): DatabaseImportWizardAdapter {
    return IMPORT_WIZARD_ADAPTERS[normalizeDatabaseKind(kind)];
}
