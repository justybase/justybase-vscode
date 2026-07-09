import {
  CompletionItem,
  CompletionItemKind,
} from "vscode-languageserver/node";
import type { DatabaseKind } from "../contracts/database";
import type { MetadataColumnItem } from "../lsp/protocol";
import type { LocalDefinition } from "../providers/types";
import {
  buildMetadataLookupTargets,
  isNetezzaDoubleDotSource,
  shouldTreatSingleDotPathAsSchema,
  supportsDoubleDotPath,
  usesDatabaseObjectTwoPartName,
  type MetadataLookupOptions,
} from "./completionPathUtils";
import { dedupeWildcardSources } from "./completionQualifierUtils";
import {
  findLocalDefinition,
  dedupeColumnNames,
  normalizeColumnNames,
  getWildcardResolutionLocalDefinitions,
} from "./completionLocalDefinitionUtils";
import {
  parseProcedureArgumentNames,
  procedureMatchesCallName,
} from "../metadata/procedureSignatureUtils";
import { dedupeCompletionItems, matchesPrefix } from "./completionRanker";
import { filterMetadataItems } from "./completionRenderer";
import type {
  CompletionMetadataProvider,
  FromJoinContext,
} from "./completionTypes";
import { CompletionWildcardResolver } from "./completionWildcardResolver";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";

/**
 * Resolves metadata-backed completion candidates and local-definition columns.
 */
export class CompletionMetadataResolver {
  constructor(
    private readonly metadataProvider: CompletionMetadataProvider,
    private readonly wildcardResolver: CompletionWildcardResolver,
    private readonly parseSession?: DocumentParseSession,
  ) {}

  public async resolveTablePathCompletions(
    context: FromJoinContext,
    localItems: CompletionItem[],
    documentUri: string,
    effectiveDb: string | undefined,
    databaseKind?: DatabaseKind,
    includeViews = false,
  ): Promise<CompletionItem[]> {
    if (context.kind === "db_dot") {
      if (usesDatabaseObjectTwoPartName(databaseKind)) {
        return this.getTableLikeCompletions(
          documentUri,
          context.dbName,
          undefined,
          context.partial,
          includeViews,
          databaseKind,
        );
      }
      if (databaseKind === "db2") {
        return this.resolveDb2DbDotTablePathCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          includeViews,
        );
      }
      if (databaseKind === "mssql") {
        const result = await this.resolveDb2DbDotTablePathCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          includeViews,
        );
        if (result.length > 0) {
          return result;
        }
        return this.getSchemaPathCompletions(
          documentUri,
          context.dbName,
          context.partial,
          databaseKind,
        );
      }
      if (databaseKind === "netezza") {
        return this.resolveNetezzaDbDotTablePathCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          includeViews,
          databaseKind,
        );
      }
      if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
        if (!effectiveDb) {
          return [];
        }
        return this.getTableLikeCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          includeViews,
          databaseKind,
        );
      }
      return this.getSchemaPathCompletions(
        documentUri,
        context.dbName,
        context.partial,
        databaseKind,
      );
    }

    if (context.kind === "db_schema_dot") {
      return this.getTableLikeCompletions(
        documentUri,
        context.dbName,
        context.schemaName,
        context.partial,
        includeViews,
        databaseKind,
      );
    }

    if (context.kind === "db_double_dot") {
      if (!supportsDoubleDotPath(databaseKind)) {
        return [];
      }
      return this.getTableLikeCompletions(
        documentUri,
        context.dbName,
        undefined,
        context.partial,
        includeViews,
        databaseKind,
      );
    }

    const partial = context.partial;
    const result: CompletionItem[] = [
      ...localItems.filter((item) => matchesPrefix(item.label, partial)),
    ];
    const databases = await this.metadataProvider.getDatabases(documentUri);
    result.push(
      ...filterMetadataItems(databases, partial, CompletionItemKind.Module),
    );

    if (effectiveDb) {
      if (databaseKind === "db2" || databaseKind === "mssql") {
        result.push(
          ...(await this.getSchemaPathCompletions(
            documentUri,
            effectiveDb,
            partial,
            databaseKind,
          )),
        );
        result.push(
          ...(await this.getTableLikeCompletions(
            documentUri,
            effectiveDb,
            undefined,
            partial,
            includeViews,
            databaseKind,
          )),
        );
      } else {
        if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
          result.push(
            ...(await this.getSchemaPathCompletions(
              documentUri,
              effectiveDb,
              partial,
              databaseKind,
            )),
          );
        }
        result.push(
          ...(await this.getTableLikeCompletions(
            documentUri,
            effectiveDb,
            undefined,
            partial,
            includeViews,
            databaseKind,
          )),
        );
      }
    }

    return dedupeCompletionItems(result);
  }

  public async resolveViewPathCompletions(
    context: FromJoinContext,
    documentUri: string,
    effectiveDb: string | undefined,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (context.kind === "db_dot") {
      if (usesDatabaseObjectTwoPartName(databaseKind)) {
        const views = await this.metadataProvider.getViews(
          documentUri,
          context.dbName,
        );
        return filterMetadataItems(
          views,
          context.partial,
          CompletionItemKind.Interface,
        );
      }
      if (databaseKind === "db2") {
        if (!effectiveDb) {
          return [];
        }
        const views = await this.metadataProvider.getViews(
          documentUri,
          effectiveDb,
          context.dbName,
        );
        return filterMetadataItems(
          views,
          context.partial,
          CompletionItemKind.Interface,
        );
      }
      if (databaseKind === "netezza") {
        return this.resolveNetezzaDbDotViewPathCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          databaseKind,
        );
      }
      if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
        if (!effectiveDb) {
          return [];
        }
        const views = await this.metadataProvider.getViews(
          documentUri,
          effectiveDb,
          context.dbName,
        );
        return filterMetadataItems(
          views,
          context.partial,
          CompletionItemKind.Interface,
        );
      }
      return this.getSchemaPathCompletions(
        documentUri,
        context.dbName,
        context.partial,
        databaseKind,
      );
    }

    if (context.kind === "db_schema_dot") {
      const views = await this.metadataProvider.getViews(
        documentUri,
        context.dbName,
        context.schemaName,
      );
      return filterMetadataItems(
        views,
        context.partial,
        CompletionItemKind.Interface,
      );
    }

    if (context.kind === "db_double_dot") {
      if (!supportsDoubleDotPath(databaseKind)) {
        return [];
      }
      const views = await this.metadataProvider.getViews(
        documentUri,
        context.dbName,
      );
      return filterMetadataItems(
        views,
        context.partial,
        CompletionItemKind.Interface,
      );
    }

    const databases = await this.metadataProvider.getDatabases(documentUri);
    const result = filterMetadataItems(
      databases,
      context.partial,
      CompletionItemKind.Module,
    );
    if (effectiveDb) {
      if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
        result.push(
          ...(await this.getSchemaPathCompletions(
            documentUri,
            effectiveDb,
            context.partial,
            databaseKind,
          )),
        );
      }
      const views = await this.metadataProvider.getViews(documentUri, effectiveDb);
      result.push(
        ...filterMetadataItems(
          views,
          context.partial,
          CompletionItemKind.Interface,
        ),
      );
    }
    return dedupeCompletionItems(result);
  }

  public async resolveProcedurePathCompletions(
    context: FromJoinContext,
    documentUri: string,
    effectiveDb: string | undefined,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (context.kind === "db_dot") {
      if (usesDatabaseObjectTwoPartName(databaseKind)) {
        const procedures = await this.metadataProvider.getProcedures(
          documentUri,
          context.dbName,
        );
        return filterMetadataItems(
          procedures,
          context.partial,
          CompletionItemKind.Function,
        );
      }
      if (databaseKind === "db2") {
        if (!effectiveDb) {
          return [];
        }
        const procedures = await this.metadataProvider.getProcedures(
          documentUri,
          effectiveDb,
          context.dbName,
        );
        return filterMetadataItems(
          procedures,
          context.partial,
          CompletionItemKind.Function,
        );
      }
      if (databaseKind === "netezza") {
        return this.resolveNetezzaDbDotProcedurePathCompletions(
          documentUri,
          effectiveDb,
          context.dbName,
          context.partial,
          databaseKind,
        );
      }
      if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
        if (!effectiveDb) {
          return [];
        }
        const procedures = await this.metadataProvider.getProcedures(
          documentUri,
          effectiveDb,
          context.dbName,
        );
        return filterMetadataItems(
          procedures,
          context.partial,
          CompletionItemKind.Function,
        );
      }
      return this.getSchemaPathCompletions(
        documentUri,
        context.dbName,
        context.partial,
        databaseKind,
      );
    }

    if (context.kind === "db_schema_dot") {
      const procedures = await this.metadataProvider.getProcedures(
        documentUri,
        context.dbName,
        context.schemaName,
      );
      return filterMetadataItems(
        procedures,
        context.partial,
        CompletionItemKind.Function,
      );
    }

    if (context.kind === "db_double_dot") {
      if (!supportsDoubleDotPath(databaseKind)) {
        return [];
      }
      const procedures = await this.metadataProvider.getProcedures(
        documentUri,
        context.dbName,
      );
      return filterMetadataItems(
        procedures,
        context.partial,
        CompletionItemKind.Function,
      );
    }

    const databases = await this.metadataProvider.getDatabases(documentUri);
    const result = filterMetadataItems(
      databases,
      context.partial,
      CompletionItemKind.Module,
    );
    if (effectiveDb) {
      if (shouldTreatSingleDotPathAsSchema(databaseKind)) {
        result.push(
          ...(await this.getSchemaPathCompletions(
            documentUri,
            effectiveDb,
            context.partial,
            databaseKind,
          )),
        );
      }
      const procedures = await this.metadataProvider.getProcedures(
        documentUri,
        effectiveDb,
      );
      result.push(
        ...filterMetadataItems(
          procedures,
          context.partial,
          CompletionItemKind.Function,
        ),
      );
    }
    return dedupeCompletionItems(result);
  }

  public async resolveCallArgumentCompletions(
    documentUri: string,
    callContext: {
      procedureName: string;
      argIndex: number;
      database?: string;
      schema?: string;
    },
    effectiveDb: string | undefined,
    _databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    const database = callContext.database ?? effectiveDb;
    if (!database) {
      return [
        {
          label: `arg${callContext.argIndex + 1}`,
          kind: CompletionItemKind.Variable,
          detail: `Argument ${callContext.argIndex + 1}`,
          sortText: "1_000",
        },
      ];
    }

    const procedures = await this.metadataProvider.getProcedures(
      documentUri,
      database,
      callContext.schema,
    );
    const procedure = procedures.find((item) =>
      procedureMatchesCallName(callContext.procedureName, item.name),
    );
    const argNames =
      procedure?.argumentNames ??
      parseProcedureArgumentNames(
        procedure?.name ?? procedure?.detail ?? procedure?.description ?? "",
      );
    if (argNames.length > 0) {
      return argNames.map((argName, index) => ({
        label: argName,
        kind: CompletionItemKind.Variable,
        detail: `Argument ${index + 1}`,
        sortText: `1_${String(index).padStart(3, "0")}_${argName}`,
      }));
    }

    return [
      {
        label: `arg${callContext.argIndex + 1}`,
        kind: CompletionItemKind.Variable,
        detail: `Argument ${callContext.argIndex + 1}`,
        sortText: "1_000",
      },
    ];
  }

  public async getSchemaPathCompletions(
    documentUri: string,
    database: string,
    partial: string,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    const schemas = await this.metadataProvider.getSchemas(documentUri, database);
    const schemaItems = filterMetadataItems(
      schemas,
      partial,
      CompletionItemKind.Module,
    );
    if (
      schemaItems.length > 0 ||
      databaseKind !== "mssql" ||
      !matchesPrefix("dbo", partial)
    ) {
      return schemaItems;
    }

    return [
      {
        label: "dbo",
        kind: CompletionItemKind.Module,
        detail: `Default schema in ${database}`,
      },
    ];
  }

  public async getMetadataColumnsForSource(
    documentUri: string,
    source: { db?: string; schema?: string; table: string },
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind?: DatabaseKind,
    options?: {
      omitSchemaArgumentWhenUndefined?: boolean;
      netezzaSchemasEnabled?: boolean;
    },
  ): Promise<MetadataColumnItem[]> {
    let lookupOptions: MetadataLookupOptions | undefined;
    if (isNetezzaDoubleDotSource(source, databaseKind)) {
      let defaultSchema: string | undefined;
      if (
        options?.netezzaSchemasEnabled === true &&
        source.db &&
        this.metadataProvider.getNetezzaDefaultSchema
      ) {
        defaultSchema = await this.metadataProvider.getNetezzaDefaultSchema(
          documentUri,
          source.db,
        );
      }
      lookupOptions = {
        netezzaSchemasEnabled: options?.netezzaSchemasEnabled,
        netezzaDefaultSchemaForDatabase: defaultSchema,
      };
    }

    const lookupTargets = buildMetadataLookupTargets(
      source,
      effectiveDb,
      effectiveSchema,
      databaseKind,
      lookupOptions,
    );

    for (const lookupTarget of lookupTargets) {
      if (!lookupTarget.database) {
        continue;
      }

      const omitSchemaArgument =
        isNetezzaDoubleDotSource(source, databaseKind) &&
        lookupTarget.schema === undefined;

      const columns =
        omitSchemaArgument ||
        (options?.omitSchemaArgumentWhenUndefined &&
          lookupTarget.schema === undefined)
          ? await this.metadataProvider.getColumns(
              documentUri,
              lookupTarget.database,
              lookupTarget.table,
            )
          : await this.metadataProvider.getColumns(
              documentUri,
              lookupTarget.database,
              lookupTarget.table,
              lookupTarget.schema,
            );
      if (columns.length > 0) {
        return columns;
      }
    }

    return [];
  }

  public async resolveLocalDefinitionColumns(
    definition: LocalDefinition,
    fullSql: string,
    _localDefs: LocalDefinition[],
    documentUri: string,
    documentVersion: number,
    effectiveDb: string | undefined,
    effectiveSchema: string | undefined,
    databaseKind: DatabaseKind | undefined,
    resolving: Set<string>,
  ): Promise<string[]> {
    const definitionKey = definition.name.toUpperCase();
    if (resolving.has(definitionKey)) {
      return normalizeColumnNames(definition.columns);
    }

    const nextResolving = new Set(resolving);
    nextResolving.add(definitionKey);

    const normalizedColumns = normalizeColumnNames(definition.columns);
    const explicitColumns = normalizedColumns.filter(
      (column) => column !== "*" && !column.endsWith(".*"),
    );

    if (
      this.wildcardResolver.definitionHasExplicitColumnList(
        fullSql,
        definition.name,
        databaseKind,
        documentUri,
        documentVersion,
      )
    ) {
      return explicitColumns;
    }

    const wildcardSources = dedupeWildcardSources(
      this.wildcardResolver.extractWildcardTableSources(
        fullSql,
        definition.name,
        databaseKind,
        documentUri,
        documentVersion,
      ),
    );

    if (wildcardSources.length === 0) {
      if (normalizedColumns.includes("*")) {
        const fallbackColumns = await this.getMetadataColumnsForSource(
          documentUri,
          {
            table: definition.name,
          },
          effectiveDb,
          effectiveSchema,
          databaseKind,
          { omitSchemaArgumentWhenUndefined: true },
        );
        const merged = [
          ...explicitColumns,
          ...fallbackColumns.map((column) => column.name),
        ];
        return dedupeColumnNames(merged);
      }
      return explicitColumns;
    }

    const resolutionLocalDefinitions = getWildcardResolutionLocalDefinitions(
      this.parseSession,
      this.wildcardResolver,
      {
        documentUri,
        documentVersion,
        sql: fullSql,
        databaseKind,
      },
      definition,
    );
    const wildcardColumns: string[] = [];
    for (const source of wildcardSources) {
      const localSourceDefinition = findLocalDefinition(
        resolutionLocalDefinitions,
        source.table,
      );
      if (localSourceDefinition) {
        const nestedColumns = await this.resolveLocalDefinitionColumns(
          localSourceDefinition,
          fullSql,
          resolutionLocalDefinitions,
          documentUri,
          documentVersion,
          effectiveDb,
          effectiveSchema,
          databaseKind,
          nextResolving,
        );
        wildcardColumns.push(...nestedColumns);
        continue;
      }

      const metadataColumns = await this.getMetadataColumnsForSource(
        documentUri,
        source,
        effectiveDb,
        effectiveSchema,
        databaseKind,
      );
      wildcardColumns.push(...metadataColumns.map((column) => column.name));
    }
    return dedupeColumnNames([...explicitColumns, ...wildcardColumns]);
  }

  /**
   * Netezza system views that are universally available across all databases.
   * These are not returned by the standard metadata queries because they have
   * OBJTYPE = 'SYSTEM VIEW' and reside in the SYSTEM database.
   *
   * Source: src/dialects/netezza/metadata/systemQueries.ts (NZ_SYSTEM_VIEWS)
   */
  private static readonly NETEZZA_SYSTEM_VIEWS = [
    // Session & monitoring
    '_V_SESSION',
    '_V_TABLE_STORAGE_STAT',
    // Object metadata
    '_V_OBJECT_DATA',
    '_V_TABLE',
    '_V_VIEW',
    '_V_PROCEDURE',
    '_V_SYNONYM',
    // Column & key structure
    '_V_RELATION_COLUMN',
    '_V_RELATION_KEYDATA',
    '_V_TABLE_DIST_MAP',
    '_V_TABLE_ORGANIZE_COLUMN',
    // External tables
    '_V_EXTERNAL',
    '_V_EXTOBJECT',
    // Database & schema
    '_V_DATABASE',
    '_V_SCHEMA',
  ] as const;

  private async getTableLikeCompletions(
    documentUri: string,
    database: string,
    schema: string | undefined,
    partial: string,
    includeViews: boolean,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    const tables =
      schema === undefined
        ? await this.metadataProvider.getTables(documentUri, database)
        : await this.metadataProvider.getTables(documentUri, database, schema);
    const result = filterMetadataItems(tables, partial, undefined, databaseKind);

    let viewItems: CompletionItem[] = [];
    if (includeViews) {
      const views =
        schema === undefined
          ? await this.metadataProvider.getViews(documentUri, database)
          : await this.metadataProvider.getViews(documentUri, database, schema);
      viewItems = filterMetadataItems(views, partial, CompletionItemKind.Interface, databaseKind);

      // Inject Netezza system views as synthetic completions for FROM/JOIN context.
      // These system views are not returned by the standard metadata provider because
      // they have OBJTYPE = 'SYSTEM VIEW' and reside in the SYSTEM database.
      // Source: NZ_SYSTEM_VIEWS in systemQueries.ts
      if (databaseKind === 'netezza' && schema === undefined) {
        for (const viewName of CompletionMetadataResolver.NETEZZA_SYSTEM_VIEWS) {
          if (matchesPrefix(viewName, partial)) {
            viewItems.push({
              label: viewName,
              kind: CompletionItemKind.Interface,
              detail: 'System View (Netezza)',
              sortText: viewName,
            });
          }
        }
      }
    }

    return dedupeCompletionItems([
      ...result,
      ...viewItems,
    ]);
  }

  private async matchesKnownDatabase(
    documentUri: string,
    name: string,
  ): Promise<boolean> {
    const databases = await this.metadataProvider.getDatabases(documentUri);
    const normalized = name.toUpperCase();
    return databases.some((item) => item.name.toUpperCase() === normalized);
  }

  private async resolveNetezzaDbDotTablePathCompletions(
    documentUri: string,
    effectiveDb: string | undefined,
    qualifier: string,
    partial: string,
    includeViews: boolean,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (await this.matchesKnownDatabase(documentUri, qualifier)) {
      return this.getSchemaPathCompletions(
        documentUri,
        qualifier,
        partial,
        databaseKind,
      );
    }
    if (!effectiveDb) {
      return [];
    }
    return this.getTableLikeCompletions(
      documentUri,
      effectiveDb,
      qualifier,
      partial,
      includeViews,
      databaseKind,
    );
  }

  private async resolveNetezzaDbDotViewPathCompletions(
    documentUri: string,
    effectiveDb: string | undefined,
    qualifier: string,
    partial: string,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (await this.matchesKnownDatabase(documentUri, qualifier)) {
      return this.getSchemaPathCompletions(
        documentUri,
        qualifier,
        partial,
        databaseKind,
      );
    }
    if (!effectiveDb) {
      return [];
    }
    const views = await this.metadataProvider.getViews(
      documentUri,
      effectiveDb,
      qualifier,
    );
    return filterMetadataItems(
      views,
      partial,
      CompletionItemKind.Interface,
    );
  }

  private async resolveNetezzaDbDotProcedurePathCompletions(
    documentUri: string,
    effectiveDb: string | undefined,
    qualifier: string,
    partial: string,
    databaseKind?: DatabaseKind,
  ): Promise<CompletionItem[]> {
    if (await this.matchesKnownDatabase(documentUri, qualifier)) {
      return this.getSchemaPathCompletions(
        documentUri,
        qualifier,
        partial,
        databaseKind,
      );
    }
    if (!effectiveDb) {
      return [];
    }
    const procedures = await this.metadataProvider.getProcedures(
      documentUri,
      effectiveDb,
      qualifier,
    );
    return filterMetadataItems(
      procedures,
      partial,
      CompletionItemKind.Function,
    );
  }

  private async resolveDb2DbDotTablePathCompletions(
    documentUri: string,
    effectiveDb: string | undefined,
    qualifier: string,
    partial: string,
    includeViews: boolean,
  ): Promise<CompletionItem[]> {
    const result: CompletionItem[] = [];
    const normalizedQualifier = qualifier.toUpperCase();
    const normalizedEffectiveDb = effectiveDb?.toUpperCase();

    if (effectiveDb) {
      result.push(
        ...(await this.getTableLikeCompletions(
          documentUri,
          effectiveDb,
          qualifier,
          partial,
          includeViews,
          "mssql",
        )),
      );
    }

    let shouldLoadSchemas = normalizedQualifier === normalizedEffectiveDb;
    if (!shouldLoadSchemas && result.length === 0) {
      const databases = await this.metadataProvider.getDatabases(documentUri);
      shouldLoadSchemas = databases.some(
        (item) => item.name.toUpperCase() === normalizedQualifier,
      );
    }

    if (shouldLoadSchemas) {
      result.unshift(
        ...(await this.getSchemaPathCompletions(
          documentUri,
          qualifier,
          partial,
          "mssql",
        )),
      );
    }

    return dedupeCompletionItems(result);
  }
}