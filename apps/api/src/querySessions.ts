import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { QueryColumn, QueryPageRequest, QueryPageResponse, QuerySortSpec } from '@justybase/contracts';

interface SessionManifest {
  sessionId: string;
  queryId: string;
  userId: string;
  connectionId: string;
  columns: QueryColumn[];
  totalRows?: number;
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
    const valueExpression = numericType(manifest.columns[item.columnIndex]?.type) ? `CAST(${expression} AS REAL)` : `CAST(${expression} AS TEXT) COLLATE NOCASE`;
    return `${valueExpression} ${item.desc ? 'DESC' : 'ASC'}`;
  });
  return `ORDER BY ${clauses.join(', ')}, rows.row_index ASC`;
}

export class QuerySessionManager {
  private readonly root: string;
  private readonly open = new Map<string, OpenSession>();

  public constructor(dataDir: string, private readonly ttlMs = DEFAULT_TTL_MS) {
    this.root = path.join(dataDir, 'query-sessions');
    mkdirSync(this.root, { recursive: true });
  }

  public create(queryId: string, userId: string, connectionId: string, columns: QueryColumn[]): string {
    const sessionId = randomUUID();
    const now = Date.now();
    const manifest: SessionManifest = { sessionId, queryId, userId, connectionId, columns, totalRows: 0, createdAt: now, expiresAt: now + this.ttlMs, completed: false };
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

  public complete(userId: string, sessionId: string): number {
    const session = this.require(userId, sessionId);
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
    const rows = session.db.prepare(`SELECT payload FROM rows ${filtered.where} ${orderSql(session.manifest, request.sorting)} LIMIT ? OFFSET ?`).all(...filtered.params, limit, offset) as Array<{ payload: string }>;
    const values = rows.map(row => JSON.parse(row.payload) as unknown[]);
    const totalRows = Number(countRow.count);
    session.manifest.expiresAt = Date.now() + this.ttlMs;
    this.writeManifest(session.manifest);
    return { sessionId, columns: session.manifest.columns, rows: values, offset, limit, totalRows, hasMore: offset + values.length < totalRows };
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

  public querySessionId(userId: string, queryId: string): string | undefined {
    for (const manifest of this.manifests()) if (manifest.userId === userId && manifest.queryId === queryId) return manifest.sessionId;
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
      try { return [JSON.parse(readFileSync(path.join(this.root, entry.name), 'utf8')) as SessionManifest]; } catch { return []; }
    });
  }

  private readManifest(sessionId: string): SessionManifest | undefined {
    try { return JSON.parse(readFileSync(this.manifestPath(sessionId), 'utf8')) as SessionManifest; } catch { return undefined; }
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
