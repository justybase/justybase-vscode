import type {
  SqlQualityAnalyzeOptions,
  SqlQualityEngine,
  SqlQualityResult,
} from "../providers/sqlQualityEngine";
import type {
  DocumentParseRequest,
  DocumentParseSession,
} from "./documentParseSession";
import type {
  DocumentValidationSession,
  DocumentValidationState,
} from "./documentValidationSession";
import { expandDirtyIndicesForScriptContext } from "./scriptScopeStatements";
import type { StatementIndex } from "./statementIndex";
import type { ValidationError, ValidationResult } from "./types";
import { SqlValidator } from "./validator";

export interface IncrementalValidationOptions {
  statementIndex: StatementIndex;
  dirtyIndices: readonly number[];
  cachedDiagnostics: Map<number, ValidationError[]>;
}

export interface PrepareIncrementalValidationInput {
  documentUri: string;
  sql: string;
  validationSession: DocumentValidationSession;
  metadataEpoch?: number;
  /** LSP path: widen dirty indices for CREATE/DROP script scope. */
  expandScriptContext?: boolean;
  /** LSP path: require cached diagnostics for all clean statements. */
  requireFullCacheCoverage?: boolean;
}

export interface PrepareIncrementalValidationResult {
  validationState: DocumentValidationState;
  incrementalValidation?: IncrementalValidationOptions;
}

export interface ValidationPipelineIncrementalOptions {
  metadataEpoch?: number;
  expandScriptContext?: boolean;
  requireFullCacheCoverage?: boolean;
}

export interface ValidationPipelineInput {
  sql: string;
  documentUri?: string;
  validationSession?: DocumentValidationSession;
  parseSession?: DocumentParseSession;
  parseRequest?: DocumentParseRequest;
  validator: SqlValidator;
  /** When false, skip incremental preparation. */
  incremental?: boolean | ValidationPipelineIncrementalOptions;
  /** Reuse a prior prepareIncrementalValidation result (e.g. LSP metadata warm-up). */
  prepared?: PrepareIncrementalValidationResult;
  qualityEngine?: SqlQualityEngine;
  qualityOptions?: Pick<
    SqlQualityAnalyzeOptions,
    | "rulesConfig"
    | "includeOnDemandRules"
    | "includeParserDiagnostics"
    | "skipProcedureParseWarmup"
  >;
}

export interface ValidationPipelineResult {
  validationResult?: ValidationResult;
  qualityResult?: SqlQualityResult;
  committedStatementIndex?: StatementIndex;
  dirtyIndices?: readonly number[];
}

export function shouldUseIncrementalValidation(
  previousIndex: StatementIndex | undefined,
  nextIndex: StatementIndex,
  dirtyIndices: readonly number[],
): boolean {
  if (!previousIndex || dirtyIndices.length === 0) {
    return false;
  }
  if (nextIndex.statements.length === 0) {
    return false;
  }
  const maxDirty = Math.max(1, Math.floor(nextIndex.statements.length / 2));
  return dirtyIndices.length <= maxDirty;
}

export function collectCachedStatementDiagnostics(
  documentUri: string,
  statementIndex: StatementIndex,
  dirtyIndices: readonly number[],
  validationSession: DocumentValidationSession,
  metadataEpoch?: number,
): Map<number, ValidationError[]> {
  const dirty = new Set(dirtyIndices);
  const cached = new Map<number, ValidationError[]>();
  for (const statement of statementIndex.statements) {
    if (dirty.has(statement.index)) {
      continue;
    }
    const diagnostics = validationSession.getCachedDiagnostics(
      documentUri,
      statement,
      metadataEpoch,
    );
    if (diagnostics) {
      cached.set(statement.index, diagnostics);
    }
  }
  return cached;
}

export function prepareIncrementalValidation(
  input: PrepareIncrementalValidationInput,
): PrepareIncrementalValidationResult {
  const validationState = input.validationSession.prepareDocument(
    input.documentUri,
    input.sql,
  );
  const dirtyIndices =
    input.expandScriptContext && validationState.previousIndex
      ? expandDirtyIndicesForScriptContext(
          validationState.previousIndex,
          validationState.nextIndex,
          validationState.diff.dirtyIndices,
        )
      : validationState.diff.dirtyIndices;

  if (
    !shouldUseIncrementalValidation(
      validationState.previousIndex,
      validationState.nextIndex,
      dirtyIndices,
    )
  ) {
    return { validationState };
  }

  const cachedDiagnostics = collectCachedStatementDiagnostics(
    input.documentUri,
    validationState.nextIndex,
    dirtyIndices,
    input.validationSession,
    input.metadataEpoch,
  );

  if (input.requireFullCacheCoverage) {
    const coveredCount = cachedDiagnostics.size + dirtyIndices.length;
    if (coveredCount < validationState.nextIndex.statements.length) {
      return { validationState };
    }
  }

  return {
    validationState,
    incrementalValidation: {
      statementIndex: validationState.nextIndex,
      dirtyIndices,
      cachedDiagnostics,
    },
  };
}

function resolveIncrementalOptions(
  incremental: ValidationPipelineInput["incremental"],
): ValidationPipelineIncrementalOptions | undefined {
  if (incremental === false) {
    return undefined;
  }
  if (incremental === true || incremental === undefined) {
    return {};
  }
  return incremental;
}

export async function runValidationPipeline(
  input: ValidationPipelineInput,
): Promise<ValidationPipelineResult> {
  const incrementalOptions = resolveIncrementalOptions(input.incremental);
  const prepared =
    input.prepared ??
    (input.documentUri &&
    input.validationSession &&
    incrementalOptions !== undefined
      ? prepareIncrementalValidation({
          documentUri: input.documentUri,
          sql: input.sql,
          validationSession: input.validationSession,
          metadataEpoch: incrementalOptions.metadataEpoch,
          expandScriptContext: incrementalOptions.expandScriptContext,
          requireFullCacheCoverage: incrementalOptions.requireFullCacheCoverage,
        })
      : undefined);

  if (input.qualityEngine) {
    if (input.parseRequest && input.parseSession) {
      input.parseSession.bindDocumentVersion(
        input.parseRequest.documentUri,
        input.parseRequest.documentVersion,
        input.sql,
      );
    }

    const qualityResult = input.qualityEngine.analyzeWithOptions(input.sql, {
      ...input.qualityOptions,
      parseSession: input.parseSession,
      parseRequest: input.parseRequest,
      incrementalValidation: prepared?.incrementalValidation,
      validationSession: input.validationSession,
      documentUri: input.documentUri,
    });

    return {
      qualityResult,
      committedStatementIndex: prepared?.validationState.nextIndex,
    };
  }

  if (!prepared || !input.parseSession || !input.parseRequest) {
    return {
      validationResult: input.validator.validate(input.sql),
    };
  }

  const { validationState, incrementalValidation } = prepared;
  let dirtyIndices = incrementalValidation
    ? incrementalValidation.dirtyIndices
    : validationState.nextIndex.statements.map((statement) => statement.index);

  let validationResult: ValidationResult | undefined;
  if (
    incrementalValidation &&
    dirtyIndices.length < validationState.nextIndex.statements.length
  ) {
    validationResult = input.validator.validateIncrementalFromStatements(
      input.sql,
      validationState.nextIndex.statements,
      dirtyIndices,
      incrementalValidation.cachedDiagnostics,
    );
  }

  if (!validationResult) {
    input.parseSession.bindDocumentVersion(
      input.parseRequest.documentUri,
      input.parseRequest.documentVersion,
      input.sql,
    );
    const parseResult = await input.parseSession.getParseResultAsync(
      input.parseRequest,
    );
    dirtyIndices = validationState.nextIndex.statements.map(
      (statement) => statement.index,
    );
    validationResult = input.validator.validateFromParseResult(
      input.sql,
      parseResult,
    );
  }

  return {
    validationResult,
    committedStatementIndex: validationState.nextIndex,
    dirtyIndices,
  };
}
