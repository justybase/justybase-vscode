import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { QueryAggregateRequest, QueryAggregateResponse, QueryAggregateValue, QueryColumn, QueryGroupRequest, QueryGroupResponse, QueryPageRequest, QueryPageResponse, QuerySortSpec } from '@justybase/contracts';

interface SessionManifest {
  sessionId: string;
  queryId: string;
  userId: string;
  connectionId: string;
  statementIndex: number;
  statementCount: number;
  columns: QueryColumn[];
  totalRows?: number;
  rowsAffected?: number;
  limitReached?: boolean;
  message?: string;
  createdAt: number;
  expiresAt: number;
  completed: boolean;
}

interface OpenSession {
  manifest: SessionManifest;
  db: DatabaseSync;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_PAGE_SIZE = 1000;

function jsonValue(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => typeof candidate === 'bigint' ? candidate.toString() : candidate);
}

function numericType(type: string | undefined): boolean {
  return /INT|DECIMAL|NUMERIC|NUMBER|REAL|FLOAT|DOUBLE|MONEY/i.test(type ?? '');
}

interface ExactDecimal { sign: 1 | -1; digits: bigint; scale: number; }

function exactDecimal(value: unknown): ExactDecimal | undefined {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'object') return undefined;
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) return undefined;
  const fraction = match[3] ?? '';
  let digits = BigInt(`${match[2]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale -= 1; }
  return { sign: match[1] === '-' ? -1 : 1, digits, scale };
}

function decimalText(value: ExactDecimal): string {
  if (value.digits === 0n) return '0';
  let digits = value.digits.toString();
  if (value.scale > 0) {
    if (digits.length <= value.scale) digits = `${'0'.repeat(value.scale - digits.length + 1)}${digits}`;
    const point = digits.length - value.scale;
    digits = `${digits.slice(0, point)}.${digits.slice(point)}`;
    digits = digits.replace(/0+$/u, '').replace(/\.$/u, '');
  }
  return `${value.sign < 0 ? '-' : ''}${digits}`;
}

function numericOutput(value: ExactDecimal): number | string {
  const text = decimalText(value);
  const number = Number(text);
  const roundTrip = Number.isFinite(number) ? exactDecimal(number) : undefined;
  const normalized = exactDecimal(text);
  const safeEnough = Boolean(normalized && normalized.digits.toString().length <= 15 && (!Number.isInteger(number) || Number.isSafeInteger(number)));
  return safeEnough && roundTrip && normalized && compareDecimals(roundTrip, normalized) === 0 ? number : text;
}

function signedDigits(value: ExactDecimal): bigint { return value.sign < 0 ? -value.digits : value.digits; }

function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const sum = signedDigits(left) * 10n ** BigInt(scale - left.scale) + signedDigits(right) * 10n ** BigInt(scale - right.scale);
  return { sign: sum < 0n ? -1 : 1, digits: sum < 0n ? -sum : sum, scale };
}

function averageDecimal(sum: ExactDecimal, count: number): number | string | null {
  if (count <= 0 || sum.digits === 0n) return count <= 0 ? null : '0';
  const precision = 20;
  const scaled = (signedDigits(sum) * 10n ** BigInt(precision)) / BigInt(count);
  const sign: 1 | -1 = scaled < 0n ? -1 : 1;
  const digits = scaled < 0n ? -scaled : scaled;
  return numericOutput({ sign, digits, scale: sum.scale + precision });
}

function compareDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const signedLeft = signedDigits(left) * 10n ** BigInt(Math.max(left.scale, right.scale) - left.scale);
  const signedRight = signedDigits(right) * 10n ** BigInt(Math.max(left.scale, right.scale) - right.scale);
  return signedLeft < signedRight ? -1 : signedLeft > signedRight ? 1 : 0;
}

function compareValues(left: unknown, right: unknown, numeric: boolean): number {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : -1;
  if (right === null || right === undefined) return 1;
  if (numeric) {
    const leftNumber = exactDecimal(left);
    const rightNumber = exactDecimal(right);
    if (leftNumber && rightNumber) return compareDecimals(leftNumber, rightNumber);
  }
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base', numeric: false });
}

function filterSql(manifest: SessionManifest, request: QueryPageRequest): { where: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  const globalFilter = request.globalFilter?.trim();
  if (globalFilter) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(rows.payload) WHERE CAST(json_each.value AS TEXT) LIKE ? COLLATE NOCASE)`);
    params.push(`%${globalFilter}%`);
  }
  for (const filter of request.columnFilters ?? []) {
    if (!Number.isInteger(filter.columnIndex) || filter.columnIndex < 0 || filter.columnIndex >= manifest.columns.length || !filter.value.trim()) continue;
    conditions.push(`CAST(json_extract(rows.payload, '$[${filter.columnIndex}]') AS TEXT) LIKE ? COLLATE NOCASE`);
    params.push(`%${filter.value.trim()}%`);
  }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function orderSql(manifest: SessionManifest, sorting: QuerySortSpec[] | undefined): string {
  const valid = (sorting ?? []).filter(item => Number.isInteger(item.columnIndex) && item.columnIndex >= 0 && item.columnIndex < manifest.columns.length);
  if (valid.length === 0) return 'ORDER BY rows.row_index ASC';
  const clauses = valid.map(item => {
    const expression = `json_extract(rows.payload, '$[${item.columnIndex}]')`;
    // Numeric columns are sorted by compareValues() in page(), which keeps
    // large integers/DECIMAL values out of SQLite's REAL conversion path.
    const valueExpression = `CAST(${expression} AS TEXT) COLLATE NOCASE`;
    return `${valueExpression} ${item.desc ? 'DESC' : 'ASC'}`;
  });
  return `ORDER BY ${clauses.join(', ')}, rows.row_index ASC`;
}

function hasNumericSorting(manifest: SessionManifest, sorting: QuerySortSpec[] | undefined): boolean {
  return (sorting ?? []).some(item => Number.isInteger(item.columnIndex) && item.columnIndex >= 0 && item.columnIndex < manifest.columns.length && numericType(manifest.columns[item.columnIndex]?.type));
}

export class QuerySessionManager {
  private readonly root: string;
  private readonly open = new Map<string, OpenSession>();

  public constructor(dataDir: string, private readonly ttlMs = DEFAULT_TTL_MS) {
    this.root = path.join(dataDir, 'query-sessions');
    mkdirSync(this.root, { recursive: true });
  }

  public create(queryId: string, userId: string, connectionId: string, columns: QueryColumn[], statementIndex = 0, statementCount = 1): string {
    const sessionId = randomUUID();
    const now = Date.now();
    const manifest: SessionManifest = { sessionId, queryId, userId, connectionId, statementIndex, statementCount, columns, totalRows: 0, createdAt: now, expiresAt: now + this.ttlMs, completed: false };
    const db = new DatabaseSync(this.databasePath(sessionId));
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = NORMAL; CREATE TABLE rows (row_index INTEGER PRIMARY KEY, payload TEXT NOT NULL);');
    this.open.set(sessionId, { manifest, db });
    this.writeManifest(manifest);
    return sessionId;
  }

  public appendRows(userId: string, sessionId: string, rows: unknown[][]): number {
    const session = this.require(userId, sessionId);
    if (rows.length === 0) return session.manifest.totalRows ?? this.count(session.db);
    const start = session.manifest.totalRows ?? this.count(session.db);
    const statement = session.db.prepare('INSERT INTO rows (row_index, payload) VALUES (?, ?)');
    session.db.exec('BEGIN');
    try {
      rows.forEach((row, index) => statement.run(start + index, jsonValue(row)));
      session.db.exec('COMMIT');
    } catch (error: unknown) {
      session.db.exec('ROLLBACK');
      throw error;
    }
    session.manifest.totalRows = start + rows.length;
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return session.manifest.totalRows;
  }

  public setColumns(userId: string, sessionId: string, columns: QueryColumn[]): void {
    const session = this.require(userId, sessionId);
    session.manifest.columns = columns;
    this.writeManifest(session.manifest);
  }

  public complete(userId: string, sessionId: string, metadata?: { rowsAffected?: number; limitReached?: boolean; message?: string }): number {
    const session = this.require(userId, sessionId);
    if (metadata?.rowsAffected !== undefined) session.manifest.rowsAffected = metadata.rowsAffected;
    if (metadata?.limitReached !== undefined) session.manifest.limitReached = metadata.limitReached;
    if (metadata?.message !== undefined) session.manifest.message = metadata.message;
    session.manifest.completed = true;
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return session.manifest.totalRows ?? this.count(session.db);
  }

  public page(userId: string, sessionId: string, request: QueryPageRequest): QueryPageResponse {
    const session = this.require(userId, sessionId);
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.limit ?? 200)));
    const filtered = filterSql(session.manifest, request);
    const countRow = session.db.prepare(`SELECT COUNT(*) AS count FROM rows ${filtered.where}`).get(...filtered.params) as { count: number };
    let values: unknown[][];
    if (hasNumericSorting(session.manifest, request.sorting)) {
      const storedRows = session.db.prepare(`SELECT row_index, payload FROM rows ${filtered.where}`).all(...filtered.params) as Array<{ row_index: number; payload: string }>;
      const sorting = (request.sorting ?? []).filter(item => Number.isInteger(item.columnIndex) && item.columnIndex >= 0 && item.columnIndex < session.manifest.columns.length);
      storedRows.sort((left, right) => {
        const leftRow = JSON.parse(left.payload) as unknown[];
        const rightRow = JSON.parse(right.payload) as unknown[];
        for (const item of sorting) {
          const comparison = compareValues(leftRow[item.columnIndex], rightRow[item.columnIndex], numericType(session.manifest.columns[item.columnIndex]?.type));
          if (comparison !== 0) return item.desc ? -comparison : comparison;
        }
        return left.row_index - right.row_index;
      });
      values = storedRows.slice(offset, offset + limit).map(row => JSON.parse(row.payload) as unknown[]);
    } else {
      const rows = session.db.prepare(`SELECT payload FROM rows ${filtered.where} ${orderSql(session.manifest, request.sorting)} LIMIT ? OFFSET ?`).all(...filtered.params, limit, offset) as Array<{ payload: string }>;
      values = rows.map(row => JSON.parse(row.payload) as unknown[]);
    }
    const totalRows = Number(countRow.count);
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return {
      sessionId,
      statementIndex: session.manifest.statementIndex,
      columns: session.manifest.columns,
      rows: values,
      offset,
      limit,
      totalRows,
      hasMore: offset + values.length < totalRows,
      rowsAffected: session.manifest.rowsAffected,
      limitReached: session.manifest.limitReached,
      message: session.manifest.message,
    };
  }

  public aggregate(userId: string, sessionId: string, request: QueryAggregateRequest = {}): QueryAggregateResponse {
    const session = this.require(userId, sessionId);
    const filtered = filterSql(session.manifest, request);
    const countRow = session.db.prepare(`SELECT COUNT(*) AS filtered_row_count FROM rows ${filtered.where}`).get(...filtered.params) as { filtered_row_count: number };
    const requestedFunctions = Array.isArray(request.functions) ? request.functions.filter(fn => ['count', 'sum', 'avg', 'min', 'max'].includes(fn)) : [];
    const functions = new Set(requestedFunctions.length > 0 ? requestedFunctions : ['count', 'sum', 'avg', 'min', 'max']);
    const requestedColumns = Array.isArray(request.columnIndices) ? request.columnIndices : [];
    const columnIndices = (requestedColumns.length > 0 ? requestedColumns : session.manifest.columns.map((_column, index) => index))
      .filter(index => Number.isInteger(index) && index >= 0 && index < session.manifest.columns.length);
    if (columnIndices.length === 0) return { statementIndex: session.manifest.statementIndex, filteredRowCount: Number(countRow.filtered_row_count), values: [] };

    const storedRows = session.db.prepare(`SELECT payload FROM rows ${filtered.where}`).all(...filtered.params) as Array<{ payload: string }>;
    const values: QueryAggregateValue[] = columnIndices.map(columnIndex => {
      const numeric = numericType(session.manifest.columns[columnIndex]?.type);
      const columnValues = storedRows.map(row => (JSON.parse(row.payload) as unknown[])[columnIndex]).filter(value => value !== null && value !== undefined);
      const numericValues = numeric ? columnValues.map(exactDecimal).filter((value): value is ExactDecimal => value !== undefined) : [];
      let sum: ExactDecimal | undefined;
      for (const value of numericValues) sum = sum ? addDecimals(sum, value) : value;
      let min: unknown;
      let max: unknown;
      for (const value of columnValues) {
        if (min === undefined || compareValues(value, min, numeric) < 0) min = value;
        if (max === undefined || compareValues(value, max, numeric) > 0) max = value;
      }
      return {
        columnIndex,
        count: functions.has('count') ? columnValues.length : 0,
        sum: functions.has('sum') && numeric ? (sum ? numericOutput(sum) : null) : undefined,
        avg: functions.has('avg') && numeric ? (sum ? averageDecimal(sum, numericValues.length) : null) : undefined,
        min: functions.has('min') ? min ?? null : undefined,
        max: functions.has('max') ? max ?? null : undefined,
      };
    });
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return { statementIndex: session.manifest.statementIndex, filteredRowCount: Number(countRow.filtered_row_count), values };
  }

  public group(userId: string, sessionId: string, request: QueryGroupRequest): QueryGroupResponse {
    const session = this.require(userId, sessionId);
    const groupIndices = [...new Set((request.groupByColumnIndices ?? []).filter(index => Number.isInteger(index) && index >= 0 && index < session.manifest.columns.length))];
    if (groupIndices.length === 0) throw new Error('Select at least one valid grouping column.');
    const filtered = filterSql(session.manifest, request);
    const aggregateInputs = Array.isArray(request.aggregates) ? request.aggregates : [{ function: 'count' as const }];
    const outputColumns: QueryColumn[] = groupIndices.map(index => ({ name: session.manifest.columns[index]?.name ?? `Column ${index + 1}`, type: session.manifest.columns[index]?.type }));
    const aggregateSpecs = aggregateInputs.flatMap(aggregate => {
      const functionName = aggregate.function;
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(functionName)) return [];
      const hasColumn = Number.isInteger(aggregate.columnIndex) && (aggregate.columnIndex ?? -1) >= 0 && (aggregate.columnIndex ?? -1) < session.manifest.columns.length;
      if (functionName !== 'count' && !hasColumn) return [];
      const columnName = hasColumn ? session.manifest.columns[aggregate.columnIndex ?? 0]?.name ?? `Column ${(aggregate.columnIndex ?? 0) + 1}` : '*';
      outputColumns.push({ name: `${functionName.toUpperCase()}(${columnName})`, type: functionName === 'count' ? 'BIGINT' : numericType(session.manifest.columns[aggregate.columnIndex ?? 0]?.type) ? 'DECIMAL' : session.manifest.columns[aggregate.columnIndex ?? 0]?.type });
      return [{ functionName, columnIndex: hasColumn ? aggregate.columnIndex : undefined }];
    });
    if (aggregateSpecs.length === 0) {
      aggregateSpecs.push({ functionName: 'count', columnIndex: undefined });
      outputColumns.push({ name: 'COUNT(*)', type: 'BIGINT' });
    }
    const storedRows = session.db.prepare(`SELECT payload FROM rows ${filtered.where}`).all(...filtered.params) as Array<{ payload: string }>;
    const groups = new Map<string, { values: unknown[]; rows: unknown[][] }>();
    for (const stored of storedRows) {
      const row = JSON.parse(stored.payload) as unknown[];
      const groupValues = groupIndices.map(index => row[index]);
      const key = JSON.stringify(groupValues, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      const group = groups.get(key) ?? { values: groupValues, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    const aggregateValue = (spec: { functionName: string; columnIndex?: number }, rows: unknown[][]): unknown => {
      const values = spec.columnIndex === undefined ? rows : rows.map(row => row[spec.columnIndex!]).filter(value => value !== null && value !== undefined);
      if (spec.functionName === 'count') return values.length;
      const numeric = numericType(session.manifest.columns[spec.columnIndex ?? 0]?.type);
      if (spec.functionName === 'sum' || spec.functionName === 'avg') {
        const numbers = numeric ? values.map(exactDecimal).filter((value): value is ExactDecimal => value !== undefined) : [];
        let sum: ExactDecimal | undefined;
        for (const value of numbers) sum = sum ? addDecimals(sum, value) : value;
        return spec.functionName === 'sum' ? (sum ? numericOutput(sum) : null) : (sum ? averageDecimal(sum, numbers.length) : null);
      }
      let selected: unknown;
      for (const value of values) if (selected === undefined || compareValues(value, selected, numeric) < 0 === (spec.functionName === 'min')) selected = value;
      return selected ?? null;
    };
    const grouped = [...groups.values()].map(group => ({ values: group.values, aggregates: aggregateSpecs.map(spec => aggregateValue(spec, group.rows)) }));
    const groupLimit = Math.min(10_000, Math.max(1, Math.floor(request.groupLimit ?? 1_000)));
    const firstSpec = aggregateSpecs[0]!;
    grouped.sort((left, right) => {
      const comparison = compareValues(left.aggregates[0], right.aggregates[0], firstSpec?.columnIndex !== undefined && numericType(session.manifest.columns[firstSpec.columnIndex]?.type));
      return comparison === 0 ? 0 : -comparison;
    });
    const rows = grouped.slice(0, groupLimit).map(group => [...group.values, ...group.aggregates]);
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return { statementIndex: session.manifest.statementIndex, columns: outputColumns, rows, totalGroups: groups.size };
  }

  public columns(userId: string, sessionId: string): QueryColumn[] {
    return [...this.require(userId, sessionId).manifest.columns];
  }

  /**
   * Reads a result in bounded pages. SQLite keeps the complete result on disk,
   * so callers can stream it to an HTTP response without building a second
   * in-memory copy.
   */
  public async *streamRows(userId: string, sessionId: string, request: QueryPageRequest = {}): AsyncGenerator<unknown[][]> {
    let offset = Math.max(0, Math.floor(request.offset ?? 0));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(request.limit ?? MAX_PAGE_SIZE)));
    while (true) {
      const page = this.page(userId, sessionId, { ...request, offset, limit: pageSize });
      if (page.rows.length === 0) return;
      yield page.rows;
      offset += page.rows.length;
      if (!page.hasMore) return;
    }
  }

  public manifest(userId: string, sessionId: string): SessionManifest {
    return { ...this.require(userId, sessionId).manifest, columns: [...this.require(userId, sessionId).manifest.columns] };
  }

  public querySessionId(userId: string, queryId: string, statementIndex = 0): string | undefined {
    for (const manifest of this.manifests()) if (manifest.userId === userId && manifest.queryId === queryId && (manifest.statementIndex ?? 0) === statementIndex) return manifest.sessionId;
    return undefined;
  }

  public delete(userId: string, sessionId: string): boolean {
    const manifest = this.readManifest(sessionId);
    if (!manifest || manifest.userId !== userId) return false;
    this.close(sessionId);
    rmSync(this.databasePath(sessionId), { force: true });
    rmSync(this.manifestPath(sessionId), { force: true });
    return true;
  }

  public cleanup(now = Date.now()): void {
    for (const manifest of this.manifests()) if (manifest.expiresAt <= now) {
      this.close(manifest.sessionId);
      rmSync(this.databasePath(manifest.sessionId), { force: true });
      rmSync(this.manifestPath(manifest.sessionId), { force: true });
    }
  }

  public closeAll(): void {
    for (const sessionId of this.open.keys()) this.close(sessionId);
  }

  /** Remove all result spools after an administrative data restore. */
  public clearAll(): void {
    for (const manifest of this.manifests()) {
      this.close(manifest.sessionId);
      rmSync(this.databasePath(manifest.sessionId), { force: true });
      rmSync(this.manifestPath(manifest.sessionId), { force: true });
    }
  }

  private require(userId: string, sessionId: string): OpenSession {
    const existing = this.open.get(sessionId);
    const manifest = existing?.manifest ?? this.readManifest(sessionId);
    if (!manifest || manifest.userId !== userId || manifest.expiresAt <= Date.now()) throw new Error('Query result session is unavailable or expired.');
    if (existing) return existing;
    if (!existsSync(this.databasePath(sessionId))) throw new Error('Query result data is unavailable.');
    const db = new DatabaseSync(this.databasePath(sessionId));
    const session = { manifest, db };
    this.open.set(sessionId, session);
    return session;
  }

  private count(db: DatabaseSync): number {
    const row = db.prepare('SELECT COUNT(*) AS count FROM rows').get() as { count: number };
    return Number(row.count);
  }

  private manifests(): SessionManifest[] {
    return readdirSync(this.root, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.json')).flatMap(entry => {
      try {
        const manifest = JSON.parse(readFileSync(path.join(this.root, entry.name), 'utf8')) as SessionManifest;
        // Manifests written before multi-statement results existed are still valid.
        manifest.statementIndex = Number.isInteger(manifest.statementIndex) ? manifest.statementIndex : 0;
        manifest.statementCount = Number.isInteger(manifest.statementCount) ? manifest.statementCount : 1;
        return [manifest];
      } catch { return []; }
    });
  }

  private readManifest(sessionId: string): SessionManifest | undefined {
    try {
      const manifest = JSON.parse(readFileSync(this.manifestPath(sessionId), 'utf8')) as SessionManifest;
      // Manifests written before multi-statement results existed are still valid.
      manifest.statementIndex = Number.isInteger(manifest.statementIndex) ? manifest.statementIndex : 0;
      manifest.statementCount = Number.isInteger(manifest.statementCount) ? manifest.statementCount : 1;
      return manifest;
    } catch { return undefined; }
  }

  private writeManifest(manifest: SessionManifest): void {
    writeFileSync(this.manifestPath(manifest.sessionId), JSON.stringify(manifest), 'utf8');
  }

  private databasePath(sessionId: string): string { return path.join(this.root, `${sessionId}.sqlite`); }
  private manifestPath(sessionId: string): string { return path.join(this.root, `${sessionId}.json`); }

  private close(sessionId: string): void {
    this.open.get(sessionId)?.db.close();
    this.open.delete(sessionId);
  }
}
