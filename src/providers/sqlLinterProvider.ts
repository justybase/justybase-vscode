/**
 * SQL Linter Provider for Netezza
 *
 * Provides real-time SQL linting integrated with VS Code's diagnostics system.
 */

import * as vscode from "vscode";
import { isSqlLanguageClientRunning } from "../activation/lspRegistration";
import { getDatabaseSqlAuthoring } from "../core/connectionFactory";
import { LintIssue, RuleSeverityConfig } from "./linterRules";
import { SqlValidator } from "../sqlParser";
import type { DocumentParseSession } from "../sqlParser/documentParseSession";
import { DocumentValidationSession } from "../sqlParser/documentValidationSession";
import {
  DEFAULT_LINT_DEBOUNCE_MS,
  LARGE_SCRIPT_CHAR_THRESHOLD,
  LARGE_SCRIPT_LINE_THRESHOLD,
  LARGE_SCRIPT_LINT_DEBOUNCE_MS,
  shouldIncludeParserDiagnosticsInExtensionLint,
} from "../sqlParser/validationConfig";
import { getExtensionDocumentParseSession } from "../core/extensionDocumentParseSession";
import {
  getInitializedSqlValidator,
  getSqlValidationContext,
} from "../commands/validationCommands";
import { SqlQualityEngine } from "./sqlQualityEngine";
import { runValidationPipeline } from "../sqlParser/validationPipeline";
import {
  affectsExtensionConfiguration,
  getExtensionConfiguration,
} from "../compatibility/configuration";
import { isSqlAuthoringLanguageId } from "../utils/sqlLanguage";
import { Logger } from "../utils/logger";

type LinterMode = "advanced";

/**
 * SQL Linter Provider
 * Manages VS Code diagnostics for SQL files
 */
export class SqlLinterProvider {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];
  private lintTimers: Map<string, NodeJS.Timeout> = new Map();
  private lintResultCache: Map<
    string,
    {
      version: number;
      diagnostics: vscode.Diagnostic[];
      issues: LintIssue[];
    }
  > = new Map();
  private readonly lintDebounceMs = DEFAULT_LINT_DEBOUNCE_MS;
  private readonly validator = new SqlValidator();
  private readonly parseSession: DocumentParseSession;
  private readonly validationSession: DocumentValidationSession;
  private readonly columnMetadataWarnedConnections = new Set<string>();

  constructor(parseSession: DocumentParseSession = getExtensionDocumentParseSession()) {
    this.parseSession = parseSession;
    this.validationSession = new DocumentValidationSession();
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("netezza-sql-linter");
  }

  /**
   * Activate the linter
   */
  public activate(context: vscode.ExtensionContext): void {
    // Add diagnostic collection to disposables
    context.subscriptions.push(this.diagnosticCollection);

    const validationContext = getSqlValidationContext();
    const relintDocument = (documentUri: string) => {
      const document = vscode.workspace.textDocuments.find(
        (doc) => doc.uri.toString() === documentUri,
      );
      if (!document || !this.shouldRunExtensionHostLint(document)) {
        return;
      }

      this.clearCacheForUri(document.uri);
      void this.lintDocument(document);
    };

    // Lint on document open (debounced — never block UI on open)
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (this.shouldRunExtensionHostLint(doc)) {
          this.scheduleLint(doc);
        } else if (this.shouldLint(doc) && this.isLargeScript(doc)) {
          this.diagnosticCollection.delete(doc.uri);
          this.clearCacheForUri(doc.uri);
        }
      }),
    );

    // Lint on document change
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.shouldRunExtensionHostLint(event.document)) {
          this.scheduleLint(event.document);
        }
      }),
    );

    // Clear diagnostics when document is closed
    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.diagnosticCollection.delete(doc.uri);
        this.clearCacheForUri(doc.uri);
      }),
    );

    // Lint on configuration change
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsExtensionConfiguration(event, "linter")) {
          this.lintResultCache.clear();
          this.lintAllOpenDocuments();
        }
      }),
    );

    if (validationContext) {
      this.disposables.push(
        validationContext.connectionManager.onDidChangeDocumentConnection(
          relintDocument,
        ),
      );
      this.disposables.push(
        validationContext.connectionManager.onDidChangeDocumentDatabase(
          relintDocument,
        ),
      );
    }

    // Register disposables
    context.subscriptions.push(...this.disposables);

    // Lint all currently open SQL documents (deferred to avoid blocking activation)
    setTimeout(() => {
      this.lintAllOpenDocuments();
    }, 100);
  }

  /**
   * Check if a document should be linted
   */
  private shouldLint(document: vscode.TextDocument): boolean {
    return isSqlAuthoringLanguageId(document.languageId);
  }

  /**
   * Large SQL scripts (DDL dumps): LSP already publishes parser diagnostics.
   * Running extension-host quality rules synchronously blocks CodeLens/commands.
   */
  private isLargeScript(document: vscode.TextDocument): boolean {
    if (document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD) {
      return true;
    }
    return document.getText().length > LARGE_SCRIPT_CHAR_THRESHOLD;
  }

  private shouldRunExtensionHostLint(document: vscode.TextDocument): boolean {
    if (!this.shouldLint(document)) {
      return false;
    }
    if (isSqlLanguageClientRunning() && this.isLargeScript(document)) {
      return false;
    }
    return true;
  }

  /**
   * Get linter configuration
   */
  private getConfig(): {
    enabled: boolean;
    rules: Record<string, RuleSeverityConfig>;
    mode: LinterMode;
  } {
    const config = getExtensionConfiguration("linter");
    return {
      enabled: config.get<boolean>("enabled", true) ?? true,
      rules: config.get<Record<string, RuleSeverityConfig>>("rules", {}) ?? {},
      mode: "advanced",
    };
  }

  /**
   * Lint all open SQL documents
   */
  private lintAllOpenDocuments(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (this.shouldRunExtensionHostLint(doc)) {
        this.scheduleLint(doc);
      }
    }
  }

  /**
   * Lint a document and update diagnostics
   * @param document The document to lint
   * @param onDemand If true, runs on-demand only rules (default: false for automatic linting)
   */
  public async lintDocument(
    document: vscode.TextDocument,
    onDemand: boolean = false,
  ): Promise<LintIssue[]> {
    const startedAt = performance.now();
    if (!this.shouldRunExtensionHostLint(document) && !onDemand) {
      this.diagnosticCollection.delete(document.uri);
      this.clearCacheForUri(document.uri);
      return [];
    }

    const config = this.getConfig();

    // If linter is disabled, clear diagnostics
    if (!config.enabled) {
      this.diagnosticCollection.delete(document.uri);
      this.clearCacheForUri(document.uri);
      return [];
    }

    const documentVersion = document.version ?? 0;
    const cacheKey = this.buildCacheKey(
      document.uri,
      documentVersion,
      config.mode,
      onDemand,
      config.rules,
    );
    const cached = this.lintResultCache.get(cacheKey);
    if (cached) {
      this.diagnosticCollection.set(document.uri, cached.diagnostics);
      this.logSlowLint(document, startedAt, true, false);
      return cached.issues;
    }

    const sql = document.getText();
    const issues = await this.lintSql(
      sql,
      config.rules,
      onDemand,
      config.mode,
      document.uri.toString(),
      documentVersion,
    );
    const diagnostics = this.issuesToDiagnostics(document, issues);

    if (!this.isCurrentDocumentVersion(document.uri, documentVersion)) {
      this.logSlowLint(document, startedAt, false, true);
      return [];
    }

    this.diagnosticCollection.set(document.uri, diagnostics);
    this.clearCacheForUri(document.uri);
    this.lintResultCache.set(cacheKey, {
      version: documentVersion,
      diagnostics,
      issues,
    });
    this.logSlowLint(document, startedAt, false, false);
    return issues;
  }

  private logSlowLint(
    document: vscode.TextDocument,
    startedAt: number,
    cacheHit: boolean,
    cancelled: boolean,
  ): void {
    const durationMs = performance.now() - startedAt;
    if (durationMs < 100) return;
    const memory = process.memoryUsage();
    Logger.tryGetInstance()?.warn(
      `[SqlLinter] slow uri=${document.uri.toString()} version=${document.version} length=${document.getText().length} durationMs=${durationMs.toFixed(1)} cache=${cacheHit ? "hit" : "miss"} cancelled=${cancelled} heapUsed=${memory.heapUsed} rss=${memory.rss}`,
    );
  }

  private scheduleLint(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.lintTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const debounceMs = this.isLargeScript(document)
      ? LARGE_SCRIPT_LINT_DEBOUNCE_MS
      : this.lintDebounceMs;

    const timer = setTimeout(() => {
      this.lintTimers.delete(key);
      void this.lintDocument(document);
    }, debounceMs);

    this.lintTimers.set(key, timer);
  }

  /**
   * Lint SQL text and return issues
   * @param sql - The SQL text to lint
   * @param rulesConfig - Configuration for rule severities
   * @param onDemand - If true, runs all rules including on-demand only rules
   */
  public async lintSql(
    sql: string,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
    onDemand: boolean = false,
    _mode?: LinterMode,
    documentUri?: string,
    documentVersion: number = 0,
  ): Promise<LintIssue[]> {
    if (sql.trim().length === 0) {
      return [];
    }

    const validationContext = getSqlValidationContext();
    const databaseKind =
      validationContext?.connectionManager.getExecutionDatabaseKind(
        documentUri,
      );
    const connectionName =
      validationContext?.connectionManager.resolveConnectionName?.(documentUri);
    if (connectionName && validationContext) {
      const preloadColumns = validationContext.metadataCache.preloadColumnsForConnection(
        connectionName,
      );
      if (onDemand) {
        await preloadColumns;
      } else {
        void preloadColumns.then(undefined, (error: unknown) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          Logger.getInstance().debug(
            `[SqlLinter] Background column metadata preload failed for ${connectionName}: ${errorMessage}`,
          );
        });
      }
      if (
        validationContext.metadataCache.hasTableCacheForConnection(connectionName)
        && !validationContext.metadataCache.isConnectionPrefetchFresh(connectionName)
        && !this.columnMetadataWarnedConnections.has(connectionName)
      ) {
        this.columnMetadataWarnedConnections.add(connectionName);
        Logger.getInstance().warn(
          `[SqlLinter] Column metadata unavailable for ${connectionName}; `
          + "type-aware rules (e.g. SQL025/026) deferred until metadata prefetch completes",
        );
      }
    }
    const validator = getInitializedSqlValidator(documentUri) ?? this.validator;
    const qualityEngine = new SqlQualityEngine(
      validator,
      getDatabaseSqlAuthoring(databaseKind).qualityRules,
    );
    const parseRequest = documentUri
      ? {
          documentUri,
          documentVersion,
          sql,
          databaseKind,
          validationProfile: getDatabaseSqlAuthoring(databaseKind).validation,
        }
      : undefined;

    const lspAtLintStart = isSqlLanguageClientRunning();
    const includeParserDiagnostics = shouldIncludeParserDiagnosticsInExtensionLint(
      lspAtLintStart,
      sql.length,
    );

    const pipelineResult = await runValidationPipeline({
      sql,
      documentUri,
      validationSession: documentUri ? this.validationSession : undefined,
      parseSession: this.parseSession,
      parseRequest,
      validator,
      incremental: includeParserDiagnostics && !!documentUri,
      qualityEngine,
      qualityOptions: {
        rulesConfig,
        includeOnDemandRules: onDemand,
        includeParserDiagnostics,
        skipProcedureParseWarmup: lspAtLintStart,
      },
    });

    if (pipelineResult.committedStatementIndex && documentUri) {
      this.validationSession.commitDocumentIndex(
        documentUri,
        pipelineResult.committedStatementIndex,
      );
    }

    return pipelineResult.qualityResult?.issues ?? [];
  }

  /**
   * Convert lint issues to VS Code diagnostics
   */
  private issuesToDiagnostics(
    document: vscode.TextDocument,
    issues: LintIssue[],
  ): vscode.Diagnostic[] {
    return issues.map((issue) => {
      const startPos = document.positionAt(issue.startOffset);
      const endPos = document.positionAt(issue.endOffset);
      const range = new vscode.Range(startPos, endPos);

      const diagnostic = new vscode.Diagnostic(
        range,
        issue.message,
        issue.severity,
      );
      diagnostic.source = "Netezza Quality";
      diagnostic.code = issue.ruleId;
      if (issue.suggestedFix) {
        (diagnostic as unknown as { data?: { suggestedFix: string } }).data = {
          suggestedFix: issue.suggestedFix,
        };
      }

      return diagnostic;
    });
  }

  /**
   * Clear diagnostics for a specific document
   */
  public clearDiagnostics(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri);
    this.clearCacheForUri(uri);
  }

  /**
   * Clear all diagnostics
   */
  public clearAllDiagnostics(): void {
    this.diagnosticCollection.clear();
    this.lintResultCache.clear();
  }

  private buildCacheKey(
    uri: vscode.Uri,
    version: number,
    mode: LinterMode,
    onDemand: boolean,
    rulesConfig: Record<string, RuleSeverityConfig> = {},
  ): string {
    const rulesFingerprint = this.buildRulesFingerprint(rulesConfig);
    const validationContext = getSqlValidationContext();
    const documentUri = uri.toString();
    const connectionFingerprint =
      validationContext?.connectionManager.getConnectionForExecution(
        documentUri,
      ) || "";
    const databaseKind =
      validationContext?.connectionManager.getExecutionDatabaseKind(
        documentUri,
      ) || "";
    const databaseOverride =
      validationContext?.connectionManager.getDocumentDatabase(documentUri) ||
      "";

    return `${documentUri}|${version}|${mode}|${onDemand ? "1" : "0"}|${databaseKind}|${connectionFingerprint}|${databaseOverride}|${rulesFingerprint}`;
  }

  private buildRulesFingerprint(
    rulesConfig: Record<string, RuleSeverityConfig>,
  ): string {
    return Object.keys(rulesConfig)
      .sort()
      .map((key) => `${key}:${rulesConfig[key]}`)
      .join(",");
  }

  private clearCacheForUri(uri: vscode.Uri): void {
    const uriPrefix = `${uri.toString()}|`;
    for (const key of this.lintResultCache.keys()) {
      if (key.startsWith(uriPrefix)) {
        this.lintResultCache.delete(key);
      }
    }
  }

  private isCurrentDocumentVersion(
    uri: vscode.Uri,
    expectedVersion: number,
  ): boolean {
    const currentDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString(),
    );
    if (!currentDocument) {
      return false;
    }
    return (currentDocument.version ?? 0) === expectedVersion;
  }

  /**
   * Dispose of the linter
   */
  public dispose(): void {
    this.diagnosticCollection.dispose();
    for (const timer of this.lintTimers.values()) {
      clearTimeout(timer);
    }
    this.lintTimers.clear();
    this.lintResultCache.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}

/**
 * Singleton instance
 */
let linterInstance: SqlLinterProvider | undefined;

/**
 * Get or create the linter instance
 */
export function getSqlLinter(): SqlLinterProvider {
  if (!linterInstance) {
    linterInstance = new SqlLinterProvider();
  }
  return linterInstance;
}

/**
 * Activate the SQL linter
 */
export function activateSqlLinter(
  context: vscode.ExtensionContext,
): SqlLinterProvider {
  const linter = getSqlLinter();
  linter.activate(context);
  return linter;
}
