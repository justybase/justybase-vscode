import { CstNode, type IToken } from "chevrotain";
import type { ValidationError } from "../types";
import { resolveSqlParsingRuntime } from "../parsingRuntime";
import {
  ProcedureScopeBuilder,
  type ProcedureParamMode,
} from "../procedure/procedureScopeBuilder";
import {
  decodeSqlStringLiteral,
  getStringBodyOffsetShift,
  parseWrappedProcedureStringBody,
} from "../procedure/procedureStringBody";
import { unquoteIdentifier } from "../../utils/identifierUtils";
import type { DatabaseSqlValidationProfile } from "../../sql/authoring/types";
import type { ScopeBuilder } from "./scopeBuilder";

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
  getInProcedureSqlContext(): boolean;
  setInProcedureSqlContext(value: boolean): void;
  getProcedureScope(): ProcedureScopeBuilder | null;
  setProcedureScope(scope: ProcedureScopeBuilder | null): void;
  getProcedureTopLevelSelect(): boolean;
  setProcedureTopLevelSelect(value: boolean): void;
  getStringBodyOffsetShift(): number;
  setStringBodyOffsetShift(value: number): void;
  getValidationProfile(): DatabaseSqlValidationProfile;
  getScopeBuilder(): ScopeBuilder;
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
    if (!(key.startsWith("Returns") || key.startsWith("Return")) || !Array.isArray(value)) continue;
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
  host.getScopeBuilder().enterScope();
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
  if (ctx.procedureBlock) {
    host.visit(ctx.procedureBlock[0]);
  }
  if (ctx.oracleAnonymousBlock) {
    host.visit(ctx.oracleAnonymousBlock[0]);
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
  host.getScopeBuilder().exitScope();
  host.setInProcedureContext(prev);
}

export function oracleProgramUnit(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.createProcedureStatement) {
    host.visit(ctx.createProcedureStatement[0]);
    return;
  }

  if (!ctx.procedureBlock) {
    return;
  }

  const previousContext = host.getInProcedureContext();
  host.setInProcedureContext(true);
  host.getScopeBuilder().enterScope();
  const scope = new ProcedureScopeBuilder();
  host.setProcedureScope(scope);
  try {
    host.visit(ctx.procedureBlock[0]);
    for (const diagnostic of scope.finalize()) {
      host.addError(
        diagnostic.message,
        diagnostic.token,
        diagnostic.severity,
        diagnostic.code,
      );
    }
  } finally {
    host.setProcedureScope(null);
    host.getScopeBuilder().exitScope();
    host.setInProcedureContext(previousContext);
  }
}

export function oraclePackageUnit(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oraclePackageMember?.forEach((member) => host.visit(member));
}

export function oraclePackageMember(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.oraclePackageRoutine) {
    host.visit(ctx.oraclePackageRoutine[0]);
  }
}

export function oraclePackageRoutine(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  // Package specifications contain routine declarations without a body. They
  // do not form a procedure scope until the matching package body is parsed.
  if (!ctx.oracleAnonymousBlock) return;

  const previousContext = host.getInProcedureContext();
  const scope = new ProcedureScopeBuilder();
  host.setInProcedureContext(true);
  host.getScopeBuilder().enterScope();
  host.setProcedureScope(scope);
  try {
    if (ctx.procedureArguments) {
      host.visit(ctx.procedureArguments[0]);
    }
    if (ctx.procedureSignatureSpec) {
      host.visit(ctx.procedureSignatureSpec[0]);
    }
    host.visit(ctx.oracleAnonymousBlock[0]);
    for (const diagnostic of scope.finalize()) {
      host.addError(
        diagnostic.message,
        diagnostic.token,
        diagnostic.severity,
        diagnostic.code,
      );
    }
  } finally {
    host.setProcedureScope(null);
    host.getScopeBuilder().exitScope();
    host.setInProcedureContext(previousContext);
  }
}

export function oracleTriggerUnit(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.oracleAnonymousBlock) {
    host.visit(ctx.oracleAnonymousBlock[0]);
  }
}

export function oracleTriggerHeader(): void {
  // Trigger timing/event clauses are syntax-only at this layer.
}

export function oracleAnonymousBlock(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const existingScope = host.getProcedureScope();
  if (existingScope) {
    if (ctx.oracleVariableDeclarations) {
      host.visit(ctx.oracleVariableDeclarations[0]);
    }
    if (ctx.oracleBlockBody) {
      host.visit(ctx.oracleBlockBody[0]);
    }
    return;
  }

  const previousContext = host.getInProcedureContext();
  const scope = new ProcedureScopeBuilder();
  host.setInProcedureContext(true);
  host.getScopeBuilder().enterScope();
  host.setProcedureScope(scope);
  try {
    if (ctx.oracleVariableDeclarations) {
      host.visit(ctx.oracleVariableDeclarations[0]);
    }
    if (ctx.oracleBlockBody) {
      host.visit(ctx.oracleBlockBody[0]);
    }
    for (const diagnostic of scope.finalize()) {
      host.addError(
        diagnostic.message,
        diagnostic.token,
        diagnostic.severity,
        diagnostic.code,
      );
    }
  } finally {
    host.setProcedureScope(null);
    host.getScopeBuilder().exitScope();
    host.setInProcedureContext(previousContext);
  }
}

export function oracleBlockBody(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const tokens: IToken[] = [];
  const blockStatements = ctx.oracleBlockStatement ?? [];
  if (blockStatements.length > 0) {
    blockStatements.forEach((statement) => collectOracleCstTokens(host, statement, tokens));
  } else {
    (ctx.oracleProgramToken ?? [])
      .map((node) => host.getFirstTokenFromCst(node))
      .forEach((token) => {
        if (token) tokens.push(token);
      });
  }

  const scope = host.getProcedureScope();
  if (scope) {
    scanOracleBlockTokens(scope, tokens);
  }

  blockStatements.forEach((statement) => host.visit(statement));
}

function collectOracleCstTokens(
  host: ProcedureVisitorHost,
  node: CstNode,
  result: IToken[],
): void {
  for (const values of Object.values(node.children ?? {})) {
    for (const value of values) {
      if (host.isToken(value)) {
        result.push(value);
      } else {
        collectOracleCstTokens(host, value, result);
      }
    }
  }
}

function scanOracleBlockTokens(scope: ProcedureScopeBuilder, tokens: IToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const image = tokenImage(token);

    if (image === 'RETURN') {
      scope.setHasReturn();
      continue;
    }

    if (image === 'SELECT') {
      let hasInto = false;
      for (let lookahead = index + 1; lookahead < tokens.length; lookahead += 1) {
        const nextImage = tokenImage(tokens[lookahead]);
        if (nextImage === 'INTO') hasInto = true;
        if (nextImage === ';' || nextImage === 'END') {
          scope.checkStandaloneSelect(token, hasInto);
          index = lookahead;
          break;
        }
      }
      continue;
    }

    if (!['StringLiteral', 'NumberLiteral', 'Semicolon', 'Comma', 'LParen', 'RParen', 'Dot', 'Equals', 'Assign', 'LineComment', 'BlockComment', 'Comment', 'WhiteSpace'].includes(token.tokenType.name)) {
      const nextImage = tokenImage(tokens[index + 1]);
      if (nextImage === ':=') {
        scope.markNameAssigned(unquoteIdentifier(token.image ?? ''));
      } else {
        scope.markNameUsed(unquoteIdentifier(token.image ?? ''));
      }
    }
  }
}

function tokenImage(token: IToken | undefined): string {
  return (token?.image ?? '').replace(/^"|"$/g, '').toUpperCase();
}

export function oracleBlockStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const child = [
    ctx.oracleIfStatement,
    ctx.ifStatement,
    ctx.oracleLoopStatement,
    ctx.oracleWhileStatement,
    ctx.oracleForStatement,
    ctx.loopStatement,
    ctx.whileStatement,
    ctx.forStatement,
    ctx.assignmentStatement,
    ctx.selectStatement,
    ctx.insertStatement,
    ctx.updateStatement,
    ctx.deleteStatement,
    ctx.callStatement,
    ctx.executeImmediateStatement,
    ctx.returnStatement,
    ctx.oracleNullStatement,
    ctx.oracleTokenStatement,
  ].find((entries) => entries?.length);
  if (child) {
    const isSqlStatement = [
      ctx.selectStatement,
      ctx.insertStatement,
      ctx.updateStatement,
      ctx.deleteStatement,
    ].includes(child);
    const previousSqlContext = host.getInProcedureSqlContext();
    if (isSqlStatement) {
      host.setInProcedureSqlContext(true);
    }
    try {
      host.visit(child[0]);
    } finally {
      if (isSqlStatement) {
        host.setInProcedureSqlContext(previousSqlContext);
      }
    }
  }
}

export function oracleConditionalBody(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oracleBlockStatement?.forEach((statement) => host.visit(statement));
}

export function oracleIfStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.oracleConditionalBody) {
    host.visit(ctx.oracleConditionalBody[0]);
  }
  ctx.oracleElsifClause?.forEach((clause) => host.visit(clause));
  // Visit all remaining conditional bodies (ELSE branch, if any)
  if (ctx.oracleConditionalBody?.length && ctx.oracleConditionalBody.length > 1) {
    for (let i = 1; i < ctx.oracleConditionalBody.length; i++) {
      host.visit(ctx.oracleConditionalBody[i]);
    }
  }
}

export function oracleElsifClause(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.oracleConditionalBody) {
    host.visit(ctx.oracleConditionalBody[0]);
  }
}

export function oracleLoopStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.oracleConditionalBody) {
    host.visit(ctx.oracleConditionalBody[0]);
  }
}

export function oracleWhileStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
  }
  if (ctx.oracleConditionalBody) {
    host.visit(ctx.oracleConditionalBody[0]);
  }
}

export function oracleForStatement(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.oracleForHeader) {
    host.visit(ctx.oracleForHeader[0]);
  }
  if (ctx.oracleConditionalBody) {
    host.visit(ctx.oracleConditionalBody[0]);
  }
}

export function oracleForHeader(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oracleProgramToken?.forEach((token) => host.visit(token));
}

export function oracleExceptionBlock(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oracleWhenClause?.forEach((clause) => host.visit(clause));
}

export function oracleWhenClause(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.oracleExceptionBody) {
    host.visit(ctx.oracleExceptionBody[0]);
  }
}

export function oracleExceptionBody(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oracleBlockStatement?.forEach((statement) => host.visit(statement));
}

export function oracleVariableDeclarations(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  ctx.oracleVariableDeclaration?.forEach((declaration) => host.visit(declaration));
}

export function oracleVariableDeclaration(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  const identifier = ctx.identifier?.[0];
  if (identifier) {
    const name = host.visitAs<string>(identifier);
    const token = host.getFirstTokenFromCst(identifier);
    if (name && token) {
      host.getProcedureScope()?.registerVariable(name, token);
    }
    host.visit(identifier);
  }
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
  if (ctx.expression) {
    ctx.expression.forEach((expression) => host.visit(expression));
  }
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
  if (ctx.oracleProcedureArgumentWithMode) {
    host.visit(ctx.oracleProcedureArgumentWithMode[0]);
    return;
  }
  if (ctx.oracleProcedureArgumentWithoutMode) {
    host.visit(ctx.oracleProcedureArgumentWithoutMode[0]);
    return;
  }

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

function visitOracleArgument(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
  mode: ProcedureParamMode,
): void {
  const identifier = ctx.identifier?.[0];
  if (identifier) {
    const name = host.visitAs<string>(identifier);
    const token = host.getFirstTokenFromCst(identifier);
    if (name && token) {
      host.getProcedureScope()?.registerParameter(name, mode, token);
    }
    host.visit(identifier);
  }
  if (ctx.procedureArgumentMode) {
    host.visit(ctx.procedureArgumentMode[0]);
  }
  if (ctx.typeName) {
    host.visit(ctx.typeName[0]);
  }
  if (ctx.oracleParameterDefault) {
    host.visit(ctx.oracleParameterDefault[0]);
  }
}

export function oracleProcedureArgumentWithMode(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  let mode: ProcedureParamMode = 'IN';
  const modeNode = ctx.procedureArgumentMode?.[0];
  if (modeNode) {
    const children = modeNode.children ?? {};
    if (children.Inout || (children.In && children.Out)) {
      mode = 'INOUT';
    } else if (children.Out) {
      mode = 'OUT';
    }
  }
  visitOracleArgument(host, ctx, mode);
}

export function oracleProcedureArgumentWithoutMode(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  visitOracleArgument(host, ctx, 'IN');
}

export function oracleParameterDefault(
  host: ProcedureVisitorHost,
  ctx: Record<string, CstNode[]>,
): void {
  if (ctx.expression) {
    host.visit(ctx.expression[0]);
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
  if (ctx.oracleVariableDeclarations) {
    host.visit(ctx.oracleVariableDeclarations[0]);
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
