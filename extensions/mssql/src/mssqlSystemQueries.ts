import type {
  DatabaseColumnLookupParams,
  DatabaseSourceSearchQueryOptions,
} from "@justybase/contracts";

function quoteLiteral(value: string | undefined): string {
  return `'${(value ?? "").replace(/'/g, "''")}'`;
}

function buildCatalogPrefix(database: string): string {
  return database ? `[${database.replace(/]/g, "]]")}].` : "";
}

export function buildListDatabasesQuery(): string {
  return `SELECT name AS "DATABASE" FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name`;
}

export function buildListSchemasQuery(database?: string): string {
  const catalogPrefix = buildCatalogPrefix(database ?? "");
  return `SELECT name AS [SCHEMA] FROM ${catalogPrefix}sys.schemas ORDER BY name`;
}

export function buildListTablesQuery(
  database: string,
  schema?: string,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT TABLE_NAME AS OBJNAME, 0 AS OBJID, 'TABLE' AS OBJTYPE, TABLE_SCHEMA AS [SCHEMA]
        FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
    `;
  if (schema) {
    query += ` AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY TABLE_NAME`;
  return query;
}

export function buildListViewsQuery(database: string, schema?: string): string {
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT TABLE_NAME AS OBJNAME, 0 AS OBJID, 'VIEW' AS OBJTYPE, TABLE_SCHEMA AS [SCHEMA]
        FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'VIEW'
    `;
  if (schema) {
    query += ` AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY TABLE_NAME`;
  return query;
}

export function buildListProceduresQuery(
  database: string,
  schema?: string,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT ROUTINE_NAME AS OBJNAME, 0 AS OBJID, 'PROCEDURE' AS OBJTYPE, ROUTINE_SCHEMA AS [SCHEMA]
        FROM ${catalogPrefix}INFORMATION_SCHEMA.ROUTINES
        WHERE ROUTINE_TYPE = 'PROCEDURE'
    `;
  if (schema) {
    query += ` AND ROUTINE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY ROUTINE_NAME`;
  return query;
}

export function buildObjectTypeQuery(
  database: string,
  objectType: string,
): string {
  const normalizedType = objectType?.trim().toUpperCase() || "TABLE";

  const isActuallyType =
    database === "TABLE" ||
    database === "VIEW" ||
    database === "PROCEDURE" ||
    database === "FUNCTION";
  const actualDatabase = isActuallyType ? "" : database;
  const catalogPrefix = buildCatalogPrefix(actualDatabase);

  if (normalizedType === "TABLE") {
    return `
            SELECT TABLE_SCHEMA AS [SCHEMA], TABLE_NAME AS OBJNAME, 0 AS OBJID, 'TABLE' AS OBJTYPE
            FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        `;
  } else if (normalizedType === "VIEW") {
    return `
            SELECT TABLE_SCHEMA AS [SCHEMA], TABLE_NAME AS OBJNAME, 0 AS OBJID, 'VIEW' AS OBJTYPE
            FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'VIEW'
            ORDER BY TABLE_SCHEMA, TABLE_NAME
        `;
  } else if (normalizedType === "PROCEDURE") {
    return `
            SELECT ROUTINE_SCHEMA AS [SCHEMA], ROUTINE_NAME AS OBJNAME, 0 AS OBJID, 'PROCEDURE' AS OBJTYPE
            FROM ${catalogPrefix}INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_TYPE = 'PROCEDURE'
            ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
        `;
  } else if (normalizedType === "FUNCTION") {
    return `
            SELECT ROUTINE_SCHEMA AS [SCHEMA], ROUTINE_NAME AS OBJNAME, 0 AS OBJID, 'FUNCTION' AS OBJTYPE
            FROM ${catalogPrefix}INFORMATION_SCHEMA.ROUTINES
            WHERE ROUTINE_TYPE = 'FUNCTION'
            ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME
        `;
  }

  return `
        SELECT TABLE_SCHEMA AS [SCHEMA], TABLE_NAME AS OBJNAME, 0 AS OBJID, '${normalizedType}' AS OBJTYPE
        FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLES
        WHERE 1 = 0
    `;
}

export function buildTypeGroupsQuery(): string {
  return `
        SELECT 'TABLE' AS OBJTYPE
        UNION ALL
        SELECT 'VIEW' AS OBJTYPE
        UNION ALL
        SELECT 'PROCEDURE' AS OBJTYPE
        UNION ALL
        SELECT 'FUNCTION' AS OBJTYPE
    `;
}

export function buildTableColumnsQuery(
  database: string,
  schema: string,
  tableName: string,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  return `
        SELECT 
            COLUMN_NAME AS ATTNAME,
            DATA_TYPE AS FORMAT_TYPE,
            IS_NULLABLE,
            CHARACTER_MAXIMUM_LENGTH,
            NUMERIC_PRECISION,
            NUMERIC_SCALE,
            CASE WHEN IS_NULLABLE = 'NO' THEN 1 ELSE 0 END AS IS_NOT_NULL,
            COLUMN_DEFAULT AS COLDEFAULT,
            '' AS DESCRIPTION,
            0 AS IS_PK,
            0 AS IS_FK
        FROM ${catalogPrefix}INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${tableName.replace(/'/g, "''")}'
          AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
        ORDER BY ORDINAL_POSITION
    `;
}

export function buildColumnMetadataQuery(
  database: string,
  schema: string,
  tableName: string,
): string {
  return buildTableColumnsQuery(database, schema, tableName);
}

export function buildColumnsWithKeysQuery(
  database: string,
  schema?: string,
  tableName?: string,

  _objTypes?: string[],
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT 
            c.TABLE_SCHEMA AS SCHEMA_NAME,
            c.TABLE_NAME,
            c.COLUMN_NAME,
            c.DATA_TYPE,
            c.IS_NULLABLE,
            CASE WHEN EXISTS (
                SELECT 1
                FROM ${catalogPrefix}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                INNER JOIN ${catalogPrefix}INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                    ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                  AND tc.TABLE_SCHEMA = c.TABLE_SCHEMA AND tc.TABLE_NAME = c.TABLE_NAME
                  AND k.COLUMN_NAME = c.COLUMN_NAME
            ) THEN 1 ELSE 0 END AS IS_PK
        FROM ${catalogPrefix}INFORMATION_SCHEMA.COLUMNS c
        WHERE 1 = 1
    `;
  if (schema) {
    query += ` AND c.TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
  }
  if (tableName) {
    query += ` AND c.TABLE_NAME = '${tableName.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`;
  return query;
}

export function buildForeignKeyRelationshipsQuery(
  database: string,
  schema?: string,
  tableName?: string,
): string {
  const prefix = buildCatalogPrefix(database);
  const filters = [
    schema ? ` AND source_schema.name = ${quoteLiteral(schema)}` : "",
    tableName ? ` AND source_table.name = ${quoteLiteral(tableName)}` : "",
  ].join("");
  return `
    SELECT
      ${quoteLiteral(database)} AS FROM_DATABASE,
      source_schema.name AS FROM_SCHEMA,
      source_table.name AS FROM_TABLE,
      source_column.name AS FROM_COLUMN,
      ${quoteLiteral(database)} AS TO_DATABASE,
      target_schema.name AS TO_SCHEMA,
      target_table.name AS TO_TABLE,
      target_column.name AS TO_COLUMN,
      fk.name AS CONSTRAINT_NAME,
      fkc.constraint_column_id AS ORDINAL_POSITION
    FROM ${prefix}sys.foreign_key_columns fkc
    INNER JOIN ${prefix}sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
    INNER JOIN ${prefix}sys.tables source_table ON source_table.object_id = fkc.parent_object_id
    INNER JOIN ${prefix}sys.schemas source_schema ON source_schema.schema_id = source_table.schema_id
    INNER JOIN ${prefix}sys.columns source_column
      ON source_column.object_id = source_table.object_id AND source_column.column_id = fkc.parent_column_id
    INNER JOIN ${prefix}sys.tables target_table ON target_table.object_id = fkc.referenced_object_id
    INNER JOIN ${prefix}sys.schemas target_schema ON target_schema.schema_id = target_table.schema_id
    INNER JOIN ${prefix}sys.columns target_column
      ON target_column.object_id = target_table.object_id AND target_column.column_id = fkc.referenced_column_id
    WHERE 1 = 1${filters}
    ORDER BY source_schema.name, source_table.name, fk.name, fkc.constraint_column_id
  `;
}

export function buildLookupColumnsQuery(
  params: DatabaseColumnLookupParams,
): string {
  const database = params.database || "";
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT 
            TABLE_SCHEMA AS SCHEMA_NAME,
            TABLE_NAME,
            COLUMN_NAME
        FROM ${catalogPrefix}INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${params.tableName.replace(/'/g, "''")}'
    `;
  if (params.schema) {
    query += ` AND TABLE_SCHEMA = '${params.schema.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
  return query;
}

export function buildTableCommentQuery(
  database: string,
  schema: string,
  tableName: string,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  return `
        SELECT CAST(ep.value AS NVARCHAR(MAX)) AS COMMENT
        FROM ${catalogPrefix}sys.extended_properties ep
        JOIN ${catalogPrefix}sys.tables t ON ep.major_id = t.object_id
        JOIN ${catalogPrefix}sys.schemas s ON t.schema_id = s.schema_id
        WHERE ep.minor_id = 0
          AND ep.class = 1
          AND ep.name = 'MS_Description'
          AND s.name = '${schema.replace(/'/g, "''")}'
          AND t.name = '${tableName.replace(/'/g, "''")}'
    `;
}

export function buildObjectSearchQuery(
  database: string,
  likePattern: string,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  const databaseLiteral = quoteLiteral(database);
  const escapedLikePattern = quoteLiteral(likePattern);
  return `
        SELECT TOP (200) *
        FROM (
            SELECT
                1 AS PRIORITY,
                o.name AS NAME,
                s.name AS [SCHEMA],
                CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END AS TYPE,
                ${databaseLiteral} AS [DATABASE],
                '' AS PARENT,
                COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ${catalogPrefix}sys.objects o
            JOIN ${catalogPrefix}sys.schemas s ON o.schema_id = s.schema_id
            LEFT JOIN ${catalogPrefix}sys.extended_properties ep
              ON ep.class = 1
             AND ep.major_id = o.object_id
             AND ep.minor_id = 0
             AND ep.name = 'MS_Description'
            WHERE o.type IN ('U', 'V')
              AND o.is_ms_shipped = 0
              AND UPPER(o.name) LIKE ${escapedLikePattern} ESCAPE '\\'
            UNION ALL
            SELECT
                2 AS PRIORITY,
                o.name AS NAME,
                s.name AS [SCHEMA],
                CASE WHEN o.type = 'P' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS TYPE,
                ${databaseLiteral} AS [DATABASE],
                '' AS PARENT,
                COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ${catalogPrefix}sys.objects o
            JOIN ${catalogPrefix}sys.schemas s ON o.schema_id = s.schema_id
            LEFT JOIN ${catalogPrefix}sys.extended_properties ep
              ON ep.class = 1
             AND ep.major_id = o.object_id
             AND ep.minor_id = 0
             AND ep.name = 'MS_Description'
            WHERE o.type IN ('P', 'FN', 'TF', 'IF')
              AND o.is_ms_shipped = 0
              AND UPPER(o.name) LIKE ${escapedLikePattern} ESCAPE '\\'
            UNION ALL
            SELECT
                3 AS PRIORITY,
                c.name AS NAME,
                s.name AS [SCHEMA],
                'COLUMN' AS TYPE,
                ${databaseLiteral} AS [DATABASE],
                o.name AS PARENT,
                COALESCE(CAST(ep.value AS NVARCHAR(MAX)), '') AS DESCRIPTION,
                'NAME' AS MATCH_TYPE
            FROM ${catalogPrefix}sys.columns c
            JOIN ${catalogPrefix}sys.objects o ON c.object_id = o.object_id
            JOIN ${catalogPrefix}sys.schemas s ON o.schema_id = s.schema_id
            LEFT JOIN ${catalogPrefix}sys.extended_properties ep
              ON ep.class = 1
             AND ep.major_id = c.object_id
             AND ep.minor_id = c.column_id
             AND ep.name = 'MS_Description'
            WHERE o.type IN ('U', 'V')
              AND o.is_ms_shipped = 0
              AND UPPER(c.name) LIKE ${escapedLikePattern} ESCAPE '\\'
        ) AS SEARCH_RESULTS
        ORDER BY PRIORITY, NAME
    `;
}

interface SourceSearchOptions {
  schema?: string;
  name?: string;
  rawTerm?: string;
  likePattern?: string;
  useServerSideFilter?: boolean;
}

export function buildViewSourceSearchQuery(
  database: string,
  options: DatabaseSourceSearchQueryOptions | SourceSearchOptions,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  const databaseLiteral = quoteLiteral(database);
  const schema = (options as SourceSearchOptions).schema || "";
  const name = (options as SourceSearchOptions).name || "";
  const likePattern = (options as SourceSearchOptions).likePattern || "";
  const useServerSideFilter =
    Boolean((options as SourceSearchOptions).useServerSideFilter) &&
    likePattern.length > 0;
  return `
        SELECT
            o.name AS NAME,
            s.name AS [SCHEMA],
            'VIEW' AS TYPE,
            ${databaseLiteral} AS [DATABASE]${useServerSideFilter ? "" : `,
            sm.definition AS SOURCE`}
        FROM ${catalogPrefix}sys.sql_modules sm
        JOIN ${catalogPrefix}sys.objects o ON sm.object_id = o.object_id
        JOIN ${catalogPrefix}sys.schemas s ON o.schema_id = s.schema_id
        WHERE o.type = 'V'
          ${schema ? `AND s.name = ${quoteLiteral(schema)}` : ""}
          ${name ? `AND o.name = ${quoteLiteral(name)}` : ""}
          ${useServerSideFilter ? `AND UPPER(COALESCE(sm.definition, '')) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'` : ""}
        ORDER BY s.name, o.name
    `;
}

export function buildProcedureSourceSearchQuery(
  database: string,
  options: DatabaseSourceSearchQueryOptions | SourceSearchOptions,
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  const databaseLiteral = quoteLiteral(database);
  const schema = (options as SourceSearchOptions).schema || "";
  const name = (options as SourceSearchOptions).name || "";
  const likePattern = (options as SourceSearchOptions).likePattern || "";
  const useServerSideFilter =
    Boolean((options as SourceSearchOptions).useServerSideFilter) &&
    likePattern.length > 0;
  return `
        SELECT
            o.name AS NAME,
            s.name AS [SCHEMA],
            CASE WHEN o.type = 'P' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS TYPE,
            ${databaseLiteral} AS [DATABASE]${useServerSideFilter ? "" : `,
            sm.definition AS SOURCE`}
        FROM ${catalogPrefix}sys.sql_modules sm
        JOIN ${catalogPrefix}sys.objects o ON sm.object_id = o.object_id
        JOIN ${catalogPrefix}sys.schemas s ON o.schema_id = s.schema_id
        WHERE o.type IN ('P', 'FN', 'TF', 'IF')
          ${schema ? `AND s.name = ${quoteLiteral(schema)}` : ""}
          ${name ? `AND o.name = ${quoteLiteral(name)}` : ""}
          ${useServerSideFilter ? `AND UPPER(COALESCE(sm.definition, '')) LIKE ${quoteLiteral(likePattern)} ESCAPE '\\'` : ""}
        ORDER BY s.name, o.name
    `;
}

export type MssqlTableDetailKind = "keys" | "indexes" | "triggers";

/** Keys/constraints, indexes or triggers of one table for the schema tree (NAME, KIND, DETAIL). */
export function buildTableDetailQuery(
  database: string,
  schema: string,
  tableName: string,
  detail: MssqlTableDetailKind,
): string {
  const prefix = buildCatalogPrefix(database);
  const tableJoin = `INNER JOIN ${prefix}sys.tables t ON t.object_id = src.parent_object_id
    INNER JOIN ${prefix}sys.schemas s ON s.schema_id = t.schema_id`;
  const tableFilter = `s.name = ${quoteLiteral(schema)} AND t.name = ${quoteLiteral(tableName)}`;
  const indexColumns = (objectId: string, indexId: string) => `STUFF((
        SELECT ', ' + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
        FROM ${prefix}sys.index_columns ic
        INNER JOIN ${prefix}sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.object_id = ${objectId} AND ic.index_id = ${indexId} AND ic.is_included_column = 0
        ORDER BY ic.key_ordinal
        FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '')`;
  if (detail === "keys") {
    return `
      SELECT NAME, KIND, DETAIL FROM (
        SELECT src.name AS NAME,
          CASE src.type WHEN 'PK' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS KIND,
          ${indexColumns("src.parent_object_id", "src.unique_index_id")} AS DETAIL,
          CASE src.type WHEN 'PK' THEN 0 ELSE 1 END AS SORT_KEY
        FROM ${prefix}sys.key_constraints src
        ${tableJoin}
        WHERE ${tableFilter}
        UNION ALL
        SELECT src.name, 'FOREIGN KEY',
          STUFF((
            SELECT ', ' + c.name
            FROM ${prefix}sys.foreign_key_columns fkc
            INNER JOIN ${prefix}sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
            WHERE fkc.constraint_object_id = src.object_id
            ORDER BY fkc.constraint_column_id
            FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '')
            + ' -> ' + rs.name + '.' + rt.name,
          2
        FROM ${prefix}sys.foreign_keys src
        ${tableJoin}
        INNER JOIN ${prefix}sys.tables rt ON rt.object_id = src.referenced_object_id
        INNER JOIN ${prefix}sys.schemas rs ON rs.schema_id = rt.schema_id
        WHERE ${tableFilter}
        UNION ALL
        SELECT src.name, 'CHECK', src.definition, 3
        FROM ${prefix}sys.check_constraints src
        ${tableJoin}
        WHERE ${tableFilter}
      ) keys_list
      ORDER BY SORT_KEY, NAME
    `;
  }
  if (detail === "indexes") {
    return `
      SELECT i.name AS NAME,
        CASE WHEN i.is_primary_key = 1 THEN 'PRIMARY KEY' WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE 'INDEX' END AS KIND,
        LOWER(i.type_desc) + ' (' + ${indexColumns("i.object_id", "i.index_id")} + ')' AS DETAIL
      FROM ${prefix}sys.indexes i
      INNER JOIN ${prefix}sys.tables t ON t.object_id = i.object_id
      INNER JOIN ${prefix}sys.schemas s ON s.schema_id = t.schema_id
      WHERE ${tableFilter} AND i.index_id > 0 AND i.is_hypothetical = 0
      ORDER BY i.is_primary_key DESC, i.is_unique DESC, i.name
    `;
  }
  return `
    SELECT tr.name AS NAME,
      CASE WHEN tr.is_disabled = 1 THEN 'DISABLED' ELSE 'TRIGGER' END AS KIND,
      CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF ' ELSE 'AFTER ' END + STUFF((
        SELECT ' OR ' + te.type_desc
        FROM ${prefix}sys.trigger_events te
        WHERE te.object_id = tr.object_id
        FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 4, '') AS DETAIL
    FROM ${prefix}sys.triggers tr
    INNER JOIN ${prefix}sys.tables t ON t.object_id = tr.parent_id
    INNER JOIN ${prefix}sys.schemas s ON s.schema_id = t.schema_id
    WHERE ${tableFilter}
    ORDER BY tr.name
  `;
}

/** sys.sql_expression_dependencies edges inside one database for impact analysis. */
export function buildObjectDependenciesQuery(database: string): string {
  const prefix = buildCatalogPrefix(database);
  const normalized = (alias: string) => `CASE ${alias}.type
        WHEN 'V' THEN 'VIEW' WHEN 'U' THEN 'TABLE' WHEN 'SO' THEN 'SEQUENCE'
        WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'PROCEDURE' WHEN 'IF' THEN 'PROCEDURE' WHEN 'TF' THEN 'PROCEDURE' WHEN 'TR' THEN 'PROCEDURE'
        ELSE 'TABLE' END`;
  return `
    SELECT DISTINCT
      ss.name AS SOURCE_SCHEMA,
      so.name AS SOURCE_NAME,
      ${normalized("so")} AS SOURCE_TYPE,
      ts.name AS TARGET_SCHEMA,
      tob.name AS TARGET_NAME,
      ${normalized("tob")} AS TARGET_TYPE,
      tc.name AS TARGET_COLUMN
    FROM ${prefix}sys.sql_expression_dependencies d
    INNER JOIN ${prefix}sys.objects so ON so.object_id = d.referencing_id
    INNER JOIN ${prefix}sys.schemas ss ON ss.schema_id = so.schema_id
    INNER JOIN ${prefix}sys.objects tob ON tob.object_id = d.referenced_id
    INNER JOIN ${prefix}sys.schemas ts ON ts.schema_id = tob.schema_id
    LEFT JOIN ${prefix}sys.columns tc ON tc.object_id = d.referenced_id AND tc.column_id = d.referenced_minor_id AND d.referenced_minor_id > 0
    WHERE d.referencing_class = 1 AND d.referenced_class = 1 AND so.is_ms_shipped = 0 AND d.referencing_id <> d.referenced_id
  `;
}

export type MssqlTableReportKind = "size" | "privileges" | "maintenance";
export type MssqlDatabaseReportKind = "locks" | "invalidObjects";

/** Runs a statement in the given database so OBJECT_ID / STATS_DATE resolve there, not in the session database. */
function inDatabase(database: string, sql: string): string {
  if (!database) {
    return sql;
  }
  return `EXEC [${database.replace(/]/g, "]]")}].sys.sp_executesql N'${sql.replace(/'/g, "''")}'`;
}

/** Read-only table reports shown in SQL Results (size, permissions, index fragmentation). */
export function buildTableReportQuery(
  database: string,
  schema: string,
  tableName: string,
  report: MssqlTableReportKind,
): string {
  const tableFilter = `s.name = ${quoteLiteral(schema)} AND t.name = ${quoteLiteral(tableName)}`;
  if (report === "size") {
    return inDatabase(database, `
      SELECT
        s.name AS SCHEMA_NAME,
        t.name AS TABLE_NAME,
        SUM(CASE WHEN p.index_id IN (0, 1) AND au.type = 1 THEN p.rows ELSE 0 END) AS ROW_COUNT,
        CAST(SUM(au.total_pages) * 8 / 1024.0 AS DECIMAL(18, 2)) AS RESERVED_MB,
        CAST(SUM(au.used_pages) * 8 / 1024.0 AS DECIMAL(18, 2)) AS USED_MB,
        CAST(SUM(CASE WHEN p.index_id IN (0, 1) THEN au.data_pages ELSE 0 END) * 8 / 1024.0 AS DECIMAL(18, 2)) AS DATA_MB,
        CAST(SUM(CASE WHEN p.index_id > 1 THEN au.used_pages ELSE 0 END) * 8 / 1024.0 AS DECIMAL(18, 2)) AS INDEXES_MB,
        CAST((SUM(au.total_pages) - SUM(au.used_pages)) * 8 / 1024.0 AS DECIMAL(18, 2)) AS UNUSED_MB,
        COUNT(DISTINCT p.partition_number) AS PARTITIONS
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      INNER JOIN sys.partitions p ON p.object_id = t.object_id
      INNER JOIN sys.allocation_units au ON au.container_id = p.partition_id
      WHERE ${tableFilter}
      GROUP BY s.name, t.name`);
  }
  if (report === "privileges") {
    return inDatabase(database, `
      SELECT
        grantee.name AS GRANTEE,
        grantee.type_desc AS GRANTEE_TYPE,
        dp.state_desc AS STATE,
        dp.permission_name + CASE WHEN dp.minor_id > 0 THEN ' (' + COL_NAME(dp.major_id, dp.minor_id) + ')' ELSE '' END AS PERMISSION,
        grantor.name AS GRANTOR
      FROM sys.database_permissions dp
      INNER JOIN sys.tables t ON t.object_id = dp.major_id
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      INNER JOIN sys.database_principals grantee ON grantee.principal_id = dp.grantee_principal_id
      INNER JOIN sys.database_principals grantor ON grantor.principal_id = dp.grantor_principal_id
      WHERE dp.class = 1 AND ${tableFilter}
      ORDER BY grantee.name, dp.permission_name`);
  }
  // Fragmentation thresholds follow the usual guidance: > 30% rebuild, > 5% reorganize, small indexes skipped.
  return inDatabase(database, `
      SELECT
        s.name AS SCHEMA_NAME,
        t.name AS TABLE_NAME,
        COALESCE(i.name, '(heap)') AS INDEX_NAME,
        i.type_desc AS INDEX_TYPE,
        CASE
          WHEN ps.page_count < 1000 THEN 'OK (too small to matter)'
          WHEN ps.avg_fragmentation_in_percent > 30 THEN 'ALTER INDEX ... REBUILD'
          WHEN ps.avg_fragmentation_in_percent > 5 THEN 'ALTER INDEX ... REORGANIZE'
          ELSE 'OK'
        END AS RECOMMENDATION,
        CAST(ps.avg_fragmentation_in_percent AS DECIMAL(7, 2)) AS FRAGMENTATION_PCT,
        ps.page_count AS PAGE_COUNT,
        STATS_DATE(i.object_id, i.index_id) AS STATISTICS_UPDATED
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      CROSS APPLY sys.dm_db_index_physical_stats(DB_ID(), t.object_id, NULL, NULL, 'LIMITED') ps
      INNER JOIN sys.indexes i ON i.object_id = ps.object_id AND i.index_id = ps.index_id
      WHERE ${tableFilter} AND ps.alloc_unit_type_desc = 'IN_ROW_DATA'
      ORDER BY ps.avg_fragmentation_in_percent DESC`);
}

/** Read-only database reports shown in SQL Results; SQL Server has no invalid-object catalog. */
export function buildDatabaseReportQuery(_database: string, report: MssqlDatabaseReportKind): string | undefined {
  if (report !== "locks") {
    return undefined;
  }
  // Other sessions are visible only with VIEW SERVER STATE; without it the report lists the caller's own requests.
  return `
    SELECT
      r.session_id AS WAITING_SESSION,
      ws.login_name AS WAITING_LOGIN,
      ws.program_name AS WAITING_PROGRAM,
      DB_NAME(r.database_id) AS DATABASE_NAME,
      r.wait_time / 1000 AS WAIT_SECONDS,
      r.wait_type AS WAIT_TYPE,
      r.wait_resource AS WAIT_RESOURCE,
      r.blocking_session_id AS BLOCKING_SESSION,
      bs.login_name AS BLOCKING_LOGIN,
      bs.program_name AS BLOCKING_PROGRAM,
      bs.status AS BLOCKING_STATUS,
      LEFT(wt.text, 2000) AS WAITING_SQL
    FROM sys.dm_exec_requests r
    INNER JOIN sys.dm_exec_sessions ws ON ws.session_id = r.session_id
    LEFT JOIN sys.dm_exec_sessions bs ON bs.session_id = r.blocking_session_id
    OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) wt
    WHERE r.blocking_session_id <> 0
    ORDER BY r.wait_time DESC`;
}
