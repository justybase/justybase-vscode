import { CstNode, type IToken } from "chevrotain";
import type { DatabaseSqlValidationProfile } from "../../sql/authoring/types";
import type { ProcedureScopeBuilder } from "../procedure/procedureScopeBuilder";
import type { SchemaProvider } from "../schemaProvider";
import type { TableInfo, TokenPosition, ValidationError } from "../types";
import type { ScopeBuilder } from "./scopeBuilder";

export interface SqlVisitorHost {
  addError(
    message: string,
    token: IToken,
    severity?: ValidationError["severity"],
    code?: string,
    suggestedFix?: string,
  ): void;
  addErrorAtPosition(
    message: string,
    position: TokenPosition,
    severity?: ValidationError["severity"],
    code?: string,
    suggestedFix?: string,
  ): void;
  visit(node: CstNode): unknown;
  visitAs<T>(node: CstNode): T;
  visitEmbeddedSelectNode(node: CstNode): void;
  getTokenText(token: IToken | IToken[] | undefined): string;
  isCstNode(value: unknown): value is CstNode;
  isToken(value: unknown): value is IToken;
  getFirstTokenFromCst(node: CstNode): IToken | undefined;
  getCstText(node: CstNode): string;
  findDescendantCstNode(node: CstNode, targetName: string): CstNode | undefined;
  findDescendantCstNodeBounded(
    node: CstNode,
    targetName: string,
    boundaryRules?: ReadonlySet<string>,
  ): CstNode | undefined;
  getScopeBuilder(): ScopeBuilder;
  getSchemaProvider(): SchemaProvider | undefined;
  getValidationProfile(): DatabaseSqlValidationProfile;
  getProcedureScope(): ProcedureScopeBuilder | null;
  getProcedureTopLevelSelect(): boolean;
  validateTableExists(table: TableInfo, tableNameNode: CstNode): void;
  validateBooleanContext(
    expressionNode: CstNode,
    token: IToken,
    context: string,
  ): void;
  validateDataType(
    typeInfo: { name: string; params: string[] },
    token: IToken,
  ): void;
  applyKnownTableInfo(table: TableInfo, known: TableInfo): void;
  formatRelationName(
    database: string | undefined,
    schema: string | undefined,
    name: string,
  ): string;
  hasScriptCreatedProcedure(name: string): boolean;

  getInOrderBy(): boolean;
  setInOrderBy(value: boolean): void;
  getInWhere(): boolean;
  setInWhere(value: boolean): void;
  getInProcedureContext(): boolean;
  getInPerformContext(): boolean;
  setInPerformContext(value: boolean): void;
  getInSelectList(): boolean;
  setInSelectList(value: boolean): void;
  getSelectListAliasesSoFar(): Set<string>;
  setSelectListAliasesSoFar(value: Set<string>): void;
  getCanReferenceSelectAliases(): boolean;
  setCanReferenceSelectAliases(value: boolean): void;
  getEmbeddedSelectDepth(): number;
  setEmbeddedSelectDepth(value: number): void;
  pushSelectOutputAliases(value: Set<string>): void;
  replaceCurrentSelectOutputAliases(value: Set<string>): void;
  popSelectOutputAliases(): Set<string> | undefined;
  getCurrentSelectOutputAliases(): Set<string> | undefined;
}
