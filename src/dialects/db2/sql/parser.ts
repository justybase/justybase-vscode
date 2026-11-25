import type { CstNode, TokenType } from 'chevrotain';
import type { OrAlternative } from '../../../sqlParser/BaseSqlParser';
import * as baseLexer from '../../netezza/sql/lexer';
import * as db2Lexer from './lexer';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

/**
 * Tokens allowed in SQL PL units that are not reachable through
 * `commandTailToken` (the shared token soup used for the body).
 *
 * The `CURRENT …` special registers are intentionally absent: the Db2
 * identifier rule already accepts them, and listing them here would make the
 * `db2ProgramToken` alternatives overlap (Chevrotain ambiguity).
 */
const DB2_PROGRAM_ONLY_TOKENS: TokenType[] = [
	db2Lexer.Db2LanguageSql,
	db2Lexer.Db2GeneratedAlways,
	db2Lexer.Db2GeneratedByDefault,
	db2Lexer.Db2Identity,
	db2Lexer.Db2WithUr,
	db2Lexer.Db2WithCs,
	db2Lexer.Db2WithRs,
	db2Lexer.Db2WithRr,
	db2Lexer.Db2OptimizeFor,
	db2Lexer.Db2ForReadOnly,
	db2Lexer.Db2ForUpdate,
	db2Lexer.Db2FinalTable,
	db2Lexer.Db2OldTable,
	db2Lexer.Db2NewTable,
	db2Lexer.Db2ModifiedBy,
	db2Lexer.Db2DeclareGlobalTemporary,
	db2Lexer.Db2OrganizeBy,
	db2Lexer.Db2DataCapture,
	db2Lexer.Db2Nickname,
	// SQL PL keywords that lex as dedicated tokens but are not part of the
	// Netezza identifier surface (`DEFAULT`, `BETWEEN`, `COMMIT`, `FETCH`, ...
	// are already covered through `commandTailToken`).
	baseLexer.Sqlstate,
	baseLexer.Out,
	baseLexer.Inout,
	baseLexer.Cast,
	baseLexer.Semicolon,
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
	db2ValuesQuery!: AnyRule;
	db2IsolationClause!: AnyRule;
	db2OptimizeForClause!: AnyRule;
	db2ForClause!: AnyRule;
	db2DeclareGlobalTempTable!: AnyRule;
	db2CreateAliasStatement!: AnyRule;
	db2CreateSynonymStatement!: AnyRule;
	db2ExecuteImmediateStatement!: AnyRule;
	db2CursorStatement!: AnyRule;
	db2CreateNicknameStatement!: AnyRule;
	db2ProgramToken!: AnyRule;
	db2ProcedureUnit!: AnyRule;
	db2TableResultClause!: AnyRule;
	db2TableOption!: AnyRule;
	db2PartitionClause!: AnyRule;
	db2PartitionKeyList!: AnyRule;
	db2PartitionNullOrder!: AnyRule;
	db2PartitionDefinition!: AnyRule;
	db2PartitionBoundary!: AnyRule;
	db2PartitionInclusivity!: AnyRule;
	db2ConstraintAttributes!: AnyRule;
	db2CreateIndexStatement!: AnyRule;
	db2IndexKeyList!: AnyRule;
	db2IndexKeyColumn!: AnyRule;
	db2IndexTailToken!: AnyRule;
	db2RenameTableStatement!: AnyRule;
	db2IdentityClause!: AnyRule;
	db2IdentityOptionToken!: AnyRule;
	db2CommentConstraint!: AnyRule;
	db2RefreshTableStatement!: AnyRule;
	db2AlterTableOptionAction!: AnyRule;
	db2CompressClause!: AnyRule;
	db2DataCaptureClause!: AnyRule;
	db2OnCommitClause!: AnyRule;
	db2NotLoggedInitiallyClause!: AnyRule;
	db2DataInitiallyDeferredClause!: AnyRule;
	db2DistributeClause!: AnyRule;
	db2AlterTablePartitionAction!: AnyRule;
	db2PartitionRangeDefinition!: AnyRule;
	db2PartitionStartClause!: AnyRule;
	db2PartitionEndClause!: AnyRule;
	db2PartitionBoundaryValue!: AnyRule;
	db2PartitionKeywordOrIdentifier!: AnyRule;
	db2AdminCommandStatement!: AnyRule;
	db2EndBlockKeyword!: AnyRule;
	db2ProgramKeyword!: AnyRule;
	db2CompoundBody!: AnyRule;
	db2CreateTriggerStatement!: AnyRule;
	db2LabelStatement!: AnyRule;
	db2ExportStatement!: AnyRule;
	db2ImportStatement!: AnyRule;

	public constructor() {
		super(db2Lexer);
	}

	protected supportsEmptyQualifiedNameSegment(): boolean {
		return false;
	}

	protected getAdditionalPrimaryExpressionAlternatives(): OrAlternative[] {
		// Db2 special registers lex as one multi-word token each, so every one
		// must be an expression alternative or `SELECT CURRENT SCHEMA` fails.
		return [
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentDate) },
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentTime) },
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentTimestamp) },
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentSchema) },
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentServer) },
			{ ALT: () => this.CONSUME(db2Lexer.Db2CurrentUser) },
		];
	}

	protected getNetezzaIdentifierTokens() {
		// `SET CURRENT SCHEMA x`, `SET CURRENT SQLID`, and `SET CURRENT DEGREE`
		// all route through `commandTail` → `identifier`, and the Db2 lexer emits
		// those registers as one multi-word token each.
		return [
			...super.getNetezzaIdentifierTokens(),
			db2Lexer.Db2CurrentSchema,
			db2Lexer.Db2CurrentServer,
			db2Lexer.Db2CurrentDate,
			db2Lexer.Db2CurrentTime,
			db2Lexer.Db2CurrentTimestamp,
			db2Lexer.Db2CurrentUser,
			// Command-leading Db2 words stay usable as unquoted object/column
			// names. They are not reserved words, so excluding them would reject
			// valid schemas that happen to be named `INDEX`, `REORG`, ...
			db2Lexer.Db2Index,
			db2Lexer.Db2Trigger,
			db2Lexer.Db2Reorg,
			db2Lexer.Db2Runstats,
			db2Lexer.Db2Export,
			db2Lexer.Db2Import,
		];
	}

	protected getForeignKeyActions(event: 'DELETE' | 'UPDATE'): readonly string[] {
		return event === 'DELETE' ? ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL'] : [];
	}

	protected getAdditionalColumnDefinitionAlternatives(): OrAlternative[] {
		// Db2 identity columns: `GENERATED ALWAYS AS IDENTITY [(options)]`.
		return [
			{
				GATE: () =>
					this.LA(1).tokenType === db2Lexer.Db2GeneratedAlways
					|| this.LA(1).tokenType === db2Lexer.Db2GeneratedByDefault,
				ALT: () => this.SUBRULE(this.db2IdentityClause),
			},
		];
	}

	protected getAdditionalCommentAlternatives(): OrAlternative[] {
		// `COMMENT ON CONSTRAINT table.constraint IS '…'` — Db2's form, emitted
		// by the DDL generator for constraint comments.
		return [
			{
				GATE: () => this.isDb2KeywordAt(1, 'CONSTRAINT'),
				ALT: () => this.SUBRULE(this.db2CommentConstraint),
			},
		];
	}

	protected registerCreateTableDialectClauses(): void {
		this.MANY({
			GATE: () => this.startsDb2TableOption(),
			DEF: () => this.SUBRULE(this.db2TableOption),
		});
	}

	/**
	 * Db2 table options all start with a fixed word (or a multi-word Db2 token).
	 * Gating the `MANY` keeps a trailing unknown identifier from being parsed as
	 * an option and keeps grammar analysis cheap.
	 */
	private startsDb2TableOption(): boolean {
		const type = this.LA(1).tokenType;
		if (
			type === db2Lexer.Db2OrganizeBy
			|| type === db2Lexer.Db2DataCapture
			|| type === baseLexer.In
			|| type === baseLexer.Distribute
			|| type === baseLexer.PartitionBy
		) {
			return true;
		}
		return /^(COMPRESS|ON|NOT|DATA)$/i.test(this.LA(1).image);
	}

	protected registerAlterTableDialectRule(): void {
		this.OVERRIDE_RULE('alterTableStatement', () => {
			this.CONSUME(baseLexer.Alter);
			this.CONSUME(baseLexer.Table);
			this.SUBRULE(this.qualifiedName);
			this.OPTION(() => {
				this.OR([
					{
						// ADD / ATTACH / DETACH PARTITION, emitted by the Db2 partition designer.
						GATE: () => this.startsDb2PartitionAction(),
						ALT: () => this.SUBRULE(this.db2AlterTablePartitionAction),
					},
					{
						// ACTIVATE NOT LOGGED INITIALLY / COMPRESS / DATA CAPTURE / APPEND.
						GATE: () => this.startsDb2AlterTableOption(),
						ALT: () => this.SUBRULE(this.db2AlterTableOptionAction),
					},
					{ ALT: () => this.SUBRULE(this.alterTableAction) },
				]);
			});
		});

		// Db2 ALTER COLUMN also accepts SET DATA TYPE / SET NOT NULL /
		// DROP NOT NULL, which the shared ANSI action does not model.
		this.OVERRIDE_RULE('alterTableAlterColumnAction', () => {
			this.CONSUME(baseLexer.Alter);
			this.OPTION(() => this.CONSUME(baseLexer.Column));
			this.SUBRULE(this.columnName);
			this.OR([
				{
					GATE: () => this.isDb2KeywordAt(1, 'SET') && this.isDb2KeywordAt(2, 'DATA'),
					ALT: () => {
						this.CONSUME(baseLexer.Set);
						// SET DATA TYPE
						this.CONSUME(baseLexer.Identifier);
						this.CONSUME(baseLexer.Type);
						this.SUBRULE(this.typeName);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'SET') && this.isDb2KeywordAt(2, 'NOT'),
					ALT: () => {
						this.CONSUME1(baseLexer.Set);
						this.CONSUME(baseLexer.Not);
						this.CONSUME(baseLexer.Null);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'DROP') && this.isDb2KeywordAt(2, 'NOT'),
					ALT: () => {
						this.CONSUME(baseLexer.Drop);
						this.CONSUME1(baseLexer.Not);
						this.CONSUME1(baseLexer.Null);
					},
				},
				{
					ALT: () => {
						this.CONSUME2(baseLexer.Set);
						this.CONSUME(baseLexer.Default);
						this.SUBRULE(this.additiveExpression);
					},
				},
				{
					ALT: () => {
						this.CONSUME1(baseLexer.Drop);
						this.CONSUME1(baseLexer.Default);
					},
				},
			]);
		});
	}

	private startsDb2AlterTableOption(): boolean {
		if (this.isDb2KeywordAt(1, 'ACTIVATE') || this.isDb2KeywordAt(1, 'COMPRESS')) {
			return true;
		}
		if (this.isDb2KeywordAt(1, 'APPEND')) {
			return true;
		}
		if (this.isDb2KeywordAt(1, 'NOT') && this.isDb2KeywordAt(2, 'LOGGED')) {
			return true;
		}
		return this.LA(1).tokenType === db2Lexer.Db2DataCapture;
	}

	private startsDb2PartitionAction(): boolean {
		const la1 = this.LA(1).image.toUpperCase();
		if (la1 === 'ATTACH' || la1 === 'DETACH') {
			return true;
		}
		return la1 === 'ADD' && this.isDb2KeywordAt(2, 'PARTITION');
	}

	protected getAdditionalDropObjectAlternatives(): OrAlternative[] {
		// `DROP INDEX schema.name` — emitted by the Db2 designer and used by DBAs.
		return [
			{
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2Index,
				ALT: () => this.CONSUME1(db2Lexer.Db2Index),
			},
		];
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
			// ALTER SEQUENCE / DATABASE / USER / VIEW / SCHEMA / PROCEDURE reuse
			// the shared offset-stable object rule. ALTER TABLE is claimed earlier
			// by `alterTableStatement`, so Db2 table actions still win.
			{ ALT: () => this.SUBRULE(this.alterObjectStatement) },
			{ GATE: () => this.LA(1).tokenType === baseLexer.Values, ALT: () => this.SUBRULE(this.db2ValuesQuery) },
			{
				GATE: () => this.startsDb2Procedure(),
				ALT: () => this.SUBRULE(this.db2ProcedureUnit),
			},
			{
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2DeclareGlobalTemporary,
				ALT: () => this.SUBRULE(this.db2DeclareGlobalTempTable),
			},
			{
				// IBM documents SYNONYM as an accepted spelling of ALIAS.
				GATE: () =>
					this.LA(1).tokenType === baseLexer.Create
					&& this.LA(2).tokenType === baseLexer.Synonym,
				ALT: () => this.SUBRULE(this.db2CreateSynonymStatement),
			},
			{
				// IBM Db2: CREATE ALIAS … FOR …
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
			{
				// CREATE [UNIQUE] INDEX … — the Db2 index designer emits this.
				GATE: () => this.startsDb2CreateIndex(),
				ALT: () => this.SUBRULE(this.db2CreateIndexStatement),
			},
			{
				// Db2 rejects ALTER TABLE … RENAME TO; the rename command emits this form.
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2RenameTable,
				ALT: () => this.SUBRULE(this.db2RenameTableStatement),
			},
			{
				// REORG / RUNSTATS are Db2 administration commands with long option
				// lists; the maintenance provider wraps them in ADMIN_CMD, but users
				// also run them directly.
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2Reorg || this.LA(1).tokenType === db2Lexer.Db2Runstats,
				ALT: () => this.SUBRULE(this.db2AdminCommandStatement),
			},
			{
				// Db2 triggers carry a `BEGIN ATOMIC` compound body.
				GATE: () => this.startsDb2Trigger(),
				ALT: () => this.SUBRULE(this.db2CreateTriggerStatement),
			},
			{
				// Db2 labels are the native alternative to COMMENT ON.
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2LabelOn,
				ALT: () => this.SUBRULE(this.db2LabelStatement),
			},
			{
				// EXPORT / IMPORT are the Db2 data-movement utilities.
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2Export,
				ALT: () => this.SUBRULE(this.db2ExportStatement),
			},
			{
				GATE: () => this.LA(1).tokenType === db2Lexer.Db2Import,
				ALT: () => this.SUBRULE(this.db2ImportStatement),
			},
			{
				// MQT refresh command emitted by the schema menu.
				GATE: () => this.isDb2KeywordAt(1, 'REFRESH') && this.isDb2KeywordAt(2, 'TABLE'),
				ALT: () => this.SUBRULE(this.db2RefreshTableStatement),
			},
			{
				// `EXECUTE IMMEDIATE '…'` — Db2 dynamic SQL, not a procedure call.
				GATE: () =>
					this.LA(1).tokenType === baseLexer.Execute
					&& this.LA(2).tokenType === baseLexer.Immediate,
				ALT: () => this.SUBRULE(this.db2ExecuteImmediateStatement),
			},
			{
				// SQL PL cursor control and PREPARE run as ordinary statements.
				GATE: () => this.startsDb2CursorStatement(),
				ALT: () => this.SUBRULE(this.db2CursorStatement),
			},
		];
	}

	/** `DECLARE c CURSOR …` / `OPEN c` / `FETCH … FROM c` / `CLOSE c` / `PREPARE`. */
	private startsDb2CursorStatement(): boolean {
		return /^(DECLARE|OPEN|FETCH|CLOSE|PREPARE|DESCRIBE)$/i.test(this.LA(1).image);
	}

	private startsDb2CreateIndex(): boolean {
		if (this.LA(1).tokenType !== baseLexer.Create) {
			return false;
		}
		if (this.LA(2).tokenType === db2Lexer.Db2Index) {
			return true;
		}
		return (
			this.LA(2).tokenType === baseLexer.Unique
			&& this.LA(3).tokenType === db2Lexer.Db2Index
		);
	}

	private startsDb2Trigger(): boolean {
		return this.LA(1).tokenType === baseLexer.Create && this.LA(2).tokenType === db2Lexer.Db2Trigger;
	}

	private isDb2KeywordAt(lookahead: number, keyword: string): boolean {
		return this.LA(lookahead).image.toUpperCase() === keyword;
	}

	/**
	 * A compound body continues until the `END` that closes it. An `END`
	 * followed by a block keyword (`END IF`, `END WHILE`, `END LOOP`,
	 * `END REPEAT`, `END FOR`, `END CASE`) terminates an inner construct and
	 * keeps the outer body open. A plain `END` closes a nested `BEGIN` or a
	 * case expression while the block stack is non-empty, and otherwise closes
	 * the body itself.
	 */
	private shouldContinueDb2Body(blockStack: readonly ('begin' | 'case')[]): boolean {
		if (blockStack.length > 0) {
			return true;
		}
		if (this.LA(1).tokenType !== baseLexer.End) {
			return true;
		}
		return this.isDb2BlockTerminator(this.LA(2).tokenType);
	}

	private isDb2BlockTerminator(nextType: TokenType): boolean {
		return (
			nextType === baseLexer.If
			|| nextType === baseLexer.While
			|| nextType === baseLexer.Loop
			|| nextType === baseLexer.Case
			|| nextType === baseLexer.For
			|| (nextType === baseLexer.Identifier && this.isDb2KeywordAt(2, 'REPEAT'))
		);
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
		this.RULE('db2ValuesQuery', () => {
			this.CONSUME(baseLexer.Values);
			this.AT_LEAST_ONE_SEP({ SEP: baseLexer.Comma, DEF: () => this.SUBRULE(this.expression) });
		});
		this.OVERRIDE_RULE('cteDefinition', () => {
			this.CONSUME(baseLexer.Identifier);
			this.OPTION(() => this.SUBRULE(this.cteColumnList));
			this.CONSUME(baseLexer.As);
			this.CONSUME(baseLexer.LParen);
			this.OR([
				{ ALT: () => this.SUBRULE(this.withStatement) },
				{ ALT: () => this.SUBRULE(this.selectStatement) },
				{ ALT: () => this.SUBRULE(this.db2ValuesQuery) },
			]);
			this.CONSUME(baseLexer.RParen);
		});
		this.RULE('db2TableOption', () => {
			this.OR([
				{ ALT: () => {
					this.CONSUME(db2Lexer.Db2OrganizeBy);
					this.OR1([
						{ ALT: () => this.CONSUME(baseLexer.Row) },
						{ ALT: () => this.CONSUME(baseLexer.Column) },
						{ GATE: () => this.LA(1).image.toUpperCase() === 'DIMENSIONS', ALT: () => {
							this.CONSUME(baseLexer.Identifier);
							this.SUBRULE(this.columnList);
						} },
					]);
				} },
				{ ALT: () => { this.CONSUME(baseLexer.In); this.SUBRULE(this.identifier); } },
				{ GATE: () => this.isDb2KeywordAt(1, 'COMPRESS'), ALT: () => this.SUBRULE(this.db2CompressClause) },
				{ ALT: () => this.SUBRULE(this.db2DataCaptureClause) },
				{ ALT: () => this.SUBRULE(this.db2OnCommitClause) },
				{ ALT: () => this.SUBRULE(this.db2NotLoggedInitiallyClause) },
				{ ALT: () => this.SUBRULE(this.db2DataInitiallyDeferredClause) },
				{ ALT: () => this.SUBRULE(this.db2DistributeClause) },
				{ ALT: () => this.SUBRULE(this.db2PartitionClause) },
			]);
		});

		/** `COMPRESS YES [ADAPTIVE|STATIC]` / `COMPRESS NO`. */
		this.RULE('db2CompressClause', () => {
			// COMPRESS is a plain word in Db2 and has no dedicated token.
			this.CONSUME(baseLexer.Identifier);
			this.OR([
				{
					GATE: () => /^(YES|NO)$/i.test(this.LA(1).image),
					ALT: () => this.CONSUME1(baseLexer.Identifier),
				},
			]);
			this.OPTION({ GATE: () => /^(ADAPTIVE|STATIC)$/i.test(this.LA(1).image), DEF: () => this.CONSUME2(baseLexer.Identifier) });
		});

		/** `DATA CAPTURE CHANGES` / `DATA CAPTURE NONE`. */
		this.RULE('db2DataCaptureClause', () => {
			this.CONSUME(db2Lexer.Db2DataCapture);
			this.OR([
				{ ALT: () => this.CONSUME(baseLexer.None) },
				{ GATE: () => this.isDb2KeywordAt(1, 'CHANGES'), ALT: () => this.CONSUME(baseLexer.Identifier) },
			]);
		});

		/** `ON COMMIT DELETE ROWS` / `ON COMMIT PRESERVE ROWS` (declared global temp tables). */
		this.RULE('db2OnCommitClause', () => {
			this.CONSUME(baseLexer.On);
			this.CONSUME(baseLexer.Commit);
			this.OR([
				{ ALT: () => this.CONSUME(baseLexer.Delete) },
				{ ALT: () => this.CONSUME(baseLexer.Drop) },
				{ GATE: () => this.isDb2KeywordAt(1, 'PRESERVE'), ALT: () => this.CONSUME(baseLexer.Identifier) },
			]);
			this.CONSUME(baseLexer.Rows);
		});

		/** `NOT LOGGED [INITIALLY]` — created global temporary tables omit INITIALLY. */
		this.RULE('db2NotLoggedInitiallyClause', () => {
			this.CONSUME(baseLexer.Not);
			this.CONSUME(baseLexer.Identifier);
			this.OPTION({ GATE: () => this.LA(1).tokenType === baseLexer.Initially, DEF: () => this.CONSUME(baseLexer.Initially) });
		});

		/** `DATA INITIALLY DEFERRED REFRESH DEFERRED` (materialized query tables). */
		this.RULE('db2DataInitiallyDeferredClause', () => {
			this.CONSUME(baseLexer.Identifier);
			this.CONSUME(baseLexer.Initially);
			this.CONSUME(baseLexer.Deferred);
			this.OR([
				{ GATE: () => this.isDb2KeywordAt(1, 'REFRESH'), ALT: () => this.CONSUME1(baseLexer.Identifier) },
				{ GATE: () => this.isDb2KeywordAt(1, 'ENABLE'), ALT: () => this.CONSUME2(baseLexer.Identifier) },
			]);
			this.CONSUME1(baseLexer.Deferred);
		});

		/** `DISTRIBUTE BY HASH (cols)` / `DISTRIBUTE BY RANDOM`. */
		this.RULE('db2DistributeClause', () => {
			this.CONSUME(baseLexer.Distribute);
			this.OR([
				{ GATE: () => this.isDb2KeywordAt(1, 'BY'), ALT: () => this.CONSUME(baseLexer.Identifier) },
			]);
			this.OR1([
				{ GATE: () => this.LA(1).tokenType === baseLexer.Hash, ALT: () => { this.CONSUME(baseLexer.Hash); this.SUBRULE(this.columnList); } },
				{ ALT: () => this.CONSUME(baseLexer.Random) },
			]);
		});

		this.RULE('db2PartitionClause', () => {
			this.CONSUME(baseLexer.PartitionBy);
			this.CONSUME(baseLexer.Range);
			this.SUBRULE(this.db2PartitionKeyList);
			this.CONSUME(baseLexer.LParen);
			this.AT_LEAST_ONE_SEP({
				SEP: baseLexer.Comma,
				DEF: () => this.SUBRULE(this.db2PartitionDefinition),
			});
			this.CONSUME(baseLexer.RParen);
		});

		this.RULE('db2PartitionKeyList', () => {
			this.CONSUME(baseLexer.LParen);
			this.AT_LEAST_ONE_SEP({
				SEP: baseLexer.Comma,
				DEF: () => {
					this.SUBRULE(this.expression);
					this.OPTION({ GATE: () => this.LA(1).tokenType === baseLexer.Nulls, DEF: () => this.SUBRULE(this.db2PartitionNullOrder) });
				},
			});
			this.CONSUME(baseLexer.RParen);
		});

		this.RULE('db2PartitionNullOrder', () => {
			this.CONSUME(baseLexer.Nulls);
			this.OR([
				{ GATE: () => this.LA(1).tokenType === baseLexer.First, ALT: () => this.CONSUME(baseLexer.First) },
				{ GATE: () => this.LA(1).image.toUpperCase() === 'LAST', ALT: () => this.CONSUME1(baseLexer.Identifier) },
			]);
		});

		this.RULE('db2PartitionDefinition', () => {
			this.OR([{ GATE: () => this.LA(1).image.toUpperCase() === 'PARTITION', ALT: () => this.CONSUME(baseLexer.Identifier) }]);
			this.SUBRULE(this.identifier);
			this.OR1([{ GATE: () => this.LA(1).image.toUpperCase() === 'STARTING', ALT: () => this.CONSUME1(baseLexer.Identifier) }]);
			this.OPTION(() => this.CONSUME(baseLexer.From));
			this.SUBRULE(this.db2PartitionBoundary);
			this.OPTION1({
				GATE: () => /^(INCLUSIVE|EXCLUSIVE)$/i.test(this.LA(1).image),
				DEF: () => this.SUBRULE(this.db2PartitionInclusivity),
			});
			this.OR2([{ GATE: () => this.LA(1).image.toUpperCase() === 'ENDING', ALT: () => this.CONSUME2(baseLexer.Identifier) }]);
			this.OPTION2({
				GATE: () => this.LA(1).image.toUpperCase() === 'AT',
				DEF: () => this.CONSUME3(baseLexer.Identifier),
			});
			this.SUBRULE1(this.db2PartitionBoundary);
			this.OPTION3({
				GATE: () => /^(INCLUSIVE|EXCLUSIVE)$/i.test(this.LA(1).image),
				DEF: () => this.SUBRULE1(this.db2PartitionInclusivity),
			});
			this.OPTION4(() => { this.CONSUME(baseLexer.In); this.SUBRULE1(this.identifier); });
		});

		this.RULE('db2PartitionInclusivity', () => {
			this.OR([
				{ GATE: () => this.LA(1).image.toUpperCase() === 'INCLUSIVE', ALT: () => this.CONSUME(baseLexer.Identifier) },
				{ GATE: () => this.LA(1).image.toUpperCase() === 'EXCLUSIVE', ALT: () => this.CONSUME1(baseLexer.Identifier) },
			]);
		});

		this.RULE('db2PartitionBoundary', () => {
			this.OR([
				{ GATE: () => /^(MINVALUE|MAXVALUE)$/i.test(this.LA(1).image), ALT: () => this.CONSUME(baseLexer.Identifier) },
				{ ALT: () => {
					this.CONSUME(baseLexer.LParen);
					this.AT_LEAST_ONE_SEP({ SEP: baseLexer.Comma, DEF: () => this.SUBRULE1(this.expression) });
					this.CONSUME(baseLexer.RParen);
				} },
				{ GATE: () => this.LA(1).tokenType !== baseLexer.LParen && !/^(MINVALUE|MAXVALUE)$/i.test(this.LA(1).image), ALT: () => this.SUBRULE(this.expression) },
			]);
		});

		this.RULE('db2ConstraintAttributes', () => {
			this.OPTION(() => this.CONSUME(baseLexer.Not));
			this.OR([{ GATE: () => this.LA(1).image.toUpperCase() === 'ENFORCED', ALT: () => this.CONSUME(baseLexer.Identifier) }]);
			this.OPTION1(() => {
				this.OR1([
					{ GATE: () => this.LA(1).image.toUpperCase() === 'TRUSTED', ALT: () => this.CONSUME1(baseLexer.Identifier) },
					{ GATE: () => this.LA(1).image.toUpperCase() === 'NOT', ALT: () => {
						this.CONSUME1(baseLexer.Not);
						this.CONSUME2(baseLexer.Identifier);
					} },
				]);
			});
		});
		this.OVERRIDE_RULE('tableConstraintDefinition', () => {
			this.OPTION(() => { this.CONSUME(baseLexer.Constraint); this.SUBRULE(this.identifier); });
			this.SUBRULE(this.constraintDefinition);
			this.OPTION1(() => this.SUBRULE(this.db2ConstraintAttributes));
		});

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

		/**
		 * `CREATE SYNONYM name FOR target` — IBM documents SYNONYM as an accepted
		 * spelling of ALIAS (see the CREATE SYNONYM reference page for Db2 LUW).
		 */
		this.RULE('db2CreateSynonymStatement', () => {
			this.CONSUME(baseLexer.Create);
			this.CONSUME(baseLexer.Synonym);
			this.SUBRULE(this.qualifiedName);
			this.CONSUME(baseLexer.For);
			this.SUBRULE1(this.qualifiedName);
		});

		/** `EXECUTE IMMEDIATE <string expression>` — Db2 dynamic SQL. */
		this.RULE('db2ExecuteImmediateStatement', () => {
			this.CONSUME(baseLexer.Execute);
			this.CONSUME(baseLexer.Immediate);
			this.SUBRULE(this.commandTail);
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

		/**
		 * `CREATE [UNIQUE] INDEX name ON table (keys) INCLUDE (...) ...`
		 *
		 * The trailing physical clauses (INCLUDE / ALLOW REVERSE SCANS / COMPRESS /
		 * PCTFREE / IN tablespace / CLUSTER) are emitted by the Db2 index designer,
		 * so they must round-trip through the strict parser.
		 */
		this.RULE('db2CreateIndexStatement', () => {
			this.CONSUME(baseLexer.Create);
			this.OPTION(() => this.CONSUME(baseLexer.Unique));
			this.CONSUME(db2Lexer.Db2Index);
			this.SUBRULE(this.qualifiedName);
			this.CONSUME(baseLexer.On);
			this.SUBRULE1(this.qualifiedName);
			this.SUBRULE(this.db2IndexKeyList);
			// INCLUDE / ALLOW REVERSE SCANS / COMPRESS / PCTFREE / LEVEL2 PCTFREE /
			// MINPCTUSED / PAGE SPLIT / COLLECT ... STATISTICS / IN tablespace /
			// CLUSTER. The list is long and version-specific, so it stays an
			// offset-stable token tail instead of a rule per clause.
			this.MANY(() => this.SUBRULE(this.db2IndexTailToken));
		});

		this.RULE('db2IndexTailToken', () => {
			this.OR([
				{ GATE: () => this.LA(1).tokenType === baseLexer.Reverse, ALT: () => this.CONSUME(baseLexer.Reverse) },
				{ ALT: () => this.SUBRULE(this.commandTailToken) },
			]);
		});

		this.RULE('db2IndexKeyList', () => {
			this.CONSUME(baseLexer.LParen);
			this.AT_LEAST_ONE_SEP({ SEP: baseLexer.Comma, DEF: () => this.SUBRULE(this.db2IndexKeyColumn) });
			this.CONSUME(baseLexer.RParen);
		});

		this.RULE('db2IndexKeyColumn', () => {
			this.SUBRULE(this.identifier);
			this.OPTION(() => this.OR([
				{ ALT: () => this.CONSUME(baseLexer.Asc) },
				{ ALT: () => this.CONSUME(baseLexer.Desc) },
			]));
		});

		this.RULE('db2RenameTableStatement', () => {
			this.CONSUME(db2Lexer.Db2RenameTable);
			this.SUBRULE(this.qualifiedName);
			this.CONSUME(baseLexer.To);
			// Db2 rejects a qualified target (SQLCODE -108).
			this.SUBRULE1(this.identifier);
		});

		this.RULE('db2IdentityClause', () => {
			this.OR([
				{ GATE: () => this.LA(1).tokenType === db2Lexer.Db2GeneratedAlways, ALT: () => this.CONSUME(db2Lexer.Db2GeneratedAlways) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2GeneratedByDefault) },
			]);
			this.CONSUME(baseLexer.As);
			this.CONSUME(db2Lexer.Db2Identity);
			this.OPTION(() => {
				this.CONSUME(baseLexer.LParen);
				this.MANY(() => this.SUBRULE(this.db2IdentityOptionToken));
				this.CONSUME(baseLexer.RParen);
			});
		});

		/**
		 * `START WITH n INCREMENT BY n MINVALUE n MAXVALUE n CYCLE|NO CYCLE CACHE n`
		 * and the other identity/sequence options. Kept token-by-token (not
		 * `commandTailToken`) so the closing parenthesis stays structural.
		 */
		this.RULE('db2IdentityOptionToken', () => {
			this.OR([
				{ ALT: () => this.SUBRULE(this.identifier) },
				{ ALT: () => this.CONSUME(baseLexer.NumberLiteral) },
				{ ALT: () => this.SUBRULE(this.db2ProgramKeyword) },
			]);
		});

		this.RULE('db2CommentConstraint', () => {
			this.CONSUME(baseLexer.Constraint);
			// `table-name.constraint-name` (optionally schema/database qualified):
			// the last segment is the constraint, so reuse the shared multi-part
			// comment target rule.
			this.SUBRULE(this.commentColumnTarget);
			this.CONSUME(baseLexer.Is);
			this.CONSUME(baseLexer.StringLiteral);
		});

		this.RULE('db2RefreshTableStatement', () => {
			this.CONSUME(baseLexer.Identifier);
			this.CONSUME(baseLexer.Table);
			this.SUBRULE(this.qualifiedName);
		});

		/**
		 * Cursor control and dynamic-SQL preparation as standalone statements:
		 * `DECLARE c CURSOR WITH RETURN FOR …`, `OPEN c`, `FETCH … FROM c INTO …`,
		 * `CLOSE c`, `PREPARE s FROM …`, `DESCRIBE …`. The option tail is
		 * offset-stable because every form differs by version and context.
		 */
		this.RULE('db2CursorStatement', () => {
			this.OR([
				{ GATE: () => this.LA(1).tokenType === baseLexer.Declare, ALT: () => this.CONSUME(baseLexer.Declare) },
				{
					GATE: () => /^(OPEN|CLOSE|PREPARE|DESCRIBE)$/i.test(this.LA(1).image),
					ALT: () => this.CONSUME(baseLexer.Identifier),
				},
				{ ALT: () => this.CONSUME(baseLexer.Fetch) },
			]);
			this.SUBRULE(this.commandTail);
		});

		/**
		 * `ALTER TABLE t ACTIVATE NOT LOGGED INITIALLY` / `NOT LOGGED INITIALLY`
		 * / `COMPRESS YES|NO [ADAPTIVE|STATIC]` / `DATA CAPTURE CHANGES|NONE` /
		 * `APPEND ON|OFF`. Db2 keeps these outside the ADD/DROP/ALTER action set.
		 */
		this.RULE('db2AlterTableOptionAction', () => {
			this.OR([
				{
					GATE: () => this.isDb2KeywordAt(1, 'ACTIVATE'),
					ALT: () => {
						// ACTIVATE NOT LOGGED INITIALLY
						this.CONSUME(baseLexer.Identifier);
						this.CONSUME(baseLexer.Not);
						this.CONSUME1(baseLexer.Identifier);
						this.CONSUME(baseLexer.Initially);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'NOT'),
					ALT: () => {
						// NOT LOGGED INITIALLY
						this.CONSUME1(baseLexer.Not);
						this.CONSUME2(baseLexer.Identifier);
						this.CONSUME1(baseLexer.Initially);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'COMPRESS'),
					ALT: () => this.SUBRULE(this.db2CompressClause),
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'APPEND'),
					ALT: () => {
						this.CONSUME3(baseLexer.Identifier);
						this.OR1([
							{ ALT: () => this.CONSUME(baseLexer.On) },
							{ GATE: () => this.isDb2KeywordAt(1, 'OFF'), ALT: () => this.CONSUME4(baseLexer.Identifier) },
						]);
					},
				},
				{ ALT: () => this.SUBRULE(this.db2DataCaptureClause) },
			]);
		});

		/**
		 * `ALTER TABLE t ADD PARTITION …` / `ATTACH PARTITION … FROM TABLE s` /
		 * `DETACH PARTITION … INTO TABLE d`, all emitted by the Db2 partition
		 * designer. The TO TABLE words in `DETACH … INTO TABLE` are optional in
		 * Db2 and omitted by the designer's `INTO <table>` form.
		 */
		this.RULE('db2AlterTablePartitionAction', () => {
			this.OR([
				{
					GATE: () => this.isDb2KeywordAt(1, 'ADD'),
					ALT: () => {
						this.CONSUME(baseLexer.Add);
						this.SUBRULE(this.db2PartitionRangeDefinition);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'ATTACH'),
					ALT: () => {
						this.CONSUME1(baseLexer.Identifier);
						this.SUBRULE1(this.db2PartitionRangeDefinition);
						this.CONSUME(baseLexer.From);
						this.CONSUME(baseLexer.Table);
						this.SUBRULE(this.qualifiedName);
					},
				},
				{
					GATE: () => this.isDb2KeywordAt(1, 'DETACH'),
					ALT: () => {
						this.CONSUME2(baseLexer.Identifier);
						this.SUBRULE2(this.db2PartitionRangeDefinition);
					},
				},
			]);
		});

		/**
		 * `PARTITION p STARTING FROM (…) INCLUSIVE ENDING AT (…) EXCLUSIVE`
		 * plus the `IN` / `INDEX IN` / `LONG IN` tablespace clauses. Add/attach
		 * use the `STARTING FROM … ENDING AT …` form, detach only needs the
		 * partition name and the `INTO TABLE` target.
		 */
		this.RULE('db2PartitionRangeDefinition', () => {
			this.SUBRULE(this.db2PartitionKeywordOrIdentifier);
			this.SUBRULE(this.identifier);
			this.OPTION(() => this.SUBRULE(this.db2PartitionStartClause));
			this.OPTION1(() => this.SUBRULE(this.db2PartitionEndClause));
			this.OPTION2(() => {
				this.CONSUME(baseLexer.In);
				this.SUBRULE1(this.identifier);
			});
			this.OPTION3(() => {
				this.OR([
					{ GATE: () => this.isDb2KeywordAt(1, 'INDEX'), ALT: () => this.CONSUME1(baseLexer.Identifier) },
					{ GATE: () => this.isDb2KeywordAt(1, 'LONG'), ALT: () => this.CONSUME2(baseLexer.Identifier) },
				]);
				this.CONSUME1(baseLexer.In);
				this.SUBRULE2(this.identifier);
			});
			this.OPTION4(() => {
				this.CONSUME(baseLexer.Into);
				this.OPTION5(() => this.CONSUME(baseLexer.Table));
				this.SUBRULE3(this.qualifiedName);
			});
		});

		this.RULE('db2PartitionStartClause', () => {
			this.OR([
				{ GATE: () => this.isDb2KeywordAt(1, 'STARTING'), ALT: () => this.CONSUME(baseLexer.Identifier) },
				{ GATE: () => this.isDb2KeywordAt(1, 'START'), ALT: () => this.CONSUME1(baseLexer.Identifier) },
			]);
			this.OPTION(() => this.CONSUME(baseLexer.From));
			this.SUBRULE(this.db2PartitionBoundaryValue);
			this.OPTION1(() => this.SUBRULE(this.db2PartitionInclusivity));
		});

		this.RULE('db2PartitionEndClause', () => {
			this.OR([
				{ GATE: () => this.isDb2KeywordAt(1, 'ENDING'), ALT: () => this.CONSUME(baseLexer.Identifier) },
				{ GATE: () => this.isDb2KeywordAt(1, 'END'), ALT: () => this.CONSUME1(baseLexer.Identifier) },
			]);
			this.OPTION(() => {
				this.OR1([
					{ GATE: () => this.isDb2KeywordAt(1, 'AT'), ALT: () => this.CONSUME2(baseLexer.Identifier) },
					{ GATE: () => this.isDb2KeywordAt(1, 'FROM'), ALT: () => this.CONSUME(baseLexer.From) },
				]);
			});
			this.SUBRULE(this.db2PartitionBoundaryValue);
			this.OPTION1(() => this.SUBRULE(this.db2PartitionInclusivity));
		});

		this.RULE('db2PartitionBoundaryValue', () => {
			this.OR([
				{ GATE: () => this.isDb2KeywordAt(1, 'MINVALUE'), ALT: () => this.CONSUME(baseLexer.Identifier) },
				{ GATE: () => this.isDb2KeywordAt(1, 'MAXVALUE'), ALT: () => this.CONSUME1(baseLexer.Identifier) },
				{ ALT: () => {
					this.CONSUME(baseLexer.LParen);
					this.AT_LEAST_ONE_SEP({ SEP: baseLexer.Comma, DEF: () => this.SUBRULE(this.expression) });
					this.CONSUME(baseLexer.RParen);
				} },
			]);
		});

		this.RULE('db2PartitionKeywordOrIdentifier', () => {
			this.OR([{ GATE: () => this.isDb2KeywordAt(1, 'PARTITION'), ALT: () => this.CONSUME(baseLexer.Identifier) }]);
		});

		/**
		 * `REORG TABLE t` / `RUNSTATS ON TABLE t ...` and their `REORG INDEXES ALL
		 * FOR TABLE t` / `REORG TABLE t ...` variants. Option lists are long and
		 * version-specific, so the tail is an offset-stable token sequence.
		 */
		this.RULE('db2AdminCommandStatement', () => {
			this.OR([
				{ GATE: () => this.LA(1).tokenType === db2Lexer.Db2Reorg, ALT: () => this.CONSUME(db2Lexer.Db2Reorg) },
				{ ALT: () => this.CONSUME(db2Lexer.Db2Runstats) },
			]);
			this.MANY(() => this.SUBRULE(this.commandTailToken));
		});

		/**
		 * `CREATE TRIGGER name AFTER|BEFORE|INSTEAD OF … ON table … BEGIN ATOMIC … END`
		 *
		 * The header carries a long, version-specific option list
		 * (`REFERENCING … FOR EACH ROW MODE DB2SQL`, `UPDATE OF …`, …), so it is
		 * an offset-stable token sequence that stops at `BEGIN`. The body reuses
		 * the depth-tracked compound body; `ATOMIC` is just the first body token.
		 */
		this.RULE('db2CreateTriggerStatement', () => {
			this.CONSUME(baseLexer.Create);
			this.CONSUME(db2Lexer.Db2Trigger);
			this.SUBRULE(this.qualifiedName);
			this.MANY({
				GATE: () => this.LA(1).tokenType !== baseLexer.Begin,
				DEF: () => this.SUBRULE(this.db2ProgramToken),
			});
			this.SUBRULE(this.db2CompoundBody);
		});

		/**
		 * `LABEL ON TABLE|COLUMN|INDEX|ALIAS … IS '…'`. The object-kind word and
		 * the qualified target are the only structure; the label text is a literal.
		 */
		this.RULE('db2LabelStatement', () => {
			this.CONSUME(db2Lexer.Db2LabelOn);
			this.SUBRULE(this.identifier);
			this.SUBRULE(this.qualifiedName);
			this.OPTION(() => this.SUBRULE(this.commandTail));
		});

		/**
		 * `EXPORT TO file OF IXF SELECT …` — the file and format are not SQL
		 * expressions, so they stay a token sequence; the embedded query keeps its
		 * own rule so scope analysis still sees the referenced tables.
		 */
		this.RULE('db2ExportStatement', () => {
			this.CONSUME(db2Lexer.Db2Export);
			this.MANY({
				GATE: () => this.LA(1).tokenType !== baseLexer.Select
					&& this.LA(1).tokenType !== baseLexer.With,
				DEF: () => this.SUBRULE(this.commandTailToken),
			});
			this.OR([
				{ GATE: () => this.LA(1).tokenType === baseLexer.With, ALT: () => this.SUBRULE(this.withAnyStatement) },
				{ ALT: () => this.SUBRULE(this.selectStatement) },
			]);
		});

		/**
		 * `IMPORT FROM file OF IXF INSERT INTO t …`. The target import mode is a
		 * utility option list, not SQL, so the whole statement is an offset-stable
		 * token sequence.
		 */
		this.RULE('db2ImportStatement', () => {
			this.CONSUME(db2Lexer.Db2Import);
			this.MANY(() => this.SUBRULE(this.commandTailToken));
		});

		this.RULE('db2ProgramToken', () => {
			// SQL PL bodies are an offset-stable token sequence, not a modelled
			// statement grammar. `commandTailToken` already accepts identifiers,
			// literals and punctuation; the Db2-only multi-word tokens are added
			// here and are disjoint from it, so the OR stays unambiguous.
			this.OR([
				{ ALT: () => this.SUBRULE(this.commandTailToken) },
				{ ALT: () => this.SUBRULE(this.db2ProgramKeyword) },
			]);
		});

		this.RULE('db2ProgramKeyword', () => {
			this.OR(this.getTokenAlternatives(DB2_PROGRAM_ONLY_TOKENS));
		});

		/** `END IF` / `END WHILE` / `END LOOP` / `END FOR` / `END REPEAT` / `END CASE`. */
		this.RULE('db2EndBlockKeyword', () => {
			this.CONSUME(baseLexer.End);
			this.OR([
				{ GATE: () => this.LA(1).tokenType === baseLexer.If, ALT: () => this.CONSUME(baseLexer.If) },
				{ GATE: () => this.LA(1).tokenType === baseLexer.While, ALT: () => this.CONSUME(baseLexer.While) },
				{ GATE: () => this.LA(1).tokenType === baseLexer.Loop, ALT: () => this.CONSUME(baseLexer.Loop) },
				{ GATE: () => this.LA(1).tokenType === baseLexer.Case, ALT: () => this.CONSUME(baseLexer.Case) },
				{ GATE: () => this.LA(1).tokenType === baseLexer.For, ALT: () => this.CONSUME(baseLexer.For) },
				{ GATE: () => this.isDb2KeywordAt(1, 'REPEAT'), ALT: () => this.CONSUME(baseLexer.Identifier) },
			]);
		});

		/**
		 * `BEGIN … END` with nesting. The body stays an offset-stable token
		 * sequence, but the `BEGIN` / `CASE` stack is tracked so `IF … END IF`,
		 * `WHILE … END WHILE`, `CASE … END CASE`, case expressions and nested
		 * compound statements all end where they should.
		 */
		this.RULE('db2CompoundBody', () => {
			this.CONSUME(baseLexer.Begin);
			const blockStack: Array<'begin' | 'case'> = [];
			this.MANY({
				GATE: () => this.shouldContinueDb2Body(blockStack),
				DEF: () => {
					const tokenType = this.LA(1).tokenType;
					const nextType = this.LA(2).tokenType;
					if (tokenType === baseLexer.End) {
						if (this.isDb2BlockTerminator(nextType)) {
							// `END IF` / `END WHILE` / `END LOOP` / `END REPEAT` /
							// `END FOR` close an inner construct; only `END CASE`
							// also closes a tracked `CASE`.
							if (nextType === baseLexer.Case && blockStack[blockStack.length - 1] === 'case') {
								blockStack.pop();
							}
							this.SUBRULE(this.db2EndBlockKeyword);
							return;
						}
						// A plain `END` closes the innermost `BEGIN` or case expression.
						if (blockStack.length > 0) {
							blockStack.pop();
						}
						this.CONSUME1(baseLexer.End);
						return;
					}
					if (tokenType === baseLexer.Case) {
						blockStack.push('case');
					} else if (tokenType === baseLexer.Begin) {
						blockStack.push('begin');
					}
					this.SUBRULE(this.db2ProgramToken);
				},
			});
			this.CONSUME(baseLexer.End);
		});

		/**
		 * Thin SQL PL unit: explicit `CREATE … PROCEDURE` header, then `BEGIN … END`.
		 *
		 * The header is a token sequence that stops at `BEGIN`; the body tracks
		 * `BEGIN` and `CASE` depth, so `IF … END IF`, `WHILE … END WHILE`,
		 * nested compound statements and `CASE` expressions all end where they
		 * should. The explicit header narrows the rule FIRST set to {Create} so
		 * the shared statement OR stays cheap to self-analyze (catch-all token
		 * soups first sets overlap every DML alternative and blow up
		 * Chevrotain's lookahead analysis).
		 */
		this.RULE('db2ProcedureUnit', () => {
			this.CONSUME(baseLexer.Create);
			this.OPTION(() => {
				this.CONSUME(baseLexer.Or);
				this.CONSUME(baseLexer.Replace);
			});
			this.CONSUME(baseLexer.Procedure);
			this.SUBRULE(this.qualifiedName);
			this.MANY({
				GATE: () => this.LA(1).tokenType !== baseLexer.Begin,
				DEF: () => this.SUBRULE(this.db2ProgramToken),
			});
			this.SUBRULE(this.db2CompoundBody);
			this.OPTION1(() => this.SUBRULE(this.identifier));
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
