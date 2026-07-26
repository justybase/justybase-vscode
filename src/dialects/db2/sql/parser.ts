import type { CstNode, TokenType } from 'chevrotain';
import type { OrAlternative } from '../../../sqlParser/BaseSqlParser';
import * as baseLexer from '../../netezza/sql/lexer';
import * as db2Lexer from './lexer';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

/** Tokens allowed in procedure headers / compound bodies (not Begin/End — those are structural). */
const DB2_PROGRAM_TOKENS: TokenType[] = [
	db2Lexer.Db2LanguageSql,
	db2Lexer.Db2GeneratedAlways,
	db2Lexer.Db2GeneratedByDefault,
	db2Lexer.Db2Identity,
	db2Lexer.Db2CurrentSchema,
	db2Lexer.Db2CurrentServer,
	db2Lexer.Db2CurrentDate,
	db2Lexer.Db2CurrentTime,
	db2Lexer.Db2CurrentTimestamp,
	db2Lexer.Db2CurrentUser,
	db2Lexer.Db2WithUr,
	db2Lexer.Db2WithCs,
	db2Lexer.Db2WithRs,
	db2Lexer.Db2WithRr,
	db2Lexer.Db2OptimizeFor,
	db2Lexer.Db2ForReadOnly,
	db2Lexer.Db2ForUpdate,
	baseLexer.Create,
	baseLexer.Or,
	baseLexer.Replace,
	baseLexer.Procedure,
	baseLexer.Declare,
	baseLexer.If,
	baseLexer.Then,
	baseLexer.Else,
	baseLexer.While,
	baseLexer.Loop,
	baseLexer.Return,
	baseLexer.Returns,
	baseLexer.Set,
	baseLexer.Select,
	baseLexer.From,
	baseLexer.Where,
	baseLexer.Into,
	baseLexer.Insert,
	baseLexer.Update,
	baseLexer.Delete,
	baseLexer.Call,
	baseLexer.As,
	baseLexer.In,
	baseLexer.Out,
	baseLexer.Is,
	baseLexer.Null,
	baseLexer.Not,
	baseLexer.And,
	baseLexer.For,
	baseLexer.Like,
	baseLexer.Language,
	baseLexer.Identifier,
	baseLexer.QuotedIdentifier,
	baseLexer.NumberLiteral,
	baseLexer.StringLiteral,
	baseLexer.Equals,
	baseLexer.NotEquals,
	baseLexer.LessThan,
	baseLexer.GreaterThan,
	baseLexer.LessThanEquals,
	baseLexer.GreaterThanEquals,
	baseLexer.Assign,
	baseLexer.Plus,
	baseLexer.Minus,
	baseLexer.Multiply,
	baseLexer.Divide,
	baseLexer.Dot,
	baseLexer.Comma,
	baseLexer.Semicolon,
	baseLexer.LParen,
	baseLexer.RParen,
];

/**
 * Db2 LUW parser layered on the shared CST grammar.
 *
 * SELECT/DML stay shared for completion and scope analysis. Db2-only clauses
 * (`OPTIMIZE FOR`, isolation, `FOR READ ONLY`) are explicit rules. Netezza-only
 * surfaces (LIMIT, DB..TABLE, GROOM, DISTRIBUTE ON) are disabled. SQL PL units
 * are preserved as an offset-stable token CST until deeper visitor work lands.
 */
export class Db2SqlParser extends NetezzaSqlParser {
	db2IsolationClause!: AnyRule;
	db2OptimizeForClause!: AnyRule;
	db2ForClause!: AnyRule;
	db2DeclareGlobalTempTable!: AnyRule;
	db2CreateAliasStatement!: AnyRule;
	db2CreateNicknameStatement!: AnyRule;
	db2ProgramToken!: AnyRule;
	db2ProcedureUnit!: AnyRule;
	db2TableResultClause!: AnyRule;

	public constructor() {
		super(db2Lexer);
	}

	protected supportsEmptyQualifiedNameSegment(): boolean {
		return false;
	}

	protected registerCreateTableDialectClauses(): void {
		// Db2 has no Netezza DISTRIBUTE ON / ORGANIZE ON clauses.
		// ORGANIZE BY / PARTITION BY / DATA CAPTURE fall through commandTail when present.
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

	protected getAdditionalTableSourceAlternatives(): OrAlternative[] {
		return [
			{
				GATE: () =>
					this.LA(1).tokenType === db2Lexer.Db2FinalTable
					|| this.LA(1).tokenType === db2Lexer.Db2OldTable
					|| this.LA(1).tokenType === db2Lexer.Db2NewTable,
				ALT: () => this.SUBRULE(this.db2TableResultClause),
			},
		];
	}

	protected getAdditionalStatementAlternatives(): OrAlternative[] {
		return [
			{
				GATE: () => this.startsDb2Procedure(),
				ALT: () => this.SUBRULE(this.db2ProcedureUnit),
			},
			{
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2DeclareGlobalTemporary,
				ALT: () => this.SUBRULE(this.db2DeclareGlobalTempTable),
			},
			{
				// IBM Db2: CREATE ALIAS … FOR … (synonyms are deprecated / not LUW DDL).
				// See https://www.ibm.com/docs/en/db2-for-zos/12.0.0?topic=elements-aliases
				GATE: () =>
					this.LA(1).tokenType === baseLexer.Create
					&& this.LA(2).tokenType === baseLexer.Alias,
				ALT: () => this.SUBRULE(this.db2CreateAliasStatement),
			},
			{
				// Federated remote object pointer (LUW); not the same as ALIAS.
				GATE: () =>
					this.LA(1).tokenType === baseLexer.Create
					&& this.LA(2).tokenType === db2Lexer.Db2Nickname,
				ALT: () => this.SUBRULE(this.db2CreateNicknameStatement),
			},
		];
	}

	private startsDb2Procedure(): boolean {
		if (this.LA(1).tokenType !== baseLexer.Create) {
			return false;
		}
		if (this.LA(2).tokenType === baseLexer.Procedure) {
			return true;
		}
		return (
			this.LA(2).tokenType === baseLexer.Or
			&& this.LA(3).tokenType === baseLexer.Replace
			&& this.LA(4).tokenType === baseLexer.Procedure
		);
	}

	protected registerDialectExtensions(): void {
		this.RULE('db2IsolationClause', () => {
			this.OR([
				{ ALT: () => this.CONSUME(db2Lexer.Db2WithUr) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2WithCs) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2WithRs) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2WithRr) },
			]);
		});

		this.RULE('db2OptimizeForClause', () => {
			this.CONSUME(db2Lexer.Db2OptimizeFor);
			this.CONSUME(db2Lexer.NumberLiteral);
			this.OPTION(() => {
				this.OR([
					{ ALT: () => this.CONSUME(db2Lexer.Rows) },
					{ ALT: () => this.CONSUME(db2Lexer.Row) },
				]);
			});
		});

		this.RULE('db2ForClause', () => {
			this.OR([
				{ ALT: () => this.CONSUME(db2Lexer.Db2ForReadOnly) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2ForUpdate) },
			]);
		});

		this.RULE('db2TableResultClause', () => {
			this.OR([
				{ ALT: () => this.CONSUME(db2Lexer.Db2FinalTable) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2OldTable) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2NewTable) },
			]);
			this.CONSUME(db2Lexer.LParen);
			this.OR1([
				{ ALT: () => this.SUBRULE(this.insertStatement) },
				{ ALT: () => this.SUBRULE(this.updateStatement) },
				{ ALT: () => this.SUBRULE(this.deleteStatement) },
				{ ALT: () => this.SUBRULE(this.selectStatement) },
			]);
			this.CONSUME(db2Lexer.RParen);
		});

		this.RULE('db2DeclareGlobalTempTable', () => {
			this.CONSUME(db2Lexer.Db2DeclareGlobalTemporary);
			this.CONSUME(db2Lexer.Table);
			this.SUBRULE(this.qualifiedName);
			this.OPTION(() => this.SUBRULE(this.commandTail));
		});

		this.RULE('db2CreateAliasStatement', () => {
			this.CONSUME(baseLexer.Create);
			this.CONSUME(baseLexer.Alias);
			this.SUBRULE(this.qualifiedName);
			this.CONSUME(baseLexer.For);
			this.SUBRULE1(this.qualifiedName);
		});

		this.RULE('db2CreateNicknameStatement', () => {
			this.CONSUME(baseLexer.Create);
			this.CONSUME(db2Lexer.Db2Nickname);
			this.SUBRULE(this.qualifiedName);
			this.CONSUME(baseLexer.For);
			// server.remote_schema.remote_table (or server.remote_table)
			this.SUBRULE1(this.qualifiedName);
			this.OPTION(() => this.SUBRULE(this.commandTail));
		});

		this.RULE('db2ProgramToken', () => {
			this.OR(this.getTokenAlternatives(DB2_PROGRAM_TOKENS));
		});

		/**
		 * Thin SQL PL unit: CREATE … PROCEDURE header tokens, then BEGIN … END.
		 * Nested BEGIN/END is not modeled yet (phase-4 depth); header stops at BEGIN.
		 */
		this.RULE('db2ProcedureUnit', () => {
			this.MANY({
				GATE: () => this.LA(1).tokenType !== baseLexer.Begin,
				DEF: () => this.SUBRULE(this.db2ProgramToken),
			});
			this.CONSUME(baseLexer.Begin);
			this.MANY1({
				GATE: () => this.LA(1).tokenType !== baseLexer.End,
				DEF: () => this.SUBRULE1(this.db2ProgramToken),
			});
			this.CONSUME(baseLexer.End);
			this.OPTION(() => {
				this.OR([
					{ ALT: () => this.CONSUME(baseLexer.Identifier) },
					{ ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
				]);
			});
		});

		// No LIMIT (Netezza-only). Keep FETCH FIRST + Db2 trailing clauses.
		this.OVERRIDE_RULE('selectStatement', () => {
			this.SUBRULE(this.selectClause);
			this.OPTION(() => this.SUBRULE(this.fromClause));
			this.OPTION1(() => this.SUBRULE(this.whereClause));
			this.OPTION2(() => this.SUBRULE(this.groupByClause));
			this.OPTION3(() => this.SUBRULE(this.havingClause));
			this.OPTION4(() => this.SUBRULE(this.orderByClause));
			this.OPTION5(() => this.SUBRULE(this.fetchFirstClause));
			this.OPTION6(() => this.SUBRULE(this.db2OptimizeForClause));
			this.OPTION7(() => this.SUBRULE(this.db2ForClause));
			this.OPTION8(() => this.SUBRULE(this.db2IsolationClause));
			this.MANY(() => {
				this.SUBRULE(this.setOperation);
				this.OR7([
					{
						ALT: () => {
							this.CONSUME(db2Lexer.LParen);
							this.OR8([
								{ ALT: () => this.SUBRULE1(this.withStatement) },
								{ ALT: () => this.SUBRULE1(this.selectStatement) },
							]);
							this.CONSUME(db2Lexer.RParen);
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
	}
}

export class SqlParser extends Db2SqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
	return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
	parserInstance ??= createSqlParserInstance();
	return parserInstance;
}
