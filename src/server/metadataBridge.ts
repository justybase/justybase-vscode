import type {
  MetadataColumnItem,
  MetadataContextResponse,
  MetadataObjectItem,
  MetadataRequestParams,
  MetadataResponse,
  MetadataTableInfoResponse,
} from "../lsp/protocol";
import type {
  QualificationProposal,
  TableQualificationRequest,
} from "../core/tableQualificationResolver";
import { getMetadataQueryConcurrencyLimit } from "../metadata/metadataQueryLimiter";
import { simpleHash } from "../providers/parsers/hashUtils";
import { extractTableReferences } from "./diagnosticsUtils";
import type { MetadataColumnLookupOptions } from "../metadata/metadataQueryDiagnostics";
import { createNetezzaUserIdentifier } from "../dialects/netezza/metadata/identifierUtils";

function hasUsableTableInfo(
  tableInfo: MetadataTableInfoResponse | undefined,
): tableInfo is MetadataTableInfoResponse {
  return Boolean(
    tableInfo
    && (
      tableInfo.columns.length > 0
      || tableInfo.exists === false
      || tableInfo.columnsComplete === true
    ),
  );
}

export interface Logger {
  error: (message: string) => void;
}

export class MetadataBridge {
  private static readonly LIST_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

  private readonly tableInfoCache = new Map<
    string,
    MetadataTableInfoResponse
  >();

  private readonly listCache = new Map<
    string,
    { data: MetadataObjectItem[]; timestamp: number }
  >();

  private readonly listFetchInFlight = new Map<
    string,
    { epoch: number; promise: Promise<MetadataObjectItem[]> }
  >();

  private readonly documentListEpoch = new Map<string, number>();
  private readonly documentConnectionNames = new Map<string, string>();
  private readonly documentDatabaseKinds = new Map<
    string,
    MetadataContextResponse["databaseKind"] | null
  >();
  private readonly connectionDatabaseKinds = new Map<
    string,
    MetadataContextResponse["databaseKind"] | null
  >();
  private readonly validationWarmFingerprint = new Map<string, string>();
  private readonly validationMetadataEpoch = new Map<string, number>();
  private readonly qualificationCache = new Map<string, QualificationProposal[]>();

  constructor(
    private readonly sendRequest: (
      params: MetadataRequestParams,
    ) => Promise<MetadataResponse>,
    private readonly logger?: Logger,
  ) {}

  async getContext(documentUri: string): Promise<MetadataContextResponse> {
    const response = await this.request({
      documentUri,
      kind: "context",
    });
    const context = this.asContextResponse(response) ?? {};
    if (context.connectionName) {
      this.documentConnectionNames.set(documentUri, context.connectionName);
      this.connectionDatabaseKinds.set(
        context.connectionName,
        context.databaseKind ?? null,
      );
    }
    this.documentDatabaseKinds.set(documentUri, context.databaseKind ?? null);
    return context;
  }

  async getDatabases(documentUri: string): Promise<MetadataObjectItem[]> {
    const cacheKey = `DBS|${documentUri}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "databases" }),
    );
  }

  async getSchemas(
    documentUri: string,
    database: string,
  ): Promise<MetadataObjectItem[]> {
    const cacheKey = `SCH|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "schemas", database }),
    );
  }

  async getTables(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]> {
    const cacheKey = `TBL|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}|${this.normalizeIdentifierForCache(documentUri, schema ?? "")}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "tables", database, schema }),
    );
  }

  async getViews(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]> {
    const cacheKey = `VEW|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}|${this.normalizeIdentifierForCache(documentUri, schema ?? "")}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "views", database, schema }),
    );
  }

  async getSourceObjects(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]> {
    const cacheKey = `SRC|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}|${this.normalizeIdentifierForCache(documentUri, schema ?? "")}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "sourceObjects", database, schema }),
    );
  }

  async getProcedures(
    documentUri: string,
    database: string,
    schema?: string,
  ): Promise<MetadataObjectItem[]> {
    const cacheKey = `PRC|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}|${this.normalizeIdentifierForCache(documentUri, schema ?? "")}`;
    return this.getCachedOrFetchList(cacheKey, () =>
      this.requestList({ documentUri, kind: "procedures", database, schema }),
    );
  }

  async getColumns(
    documentUri: string,
    database: string,
    table: string,
    schema?: string,
    options?: MetadataColumnLookupOptions,
  ): Promise<MetadataColumnItem[]> {
    if (options?.allowDatabaseFetch === false) {
      // `cachedTableInfo` is explicitly backed by the extension-host cache;
      // unlike `tableInfo`/`columns`, it never performs a live catalog fetch.
      // Keep this request so LSP completion can consume the initial per-
      // connection prefetch even though the language server has its own cache.
      const cachedTableInfo = await this.getCachedTableInfo(
        documentUri,
        database,
        table,
        schema,
      );
      return cachedTableInfo?.columns ?? [];
    }

    if (options?.allowPublicSynonym) {
      const connectionName = await this.resolveConnectionName(documentUri);
      const cacheKey = connectionName
        ? this.buildTableCacheKey(connectionName, database, schema, table)
        : undefined;
      const cached = cacheKey ? this.tableInfoCache.get(cacheKey) : undefined;
      if (
        cached
        && (cached.columns.length > 0 || cached.columnsComplete === true)
      ) {
        return cached.columns;
      }

      const response = await this.request({
        documentUri,
        kind: "columns",
        database,
        schema,
        table,
        allowPublicSynonym: true,
      });
      const columns = this.asColumnList(response);
      if (cacheKey && columns.length > 0) {
        this.cacheTableInfo(documentUri, cacheKey, {
          exists: true,
          table,
          database,
          schema,
          columns,
        });
      }
      return columns;
    }

    const tableInfo = await this.getCachedTableInfo(
      documentUri,
      database,
      table,
      schema,
    );
    if (
      tableInfo
      && (tableInfo.columns.length > 0 || tableInfo.columnsComplete === true)
    ) {
      return tableInfo.columns;
    }

    const fetched = await this.getTableInfo(
      documentUri,
      database,
      table,
      schema,
    );
    if (
      fetched
      && (fetched.columns.length > 0 || fetched.columnsComplete === true)
    ) {
      return fetched.columns;
    }

    const response = await this.request({
      documentUri,
      kind: "columns",
      database,
      schema,
      table,
    });
    return this.asColumnList(response);
  }

  async getNetezzaDefaultSchema(
    documentUri: string,
    database: string,
  ): Promise<string | undefined> {
    const response = await this.request({
      documentUri,
      kind: "netezzaDefaultSchema",
      database,
    });
    return typeof response === "string" ? response : undefined;
  }

  async getTableInfo(
    documentUri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataTableInfoResponse | undefined> {
    const cached = await this.getCachedTableInfo(
      documentUri,
      database,
      table,
      schema,
    );
    if (hasUsableTableInfo(cached)) {
      return cached;
    }

    const connectionName = await this.resolveConnectionName(documentUri);
    const cacheKey = this.buildTableCacheKey(
      connectionName,
      database,
      schema,
      table,
    );
    const localCached = this.tableInfoCache.get(cacheKey);
    if (hasUsableTableInfo(localCached)) {
      return localCached;
    }

    const response = await this.request({
      documentUri,
      kind: "tableInfo",
      database,
      schema,
      table,
    });
    const tableInfo = this.asTableInfo(response);
    if (!tableInfo) {
      return undefined;
    }

    this.cacheTableInfo(documentUri, cacheKey, tableInfo);
    return tableInfo;
  }

  async getCachedTableInfo(
    documentUri: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<MetadataTableInfoResponse | undefined> {
    const connectionName = await this.resolveConnectionName(documentUri);
    const cacheKey = this.buildTableCacheKey(
      connectionName,
      database,
      schema,
      table,
    );
    const cached = this.tableInfoCache.get(cacheKey);
    if (hasUsableTableInfo(cached)) {
      return cached;
    }

    const response = await this.request({
      documentUri,
      kind: "cachedTableInfo",
      database,
      schema,
      table,
    });
    const tableInfo = this.asTableInfo(response);
    if (!tableInfo) {
      return undefined;
    }

    this.cacheTableInfo(documentUri, cacheKey, tableInfo);
    return tableInfo;
  }

  getValidationMetadataEpoch(documentUri: string): number {
    return this.validationMetadataEpoch.get(documentUri) ?? 0;
  }

  findCachedTableInfo(
    documentUri: string,
    table: string,
    database?: string,
    schema?: string,
  ): MetadataTableInfoResponse | undefined {
    const connectionName = this.documentConnectionNames.get(documentUri);
    if (connectionName && database) {
      const cacheKey = this.buildTableCacheKey(
        connectionName,
        database,
        schema,
        table,
      );
      const direct = this.tableInfoCache.get(cacheKey);
      if (hasUsableTableInfo(direct)) {
        return direct;
      }
    }

    const normalizedTable = this.normalizeIdentifierForCache(documentUri, table);
    const normalizedDatabase = database
      ? this.normalizeIdentifierForCache(documentUri, database)
      : undefined;
    const normalizedSchema = schema
      ? this.normalizeIdentifierForCache(documentUri, schema)
      : undefined;

    for (const [cacheKey, info] of this.tableInfoCache.entries()) {
      const parsed = this.parseTableCacheKey(cacheKey);
      if (!parsed) {
        continue;
      }
      if (
        connectionName &&
        parsed.connectionName.toUpperCase() !== connectionName.toUpperCase()
      ) {
        continue;
      }
      if (this.normalizeIdentifierForCache(documentUri, parsed.table) !== normalizedTable) {
        continue;
      }
      if (
        normalizedDatabase &&
        this.normalizeIdentifierForCache(documentUri, parsed.database) !== normalizedDatabase
      ) {
        continue;
      }
      if (
        normalizedSchema &&
        this.normalizeIdentifierForCache(documentUri, parsed.schema || "") !== normalizedSchema
      ) {
        continue;
      }
      if (!hasUsableTableInfo(info)) {
        continue;
      }
      return info;
    }

    return undefined;
  }

  hasAnyTableInfo(documentUri: string): boolean {
    const connectionName = this.documentConnectionNames.get(documentUri);
    if (!connectionName) {
      return false;
    }

    const prefix = `${connectionName.toUpperCase()}|`;
    for (const cacheKey of this.tableInfoCache.keys()) {
      if (cacheKey.toUpperCase().startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  hasCachedTableListForDatabase(
    documentUri: string,
    database: string,
  ): boolean {
    const prefix = `TBL|${documentUri}|${this.normalizeIdentifierForCache(documentUri, database)}|`;
    for (const cacheKey of this.listCache.keys()) {
      if (cacheKey.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  getCachedQualificationProposals(
    documentUri: string,
    request: TableQualificationRequest,
  ): QualificationProposal[] {
    const cacheKey = this.buildQualificationCacheKey(
      documentUri,
      request.database,
      request.schema,
      request.name,
    );
    return this.qualificationCache.get(cacheKey) ?? [];
  }

  async qualifyTable(
    documentUri: string,
    request: TableQualificationRequest,
  ): Promise<QualificationProposal[]> {
    const cacheKey = this.buildQualificationCacheKey(
      documentUri,
      request.database,
      request.schema,
      request.name,
    );
    const cached = this.qualificationCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const response = await this.request({
      documentUri,
      kind: "qualifyTable",
      database: request.database,
      schema: request.schema,
      table: request.name,
    });
    const proposals = this.asQualificationProposals(response);
    this.qualificationCache.set(cacheKey, proposals);
    return proposals;
  }

  private asQualificationProposals(
    response: MetadataResponse,
  ): QualificationProposal[] {
    if (!Array.isArray(response) || response.length === 0) {
      return [];
    }
    const first = response[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "qualifiedText" in first &&
      typeof first.qualifiedText === "string"
    ) {
      return response as QualificationProposal[];
    }
    return [];
  }

  async warmValidationCache(
    documentUri: string,
    sql: string,
    sqlFragments?: readonly string[],
  ): Promise<MetadataContextResponse> {
    const context = await this.getContext(documentUri);
    if (!context.effectiveDatabase) {
      return context;
    }

    const references = extractTableReferences(
      sqlFragments && sqlFragments.length > 0 ? sqlFragments.join("\n") : sql,
      context.databaseKind,
    );
    const effectiveDatabase = context.effectiveDatabase;
    const refsFingerprint = this.computeValidationRefsFingerprint(documentUri, references);
    const previousFingerprint = this.validationWarmFingerprint.get(documentUri);

    if (
      previousFingerprint === refsFingerprint &&
      (await this.areValidationReferencesCached(
        documentUri,
        references,
        effectiveDatabase,
      ))
    ) {
      const underQualifiedReferences = references.filter(
        (reference) => !isFullyQualifiedReference(reference, context.databaseKind),
      );
      if (
        underQualifiedReferences.length > 0 &&
        !this.areQualificationProposalsCached(
          documentUri,
          underQualifiedReferences,
        )
      ) {
        await this.warmQualificationProposals(
          documentUri,
          underQualifiedReferences,
        );
        this.bumpValidationMetadataEpoch(documentUri);
      }
      return context;
    }

    const databasesToWarm = new Set<string>();

    for (const reference of references) {
      const database = reference.database || effectiveDatabase;
      if (!database) {
        continue;
      }

      const cached = await this.getCachedTableInfo(
        documentUri,
        database,
        reference.table,
        reference.schema,
      );
      if (!hasUsableTableInfo(cached)) {
        databasesToWarm.add(database);
      }
    }

    if (databasesToWarm.size > 0) {
      await this.request({
        documentUri,
        kind: "warmDatabaseColumns",
        databases: Array.from(databasesToWarm),
      });

      const concurrencyLimit = getMetadataQueryConcurrencyLimit();
      for (let i = 0; i < references.length; i += concurrencyLimit) {
        const batch = references.slice(i, i + concurrencyLimit);
        await Promise.all(
          batch.map(async (reference) => {
            const database = reference.database || effectiveDatabase;
            if (!database) {
              return;
            }
            await this.getTableInfo(
              documentUri,
              database,
              reference.table,
              reference.schema,
            );
          }),
        );
      }

      this.bumpValidationMetadataEpoch(documentUri);
    }

    const underQualifiedReferences = references.filter(
      (reference) => !isFullyQualifiedReference(reference, context.databaseKind),
    );
    if (underQualifiedReferences.length > 0) {
      await this.warmQualificationProposals(
        documentUri,
        underQualifiedReferences,
      );
    }

    this.validationWarmFingerprint.set(documentUri, refsFingerprint);
    return context;
  }

  private areQualificationProposalsCached(
    documentUri: string,
    references: ReadonlyArray<{
      database?: string;
      schema?: string;
      table: string;
    }>,
  ): boolean {
    for (const reference of references) {
      const cacheKey = this.buildQualificationCacheKey(
        documentUri,
        reference.database,
        reference.schema,
        reference.table,
      );
      if (!this.qualificationCache.has(cacheKey)) {
        return false;
      }
    }
    return true;
  }

  private async warmQualificationProposals(
    documentUri: string,
    references: ReadonlyArray<{
      database?: string;
      schema?: string;
      table: string;
    }>,
  ): Promise<void> {
    const concurrencyLimit = getMetadataQueryConcurrencyLimit();
    for (let i = 0; i < references.length; i += concurrencyLimit) {
      const batch = references.slice(i, i + concurrencyLimit);
      await Promise.all(
        batch.map(async (reference) => {
          await this.qualifyTable(documentUri, {
            database: reference.database,
            schema: reference.schema,
            name: reference.table,
          });
        }),
      );
    }
  }

  clearDocument(documentUri: string): void {
    this.documentConnectionNames.delete(documentUri);
    this.documentDatabaseKinds.delete(documentUri);
    this.validationWarmFingerprint.delete(documentUri);
    this.validationMetadataEpoch.delete(documentUri);
    this.clearQualificationCacheForDocument(documentUri);

    const matchingListKey = (key: string): boolean =>
      this.extractDocUri(key) === documentUri;

    const staleKeys: string[] = [];
    for (const cacheKey of this.listCache.keys()) {
      if (matchingListKey(cacheKey)) {
        staleKeys.push(cacheKey);
      }
    }
    for (const cacheKey of this.listFetchInFlight.keys()) {
      if (!staleKeys.includes(cacheKey) && matchingListKey(cacheKey)) {
        staleKeys.push(cacheKey);
      }
    }
    staleKeys.forEach((key) => {
      this.listCache.delete(key);
      this.listFetchInFlight.delete(key);
    });

    const currentEpoch = this.documentListEpoch.get(documentUri) ?? 0;
    this.documentListEpoch.set(documentUri, currentEpoch + 1);
  }

  clearAll(): void {
    this.tableInfoCache.clear();
    this.listCache.clear();
    this.listFetchInFlight.clear();
    this.documentListEpoch.clear();
    this.documentConnectionNames.clear();
    this.documentDatabaseKinds.clear();
    this.connectionDatabaseKinds.clear();
    this.validationWarmFingerprint.clear();
    this.validationMetadataEpoch.clear();
    this.qualificationCache.clear();
  }

  /** Clears cached metadata only for documents bound to one connection. */
  clearConnection(connectionName: string): string[] {
    const normalized = connectionName.toUpperCase();
    const documentUris = Array.from(
      this.documentConnectionNames.entries(),
      ([documentUri, name]) => ({ documentUri, name }),
    )
      .filter(({ name }) => name.toUpperCase() === normalized)
      .map(({ documentUri }) => documentUri);

    const tablePrefix = `${normalized}|`;
    for (const cacheKey of this.tableInfoCache.keys()) {
      if (cacheKey.toUpperCase().startsWith(tablePrefix)) {
        this.tableInfoCache.delete(cacheKey);
      }
    }
    for (const documentUri of documentUris) {
      this.clearDocument(documentUri);
    }
    return documentUris;
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private cacheTableInfo(
    documentUri: string,
    cacheKey: string,
    tableInfo: MetadataTableInfoResponse,
  ): void {
    const previous = this.tableInfoCache.get(cacheKey);
    const hadColumns = (previous?.columns.length ?? 0) > 0;
    this.tableInfoCache.set(cacheKey, tableInfo);
    if (!hadColumns && tableInfo.columns.length > 0) {
      this.bumpValidationMetadataEpoch(documentUri);
    }
  }

  private bumpValidationMetadataEpoch(documentUri: string): void {
    this.validationMetadataEpoch.set(
      documentUri,
      this.getValidationMetadataEpoch(documentUri) + 1,
    );
  }

  private computeValidationRefsFingerprint(
    documentUri: string,
    references: ReturnType<typeof extractTableReferences>,
  ): string {
    const serialized = references
      .map(
        (reference) =>
          `${this.normalizeIdentifierForCache(documentUri, reference.database ?? "")}|${this.normalizeIdentifierForCache(documentUri, reference.schema ?? "")}|${this.normalizeIdentifierForCache(documentUri, reference.table)}`,
      )
      .sort()
      .join(";");
    return simpleHash(serialized);
  }

  private async areValidationReferencesCached(
    documentUri: string,
    references: ReturnType<typeof extractTableReferences>,
    effectiveDatabase: string,
  ): Promise<boolean> {
    for (const reference of references) {
      const database = reference.database || effectiveDatabase;
      if (!database) {
        continue;
      }

      const cached = await this.getCachedTableInfo(
        documentUri,
        database,
        reference.table,
        reference.schema,
      );
      if (!hasUsableTableInfo(cached)) {
        return false;
      }
    }

    return true;
  }

  private async resolveConnectionName(
    documentUri: string,
  ): Promise<string | undefined> {
    const cached = this.documentConnectionNames.get(documentUri);
    if (cached) {
      return cached;
    }

    const context = await this.getContext(documentUri);
    return context.connectionName;
  }

  private async getCachedOrFetchList(
    cacheKey: string,
    fetchFn: () => Promise<MetadataResponse>,
  ): Promise<MetadataObjectItem[]> {
    const cached = this.listCache.get(cacheKey);
    if (
      cached &&
      Date.now() - cached.timestamp < MetadataBridge.LIST_CACHE_TTL_MS
    ) {
      return cached.data;
    }

    const inFlight = this.listFetchInFlight.get(cacheKey);
    if (inFlight) {
      return await inFlight.promise;
    }

    const docEpochKey = this.extractDocUri(cacheKey);
    const startEpoch = this.documentListEpoch.get(docEpochKey) ?? 0;

    const promise = (async () => {
      try {
        const response = await fetchFn();
        this.listFetchInFlight.delete(cacheKey);
        if (response === null) {
          return [];
        }
        const currentEpoch = this.documentListEpoch.get(docEpochKey) ?? 0;
        if (currentEpoch !== startEpoch) {
          return this.asObjectList(response);
        }
        const data = this.asObjectList(response);
        // A Netezza list request is deliberately cache-only: it must never
        // make completion issue a live catalog query.  During cold start that
        // cache can legitimately be empty while the background prefetch is
        // still running.  Do not turn that transient miss into a 12-hour
        // negative cache entry, otherwise completion stays empty after the
        // host cache is populated.
        const isNetezzaCacheOnly =
          this.documentDatabaseKinds.get(docEpochKey) === "netezza";
        if (data.length > 0 || !isNetezzaCacheOnly) {
          this.listCache.set(cacheKey, { data, timestamp: Date.now() });
        }
        return data;
      } catch {
        this.listFetchInFlight.delete(cacheKey);
        return [];
      }
    })();

    this.listFetchInFlight.set(cacheKey, { epoch: startEpoch, promise });
    return await promise;
  }

  private requestList(params: MetadataRequestParams): Promise<MetadataResponse> {
    if (this.documentDatabaseKinds.get(params.documentUri) === "netezza") {
      return this.request({ ...params, cacheOnly: true });
    }
    return this.request(params);
  }

  private extractDocUri(cacheKey: string): string {
    const firstPipe = cacheKey.indexOf("|");
    if (firstPipe === -1) {
      return cacheKey;
    }
    const secondPipe = cacheKey.indexOf("|", firstPipe + 1);
    return secondPipe === -1
      ? cacheKey.substring(firstPipe + 1)
      : cacheKey.substring(firstPipe + 1, secondPipe);
  }

  private async request(
    params: MetadataRequestParams,
  ): Promise<MetadataResponse> {
    try {
      return await this.sendRequest(params);
    } catch (error: unknown) {
      this.logger?.error(
        `Metadata request failed (${params.kind}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private buildTableCacheKey(
    connectionName: string | undefined,
    database: string,
    schema: string | undefined,
    table: string,
  ): string {
    const normalizedConnection = (connectionName || "UNKNOWN").toUpperCase();
    const databaseKind = connectionName
      ? (this.connectionDatabaseKinds.get(connectionName) ?? undefined)
      : undefined;
    const normalizedDatabase = this.normalizeIdentifierForCacheByKind(database, databaseKind);
    const normalizedSchema = this.normalizeIdentifierForCacheByKind(schema || "", databaseKind);
    const normalizedTable = this.normalizeIdentifierForCacheByKind(table, databaseKind);
    return `${normalizedConnection}|${normalizedDatabase}|${normalizedSchema}|${normalizedTable}`;
  }

  private normalizeIdentifierForCache(
    documentUri: string,
    value: string,
  ): string {
    return this.normalizeIdentifierForCacheByKind(
      value,
      this.documentDatabaseKinds.get(documentUri) ?? undefined,
    );
  }

  private normalizeIdentifierForCacheByKind(
    value: string,
    databaseKind: MetadataContextResponse["databaseKind"] | undefined,
  ): string {
    if (databaseKind === "netezza") {
      return createNetezzaUserIdentifier(value).value;
    }
    return value.toUpperCase();
  }

  private parseTableCacheKey(
    key: string,
  ):
    | {
        connectionName: string;
        database: string;
        schema?: string;
        table: string;
      }
    | undefined {
    const parts = key.split("|");
    if (parts.length !== 4) {
      return undefined;
    }
    return {
      connectionName: parts[0],
      database: parts[1],
      schema: parts[2] || undefined,
      table: parts[3],
    };
  }

  private buildQualificationCacheKey(
    documentUri: string,
    database: string | undefined,
    schema: string | undefined,
    table: string,
  ): string {
    return `${documentUri}|${this.normalizeIdentifierForCache(documentUri, database ?? "")}|${this.normalizeIdentifierForCache(documentUri, schema ?? "")}|${this.normalizeIdentifierForCache(documentUri, table)}`;
  }

  private clearQualificationCacheForDocument(documentUri: string): void {
    for (const cacheKey of Array.from(this.qualificationCache.keys())) {
      if (cacheKey.startsWith(`${documentUri}|`)) {
        this.qualificationCache.delete(cacheKey);
      }
    }
  }

  private asContextResponse(
    response: MetadataResponse,
  ): MetadataContextResponse | undefined {
    if (!response || Array.isArray(response) || typeof response === "string") {
      return undefined;
    }
    if ("exists" in response || "columns" in response || "table" in response) {
      return undefined;
    }
    return response as MetadataContextResponse;
  }

  private asObjectList(response: MetadataResponse): MetadataObjectItem[] {
    if (!Array.isArray(response)) {
      return [];
    }
    return response.filter((item): item is MetadataObjectItem => {
      return typeof item === "object" && item !== null && "name" in item;
    });
  }

  private asColumnList(response: MetadataResponse): MetadataColumnItem[] {
    if (!Array.isArray(response)) {
      return [];
    }
    return response.flatMap((item) => this.asColumnItem(item));
  }

  private asTableInfo(
    response: MetadataResponse,
  ): MetadataTableInfoResponse | undefined {
    if (!response || Array.isArray(response) || typeof response === "string") {
      return undefined;
    }
    if (
      !("exists" in response) ||
      !("table" in response) ||
      !("columns" in response)
    ) {
      return undefined;
    }
    const columns = this.asColumnList(response.columns);
    return {
      exists: response.exists === true,
      table: typeof response.table === "string" ? response.table : "",
      database:
        typeof response.database === "string" ? response.database : undefined,
      schema: typeof response.schema === "string" ? response.schema : undefined,
      description:
        typeof response.description === "string"
          ? response.description.trim() || undefined
          : undefined,
      ...("columnsComplete" in response && response.columnsComplete === true
        ? { columnsComplete: true }
        : {}),
      columns,
    };
  }

  private asColumnItem(value: unknown): MetadataColumnItem[] {
    if (typeof value !== "object" || value === null || !("name" in value)) {
      return [];
    }

    const item = value as {
      name?: unknown;
      type?: unknown;
      description?: unknown;
      isPk?: unknown;
      isFk?: unknown;
    };
    if (typeof item.name !== "string" || item.name.length === 0) {
      return [];
    }

    return [{
      name: item.name,
      type: typeof item.type === "string" ? item.type : undefined,
      description:
        typeof item.description === "string"
          ? item.description.trim() || undefined
          : undefined,
      isPk: typeof item.isPk === "boolean" ? item.isPk : undefined,
      isFk: typeof item.isFk === "boolean" ? item.isFk : undefined,
    }];
  }
}

function isFullyQualifiedReference(
  reference: { database?: string; schema?: string; table: string },
  databaseKind?: import("../contracts/database").DatabaseKind,
): boolean {
  return databaseKind === "mysql"
    ? !!reference.database
    : !!reference.database && !!reference.schema;
}
