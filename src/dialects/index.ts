import { registerDatabaseDialect } from '../core/factories/databaseDialectRegistry';
import { netezzaDialect } from './netezza';
import { sqliteDialect } from './sqlite';
import { oracleDialect } from './oracle';
import { postgresqlDialect } from './postgresql';
import { verticaDialect } from './vertica';
import { snowflakeDialect } from './snowflake';
import { db2Dialect } from './db2';
import { mssqlDialect } from './mssql';
import { mysqlDialect } from './mysql';
import { duckdbDialect } from './duckdb';

let builtInDialectsRegistered = false;

// Export all dialects for use by the login panel
export const allAvailableDialects = [
    netezzaDialect,
    sqliteDialect,
    oracleDialect,
    postgresqlDialect,
    verticaDialect,
    snowflakeDialect,
    db2Dialect,
    mssqlDialect,
    mysqlDialect,
    duckdbDialect
];

export function ensureBuiltInDialectsRegistered(): void {
    if (builtInDialectsRegistered) {
        return;
    }

    registerDatabaseDialect(netezzaDialect);
    registerDatabaseDialect(sqliteDialect);
    builtInDialectsRegistered = true;
}

export function __TEST_ONLY_resetBuiltInDialectsRegistration(): void {
    builtInDialectsRegistered = false;
}
