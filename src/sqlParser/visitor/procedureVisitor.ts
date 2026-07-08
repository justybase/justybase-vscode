import { CstNode, type IToken } from "chevrotain";
import type { ValidationError } from "../types";
import { resolveSqlParsingRuntime } from "../parsingRuntime";
import { ProcedureScopeBuilder } from "../procedure/procedureScopeBuilder";
import {
  decodeSqlStringLiteral,
  getStringBodyOffsetShift,
  parseWrappedProcedureStringBody,
} from "../procedure/procedureStringBody";
import { unquoteIdentifier } from "../../utils/identifierUtils";
import type { DatabaseSqlValidationProfile } from "../../sql/authoring/types";

export interface ProcedureVisitorHost {
  addError(
    message: string,
    token: IToken,
    severity: ValidationError["severity"],
    code: string,
  ): void;
  visit(node: CstNode): void;
  visitAs<T>(node: CstNode): T;
  getTokenText(token: IToken | IToken[] | undefined): string;
  getFirstTokenFromCst(node: CstNode): IToken | undefined;
  isToken(value: unknown): value is IToken;
  getInProcedureContext(): boolean;
  setInProcedureContext(value: boolean): void;
  getProcedureScope(): ProcedureScopeBuilder | null;
  setProcedureScope(scope: ProcedureScopeBuilder | null): void;
  getProcedureTopLevelSelect(): boolean;
  setProcedureTopLevelSelect(value: boolean): void;
  getStringBodyOffsetShift(): number;
  setStringBodyOffsetShift(value: number): void;
  getValidationProfile(): DatabaseSqlValidationProfile;
  addScriptCreatedProcedure(name: string): void;
  formatRelationName(
    database: string | undefined,
    schema: string | undefined,
    name: string,
  ): string;
}

function getFirstReturnsToken(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[] | IToken[]>,
): IToken | undefined {
  for (const [key, value] of Object.entries(ctx)) {
    if (!key.startsWith("Returns") || !Array.isArray(value)) continue;
    const token = value[0];
    if (host.isToken(token)) return token;
  }
  return undefined;
}

function getFirstDeclarationNameToken(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[] | IToken[]>,
): IToken | undefined {
  for (const key of [
    "Identifier",
    "QuotedIdentifier",
    "Owner",
    "Start",
  ] as const) {
    const value = ctx[key];
    if (!Array.isArray(value) || value.length === 0) continue;
    const token = value[0];
    if (host.isToken(token)) return token;
  }
  return undefined;
}

function validateStringProcedureBody(
  host: ProcedureVisitorHost,
  stringToken: IToken,
): void {
  const decoded = decodeSqlStringLiteral(stringToken.image ?? "");
  const quoteContentStart = (stringToken.startOffset ?? 0) + 1;
  const offsetShift = getStringBodyOffsetShift(quoteContentStart);
  const parsingRuntime = resolveSqlParsingRuntime({
    validationProfile: host.getValidationProfile(),
  });
  const { beginProcBody, parserErrors } = parseWrappedProcedureStringBody(
    decoded,
    parsingRuntime,
  );

  if (parserErrors.length > 0) {
    const errorToken = parserErrors[0].token ?? stringToken;
    const isCaseEndError = parserErrors[0].message.includes("End");
    host.setStringBodyOffsetShift(offsetShift);
    host.addError(
      isCaseEndError
        ? "CASE expression must end with END"
        : parserErrors[0].message,
      errorToken,
      "error",
      isCaseEndError ? "SQL041" : "PAR001",
    );
    host.setStringBodyOffsetShift(0);
    if (!beginProcBody) {
      return;
    }
  }

  if (!beginProcBody) {
    return;
  }

  const savedShift = host.getStringBodyOffsetShift();
  host.setStringBodyOffsetShift(offsetShift);
  try {
    host.visit(beginProcBody);
  } finally {
    host.setStringBodyOffsetShift(savedShift);
  }
}

export function createProcedureStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const prev = host.getInProcedureContext();
  host.setInProcedureContext(true);
  const scope = new ProcedureScopeBuilder();
  host.setProcedureScope(scope);

  if (ctx.qualifiedName) {
    const nameInfo = host.visitAs<{
      name: string;
      schema?: string;
      database?: string;
    }>(ctx.qualifiedName[0]);
    host.addScriptCreatedProcedure(
      host.formatRelationName(
        nameInfo.database,
        nameInfo.schema,
        nameInfo.name,
      ),
    );
  }

  if (ctx.procedureArguments) {
    host.visit(ctx.procedureArguments[0]);
  }
  if (ctx.procedureSignatureSpec) {
    host.visit(ctx.procedureSignatureSpec[0]);
  }
  if (ctx.procedureBody) {
    host.visit(ctx.procedureBody[0]);
  }

  for (const diagnostic of scope.finalize()) {
    host.addError(
      diagnostic.message,
      diagnostic.token,
      diagnostic.severity,
      diagnostic.code,
    );
  }

  host.setProcedureScope(null);
  host.setInProcedureContext(prev);
}

export function procedureArguments(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureArgument) {
    ctx.procedureArgument.forEach((arg: CstNode) => host.visit(arg));
  }
}

export function procedureArgument(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  let mode: "IN" | "OUT" | "INOUT" = "IN";
  if (ctx.procedureArgumentMode) {
    const modeNode = ctx.procedureArgumentMode[0];
    if (modeNode.children?.Inout) {
      mode = "INOUT";
    } else if (modeNode.children?.Out) {
      mode = "OUT";
    } else if (modeNode.children?.In) {
      mode = "IN";
    }
    host.visit(modeNode);
  }
  if (ctx.identifier) {
    const name = host.visitAs<string>(ctx.identifier[0]);
    const token = host.getFirstTokenFromCst(ctx.identifier[0]);
    const procedureScope = host.getProcedureScope();
    if (procedureScope && name && token) {
      procedureScope.registerParameter(name, mode, token);
    }
    host.visit(ctx.identifier[0]);
  }
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
}

export function procedureArgumentMode(): void {
  // Syntax-only construct.
}

export function procedureReturnType(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
}

export function procedureSignatureSpec(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const returnsToken = getFirstReturnsToken(host, ctx);
  const procedureScope = host.getProcedureScope();
  if (returnsToken && procedureScope) {
    procedureScope.setHasReturns(returnsToken);
  }
  if (ctx.procedureReturnType) {
    host.visit(ctx.procedureReturnType[0]);
  }
  if (ctx.executeAsClause) {
    host.visit(ctx.executeAsClause[0]);
  }
}

export function executeAsClause(): void {
  // No validation needed
}

export function procedureBody(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const stringToken = ctx.StringLiteral?.[0];
  if (stringToken && host.isToken(stringToken)) {
    validateStringProcedureBody(host, stringToken);
    return;
  }
  if (ctx.beginProcBody) {
    host.visit(ctx.beginProcBody[0]);
  }
}

export function beginProcBody(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
}

export function procedureBlock(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureDeclareSection) {
    host.visit(ctx.procedureDeclareSection[0]);
  }
  if (ctx.autocommitClause) {
    host.visit(ctx.autocommitClause[0]);
  }
  if (ctx.procedureStatements) {
    host.visit(ctx.procedureStatements[0]);
  }
  if (ctx.exceptionBlock) {
    host.visit(ctx.exceptionBlock[0]);
  }
}

export function autocommitClause(): void {
  // Syntax-only construct.
}

export function procedureDeclareSection(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.variableDeclarations) {
    host.visit(ctx.variableDeclarations[0]);
  }
}

export function variableDeclarations(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.variableDeclaration) {
    ctx.variableDeclaration.forEach((decl: CstNode) => host.visit(decl));
  }
}

export function variableDeclaration(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const nameToken = getFirstDeclarationNameToken(host, ctx);
  const procedureScope = host.getProcedureScope();
  if (nameToken && procedureScope) {
    procedureScope.registerVariable(
      unquoteIdentifier(host.getTokenText(nameToken)),
      nameToken,
    );
  }
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
}

export function procedureStatements(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureStatement) {
    ctx.procedureStatement.forEach((stmt: CstNode) => host.visit(stmt));
  }
}

export function procedureStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.procedureBlock) host.visit(ctx.procedureBlock[0]);
  else if (ctx.ifStatement) host.visit(ctx.ifStatement[0]);
  else if (ctx.loopStatement) host.visit(ctx.loopStatement[0]);
  else if (ctx.whileStatement) host.visit(ctx.whileStatement[0]);
  else if (ctx.forStatement) host.visit(ctx.forStatement[0]);
  else if (ctx.exitStatement) host.visit(ctx.exitStatement[0]);
  else if (ctx.raiseStatement) host.visit(ctx.raiseStatement[0]);
  else if (ctx.returnStatement) host.visit(ctx.returnStatement[0]);
  else if (ctx.performStatement) host.visit(ctx.performStatement[0]);
  else if (ctx.arrayAssignmentStatement)
    host.visit(ctx.arrayAssignmentStatement[0]);
  else if (ctx.arrayMethodStatement) host.visit(ctx.arrayMethodStatement[0]);
  else if (ctx.assignmentStatement) host.visit(ctx.assignmentStatement[0]);
  else if (ctx.rollbackStatement) host.visit(ctx.rollbackStatement[0]);
  else if (ctx.commitStatement) host.visit(ctx.commitStatement[0]);
  else if (ctx.executeImmediateStatement)
    host.visit(ctx.executeImmediateStatement[0]);
  else if (ctx.callStatement) host.visit(ctx.callStatement[0]);
  else if (ctx.selectStatement) {
    host.setProcedureTopLevelSelect(true);
    host.visit(ctx.selectStatement[0]);
    host.setProcedureTopLevelSelect(false);
  } else if (ctx.insertStatement) host.visit(ctx.insertStatement[0]);
  else if (ctx.updateStatement) host.visit(ctx.updateStatement[0]);
  else if (ctx.deleteStatement) host.visit(ctx.deleteStatement[0]);
  else if (ctx.createTableStatement) host.visit(ctx.createTableStatement[0]);
  else if (ctx.createViewStatement) host.visit(ctx.createViewStatement[0]);
  else if (ctx.commentStatement) host.visit(ctx.commentStatement[0]);
  else if (ctx.alterTableStatement) host.visit(ctx.alterTableStatement[0]);
  else if (ctx.dropStatement) host.visit(ctx.dropStatement[0]);
  else if (ctx.groomStatement) host.visit(ctx.groomStatement[0]);
  else if (ctx.generateStatisticsStatement)
    host.visit(ctx.generateStatisticsStatement[0]);
}

export function procedureLabel(_ctx: Record<string, CstNode[]>): void {
  // Syntax-only; label resolution deferred to future NZP rule
}
