import type { CstNode, IRecognitionException, IToken } from "chevrotain";
import { SqlVisitor as SharedSqlVisitor } from "@justybase/sql-core/validation/visitor/sqlVisitorCore";
import * as procedureVisitor from "@justybase/sql-core/validation/visitor/procedureVisitor";
import { ProcedureScopeBuilder } from "@justybase/sql-core/validation/procedureScopeBuilder";
import type { SqlVisitorQualificationTraits } from "@justybase/sql-core/validation/visitor/sqlVisitorHost";
import { getDatabaseSqlAuthoring } from "../../core/sqlAuthoringRegistry";
import { getDatabaseDialectTraits } from "../../core/dialectTraits";
import type { DatabaseSqlValidationProfile } from "../../sql/authoring/types";
import {
  formatQualifiedObjectName,
  stripIdentifierQuoting,
} from "../../utils/identifierUtils";
import {
  parseSqlStatements,
  resolveSqlParsingRuntime,
  type MacroReferenceRange,
} from "../parsingRuntime";
import { parseWrappedProcedureStringBody } from "../procedure/procedureStringBody";
import type { SchemaProvider } from "../schemaProvider";

/**
 * Desktop visitor: the shared @justybase/sql-core SqlVisitor plus the dialect hooks for the
 * non-Netezza runtimes. Grammar rules get their visitor methods in sql-core only; this class
 * overrides a rule method only where a dialect needs different behavior.
 */
export class SqlVisitor extends SharedSqlVisitor {
  constructor(
    schemaProvider?: SchemaProvider,
    validationProfile: DatabaseSqlValidationProfile = getDatabaseSqlAuthoring()
      .validation,
    macroReferenceRanges: readonly MacroReferenceRange[] = [],
  ) {
    super(schemaProvider, validationProfile, macroReferenceRanges);
  }

  private get databaseKind(): DatabaseSqlValidationProfile["databaseKind"] {
    return this.getValidationProfile().databaseKind;
  }

  override stripIdentifierQuoting(text: string): string {
    return stripIdentifierQuoting(text, this.databaseKind);
  }

  override formatRelationName(
    database: string | undefined,
    schema: string | undefined,
    name: string,
  ): string {
    return formatQualifiedObjectName(database, schema, name, this.databaseKind);
  }

  override getQualificationTraits(): SqlVisitorQualificationTraits {
    const databaseKind = this.databaseKind;
    return {
      twoPartNameStyle:
        databaseKind === "mysql" ? "database-object" : "schema-object",
      supportsThreePartName:
        !databaseKind ||
        getDatabaseDialectTraits(databaseKind).qualification
          .supportsThreePartName,
    };
  }

  override parseProcedureStringBody(decodedBody: string): {
    beginProcBody?: CstNode;
    parserErrors: IRecognitionException[];
  } {
    return parseWrappedProcedureStringBody(
      decodedBody,
      resolveSqlParsingRuntime({ validationProfile: this.getValidationProfile() }),
    );
  }

  protected override quotedIdentifiersAreCaseSensitive(): boolean {
    const databaseKind = this.databaseKind;
    return databaseKind === undefined || databaseKind === "netezza";
  }

  override beginStatement(ctx: Record<string, CstNode[]>): void {
    if (
      resolveSqlParsingRuntime({ validationProfile: this.getValidationProfile() })
        .id !== "oracle"
    ) {
      super.beginStatement(ctx);
      return;
    }

    const tokens: IToken[] = [];
    const collectTokens = (value: unknown): void => {
      if (this.isToken(value)) {
        tokens.push(value);
        return;
      }
      if (!this.isCstNode(value)) return;
      Object.values(value.children ?? {}).forEach((children) => {
        children.forEach((child) => collectTokens(child));
      });
    };
    Object.values(ctx).forEach((children) => {
      (children as unknown[]).forEach((child) => collectTokens(child));
    });
    tokens.sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0));

    const existingScope = this.getProcedureScope();
    const scope = existingScope ?? new ProcedureScopeBuilder();
    const previousContext = this.getInProcedureContext();
    if (!existingScope) {
      this.setInProcedureContext(true);
      this.getScopeBuilder().enterScope();
      this.setProcedureScope(scope);
    }

    try {
      procedureVisitor.registerOracleDeclarationTokens(scope, tokens);
      const beginIndex = tokens.findIndex((token) => token.image?.toUpperCase() === "BEGIN");
      procedureVisitor.scanOracleBlockTokens(
        scope,
        beginIndex >= 0 ? tokens.slice(beginIndex + 1) : tokens,
      );
      this.visitOracleEmbeddedSelects(tokens, beginIndex);

      if (!existingScope) {
        for (const diagnostic of scope.finalize()) {
          this.addError(
            diagnostic.message,
            diagnostic.token,
            diagnostic.severity,
            diagnostic.code,
          );
        }
      }
    } finally {
      if (!existingScope) {
        this.setProcedureScope(null);
        this.getScopeBuilder().exitScope();
        this.setInProcedureContext(previousContext);
      }
    }
  }

  private visitOracleEmbeddedSelects(tokens: IToken[], beginIndex: number): void {
    if (beginIndex < 0) return;

    const runtime = resolveSqlParsingRuntime({
      validationProfile: this.getValidationProfile(),
    });
    for (let index = beginIndex + 1; index < tokens.length; index += 1) {
      if (tokens[index].image?.toUpperCase() !== "SELECT") continue;

      const endIndex = tokens.findIndex(
        (token, candidate) => candidate >= index && token.image === ";",
      );
      if (endIndex < 0) break;

      const sql = tokens
        .slice(index, endIndex + 1)
        .map((token) => token.image)
        .join(" ");
      const parseResult = parseSqlStatements({ sql, runtime });
      if (parseResult.actionableParserErrors.length > 0 || !parseResult.cst) {
        index = endIndex;
        continue;
      }

      const statement = parseResult.cst.children.statement?.[0];
      if (statement && this.isCstNode(statement)) {
        const previousSqlContext = this.getInProcedureSqlContext();
        this.setInProcedureSqlContext(true);
        try {
          this.visit(statement);
        } finally {
          this.setInProcedureSqlContext(previousSqlContext);
        }
      }
      index = endIndex;
    }
  }
}
