import type {
  DatabaseDdlColumnInfo,
  DatabaseDdlKeyInfo,
} from '@justybase/contracts';

/**
 * Netezza table DDL is deliberately kept as a pure formatter. The desktop
 * and companion adapters can load catalog metadata independently and
 * still produce byte-for-byte compatible DDL.
 */
const NETEZZA_RESERVED_IDENTIFIERS = new Set(
  `ABORT ALL ALLOCATE ANALYSE ANALYZE AND ANY AS ASC AUTOMAINT AWSS3 AZUREBLOB BETWEEN BINARY BIT BOTH CASE CAST CHAR CHARACTER CHECK CLUSTER COALESCE COLLATE COLLATION COLUMN CONSTRAINT COPY CROSS CURRENT CURRENT_CATALOG CURRENT_DATE CURRENT_DB CURRENT_SCHEMA CURRENT_SID CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURRENT_USERID CURRENT_USEROID DAYSPERROW DEALLOCATE DEC DECIMAL DECODE DEFAULT DEREGISTER DESC DISTINCT DISTRIBUTE DO ELSE END EXCEPT EXCLUDE EXISTS EXPLAIN EXPRESS EXTEND EXTERNAL EXTRACT FALSE FIRST FLOAT FOLLOWING FOR FOREIGN FROM FULL FUNCTION GENSTATS GLOBAL GROUP HAVING HISTOGRAM IDENTIFIER_CASE ILIKE IN INDEX INITIALLY INNER INOUT INTERSECT INTERVAL INTO JOURNAL LEADING LEFT LIKE LIMIT LOAD LOCAL LOCK MINUS MOVE NATURAL NCHAR NEW NOCASCADE NOT NOTNULL NULL NULLS NUMERIC NVL NVL2 OFFSET OFF OLD ON ONLINE ONLY OR ORDER OTHERS OUT OUTER OVER OVERLAPS PAUSESTEPS PAUSETIME PARTITION POSITION PRECEDING PRECISION PRESERVE PRIMARY REGISTER RESET REUSE RIGHT ROWS SELECT SESSION_USER SETOF SHOW SOME TABLE TEMPORAL THEN TIES TIME TIME_TRAVEL_ENABLE TIMESTAMP TO TRAILING TRANSACTION TRIGGER TRIM TRUE UNBOUNDED UNION UNIQUE USER USING VACUUM VARCHAR VERBOSE VERSION VIEW WHEN WHERE WITH WRITE CTID OID XMIN CMIN XMAX CMAX TABLEOID ROWID DATASLICEID CREATEXID DELETEXID`.split(/\s+/u),
);

export function quoteNetezzaIdentifier(name: string): string {
  if (!name) return name;

  const isSimpleIdentifier = /^[A-Z][A-Z0-9_]*$/u.test(name)
    && name === name.toUpperCase()
    && !NETEZZA_RESERVED_IDENTIFIERS.has(name);
  if (isSimpleIdentifier) return name;

  return `"${name.replace(/"/gu, '""')}"`;
}

function quoteSqlString(value: string): string {
  return value.replace(/'/gu, "''");
}

/**
 * Builds the same table DDL shape used by the VS Code Netezza provider.
 *
 * `keysInfo` is a map rather than an array because the catalog naturally
 * groups multiple rows by constraint name.  A ReadonlyMap is accepted so a
 * transport adapter never has to mutate the metadata it received.
 */
export function buildNetezzaTableDdl(
  database: string,
  schema: string,
  tableName: string,
  columns: readonly DatabaseDdlColumnInfo[],
  distributionColumns: readonly string[],
  organizeColumns: readonly string[],
  keysInfo: ReadonlyMap<string, DatabaseDdlKeyInfo>,
  tableComment: string | null,
): string {
  if (columns.length === 0) {
    return `-- Table ${database}.${schema}.${tableName} has no columns or was not found`;
  }

  const cleanDatabase = quoteNetezzaIdentifier(database);
  const cleanSchema = quoteNetezzaIdentifier(schema);
  const cleanTableName = quoteNetezzaIdentifier(tableName);
  const qualifiedTable = `${cleanDatabase}.${cleanSchema}.${cleanTableName}`;

  const ddlLines: string[] = [
    `CREATE TABLE ${qualifiedTable}`,
    '(',
    columns.map(column => {
      let definition = `    ${quoteNetezzaIdentifier(column.name)} ${column.fullTypeName}`;
      if (column.notNull) definition += ' NOT NULL';
      if (column.defaultValue !== null) definition += ` DEFAULT ${column.defaultValue}`;
      return definition;
    }).join(',\n'),
  ];

  if (distributionColumns.length > 0) {
    ddlLines.push(`)\nDISTRIBUTE ON (${distributionColumns.map(quoteNetezzaIdentifier).join(', ')})`);
  } else {
    ddlLines.push(')\nDISTRIBUTE ON RANDOM');
  }

  if (organizeColumns.length > 0) {
    ddlLines.push(`ORGANIZE ON (${organizeColumns.map(quoteNetezzaIdentifier).join(', ')})`);
  }

  ddlLines.push(';', '');

  for (const [keyName, keyInfo] of keysInfo) {
    const cleanKeyName = quoteNetezzaIdentifier(keyName);
    const cleanColumns = keyInfo.columns.map(quoteNetezzaIdentifier);

    if (keyInfo.typeChar === 'f') {
      const cleanPkColumns = keyInfo.pkColumns.filter(Boolean).map(quoteNetezzaIdentifier);
      if (cleanPkColumns.length > 0 && keyInfo.pkDatabase && keyInfo.pkSchema && keyInfo.pkRelation) {
        const referencedTable = [keyInfo.pkDatabase, keyInfo.pkSchema, keyInfo.pkRelation]
          .map(quoteNetezzaIdentifier)
          .join('.');
        ddlLines.push(
          `ALTER TABLE ${qualifiedTable} `
          + `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} `
          + `(${cleanColumns.join(', ')}) `
          + `REFERENCES ${referencedTable} `
          + `(${cleanPkColumns.join(', ')}) `
          + `ON DELETE ${keyInfo.deleteType} ON UPDATE ${keyInfo.updateType};`,
        );
      }
    } else if (keyInfo.typeChar === 'p' || keyInfo.typeChar === 'u') {
      ddlLines.push(
        `ALTER TABLE ${qualifiedTable} `
        + `ADD CONSTRAINT ${cleanKeyName} ${keyInfo.type} `
        + `(${cleanColumns.join(', ')});`,
      );
    }
  }

  if (tableComment) {
    ddlLines.push('', `COMMENT ON TABLE ${qualifiedTable} IS '${quoteSqlString(tableComment)}';`);
  }

  for (const column of columns) {
    if (column.description) {
      ddlLines.push(
        `COMMENT ON COLUMN ${qualifiedTable}.${quoteNetezzaIdentifier(column.name)} IS '${quoteSqlString(column.description)}';`,
      );
    }
  }

  return ddlLines.join('\n');
}

/** Builds the canonical Netezza view DDL envelope around catalog SQL. */
export function buildNetezzaViewDdl(
  database: string,
  schema: string,
  viewName: string,
  definition: string,
): string {
  return [
    `CREATE OR REPLACE VIEW ${quoteNetezzaIdentifier(database)}.${quoteNetezzaIdentifier(schema)}.${quoteNetezzaIdentifier(viewName)} AS`,
    definition || '',
  ].join('\n');
}
