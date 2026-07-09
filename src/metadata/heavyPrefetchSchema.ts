/**
 * Heavy multi-database schema for metadata prefetch E2E / stress on live Netezza.
 *
 * Targets hundreds of tables, tens of thousands of columns, with ~20% enriched
 * (PK, FK, COMMENT ON, DISTRIBUTE ON).
 */

export interface HeavySchemaConfig {
    dbPrefix: string;
    dbCount: number;
    tablesPerDb: number;
    columnsPerTable: number;
    enrichedRatio: number;
    synonymsPerDb: number;
    proceduresPerDb: number;
    schema: string;
}

export interface HeavySchemaStats {
    databases: string[];
    dimensionTables: number;
    factTables: number;
    totalTables: number;
    estimatedColumns: number;
    synonyms: number;
    procedures: number;
    enrichedTables: number;
    ddlStatements: number;
    durationMs: number;
}

export interface HeavySchemaProgress {
    phase: string;
    database: string;
    completed: number;
    total: number;
}

const COLUMN_TYPES = [
    'INTEGER',
    'BIGINT',
    'VARCHAR(64)',
    'VARCHAR(256)',
    'TIMESTAMP',
    'NUMERIC(12,2)',
    'CHAR(8)',
    'BOOLEAN',
] as const;

export function getHeavySchemaConfigFromEnv(): HeavySchemaConfig {
    return {
        dbPrefix: (process.env.NZ_E2E_DB_PREFIX || 'NZ_PREFETCH_E2E').toUpperCase(),
        dbCount: Number(process.env.NZ_E2E_DB_COUNT || '5'),
        tablesPerDb: Number(process.env.NZ_E2E_TABLES_PER_DB || '100'),
        columnsPerTable: Number(process.env.NZ_E2E_COLUMNS_PER_TABLE || '30'),
        enrichedRatio: Number(process.env.NZ_E2E_ENRICHED_RATIO || '0.2'),
        synonymsPerDb: Number(process.env.NZ_E2E_SYNONYMS_PER_DB || '50'),
        proceduresPerDb: Number(process.env.NZ_E2E_PROCEDURES_PER_DB || '25'),
        schema: (process.env.NZ_E2E_SCHEMA || 'ADMIN').toUpperCase(),
    };
}

export function resolveHeavySchemaDatabaseNames(config: HeavySchemaConfig): string[] {
    if (config.dbCount <= 1) {
        return [config.dbPrefix];
    }
    const pad = String(config.dbCount).length;
    return Array.from({ length: config.dbCount }, (_, index) => {
        const suffix = String(index + 1).padStart(Math.max(pad, 2), '0');
        return `${config.dbPrefix}_${suffix}`;
    });
}

export function countDimensionTables(config: HeavySchemaConfig): number {
    return Math.max(5, Math.floor(config.tablesPerDb * 0.1));
}

export function countFactTables(config: HeavySchemaConfig): number {
    return Math.max(0, config.tablesPerDb - countDimensionTables(config));
}

function isEnrichedTable(config: HeavySchemaConfig, tableOrdinal: number): boolean {
    const step = Math.max(1, Math.round(1 / config.enrichedRatio));
    return tableOrdinal % step === 0;
}

function dimTableName(index: number): string {
    return `DIM_REF_${String(index).padStart(3, '0')}`;
}

export function factTableName(index: number): string {
    return `FACT_${String(index).padStart(4, '0')}`;
}

function synonymName(factIndex: number): string {
    return `SYN_${factTableName(factIndex)}`;
}

function procedureName(index: number): string {
    return `P_FACT_${String(index).padStart(4, '0')}`;
}

function buildColumnDefinitions(
    config: HeavySchemaConfig,
    includeRefDim: boolean,
): string[] {
    const lines: string[] = [];
    if (includeRefDim) {
        lines.push('ROW_ID INTEGER NOT NULL');
        lines.push('REF_DIM_ID INTEGER');
    } else {
        lines.push('DIM_ID INTEGER NOT NULL');
        lines.push('DIM_LABEL VARCHAR(128)');
    }

    const dataColumns = Math.max(0, config.columnsPerTable - lines.length);
    for (let col = 0; col < dataColumns; col++) {
        const type = COLUMN_TYPES[col % COLUMN_TYPES.length];
        const name = `COL_${String(col + 1).padStart(3, '0')}`;
        lines.push(`${name} ${type}`);
    }
    return lines;
}

export function buildHeavySchemaDdl(
    config: HeavySchemaConfig,
    database: string,
): string[] {
    const ddl: string[] = [];
    const dimCount = countDimensionTables(config);
    const factCount = countFactTables(config);
    const distributeCol = 'DIM_ID';

    for (let dim = 1; dim <= dimCount; dim++) {
        const table = dimTableName(dim);
        const columns = buildColumnDefinitions(config, false).join(',\n    ');
        ddl.push(
            `CREATE TABLE ${config.schema}.${table} (
    ${columns}
) DISTRIBUTE ON (${distributeCol})`,
        );
        ddl.push(
            `ALTER TABLE ${database}.${config.schema}.${table} ADD CONSTRAINT PK_${table} PRIMARY KEY (DIM_ID)`,
        );
        ddl.push(
            `COMMENT ON TABLE ${database}.${config.schema}.${table} IS 'Dimension reference ${dim} for prefetch E2E'`,
        );
        ddl.push(
            `COMMENT ON COLUMN ${database}.${config.schema}.${table}.DIM_LABEL IS 'Human-readable dimension label'`,
        );
    }

    for (let fact = 1; fact <= factCount; fact++) {
        const table = factTableName(fact);
        const columns = buildColumnDefinitions(config, true).join(',\n    ');
        const enriched = isEnrichedTable(config, fact);
        const distCol = enriched ? 'ROW_ID' : 'ROW_ID';
        ddl.push(
            `CREATE TABLE ${config.schema}.${table} (
    ${columns}
) DISTRIBUTE ON (${distCol})`,
        );

        if (enriched) {
            const refDim = dimTableName(((fact - 1) % dimCount) + 1);
            ddl.push(
                `ALTER TABLE ${database}.${config.schema}.${table} ADD CONSTRAINT PK_${table} PRIMARY KEY (ROW_ID)`,
            );
            ddl.push(
                `ALTER TABLE ${database}.${config.schema}.${table} ADD CONSTRAINT FK_${table}_DIM FOREIGN KEY (REF_DIM_ID) REFERENCES ${database}.${config.schema}.${refDim}(DIM_ID) ON DELETE NO ACTION ON UPDATE NO ACTION`,
            );
            ddl.push(
                `COMMENT ON TABLE ${database}.${config.schema}.${table} IS 'Fact table ${fact} — enriched with PK/FK/comments'`,
            );
            ddl.push(
                `COMMENT ON COLUMN ${database}.${config.schema}.${table}.REF_DIM_ID IS 'FK to ${refDim}.DIM_ID'`,
            );
            ddl.push(
                `COMMENT ON COLUMN ${database}.${config.schema}.${table}.COL_001 IS 'Payload column sample comment'`,
            );
        }
    }

    const synonymLimit = Math.min(config.synonymsPerDb, factCount);
    for (let syn = 1; syn <= synonymLimit; syn++) {
        const fact = factTableName(syn);
        const synonym = synonymName(syn);
        ddl.push(
            `CREATE SYNONYM ${config.schema}.${synonym} FOR ${database}.${config.schema}.${fact}`,
        );
    }

    for (let proc = 1; proc <= config.proceduresPerDb; proc++) {
        const procName = procedureName(proc);
        ddl.push(`CREATE OR REPLACE PROCEDURE ${config.schema}.${procName}()
RETURNS INT4
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN ${proc};
END;
END_PROC;`);
    }

    return ddl;
}

export function estimateHeavySchemaStats(config: HeavySchemaConfig): Omit<
    HeavySchemaStats,
    'databases' | 'ddlStatements' | 'durationMs'
> {
    const dimCount = countDimensionTables(config);
    const factCount = countFactTables(config);
    const enrichedFacts = Array.from({ length: factCount }, (_, i) => i + 1).filter((n) =>
        isEnrichedTable(config, n),
    ).length;
    const totalTables = (dimCount + factCount) * config.dbCount;
    const synonymTotal = Math.min(config.synonymsPerDb, factCount) * config.dbCount;
    const procTotal = config.proceduresPerDb * config.dbCount;
    return {
        dimensionTables: dimCount * config.dbCount,
        factTables: factCount * config.dbCount,
        totalTables,
        estimatedColumns: totalTables * config.columnsPerTable,
        synonyms: synonymTotal,
        procedures: procTotal,
        enrichedTables: dimCount * config.dbCount + enrichedFacts * config.dbCount,
    };
}

export type ExecuteDdlFn = (sql: string) => Promise<void>;

export async function provisionHeavySchema(options: {
    config: HeavySchemaConfig;
    executeOnSystem: ExecuteDdlFn;
    connectToDatabase: (database: string) => Promise<ExecuteDdlFn>;
    databaseExists: (database: string) => Promise<boolean>;
    countExistingObjects: (database: string) => Promise<number>;
    onProgress?: (progress: HeavySchemaProgress) => void;
}): Promise<HeavySchemaStats> {
    const { config } = options;
    const databases = resolveHeavySchemaDatabaseNames(config);
    const start = performance.now();
    let ddlStatements = 0;
    const estimate = estimateHeavySchemaStats(config);

    const forceProvision = process.env.NZ_E2E_FORCE_PROVISION === '1';

    for (const database of databases) {
        const exists = await options.databaseExists(database);
        if (forceProvision && exists) {
            await options.executeOnSystem(`DROP DATABASE ${database}`);
            ddlStatements += 1;
        }
        if (!exists || forceProvision) {
            await options.executeOnSystem(`CREATE DATABASE ${database}`);
            ddlStatements += 1;
        }

        const execute = await options.connectToDatabase(database);
        const existing = await options.countExistingObjects(database);
        const expectedTables = countDimensionTables(config) + countFactTables(config);
        if (!forceProvision && existing >= expectedTables * 0.95) {
            options.onProgress?.({
                phase: 'reuse',
                database,
                completed: existing,
                total: config.tablesPerDb,
            });
            continue;
        }

        const ddl = buildHeavySchemaDdl(config, database);
        let completed = 0;
        for (const statement of ddl) {
            await execute(statement);
            ddlStatements += 1;
            completed += 1;
            if (completed % 50 === 0 || completed === ddl.length) {
                options.onProgress?.({
                    phase: 'ddl',
                    database,
                    completed,
                    total: ddl.length,
                });
            }
        }
    }

    return {
        databases,
        ...estimate,
        ddlStatements,
        durationMs: Math.round(performance.now() - start),
    };
}

/** Object count probe for reuse (dimension + fact tables in the target database only). */
export function heavySchemaObjectCountSql(database: string, schema: string): string {
    return `SELECT COUNT(DISTINCT OBJNAME) AS CNT
         FROM ${database}.._V_OBJECT_DATA
         WHERE UPPER(DBNAME) = UPPER('${database}')
           AND UPPER(SCHEMA) = UPPER('${schema}')
           AND OBJTYPE = 'TABLE'
           AND (OBJNAME LIKE 'FACT_%' OR OBJNAME LIKE 'DIM_REF_%')`;
}
