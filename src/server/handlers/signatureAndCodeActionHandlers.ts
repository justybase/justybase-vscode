import {
  CodeAction,
  CodeActionKind,
  Command,
  type Connection,
  SignatureHelp,
  type SignatureHelpParams,
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { TextDocuments } from "vscode-languageserver/node";
import { getDatabaseSqlAuthoring } from "../../core/connectionFactory";
import type { DatabaseKind } from "../../contracts/database";
import type { MetadataBridge } from "../metadataBridge";
import { runWithRequestBoundary } from "../requestBoundary";
import {
  buildStatementIndex,
  parseSqlStatements,
  resolveSqlParsingRuntime,
} from "../../sqlParser";
import { stripIdentifierQuoting } from "../../utils/identifierUtils";
import {
  buildTableQualificationCodeActions,
  getDiagnosticSuggestedFix,
} from "../tableQualificationCodeActions";
import { buildFunctionSignatureDocumentation } from "../functionCompletionUtils";
import {
  findFunctionCall,
  getTextBeforeCursor,
} from "../signatureHelpUtils";

const SIGNATURE_HELP_REQUEST_BUDGET_MS = 1000;
const SIGNATURE_HELP_SLOW_LOG_MS = 150;

export interface SignatureHelpHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge: MetadataBridge;
}

export function registerSignatureHelpHandler(
  deps: SignatureHelpHandlerDeps,
): void {
  const { connection, documents, metadataBridge } = deps;

  connection.onSignatureHelp(
    async (params: SignatureHelpParams, token): Promise<SignatureHelp | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      return runWithRequestBoundary(
        {
          operation: "signatureHelp",
          documentUri: document.uri,
          budgetMs: SIGNATURE_HELP_REQUEST_BUDGET_MS,
          slowLogThresholdMs: SIGNATURE_HELP_SLOW_LOG_MS,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return null;
          }

          const offset = document.offsetAt(params.position);
          const textBeforeCursor = getTextBeforeCursor(document, offset);

          const functionCall = findFunctionCall(textBeforeCursor);
          if (!functionCall) {
            return null;
          }

          if (isCancellationRequested()) {
            return null;
          }

          const { functionName, argumentPosition } = functionCall;
          const normalizedName = functionName.toUpperCase();

          const context = await metadataBridge.getContext(document.uri);
          if (isCancellationRequested()) {
            return null;
          }

          const signatures =
            getDatabaseSqlAuthoring(context.databaseKind).signatures.get(
              normalizedName,
            );
          if (!signatures || signatures.length === 0) {
            return null;
          }

          return {
            signatures: signatures.map((sig) => ({
              label: `${sig.name}(${sig.parameters.join(", ")})`,
              documentation: buildFunctionSignatureDocumentation([sig]),
              parameters: sig.parameters.map((param) => ({
                label: param as string,
              })),
            })),
            activeSignature: 0,
            activeParameter: argumentPosition,
          } satisfies SignatureHelp;
        },
      );
    },
  );
}

export interface CodeActionHandlerDeps {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  metadataBridge?: MetadataBridge;
}

export function registerCodeActionHandler(deps: CodeActionHandlerDeps): void {
  const { connection, documents, metadataBridge } = deps;

  connection.onCodeAction(
    async (params, token): Promise<(Command | CodeAction)[] | null> => {
      const document = documents.get(params.textDocument.uri);
      if (!document) {
        return null;
      }

      return runWithRequestBoundary(
        {
          operation: "codeAction",
          documentUri: document.uri,
          budgetMs: 1000,
          slowLogThresholdMs: 200,
          fallbackValue: null,
          logger: connection.console,
          token,
        },
        async ({ isCancellationRequested }) => {
          if (isCancellationRequested()) {
            return null;
          }

          const actions: (Command | CodeAction)[] = [];
          const text = document.getText();
          const needsDialectAwareJoinFix = params.context.diagnostics.some(
            (diagnostic) => {
              const code =
                typeof diagnostic.code === "string"
                  ? diagnostic.code
                  : String(diagnostic.code ?? "");
              return code === "SQL051" || code === "SQL052";
            },
          );
          let databaseKind: DatabaseKind = "netezza";
          if (needsDialectAwareJoinFix && metadataBridge) {
            const context = await metadataBridge.getContext(document.uri);
            if (isCancellationRequested()) {
              return null;
            }
            databaseKind = context.databaseKind ?? "netezza";
          }

          for (const diagnostic of params.context.diagnostics) {
            const code =
              typeof diagnostic.code === "string"
                ? diagnostic.code
                : String(diagnostic.code ?? "");
            const range = diagnostic.range;

            if (code === "SQL004") {
              const suggestedFix = getDiagnosticSuggestedFix(diagnostic);
              if (suggestedFix) {
                actions.push({
                  title: `Did you mean '${suggestedFix}'?`,
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: true,
                  edit: {
                    changes: {
                      [document.uri]: [{ range, newText: suggestedFix }],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (code === "SQL051") {
              const crossJoin = findCrossJoinReplacement(
                text,
                document.offsetAt(range.start),
                databaseKind,
              );
              if (crossJoin) {
                actions.push({
                  title: "Replace CROSS JOIN with explicit INNER JOIN",
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: true,
                  edit: {
                    changes: {
                      [document.uri]: [{
                        range: {
                          start: document.positionAt(crossJoin.startOffset),
                          end: document.positionAt(crossJoin.endOffset),
                        },
                        newText: "INNER JOIN ON 1=1",
                      }],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (code === "SQL052") {
              const aliasFix = findJoinAliasRewrite(
                text,
                document.offsetAt(range.start),
                databaseKind,
              );
              if (aliasFix) {
                const changes = [
                  {
                    range: {
                      start: document.positionAt(aliasFix.insertOffset),
                      end: document.positionAt(aliasFix.insertOffset),
                    },
                    newText: ` ${aliasFix.aliasName}`,
                  },
                  ...aliasFix.referenceRanges.map((reference) => ({
                    range: {
                      start: document.positionAt(reference.startOffset),
                      end: document.positionAt(reference.endOffset),
                    },
                    newText: aliasFix.aliasName,
                  })),
                ];
                actions.push({
                  title: `Add missing table alias '${aliasFix.aliasName}'${aliasFix.referenceRanges.length > 0 ? " and update references" : ""}`,
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: true,
                  edit: { changes: { [document.uri]: changes } },
                } satisfies CodeAction);
              }
            }

            if (code === "SQL007") {
              const rangeText = text.substring(
                document.offsetAt(range.start),
                document.offsetAt(range.end),
              );
              const suggestedFix = getDiagnosticSuggestedFix(diagnostic);
              actions.push(
                ...(await buildTableQualificationCodeActions(
                  document.uri,
                  diagnostic,
                  range,
                  rangeText,
                  metadataBridge,
                  true,
                )),
              );

              const match = rangeText.match(/^(\w+)\.(\w+)$/);
              if (match) {
                actions.push({
                  title: "Convert to DB..TABLE format (Netezza syntax)",
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: !suggestedFix,
                  edit: {
                    changes: {
                      [document.uri]: [
                        { range, newText: `${match[1]}..${match[2]}` },
                      ],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (code === "SQL048") {
              const rangeText = text.substring(
                document.offsetAt(range.start),
                document.offsetAt(range.end),
              );
              actions.push(
                ...(await buildTableQualificationCodeActions(
                  document.uri,
                  diagnostic,
                  range,
                  rangeText,
                  metadataBridge,
                  true,
                )),
              );
            }

            if (code === "SQL012") {
              const insertPos = {
                line: range.end.line,
                character: range.end.character,
              };
              actions.push({
                title: "Add VARCHAR length (e.g., VARCHAR(100))",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [
                      {
                        range: { start: insertPos, end: insertPos },
                        newText: "(100)",
                      },
                    ],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "SQL019") {
              actions.push({
                title: "Remove unused alias",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [{ range, newText: "" }],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "PAR003") {
              actions.push({
                title: "Remove duplicate keyword",
                kind: CodeActionKind.QuickFix,
                diagnostics: [diagnostic],
                isPreferred: true,
                edit: {
                  changes: {
                    [document.uri]: [{ range, newText: "" }],
                  },
                },
              } satisfies CodeAction);
            }

            if (code === "PAR004") {
              const fix = getDiagnosticSuggestedFix(diagnostic);
              if (fix) {
                actions.push({
                  title: `Fix typo: ${fix}`,
                  kind: CodeActionKind.QuickFix,
                  diagnostics: [diagnostic],
                  isPreferred: true,
                  edit: {
                    changes: {
                      [document.uri]: [{ range, newText: fix }],
                    },
                  },
                } satisfies CodeAction);
              }
            }

            if (isCancellationRequested()) {
              return null;
            }
          }

          return actions.length > 0 ? actions : null;
        },
      );
    },
  );
}

function findCrossJoinReplacement(
  text: string,
  diagnosticOffset: number,
  databaseKind: DatabaseKind,
): { startOffset: number; endOffset: number } | undefined {
  const statement = buildStatementIndex(text).statements.find(
    (candidate) => diagnosticOffset >= candidate.startOffset && diagnosticOffset <= candidate.endOffset,
  );
  if (!statement) {
    return undefined;
  }

  const runtime = resolveSqlParsingRuntime({ databaseKind });
  const parsed = parseSqlStatements({
    sql: statement.sql,
    runtime,
    databaseKind,
  });
  if (
    !parsed.cst ||
    parsed.lexResult.errors.length > 0 ||
    parsed.actionableParserErrors.length > 0
  ) {
    return undefined;
  }

  const tokens = runtime.SqlLexer.tokenize(statement.sql).tokens;
  for (let index = 0; index < tokens.length - 1; index++) {
    if (
      tokens[index].tokenType.name !== "Cross" ||
      tokens[index + 1].tokenType.name !== "Join"
    ) {
      continue;
    }
    const startOffset = statement.startOffset + (tokens[index].startOffset ?? 0);
    const endOffset = statement.startOffset + (tokens[index + 1].endOffset ?? 0) + 1;
    if (diagnosticOffset >= startOffset && diagnosticOffset <= endOffset) {
      return { startOffset, endOffset };
    }
  }
  return undefined;
}

interface JoinAliasRewrite {
  aliasName: string;
  insertOffset: number;
  referenceRanges: Array<{ startOffset: number; endOffset: number }>;
}

function findJoinAliasRewrite(
  text: string,
  diagnosticOffset: number,
  databaseKind: DatabaseKind,
): JoinAliasRewrite | undefined {
  const statement = buildStatementIndex(text).statements.find(
    (candidate) => diagnosticOffset >= candidate.startOffset && diagnosticOffset <= candidate.endOffset,
  );
  if (!statement) {
    return undefined;
  }

  const runtime = resolveSqlParsingRuntime({ databaseKind });
  const lexResult = runtime.SqlLexer.tokenize(statement.sql);
  if (lexResult.errors.length > 0) {
    return undefined;
  }

  const tokens = lexResult.tokens;
  const reservedNames = new Set<string>();
  const candidates: Array<{
    tableName: string;
    insertOffset: number;
    sourceStart: number;
    sourceEnd: number;
  }> = [];
  const definitions: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const sourceKind = tokens[index].tokenType.name;
    const isJoin = sourceKind === "Join";
    if (sourceKind !== "From" && !isJoin) {
      continue;
    }
    let cursor = index + 1;
    if (tokens[cursor]?.tokenType.name === "LParen") {
      continue;
    }

    let lastIdentifier: typeof tokens[number] | undefined;
    const relationIdentifiers: typeof tokens[number][] = [];
    while (cursor < tokens.length) {
      const tokenName = tokens[cursor].tokenType.name;
      if (isIdentifierToken(tokenName)) {
        lastIdentifier = tokens[cursor++];
        relationIdentifiers.push(lastIdentifier);
        continue;
      }
      if (tokenName === "Dot") {
        cursor++;
        continue;
      }
      break;
    }
    if (!lastIdentifier) {
      continue;
    }

    const sourceStart = tokens[index + 1]?.startOffset ?? 0;
    const sourceEnd = (lastIdentifier.endOffset ?? lastIdentifier.startOffset ?? 0) + 1;
    const tableName = normalizeSqlIdentifier(lastIdentifier.image, databaseKind);
    for (const relationIdentifier of relationIdentifiers) {
      reservedNames.add(
        normalizeSqlIdentifier(relationIdentifier.image, databaseKind).toUpperCase(),
      );
    }
    definitions.push(tableName.toUpperCase());

    const nextToken = tokens[cursor];
    if (nextToken?.tokenType.name === "As") {
      const aliasToken = tokens[cursor + 1];
      if (aliasToken && isIdentifierToken(aliasToken.tokenType.name)) {
        reservedNames.add(
          normalizeSqlIdentifier(aliasToken.image, databaseKind).toUpperCase(),
        );
        continue;
      }
    }
    if (nextToken && isIdentifierToken(nextToken.tokenType.name)) {
      reservedNames.add(
        normalizeSqlIdentifier(nextToken.image, databaseKind).toUpperCase(),
      );
      continue;
    }
    if (
      isJoin &&
      (nextToken?.tokenType.name === "On" ||
        nextToken?.tokenType.name === "Using")
    ) {
      candidates.push({
        tableName,
        insertOffset: statement.startOffset + sourceEnd,
        sourceStart,
        sourceEnd,
      });
    }
  }

  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort(
    (left, right) =>
      Math.abs(statement.startOffset + left.sourceStart - diagnosticOffset) -
      Math.abs(statement.startOffset + right.sourceStart - diagnosticOffset),
  );
  const candidate = candidates[0];
  if (
    !candidate ||
    definitions.filter(
      (name) => name === candidate.tableName.toUpperCase(),
    ).length !== 1
  ) {
    return undefined;
  }

  const base =
    candidate.tableName.replace(/[^A-Za-z0-9_]/g, "").charAt(0).toUpperCase() ||
    "T";
  let suffix = 1;
  let aliasName = base + suffix;
  while (reservedNames.has(aliasName.toUpperCase())) {
    suffix += 1;
    aliasName = base + suffix;
  }

  const referenceRanges: Array<{ startOffset: number; endOffset: number }> = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (
      !isIdentifierToken(token.tokenType.name) ||
      tokens[index + 1].tokenType.name !== "Dot"
    ) {
      continue;
    }
    if (tokens[index - 1]?.tokenType.name === "Dot") {
      continue;
    }
    const tokenName = normalizeSqlIdentifier(token.image, databaseKind);
    if (
      tokenName.toUpperCase() === candidate.tableName.toUpperCase() &&
      ((token.startOffset ?? 0) < candidate.sourceStart ||
        (token.startOffset ?? 0) >= candidate.sourceEnd)
    ) {
      referenceRanges.push({
        startOffset: statement.startOffset + (token.startOffset ?? 0),
        endOffset: statement.startOffset + (token.endOffset ?? token.startOffset ?? 0) + 1,
      });
    }
  }

  return { aliasName, insertOffset: candidate.insertOffset, referenceRanges };
}

function isIdentifierToken(tokenName: string): boolean {
  return tokenName === "Identifier" || tokenName.endsWith("Identifier");
}

function normalizeSqlIdentifier(
  image: string,
  databaseKind: DatabaseKind,
): string {
  return stripIdentifierQuoting(image, databaseKind);
}
