import type { CstNode, TokenType } from "chevrotain";
import * as netezzaLexer from "../../netezza/sql/lexer";
import * as mysqlLexer from "./lexer";
import { NetezzaSqlParser } from "../../netezza/sql/parser";

type AnyRule = () => CstNode;

/**
 * MySQL 8 parser layered on the shared CST grammar.
 *
 * The grammar intentionally covers the high-frequency authoring surface:
 * backtick names, database.table references, MySQL LIMIT forms, INSERT IGNORE,
 * ON DUPLICATE KEY UPDATE, common CREATE TABLE attributes and CTEs. It does
 * not attempt to model stored-program bodies or every vendor extension.
 */
export class MysqlSqlParser extends NetezzaSqlParser {
  mysqlOnDuplicateKeyUpdate!: AnyRule;
  mysqlColumnAttribute!: AnyRule;
  mysqlParenthesizedTail!: AnyRule;
  mysqlTableOption!: AnyRule;
  mysqlTableOptions!: AnyRule;

  public constructor() {
    super(mysqlLexer);
  }

  protected supportsEmptyQualifiedNameSegment(): boolean {
    return false;
  }

  protected getNetezzaRelaxedNameTokens(): TokenType[] {
    return [...super.getNetezzaRelaxedNameTokens(), mysqlLexer.BacktickIdentifier];
  }

  protected getNetezzaIdentifierTokens(): TokenType[] {
    return [...super.getNetezzaIdentifierTokens(), mysqlLexer.BacktickIdentifier];
  }

  protected registerCreateTableDialectClauses(): void {
    this.OPTION7(() => this.SUBRULE(this.mysqlTableOptions));
  }

  protected registerDialectExtensions(): void {
    this.RULE("mysqlOnDuplicateKeyUpdate", () => {
      this.CONSUME(netezzaLexer.On);
      this.CONSUME(netezzaLexer.Identifier); // DUPLICATE
      this.CONSUME(netezzaLexer.Key);
      this.CONSUME(netezzaLexer.Update);
      this.AT_LEAST_ONE_SEP({
        SEP: netezzaLexer.Comma,
        DEF: () => this.SUBRULE(this.updateSetItem),
      });
    });

    this.RULE("mysqlColumnAttribute", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.mysqlParenthesizedTail) },
        {
          GATE: () => this.LA(1).tokenType !== netezzaLexer.LParen,
          ALT: () => this.SUBRULE(this.commandTailToken),
        },
      ]);
    });

    this.RULE("mysqlParenthesizedTail", () => {
      this.CONSUME(netezzaLexer.LParen);
      this.AT_LEAST_ONE(() => this.SUBRULE(this.commandTailToken));
      this.CONSUME(netezzaLexer.RParen);
    });

    this.RULE("mysqlTableOption", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.mysqlParenthesizedTail) },
        {
          GATE: () => this.LA(1).tokenType !== netezzaLexer.LParen,
          ALT: () => this.SUBRULE(this.commandTailToken),
        },
      ]);
    });

    this.RULE("mysqlTableOptions", () => {
      this.AT_LEAST_ONE(() => this.SUBRULE(this.mysqlTableOption));
    });

    this.OVERRIDE_RULE("qualifiedName", () => {
      this.SUBRULE(this.identifier);
      this.OPTION(() => {
        this.CONSUME(netezzaLexer.Dot);
        this.SUBRULE1(this.identifier);
      });
    });

    this.OVERRIDE_RULE("limitClause", () => {
      this.CONSUME(netezzaLexer.Limit);
      this.CONSUME(netezzaLexer.NumberLiteral);
      this.OPTION(() => {
        this.OR([
          {
            ALT: () => {
              this.CONSUME(netezzaLexer.Comma);
              this.CONSUME1(netezzaLexer.NumberLiteral);
            },
          },
          {
            ALT: () => {
              this.CONSUME(netezzaLexer.Offset);
              this.CONSUME2(netezzaLexer.NumberLiteral);
            },
          },
        ]);
      });
    });

    this.OVERRIDE_RULE("insertStatement", () => {
      this.CONSUME(netezzaLexer.Insert);
      this.OPTION({
        GATE: () =>
          this.LA(1).tokenType === netezzaLexer.Identifier &&
          this.LA(1).image.toUpperCase() === "IGNORE",
        DEF: () => this.CONSUME(netezzaLexer.Identifier),
      });
      this.CONSUME(netezzaLexer.Into);
      this.SUBRULE(this.tableName);
      this.OPTION1(() => {
        this.CONSUME(netezzaLexer.LParen);
        this.AT_LEAST_ONE_SEP({
          SEP: netezzaLexer.Comma,
          DEF: () => this.SUBRULE(this.identifier),
        });
        this.CONSUME(netezzaLexer.RParen);
      });
      this.OR([
        { ALT: () => this.SUBRULE(this.valuesClause) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertWithClause) },
      ]);
      this.OPTION2(() => this.SUBRULE(this.mysqlOnDuplicateKeyUpdate));
    });

    this.OVERRIDE_RULE("functionCall", () => {
      this.OR1([
        { ALT: () => this.CONSUME(netezzaLexer.Identifier) },
        { ALT: () => this.CONSUME(netezzaLexer.QuotedIdentifier) },
        { ALT: () => this.CONSUME(mysqlLexer.BacktickIdentifier) },
        { ALT: () => this.CONSUME(netezzaLexer.Next) },
        { ALT: () => this.CONSUME(netezzaLexer.Replace) },
        { ALT: () => this.CONSUME(netezzaLexer.Random) },
        { ALT: () => this.CONSUME(netezzaLexer.Value) },
        { ALT: () => this.CONSUME(netezzaLexer.IsNull) },
        { ALT: () => this.CONSUME(netezzaLexer.If) },
      ]);
      this.CONSUME(netezzaLexer.LParen);
      this.OPTION(() => {
        this.OR2([
          { ALT: () => this.CONSUME(netezzaLexer.Distinct) },
          { ALT: () => this.CONSUME(netezzaLexer.All) },
        ]);
      });
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME1(netezzaLexer.RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.withinGroupClause));
      this.OPTION4(() => this.SUBRULE(this.overClause));
    });

    this.OVERRIDE_RULE("typeNameWord", () => {
      this.OR([
        { ALT: () => this.CONSUME(netezzaLexer.Identifier) },
        { ALT: () => this.CONSUME(netezzaLexer.QuotedIdentifier) },
        { ALT: () => this.CONSUME(mysqlLexer.BacktickIdentifier) },
        { ALT: () => this.CONSUME(netezzaLexer.To) },
        { ALT: () => this.CONSUME(netezzaLexer.Set) },
      ]);
    });

    this.OVERRIDE_RULE("typeArgument", () => {
      this.OR([
        { ALT: () => this.CONSUME(netezzaLexer.NumberLiteral) },
        { ALT: () => this.CONSUME(netezzaLexer.Identifier) },
        { ALT: () => this.CONSUME(netezzaLexer.QuotedIdentifier) },
        { ALT: () => this.CONSUME(mysqlLexer.BacktickIdentifier) },
        { ALT: () => this.CONSUME(netezzaLexer.StringLiteral) },
      ]);
    });

    this.OVERRIDE_RULE("columnDefinition", () => {
      this.SUBRULE(this.columnName);
      this.SUBRULE(this.typeName);
      // MySQL has many optional attributes (AUTO_INCREMENT, COMMENT, COLLATE,
      // ON UPDATE, generated-column clauses, ...). commandTailToken gives them
      // a bounded, token-based syntax without swallowing the next column.
      this.MANY({
        GATE: () =>
          this.LA(1).tokenType !== netezzaLexer.Comma &&
          this.LA(1).tokenType !== netezzaLexer.RParen,
        DEF: () => this.SUBRULE(this.mysqlColumnAttribute),
      });
    });

    this.OVERRIDE_RULE("cteDefinition", () => {
      this.SUBRULE(this.identifier);
      this.OPTION(() => this.SUBRULE(this.cteColumnList));
      this.CONSUME(netezzaLexer.As);
      this.OPTION1(() => this.CONSUME(netezzaLexer.All));
      this.CONSUME(netezzaLexer.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
      ]);
      this.CONSUME(netezzaLexer.RParen);
    });

    this.OVERRIDE_RULE("insertCteDefinition", () => {
      this.SUBRULE(this.identifier);
      this.OPTION({
        GATE: () =>
          this.LA(1).tokenType === netezzaLexer.LParen &&
          this.LA(2).tokenType !== netezzaLexer.Select &&
          this.LA(2).tokenType !== netezzaLexer.With &&
          this.LA(2).tokenType !== netezzaLexer.Recursive,
        DEF: () => this.SUBRULE(this.cteColumnList),
      });
      this.OPTION1(() => this.CONSUME(netezzaLexer.As));
      this.CONSUME(netezzaLexer.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
      ]);
      this.CONSUME(netezzaLexer.RParen);
    });
  }
}

export class SqlParser extends MysqlSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
  return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
  parserInstance ??= createSqlParserInstance();
  return parserInstance;
}

export const sqlParser = {
  get input(): unknown[] {
    return getSqlParserInstance().input;
  },
  set input(value: unknown[]) {
    getSqlParserInstance().input = value as never;
  },
  get errors(): unknown[] {
    return getSqlParserInstance().errors;
  },
  set errors(value: unknown[]) {
    getSqlParserInstance().errors = value as never;
  },
  getBaseCstVisitorConstructor(): ReturnType<SqlParser["getBaseCstVisitorConstructor"]> {
    return getSqlParserInstance().getBaseCstVisitorConstructor();
  },
  getBaseCstVisitorConstructorWithDefaults(): ReturnType<
    SqlParser["getBaseCstVisitorConstructorWithDefaults"]
  > {
    return getSqlParserInstance().getBaseCstVisitorConstructorWithDefaults();
  },
  getSerializedGastProductions(): ReturnType<SqlParser["getSerializedGastProductions"]> {
    return getSqlParserInstance().getSerializedGastProductions();
  },
} as unknown as SqlParser;
