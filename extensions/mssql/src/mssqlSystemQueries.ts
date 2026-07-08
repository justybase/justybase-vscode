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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _objTypes?: string[],
): string {
  const catalogPrefix = buildCatalogPrefix(database);
  let query = `
        SELECT 
            TABLE_SCHEMA AS SCHEMA_NAME,
            TABLE_NAME,
            COLUMN_NAME,
            DATA_TYPE,
            IS_NULLABLE
        FROM ${catalogPrefix}INFORMATION_SCHEMA.COLUMNS
        WHERE 1 = 1
    `;
  if (schema) {
    query += ` AND TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`;
  }
  if (tableName) {
    query += ` AND TABLE_NAME = '${tableName.replace(/'/g, "''")}'`;
  }
  query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`;
  return query;
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
