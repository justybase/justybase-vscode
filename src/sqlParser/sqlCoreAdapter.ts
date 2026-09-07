import type {
  NetezzaSqlParseResult,
  NetezzaSqlSchemaProvider,
  QualificationProposal as NetezzaQualificationProposal,
  ScopeSeed as NetezzaScopeSeed,
  StatementBoundary as NetezzaStatementBoundary,
} from "@justybase/sql-core/validation";
import { NETEZZA_SQL_PARSING_RUNTIME } from "@justybase/sql-core/validation";
import type { SchemaProvider } from "./schemaProvider";
import type { SqlStatementsParseResult } from "./parsingRuntime";
import type { ScopeSeed } from "./validator";
import type { StatementBoundary } from "./statementIndex";
import type {
  QualificationProposal,
} from "../core/tableQualificationResolver";

/**
 * Explicit desktop → sql-core schema adapter.
 *
 * Validation metadata now uses the shared sql-core model. The adapter keeps
 * only the runtime guard and the qualification proposal conversion, whose
 * desktop contract still requires database and schema fields.
 */
export function toNetezzaSchemaProvider(
  provider: SchemaProvider | undefined,
): NetezzaSqlSchemaProvider | undefined {
  if (!provider) return undefined;

  return {
    getTable: (database, schema, tableName) =>
      provider.getTable(database, schema, tableName),
    tableExists: (database, schema, tableName) =>
      provider.tableExists(database, schema, tableName),
    proposeTableQualification: (request) =>
      mapQualificationProposals(
        provider.proposeTableQualification?.(request),
      ),
    canValidateUnqualifiedTableReferences: () =>
      provider.canValidateUnqualifiedTableReferences?.() ?? false,
    getTablesInSchema: (database, schema) =>
      provider.getTablesInSchema?.(database, schema) ?? [],
    getDatabases: () => provider.getDatabases?.(),
    getKnownFunctions: () => provider.getKnownFunctions?.(),
  };
}

/** Convert the desktop parser session result to the Netezza-only parse type. */
export function toNetezzaParseResult(
  parseResult: SqlStatementsParseResult,
): NetezzaSqlParseResult {
  if (parseResult.runtime.id !== "netezza") {
    throw new TypeError(`Netezza validation cannot consume ${parseResult.runtime.id} parse results.`);
  }
  return {
    runtime: NETEZZA_SQL_PARSING_RUNTIME,
    lexResult: parseResult.lexResult,
    cst: parseResult.cst,
    parserErrors: parseResult.parserErrors,
    actionableParserErrors: parseResult.actionableParserErrors,
    usedIsolatedParser: parseResult.usedIsolatedParser,
  };
}

export function toNetezzaStatementBoundaries(
  statements: readonly StatementBoundary[],
): NetezzaStatementBoundary[] {
  return statements.map(({ index, startOffset, endOffset, sql }) => ({
    index,
    startOffset,
    endOffset,
    sql,
  }));
}

export function toNetezzaScopeSeeds(
  seeds: Map<number, ScopeSeed>,
): Map<number, NetezzaScopeSeed> {
  return seeds;
}

function mapQualificationProposals(
  proposals: QualificationProposal[] | undefined,
): NetezzaQualificationProposal[] {
  return (proposals ?? []).map((proposal) => ({
    database: proposal.database,
    schema: proposal.schema,
    name: proposal.name,
    qualifiedText: proposal.qualifiedText,
    isPreferred: proposal.isPreferred,
  }));
}
