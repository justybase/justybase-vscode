import type { CstNode, TokenType } from 'chevrotain';
import type { OrAlternative } from '../../../sqlParser/BaseSqlParser';
import * as baseLexer from '../../netezza/sql/lexer';
import * as mssqlLexer from './lexer';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

/** Tokens not covered by the shared command-tail token rule. */
const MSSQL_PROGRAM_TOKENS: TokenType[] = [
  mssqlLexer.MsSqlTop,
  mssqlLexer.MsSqlOutput,
  mssqlLexer.MsSqlApply,
  mssqlLexer.MsSqlCrossApply,
  mssqlLexer.MsSqlOuterApply,
  mssqlLexer.MsSqlTry,
  mssqlLexer.MsSqlCatch,
  mssqlLexer.MsSqlRecompile,
  mssqlLexer.MsSqlEncryption,
  mssqlLexer.MsSqlPercent,
  baseLexer.Semicolon,
  baseLexer.Select,
  baseLexer.From,
  baseLexer.Where,
  baseLexer.Declare,
  baseLexer.End,
  baseLexer.If,
  baseLexer.Then,
  baseLexer.Else,
  baseLexer.While,
  baseLexer.Loop,
  baseLexer.Return,
  baseLexer.Execute,
  baseLexer.As,
  baseLexer.Using,
  baseLexer.On,
  baseLexer.When,
  baseLexer.Match,
  baseLexer.Not,
  baseLexer.Into,
  baseLexer.Update,
  baseLexer.Set,
  baseLexer.Insert,
  baseLexer.Values,
  baseLexer.Or,
  baseLexer.Is,
  baseLexer.Null,
  baseLexer.And,
  baseLexer.In,
  baseLexer.Like,
];

/**
 * T-SQL parser layered on the shared CST grammar (Db2-style thin dialect layer).
 *
 * Netezza-only surfaces (LIMIT, DB..TABLE, GROOM, DISTRIBUTE ON) are disabled.
 */
export class MsSqlSqlParser extends NetezzaSqlParser {
	mssqlTopClause!: AnyRule;
	mssqlOutputClause!: AnyRule;
	mssqlOffsetFetchClause!: AnyRule;
	mssqlApplyClause!: AnyRule;
	mssqlProgramToken!: AnyRule;
	mssqlProgramKeyword!: AnyRule;
	mssqlBeginEndUnit!: AnyRule;
	mssqlProcedureBody!: AnyRule;

	public constructor() {
		super(mssqlLexer);
	}

protected getNetezzaRelaxedNameTokens() {
    return [
      ...super.getNetezzaRelaxedNameTokens(),
      mssqlLexer.MsSqlBracketedIdentifier,
      mssqlLexer.MsSqlVariable,
    ];
  }

  protected getNetezzaIdentifierTokens() {
    return super.getNetezzaIdentifierTokens();
  }

	protected supportsEmptyQualifiedNameSegment(): boolean {
		return false;
	}

	protected registerCreateTableDialectClauses(): void {
		// MSSQL has no Netezza DISTRIBUTE ON / ORGANIZE ON clauses.
	}

	protected registerAlterTableDialectRule(): void {
		this.OVERRIDE_RULE('alterTableStatement', () => {
			this.CONSUME(baseLexer.Alter);
			this.CONSUME(baseLexer.Table);
			this.SUBRULE(this.qualifiedName);
			this.OPTION(() => this.SUBRULE(this.alterTableAction));
		});
	}

	protected getAdditionalDropObjectAlternatives(): OrAlternative[] {
		return [];
	}

	protected getAdditionalExplainOptionAlternatives(): OrAlternative[] {
		return [];
	}

  protected getAdditionalStatementAlternatives(): OrAlternative[] {
    return [
      {
        GATE: () =>
          this.LA(1).tokenType === baseLexer.Identifier
          && this.LA(1).image.toUpperCase() === 'GO',
        ALT: () => this.CONSUME(baseLexer.Identifier),
      },
      {
        GATE: () => this.startsMsSqlCreateProcedure(),
        ALT: () => this.SUBRULE(this.createProcedureStatement),
      },
    ];
  }

  private startsMsSqlCreateProcedure(): boolean {
    if (this.LA(1).tokenType !== baseLexer.Create) {
      return false;
    }
    if (
      this.LA(2).tokenType === baseLexer.Procedure
      || this.LA(2).tokenType === mssqlLexer.MsSqlProc
    ) {
      return true;
    }
    return (
      this.LA(2).tokenType === baseLexer.Or
      && this.LA(3).tokenType === baseLexer.Replace
      && (this.LA(4).tokenType === baseLexer.Procedure
        || this.LA(4).tokenType === mssqlLexer.MsSqlProc)
    );
  }

  protected registerDialectExtensions(): void {
    this.RULE('mssqlTopClause', () => {
			this.CONSUME(mssqlLexer.MsSqlTop);
			this.OR([
				{
					ALT: () => {
						this.CONSUME(baseLexer.LParen);
						this.CONSUME(baseLexer.NumberLiteral);
						this.CONSUME(baseLexer.RParen);
					},
				},
				{ ALT: () => this.CONSUME1(baseLexer.NumberLiteral) },
			]);
			this.OPTION(() => this.CONSUME(mssqlLexer.MsSqlPercent));
			this.OPTION1(() => {
				this.CONSUME(baseLexer.With);
				this.CONSUME(baseLexer.Ties);
			});
		});

		this.RULE('mssqlOutputClause', () => {
			this.CONSUME(mssqlLexer.MsSqlOutput);
			this.AT_LEAST_ONE_SEP({
				SEP: baseLexer.Comma,
				DEF: () => this.SUBRULE(this.expression),
			});
			this.OPTION(() => {
				this.CONSUME(baseLexer.Into);
				this.SUBRULE(this.qualifiedName);
			});
		});

		this.RULE('mssqlOffsetFetchClause', () => {
			this.CONSUME(baseLexer.Offset);
			this.CONSUME(baseLexer.NumberLiteral);
			this.OR([
				{ ALT: () => this.CONSUME(baseLexer.Rows) },
				{ ALT: () => this.CONSUME(baseLexer.Row) },
			]);
			this.OPTION(() => {
				this.CONSUME(baseLexer.Fetch);
				this.OPTION1(() => this.CONSUME(baseLexer.Next));
				this.CONSUME1(baseLexer.NumberLiteral);
				this.OR1([
					{ ALT: () => this.CONSUME1(baseLexer.Rows) },
					{ ALT: () => this.CONSUME1(baseLexer.Row) },
				]);
				this.OPTION2(() => this.CONSUME(baseLexer.Only));
			});
		});

		this.RULE('mssqlApplyClause', () => {
			this.OR([
				{ ALT: () => this.CONSUME(mssqlLexer.MsSqlCrossApply) },
				{ ALT: () => this.CONSUME(mssqlLexer.MsSqlOuterApply) },
			]);
			this.SUBRULE(this.tableSource);
		});

    this.RULE('mssqlProgramToken', () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.commandTailToken) },
        { ALT: () => this.SUBRULE(this.mssqlProgramKeyword) },
      ]);
    });

    this.RULE('mssqlProgramKeyword', () => {
      this.OR(this.getTokenAlternatives(MSSQL_PROGRAM_TOKENS));
    });

    /**
     * Thin BEGIN…END block. Starts with BEGIN so the rule FIRST set is {Begin}
     * (a catch-all leading MANY would overlap every DML alternative and blow up
     * Chevrotain's self-analysis). Nested depth is not modeled in v1.
     */
    this.RULE('mssqlBeginEndUnit', () => {
      this.CONSUME(baseLexer.Begin);
      this.MANY1({
        GATE: () => this.LA(1).tokenType !== baseLexer.End,
        DEF: () => this.SUBRULE1(this.mssqlProgramToken),
      });
      this.CONSUME(baseLexer.End);
      this.OPTION1(() => {
        this.OR([
          { ALT: () => this.CONSUME(mssqlLexer.MsSqlTry) },
          { ALT: () => this.CONSUME(mssqlLexer.MsSqlCatch) },
        ]);
      });
    });

    // Standalone T-SQL blocks (BEGIN…END) route through beginStatement so the
    // shared `statement` OR stays cheap to self-analyze (thin acyclic body).
    this.OVERRIDE_RULE('beginStatement', () => {
      this.SUBRULE(this.mssqlBeginEndUnit);
    });

    this.RULE('mssqlProcedureBody', () => {
      this.OR([
        {
          GATE: () => this.LA(1).tokenType === baseLexer.Begin,
          ALT: () => this.SUBRULE(this.mssqlBeginEndUnit),
        },
        {
          ALT: () => {
            this.MANY(() => this.SUBRULE(this.mssqlProgramToken));
          },
        },
      ]);
    });

    this.OVERRIDE_RULE('identifier', () => {
      this.OR([
        { ALT: () => this.CONSUME(baseLexer.Identifier) },
        { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
        { ALT: () => this.CONSUME(mssqlLexer.MsSqlBracketedIdentifier) },
        { ALT: () => this.CONSUME(mssqlLexer.MsSqlVariable) },
      ]);
    });

    this.OVERRIDE_RULE('mergeStatement', () => {
      this.CONSUME(baseLexer.Merge);
      this.OPTION(() => this.CONSUME(baseLexer.Into));
      this.SUBRULE(this.tableName);
      this.AT_LEAST_ONE(() => this.SUBRULE(this.mssqlProgramToken));
    });

    this.OVERRIDE_RULE('procedureArguments', () => {
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => this.SUBRULE(this.procedureArgument),
      });
    });

    this.OVERRIDE_RULE('procedureArgument', () => {
      this.SUBRULE(this.identifier);
      this.OPTION(() => this.SUBRULE(this.typeName));
      this.OPTION1(() => {
        this.CONSUME(baseLexer.Equals);
        this.SUBRULE(this.expression);
      });
      this.OPTION2(() => this.CONSUME(mssqlLexer.MsSqlOutput));
    });

    this.OVERRIDE_RULE('selectClause', () => {
			this.CONSUME(baseLexer.Select);
			this.OPTION(() => this.SUBRULE(this.selectModifier));
			this.OPTION1(() => this.SUBRULE(this.mssqlTopClause));
			this.SUBRULE(this.selectList);
			this.OPTION2(() => this.SUBRULE(this.intoClause));
		});

		// No LIMIT (Netezza-only). Prefer OFFSET/FETCH.
		this.OVERRIDE_RULE('selectStatement', () => {
			this.SUBRULE(this.selectClause);
			this.OPTION(() => this.SUBRULE(this.fromClause));
			this.OPTION1(() => this.SUBRULE(this.whereClause));
			this.OPTION2(() => this.SUBRULE(this.groupByClause));
			this.OPTION3(() => this.SUBRULE(this.havingClause));
			this.OPTION4(() => this.SUBRULE(this.orderByClause));
			this.OPTION5(() => this.SUBRULE(this.mssqlOffsetFetchClause));
			this.OPTION6(() => this.SUBRULE(this.fetchFirstClause));
			this.MANY(() => {
				this.SUBRULE(this.setOperation);
				this.OR7([
					{
						ALT: () => {
							this.CONSUME(baseLexer.LParen);
							this.OR8([
								{ ALT: () => this.SUBRULE1(this.withStatement) },
								{ ALT: () => this.SUBRULE1(this.selectStatement) },
							]);
							this.CONSUME(baseLexer.RParen);
						},
					},
					{
						ALT: () => {
							this.OR9([
								{ ALT: () => this.SUBRULE2(this.withStatement) },
								{ ALT: () => this.SUBRULE2(this.selectStatement) },
							]);
						},
					},
				]);
			});
		});

		this.OVERRIDE_RULE('tableReference', () => {
			this.SUBRULE(this.tableSource);
			this.MANY(() => {
				this.OR([
					{
						GATE: () =>
							this.LA(1).tokenType === mssqlLexer.MsSqlCrossApply
							|| this.LA(1).tokenType === mssqlLexer.MsSqlOuterApply,
						ALT: () => this.SUBRULE(this.mssqlApplyClause),
					},
					{ ALT: () => this.SUBRULE(this.joinClause) },
				]);
			});
		});

		this.OVERRIDE_RULE('insertStatement', () => {
			this.CONSUME(baseLexer.Insert);
			this.CONSUME(baseLexer.Into);
			this.SUBRULE(this.tableName);
			this.OPTION(() => {
				this.CONSUME(baseLexer.LParen);
				this.AT_LEAST_ONE_SEP({
					SEP: baseLexer.Comma,
					DEF: () => this.SUBRULE(this.identifier),
				});
				this.CONSUME(baseLexer.RParen);
			});
			this.OPTION1(() => this.SUBRULE(this.mssqlOutputClause));
			this.OR([
				{ ALT: () => this.SUBRULE(this.valuesClause) },
				{ ALT: () => this.SUBRULE(this.selectStatement) },
				{ ALT: () => this.SUBRULE(this.insertWithClause) },
			]);
		});

		this.OVERRIDE_RULE('updateStatement', () => {
			this.CONSUME(baseLexer.Update);
			this.SUBRULE(this.tableName);
			this.OPTION(() => this.SUBRULE(this.aliasOptional));
			this.CONSUME(baseLexer.Set);
			this.AT_LEAST_ONE_SEP({
				SEP: baseLexer.Comma,
				DEF: () => {
					this.SUBRULE(this.updateSetItem);
				},
			});
			this.OPTION1(() => this.SUBRULE(this.mssqlOutputClause));
			this.OPTION2(() => this.SUBRULE(this.fromClause));
			this.OPTION3(() => this.SUBRULE(this.whereClause));
		});

this.OVERRIDE_RULE('deleteStatement', () => {
      this.CONSUME(baseLexer.Delete);
      this.CONSUME(baseLexer.From);
      this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => this.SUBRULE(this.mssqlOutputClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
    });

    this.OVERRIDE_RULE('createProcedureStatement', () => {
      this.CONSUME(baseLexer.Create);
      this.OPTION(() => {
        this.CONSUME(baseLexer.Or);
        this.CONSUME(baseLexer.Replace);
      });
      this.OR([
        { ALT: () => this.CONSUME(baseLexer.Procedure) },
        { ALT: () => this.CONSUME(mssqlLexer.MsSqlProc) },
      ]);
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => {
        this.CONSUME(baseLexer.LParen);
        this.CONSUME(baseLexer.NumberLiteral);
        this.CONSUME(baseLexer.RParen);
      });
      this.OPTION2(() => this.SUBRULE(this.procedureArguments));
      this.OPTION3(() => {
        this.CONSUME(baseLexer.With);
      this.OR1([
        { ALT: () => this.CONSUME(mssqlLexer.MsSqlRecompile) },
          { ALT: () => this.CONSUME(mssqlLexer.MsSqlEncryption) },
          {
            ALT: () => {
              this.CONSUME(baseLexer.Execute);
              this.CONSUME(baseLexer.As);
              this.SUBRULE(this.identifier);
            },
          },
        ]);
      });
      this.OR2([
        { ALT: () => this.CONSUME1(baseLexer.As) },
        { ALT: () => this.CONSUME(baseLexer.Is) },
      ]);
      // Thin single-statement body (e.g. CREATE PROCEDURE p AS SELECT 1).
      // The body rule keeps the broad token soup out of this procedure header.
      this.SUBRULE(this.mssqlProcedureBody);
    });
  }
}

export class SqlParser extends MsSqlSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
	return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
	parserInstance ??= createSqlParserInstance();
	return parserInstance;
}
