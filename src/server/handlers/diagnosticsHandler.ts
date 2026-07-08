import type { Connection } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  createPerformanceTimer,
  formatPerformanceEvent,
} from "../../services/perf/performanceEvents";
import {
  SqlValidator,
  DocumentParseSession,
  DocumentValidationSession,
} from "../../sqlParser";
import { LARGE_SCRIPT_CHAR_THRESHOLD } from "../../sqlParser/validationConfig";
import {
  prepareIncrementalValidation,
  runValidationPipeline,
} from "../../sqlParser/validationPipeline";
import type {
  StatementBoundary,
  StatementIndex,
  ValidationError,
} from "../../sqlParser";
import {
  getDatabaseSqlAuthoring,
} from "../../core/connectionFactory";
import type { RuleSeverityConfig } from "../../providers/linterRules";
import { isParserDiagnosticEnabled } from "../../providers/parserDiagnosticRuleConfig";
import { LspSchemaProvider } from "../lspSchemaProvider";
import type { MetadataBridge } from "../metadataBridge";
import {
  isDiagnosticsSuperseded,
  nextDiagnosticsGeneration,
  toDiagnostic,
} from "../diagnosticsUtils";

const LINT_DEBOUNCE_MS = 400;
const DIAGNOSTICS_SLOW_LOG_MS = 750;

export interface DiagnosticsHandlerDeps {
  connection: Connection;
  metadataBridge: MetadataBridge;
  documentParseSession: DocumentParseSession;
  documentValidationSession: DocumentValidationSession;
}

export interface DiagnosticsHandler {
  scheduleDiagnostics: (document: TextDocument) => void;
  clearScheduledDiagnostics: (documentUri: string) => void;
  onDocumentClosed: (documentUri: string) => void;
  dispose: () => void;
}

export function createDiagnosticsHandler(
  deps: DiagnosticsHandlerDeps,
): DiagnosticsHandler {
  const {
    connection,
    metadataBridge,
    documentParseSession,
    documentValidationSession,
  } = deps;
  const lintTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const diagnosticsGeneration = new Map<string, number>();

  const scheduleDiagnostics = (document: TextDocument): void => {
    clearScheduledDiagnostics(document.uri);
    const timer = setTimeout(() => {
      lintTimers.delete(document.uri);
      void publishDiagnostics(document);
    }, LINT_DEBOUNCE_MS);
    lintTimers.set(document.uri, timer);
  };

  const clearScheduledDiagnostics = (documentUri: string): void => {
    const timer = lintTimers.get(documentUri);
    if (timer) {
      clearTimeout(timer);
      lintTimers.delete(documentUri);
    }
  };

  const dispose = (): void => {
    for (const timer of lintTimers.values()) {
      clearTimeout(timer);
    }
    lintTimers.clear();
    diagnosticsGeneration.clear();
  };

  async function publishDiagnostics(document: TextDocument): Promise<void> {
    const sql = document.getText();
    if (sql.length > LARGE_SCRIPT_CHAR_THRESHOLD) {
      connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
      return;
    }
    const versionAtStart = document.version;
    const currentGen = nextDiagnosticsGeneration(
      diagnosticsGeneration,
      document.uri,
    );
    const preparedForWarmup = prepareIncrementalValidation({
      documentUri: document.uri,
      sql,
      validationSession: documentValidationSession,
      expandScriptContext: true,
    });
    const validationState = preparedForWarmup.validationState;
    const incrementalCandidate = !!preparedForWarmup.incrementalValidation;
    const initialDirtyIndices =
      preparedForWarmup.incrementalValidation?.dirtyIndices ??
      validationState.nextIndex.statements.map((statement) => statement.index);
    const dirtySqlFragments = incrementalCandidate
      ? initialDirtyIndices
          .map((index) => validationState.nextIndex.statements[index]?.sql)
          .filter((statementSql): statementSql is string => !!statementSql)
      : undefined;

    const timer = createPerformanceTimer("lsp.request.diagnostics", {
      payloadSize: sql.length,
    });

    try {
      const context = await metadataBridge.warmValidationCache(
        document.uri,
        sql,
        dirtySqlFragments,
      );
      const metadataEpoch = metadataBridge.getValidationMetadataEpoch(
        document.uri,
      );
      documentValidationSession.syncMetadataEpoch(document.uri, metadataEpoch);

      if (
        isDiagnosticsSuperseded(
          diagnosticsGeneration,
          document.uri,
          currentGen,
          document.version,
          versionAtStart,
        )
      ) {
        logCancelledDiagnostics(connection.console, timer, document.uri);
        return;
      }

      if (
        isDiagnosticsSuperseded(
          diagnosticsGeneration,
          document.uri,
          currentGen,
          document.version,
          versionAtStart,
        )
      ) {
        logCancelledDiagnostics(connection.console, timer, document.uri);
        return;
      }

      const schemaProvider = new LspSchemaProvider(
        metadataBridge,
        document.uri,
        context.effectiveDatabase,
      );
      const validator = new SqlValidator(
        schemaProvider,
        getDatabaseSqlAuthoring(context.databaseKind).validation,
      );
      const pipelineResult = await runValidationPipeline({
        sql,
        documentUri: document.uri,
        validationSession: documentValidationSession,
        parseSession: documentParseSession,
        parseRequest: {
          documentUri: document.uri,
          documentVersion: document.version,
          sql,
          databaseKind: context.databaseKind,
          validationProfile: getDatabaseSqlAuthoring(context.databaseKind)
            .validation,
        },
        validator,
        incremental: {
          metadataEpoch,
          expandScriptContext: true,
          requireFullCacheCoverage: true,
        },
      });
      const result = pipelineResult.validationResult;
      if (!result) {
        return;
      }
      const rulesConfig = await readLinterRulesConfig(connection, document.uri);
      const validationIssues = [...result.errors, ...result.warnings].filter(
        (issue) => isParserDiagnosticEnabled(issue.code, rulesConfig),
      );
      const diagnostics = validationIssues.map((issue) => toDiagnostic(issue));
      const dirtyIndices =
        pipelineResult.dirtyIndices ??
        validationState.nextIndex.statements.map((statement) => statement.index);

      if (
        isDiagnosticsSuperseded(
          diagnosticsGeneration,
          document.uri,
          currentGen,
          document.version,
          versionAtStart,
        )
      ) {
        logCancelledDiagnostics(connection.console, timer, document.uri);
        return;
      }

      storeDiagnosticsByStatement(
        document.uri,
        validationState.nextIndex,
        validationIssues,
        metadataEpoch,
        documentValidationSession,
      );
      documentValidationSession.commitDocumentIndex(
        document.uri,
        validationState.nextIndex,
      );
      connection.sendDiagnostics({ uri: document.uri, diagnostics });

      const event = timer.finish({
        result: "ok",
        metadata: {
          document_uri: document.uri,
          diagnostic_count: diagnostics.length,
          validated_statements: dirtyIndices.length,
        },
      });
      if (event.duration_ms >= DIAGNOSTICS_SLOW_LOG_MS) {
        connection.console.log(formatPerformanceEvent(event));
      }
    } catch (error: unknown) {
      connection.console.error(
        `Failed to publish diagnostics for ${document.uri}: ${toErrorMessage(error)}`,
      );
      connection.console.log(
        formatPerformanceEvent(
          timer.finish({
            result: "error",
            errorCode: "HANDLER_ERROR",
            metadata: {
              document_uri: document.uri,
              error_message: toErrorMessage(error),
            },
          }),
        ),
      );
    }
  }

  const onDocumentClosed = (documentUri: string): void => {
    clearScheduledDiagnostics(documentUri);
    diagnosticsGeneration.delete(documentUri);
  };

  return {
    scheduleDiagnostics,
    clearScheduledDiagnostics,
    onDocumentClosed,
    dispose,
  };
}

function logCancelledDiagnostics(
  logger: { log: (message: string) => void },
  timer: ReturnType<typeof createPerformanceTimer>,
  documentUri: string,
): void {
  const event = timer.finish({
    result: "cancelled",
    metadata: {
      document_uri: documentUri,
      reason: "superseded",
    },
  });
  if (event.duration_ms >= DIAGNOSTICS_SLOW_LOG_MS) {
    logger.log(formatPerformanceEvent(event));
  }
}

function storeDiagnosticsByStatement(
  documentUri: string,
  statementIndex: StatementIndex,
  diagnostics: ValidationError[],
  metadataEpoch: number,
  documentValidationSession: DocumentValidationSession,
): void {
  for (const statement of statementIndex.statements) {
    documentValidationSession.storeStatementDiagnostics(
      documentUri,
      statement,
      diagnostics.filter((diagnostic) =>
        diagnosticBelongsToStatement(diagnostic, statement),
      ),
      metadataEpoch,
    );
  }
}

function diagnosticBelongsToStatement(
  diagnostic: ValidationError,
  statement: StatementBoundary,
): boolean {
  return (
    diagnostic.position.offset >= statement.startOffset &&
    diagnostic.position.offset <= statement.endOffset
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function readLinterRulesConfig(
  connection: Connection,
  documentUri: string,
): Promise<Record<string, RuleSeverityConfig>> {
  try {
    const rules = await connection.workspace.getConfiguration({
      scopeUri: documentUri,
      section: "justybase.linter.rules",
    });
    if (rules && typeof rules === "object") {
      return rules as Record<string, RuleSeverityConfig>;
    }
  } catch (error: unknown) {
    connection.console.error(
      `Failed to read linter rules configuration: ${toErrorMessage(error)}`,
    );
  }
  return {};
}
