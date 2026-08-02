import type { TokenType } from 'chevrotain';
import { NetezzaSqlParser } from '../../netezza/sql/parser';
import * as postgresqlLexer from './lexer';
import type { CstNode } from 'chevrotain';

type AnyRule = () => CstNode;

/**
 * PostgreSQL parser layered on the shared CST grammar. It deliberately keeps
 * PostgreSQL's qualified-name rules strict (DB..TABLE is not PostgreSQL) and
 * lexes Netezza storage clauses as an unsupported token.
 */
export class PostgreSqlParser extends NetezzaSqlParser {
  postgresqlOnConflict!: AnyRule;
  postgresqlReturning!: AnyRule;
  arrayExpression!: AnyRule;
  public constructor() {
    super(postgresqlLexer);
  }

  protected supportsEmptyQualifiedNameSegment(): boolean {
    return false;
  }

  protected getNetezzaRelaxedNameTokens(): TokenType[] {
    return super.getNetezzaRelaxedNameTokens().filter(token => token !== postgresqlLexer.UnsupportedNetezza);
  }

  protected getAdditionalTableSourceAlternatives() {
    return [{
      ALT: () => {
        this.CONSUME(postgresqlLexer.Lateral);
        this.SUBRULE1(this.subquery);
      },
    }];
  }

  protected getAdditionalPrimaryExpressionAlternatives() {
    return [{ ALT: () => this.SUBRULE(this.arrayExpression) }];
  }

  protected registerDialectExtensions(): void {
    this.RULE('postgresqlReturning', () => {
      this.CONSUME(postgresqlLexer.Returning);
      this.AT_LEAST_ONE_SEP({
        SEP: postgresqlLexer.Comma,
        DEF: () => this.SUBRULE(this.expression),
      });
    });

    this.RULE('postgresqlOnConflict', () => {
      this.CONSUME(postgresqlLexer.On);
      this.CONSUME(postgresqlLexer.Conflict);
      this.OPTION(() => {
        this.SUBRULE(this.columnList);
      });
      this.CONSUME(postgresqlLexer.Do);
      this.OR([
        { ALT: () => this.CONSUME(postgresqlLexer.Nothing) },
        {
          ALT: () => {
            this.CONSUME(postgresqlLexer.Update);
            this.CONSUME(postgresqlLexer.Set);
            this.AT_LEAST_ONE_SEP({
              SEP: postgresqlLexer.Comma,
              DEF: () => this.SUBRULE(this.updateSetItem),
            });
            this.OPTION1(() => this.SUBRULE(this.whereClause));
          },
        },
      ]);
    });

    this.RULE('arrayExpression', () => {
      this.CONSUME(postgresqlLexer.ArrayKeyword);
      this.CONSUME(postgresqlLexer.LBracket);
      this.OPTION(() => {
        this.AT_LEAST_ONE_SEP({
          SEP: postgresqlLexer.Comma,
          DEF: () => this.SUBRULE(this.expression),
        });
      });
      this.CONSUME(postgresqlLexer.RBracket);
    });

    this.OVERRIDE_RULE('insertStatement', () => {
      this.CONSUME(postgresqlLexer.Insert);
      this.CONSUME(postgresqlLexer.Into);
      this.SUBRULE(this.tableName);
      this.OPTION(() => {
        this.CONSUME(postgresqlLexer.LParen);
        this.AT_LEAST_ONE_SEP({
          SEP: postgresqlLexer.Comma,
          DEF: () => this.SUBRULE(this.identifier),
        });
        this.CONSUME1(postgresqlLexer.RParen);
      });
      this.OR([
        { ALT: () => this.SUBRULE(this.valuesClause) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertWithClause) },
      ]);
      this.OPTION1(() => this.SUBRULE(this.postgresqlOnConflict));
      this.OPTION2(() => this.SUBRULE(this.postgresqlReturning));
    });

    this.OVERRIDE_RULE('updateStatement', () => {
      this.CONSUME(postgresqlLexer.Update);
      this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(postgresqlLexer.Set);
      this.AT_LEAST_ONE_SEP({
        SEP: postgresqlLexer.Comma,
        DEF: () => this.SUBRULE(this.updateSetItem),
      });
      this.OPTION1(() => this.SUBRULE(this.fromClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.postgresqlReturning));
    });

    this.OVERRIDE_RULE('deleteStatement', () => {
      this.CONSUME(postgresqlLexer.Delete);
      this.CONSUME(postgresqlLexer.From);
      this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => this.SUBRULE(this.whereClause));
      this.OPTION2(() => this.SUBRULE(this.postgresqlReturning));
    });

    this.OVERRIDE_RULE('selectModifier', () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(postgresqlLexer.Distinct);
            this.OPTION(() => {
              this.CONSUME(postgresqlLexer.On);
              this.CONSUME(postgresqlLexer.LParen);
              this.SUBRULE(this.expression);
              this.MANY(() => {
                this.CONSUME(postgresqlLexer.Comma);
                this.SUBRULE1(this.expression);
              });
              this.CONSUME(postgresqlLexer.RParen);
            });
          },
        },
        { ALT: () => this.CONSUME(postgresqlLexer.All) },
      ]);
    });

    this.OVERRIDE_RULE('castExpression', () => {
      this.SUBRULE(this.primaryExpression);
      this.MANY(() => {
        this.OR([
          { ALT: () => this.CONSUME(postgresqlLexer.JsonTextPath) },
          { ALT: () => this.CONSUME(postgresqlLexer.JsonPath) },
          { ALT: () => this.CONSUME(postgresqlLexer.JsonTextArrow) },
          { ALT: () => this.CONSUME(postgresqlLexer.JsonArrow) },
        ]);
        this.SUBRULE1(this.primaryExpression);
      });
      this.MANY1(() => {
        this.CONSUME(postgresqlLexer.DoubleColon);
        this.SUBRULE1(this.typeName);
        this.OPTION(() => {
          this.CONSUME(postgresqlLexer.LBracket);
          this.CONSUME1(postgresqlLexer.RBracket);
        });
      });
    });
  }
}

export class SqlParser extends PostgreSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
  return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
  parserInstance ??= createSqlParserInstance();
  return parserInstance;
}
