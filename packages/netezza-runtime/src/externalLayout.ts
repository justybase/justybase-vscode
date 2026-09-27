interface ExternalLayoutZone {
  usetype: unknown;
  name: unknown;
  type: unknown;
  style: unknown;
  length: unknown;
  delimiter: unknown;
  around: unknown;
  nullif: unknown;
  endian: unknown;
  alignment: unknown;
  modulus: unknown;
}

const RESERVED_IDENTIFIERS = new Set(
  `ABORT ALL ALLOCATE ANALYSE ANALYZE AND ANY AS ASC AUTOMAINT AWSS3 AZUREBLOB BETWEEN BINARY BIT BOTH CASE CAST CHAR CHARACTER CHECK CLUSTER COALESCE COLLATE COLLATION COLUMN CONSTRAINT COPY CROSS CURRENT CURRENT_CATALOG CURRENT_DATE CURRENT_DB CURRENT_SCHEMA CURRENT_SID CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURRENT_USERID CURRENT_USEROID DAYSPERROW DEALLOCATE DEC DECIMAL DECODE DEFAULT DEREGISTER DESC DISTINCT DISTRIBUTE DO ELSE END EXCEPT EXCLUDE EXISTS EXPLAIN EXPRESS EXTEND EXTERNAL EXTRACT FALSE FIRST FLOAT FOLLOWING FOR FOREIGN FROM FULL FUNCTION GENSTATS GLOBAL GROUP HAVING HISTOGRAM IDENTIFIER_CASE ILIKE IN INDEX INITIALLY INNER INOUT INTERSECT INTERVAL INTO JOURNAL LEADING LEFT LIKE LIMIT LOAD LOCAL LOCK MINUS MOVE NATURAL NCHAR NEW NOCASCADE NOT NOTNULL NULL NULLS NUMERIC NVL NVL2 OFFSET OFF OLD ON ONLINE ONLY OR ORDER OTHERS OUT OUTER OVER OVERLAPS PAUSESTEPS PAUSETIME PARTITION POSITION PRECEDING PRECISION PRESERVE PRIMARY REGISTER RESET REUSE RIGHT ROWS SELECT SESSION_USER SETOF SHOW SOME TABLE TEMPORAL THEN TIES TIME TIME_TRAVEL_ENABLE TIMESTAMP TO TRAILING TRANSACTION TRIGGER TRIM TRUE UNBOUNDED UNION UNIQUE USER USING VACUUM VARCHAR VERBOSE VERSION VIEW WHEN WHERE WITH WRITE CTID OID XMIN CMIN XMAX CMAX TABLEOID ROWID DATASLICEID CREATEXID DELETEXID`.split(/\s+/u),
);

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function rawText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function quoteIdentifier(value: string): string {
  if (/^[A-Z][A-Z0-9_]*$/u.test(value) && !RESERVED_IDENTIFIERS.has(value)) return value;
  return `"${value.replace(/"/gu, '""')}"`;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function isExternalLayoutZoneCount(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return typeof value === 'string' && /^\d+$/u.test(value.trim()) && Number(value.trim()) > 0;
}

export function reconstructExternalLayout(catalogLayout: unknown, zones: readonly ExternalLayoutZone[]): string | null {
  if (catalogLayout === null || catalogLayout === undefined) return null;
  const raw = text(catalogLayout);
  if (!raw || raw === '0') return null;
  if (!/^\d+$/u.test(raw)) return raw;

  const expectedCount = Number(raw);
  if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) return null;
  if (zones.length !== expectedCount) {
    throw new Error(`Cannot reconstruct external table LAYOUT: catalog reports ${expectedCount} zones, but _V_EXTZONES returned ${zones.length}`);
  }

  return zones.map((zone, index) => {
    const useType = text(zone.usetype).toUpperCase();
    if (useType && useType !== 'REF' && useType !== 'FILLER') {
      throw new Error(`Cannot reconstruct external table LAYOUT: unsupported zone use type ${useType}`);
    }
    const name = rawText(zone.name);
    const type = text(zone.type);
    const style = text(zone.style);
    const length = text(zone.length);
    const delimiter = rawText(zone.delimiter);
    const nullIf = text(zone.nullif);
    if (!length) throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has no length`);
    for (const [field, value] of [
      ['AROUND', zone.around], ['ENDIAN', zone.endian],
      ['ALIGNMENT', zone.alignment], ['MODULUS', zone.modulus],
    ] as const) {
      if (text(value)) throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} uses unsupported ${field} metadata`);
    }
    const parts = [useType, name ? quoteIdentifier(name) : '', type, style];
    if (delimiter) {
      if (!style) throw new Error(`Cannot reconstruct external table LAYOUT: zone ${index + 1} has a delimiter without a style`);
      if (!style.includes("'")) parts.push(quoteSqlString(delimiter));
    }
    parts.push(length);
    if (nullIf) parts.push(/^NULLIF\b/iu.test(nullIf) ? nullIf : `NULLIF ${nullIf}`);
    return parts.filter(Boolean).join(' ');
  }).join(', ');
}
