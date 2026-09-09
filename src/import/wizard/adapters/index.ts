import { DEFAULT_DATABASE_KIND, tryNormalizeDatabaseKind, type DatabaseKind } from '../../../contracts/database';
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
import { accessImportWizardAdapter } from './AccessImportWizardAdapter';
import { clickHouseImportWizardAdapter } from './ClickHouseImportWizardAdapter';

const IMPORT_WIZARD_ADAPTERS: Readonly<Record<DatabaseKind, DatabaseImportWizardAdapter>> = {
    netezza: netezzaImportWizardAdapter,
    postgresql: postgreSqlImportWizardAdapter,
    vertica: verticaImportWizardAdapter,
    db2: db2ImportWizardAdapter,
    mssql: msSqlImportWizardAdapter,
    snowflake: snowflakeImportWizardAdapter,
    oracle: oracleImportWizardAdapter,
    mysql: mySqlImportWizardAdapter,
    clickhouse: clickHouseImportWizardAdapter,
    sqlite: sqliteImportWizardAdapter,
    duckdb: duckDbImportWizardAdapter,
    access: accessImportWizardAdapter,
};

export function getImportWizardAdapter(kind?: string | DatabaseKind): DatabaseImportWizardAdapter {
    const normalizedKind = kind === undefined || kind.trim().length === 0
        ? DEFAULT_DATABASE_KIND
        : tryNormalizeDatabaseKind(kind);
    if (!normalizedKind) {
        throw new Error(`Unsupported database kind '${kind}'.`);
    }
    return IMPORT_WIZARD_ADAPTERS[normalizedKind];
}
