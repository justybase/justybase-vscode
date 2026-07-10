import * as netezzaSqlLexer from './lexer';
import {
    On,
    Or,
    Not,
    As,
    All,
    Null,
    Is,
    In,
    When,
    Then,
    Else,
    End,
    If,
    Elsif,
    Create,
    Replace,
    Table,
    Procedure,
    With,
    Final,
    Distribute,
    Random,
    Organize,
    Groom,
    Versions,
    Records,
    Pages,
    Ready,
    Start,
    Reclaim,
    Backupset,
    Default,
    None,
    Generate,
    Next,
    Express,
    Statistics,
    For,
    Of,
    Value,
    Returns,
    Language,
    Execute,
    Immediate,
    Owner,
    Caller,
    RefTable,
    Varargs,
    Nzplsql,
    BeginProc,
    EndProc,
    Begin,
    Declare,
    Exception,
    Return,
    Alias,
    Constant,
    Loop,
    While,
    Exit,
    Raise,
    Notice,
    Debug,
    Warning,
    Error,
    Perform,
    Reverse,
    Out,
    Inout,
    LabelStart,
    LabelEnd,
    Sqlstate,
    Others,
    Using,
    External,
    SameAs,
    Hash,
    Distribution,
    Plantext,
    Plangraph,
    Synonym,
    NumberLiteral,
    StringLiteral,
    DollarNumber,
    DollarIdentifier,
    Parameter,
    Identifier,
    QuotedIdentifier,
    Equals,
    NotEquals,
    LessThan,
    GreaterThan,
    LessThanEquals,
    GreaterThanEquals,
    Plus,
    Minus,
    Multiply,
    Divide,
    Concat,
    DoubleColon,
    Assign,
    Dot,
    Comma,
    Semicolon,
    LParen,
    RParen,
    LBracket,
    RBracket,
    AtSet,
    Merge,
    Into,
    Alter,
    Add,
    Drop,
    Set,
    Column,
    Constraint,
    Cascade,
    Restrict,
    To,
    Rename,
    Modify,
    Privileges,
} from './lexer';
import { BaseSqlParser, type OrAlternative } from '../../../sqlParser/BaseSqlParser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRule = () => any;

const EXTERNAL_TABLE_OPTION_NAMES = new globalThis.Set([
  "BOOLSTYLE",
  "COMPRESS",
  "CRINSTRING",
  "CTRLCHARS",
  "DATAOBJECT",
  "DATEDELIM",
  "DATESTYLE",
  "DATETIMEDELIM",
  "DECIMALDELIM",
  "DELIMITER",
  "ENCODING",
  "ESCAPECHAR",
  "FILLRECORD",
  "FORMAT",
  "IGNOREZERO",
  "INCLUDEHEADER",
  "INCLUDEZEROSECONDS",
  "LAYOUT",
  "LFINSTRING",
  "LOGDIR",
  "MAXERRORS",
  "MAXROWS",
  "MERIDIANDELIM",
  "NULLVALUE",
  "QUOTEDVALUE",
  "RECORDDELIM",
  "RECORDLENGTH",
  "REMOTESOURCE",
  "REQUIREQUOTES",
  "SKIPROWS",
  "SOCKETBUFSIZE",
  "TIMEDELIM",
  "TIMEROUNDNANOS",
  "TIMEEXTRAZEROS",
  "TIMESTYLE",
  "TRUNCSTRING",
  "Y2BASE",
  "UNIQUEID",
  "ACCESSKEYID",
  "SECRETACCESSKEY",
  "DEFAULTREGION",
  "BUCKETURL",
  "MULTIPARTSIZEMB",
  "ENDPOINT",
  "AZACCOUNT",
  "AZKEY",
  "AZCONTAINER",
  "AZMAXBLOCKS",
  "AZBLOCKSIZEMB",
  "AZLOGLEVEL",
]);

export class NetezzaSqlParser extends BaseSqlParser {
  /** Token immediately following `<<identifier>>`, if input starts with a label. */
  private tokenTypeAfterProcedureLabel(): typeof Begin | undefined {
    if (this.LA(1).tokenType !== LabelStart) {
      return undefined;
    }
    for (let i = 2; i <= 10; i++) {
      const token = this.LA(i);
      if (token.tokenType === LabelEnd) {
        return this.LA(i + 1).tokenType as typeof Begin;
      }
    }
    return undefined;
  }

  private startsLabeledOrPlain(
    tokenType: typeof Loop | typeof While | typeof For,
  ): boolean {
    if (this.LA(1).tokenType === tokenType) {
      return true;
    }
    return this.tokenTypeAfterProcedureLabel() === tokenType;
  }

  alterTableAction!: AnyRule;
  alterTableAddColumnAction!: AnyRule;
  alterTableAddConstraintAction!: AnyRule;
  alterTableAlterColumnAction!: AnyRule;
  alterTableDropColumnAction!: AnyRule;
  alterTableDropConstraintAction!: AnyRule;
  alterTableModifyColumnAction!: AnyRule;
  alterTableOwnerAction!: AnyRule;
  alterTableRenameColumnAction!: AnyRule;
  alterTableRenameTableAction!: AnyRule;
  alterTableSetPrivilegesAction!: AnyRule;
  alterTableCascadeRestrictClause!: AnyRule;

  constructor() {
    super(netezzaSqlLexer);
    this.overrideSharedGrammarForNetezza();
    this.registerNetezzaRules();
    this.finalizeParser();
  }

  protected getAdditionalStatementAlternatives(): OrAlternative[] {
    return [
      { ALT: () => this.SUBRULE(this.alterObjectStatement) },
      { ALT: () => this.SUBRULE(this.createExternalTableStatement) },
      {
        GATE: () =>
          this.LA(2).tokenType === Procedure ||
          (this.LA(2).tokenType === Or &&
            this.LA(3).tokenType === Replace &&
            this.LA(4).tokenType === Procedure),
        ALT: () => this.SUBRULE(this.createProcedureStatement),
      },
      {
        GATE: () => this.LA(2).tokenType === Synonym,
        ALT: () => this.SUBRULE(this.createSynonymStatement),
      },
      { ALT: () => this.SUBRULE(this.groomStatement) },
      { ALT: () => this.SUBRULE(this.generateStatisticsStatement) },
      { ALT: () => this.SUBRULE(this.variableSetStatement) },
    ];
  }

  protected getAdditionalDropObjectAlternatives(): OrAlternative[] {
    return [
      {
        ALT: () => {
          this.CONSUME(External);
          this.CONSUME1(Table);
        },
      },
    ];
  }

  protected getAdditionalExplainOptionAlternatives(): OrAlternative[] {
    return [
      { ALT: () => this.CONSUME(Distribution) },
      { ALT: () => this.CONSUME(Plantext) },
      { ALT: () => this.CONSUME(Plangraph) },
    ];
  }

  protected getAdditionalTableSourceAlternatives(): OrAlternative[] {
    return [
      {
        ALT: () => {
          this.CONSUME(Table);
          this.CONSUME(With);
          this.CONSUME(Final);
          this.CONSUME(LParen);
          this.SUBRULE(this.qualifiedName);
          this.CONSUME1(LParen);
          this.OPTION1(() => this.SUBRULE(this.functionArguments));
          this.CONSUME1(RParen);
          this.CONSUME(RParen);
        },
      },
    ];
  }

  protected registerCreateTableDialectClauses(): void {
    this.OPTION7(() => this.SUBRULE(this.distributeClause));
    this.OPTION8(() => this.SUBRULE(this.organizeClause));
  }

  protected supportsEmptyQualifiedNameSegment(): boolean {
    return true;
  }

  private overrideSharedGrammarForNetezza(): void {
    // The shared base parser intentionally treats keywords as reserved words so
    // future dialects start from ANSI-safe behavior. Netezza historically
    // permits many keywords in identifier positions, so we reintroduce that
    // broader surface here instead of leaking it back into the base grammar.
    this.OVERRIDE_RULE('identifier', () => {
      this.OR(this.getTokenAlternatives(this.getNetezzaIdentifierTokens()));
    });

    // Shared relaxed-name rule avoids duplicate CONSUME entries when column
    // references allow qualified names (OR / OR1 / OR2 in one rule).
    this.RULE('netezzaRelaxedName', () => {
      this.OR(this.getTokenAlternatives(this.getNetezzaRelaxedNameTokens()));
    });

    // Only a narrower keyword subset is accepted in alias/column positions.
    // Keeping this override local preserves long-standing Netezza behavior
    // without making the shared parser permissive for every dialect.
    this.OVERRIDE_RULE('alias', () => {
      this.SUBRULE(this.netezzaRelaxedName);
    });

    this.OVERRIDE_RULE('columnReference', () => {
      this.SUBRULE(this.netezzaRelaxedName);
      this.OPTION({
        GATE: () =>
          this.LA(1).tokenType === Dot && this.LA(2).tokenType !== Dot,
        DEF: () => {
          this.CONSUME(Dot);
          this.SUBRULE1(this.netezzaRelaxedName);
          this.MANY(() => {
            this.CONSUME1(Dot);
            this.SUBRULE2(this.netezzaRelaxedName);
          });
        },
      });
    });

    this.OVERRIDE_RULE('mergeStatement', () => {
      this.CONSUME(Merge);
      this.OPTION(() => this.CONSUME(Into));
      this.SUBRULE(this.tableName);
      this.OPTION1(() => this.SUBRULE(this.commandTail));
    });

    // Netezza exposes built-ins such as REPLACE/RANDOM through dedicated
    // keyword tokens, so the dialect must widen function-name parsing beyond
    // the ANSI-safe identifier-only rule in the shared parser.
    this.OVERRIDE_RULE('functionCall', () => {
      this.OR1([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
        { ALT: () => this.CONSUME(Next) },
        { ALT: () => this.CONSUME(Replace) },
        { ALT: () => this.CONSUME(Random) },
        { ALT: () => this.CONSUME(Value) },
      ]);
      this.CONSUME(LParen);
      this.OPTION(() => {
        this.OR2([
          { ALT: () => this.CONSUME(netezzaSqlLexer.Distinct) },
          { ALT: () => this.CONSUME(All) },
        ]);
      });
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.withinGroupClause));
      this.OPTION4(() => this.SUBRULE(this.overClause));
    });

    this.RULE('sequenceValueExpression', () => {
      this.CONSUME(Next);
      this.CONSUME(Value);
      this.CONSUME(For);
      this.SUBRULE(this.qualifiedName);
    });

    // VARCHAR(ANY) is allowed only in procedure arguments and return types.
    // The override allows parsing; the visitor validates procedure-context check.
    this.OVERRIDE_RULE('typeArgument', () => {
      this.OR([
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
        { ALT: () => this.CONSUME(netezzaSqlLexer.Any) },
      ]);
    });

    this.OVERRIDE_RULE('primaryExpression', () => {
      this.OR([
        {
          GATE: () => {
            const la1 = this.LA(1);
            const la2 = this.LA(2);
            return (
              la1.tokenType === NumberLiteral ||
              la1.tokenType === netezzaSqlLexer.BracedVariable ||
              la1.tokenType === netezzaSqlLexer.BracesOnlyVariable ||
              la1.tokenType === DollarNumber ||
              la1.tokenType === DollarIdentifier ||
              la1.tokenType === StringLiteral ||
              la1.tokenType === Null ||
              (la1.tokenType === Identifier &&
                la2.tokenType === StringLiteral) ||
              (la1.tokenType === QuotedIdentifier &&
                la2.tokenType === StringLiteral)
            );
          },
          ALT: () => this.SUBRULE(this.literal),
        },
        {
          GATE: () =>
            this.LA(1).tokenType === Next &&
            this.LA(2).tokenType === Value &&
            this.LA(3).tokenType === For,
          ALT: () => this.SUBRULE(this.sequenceValueExpression),
        },
        { ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.castFunctionExpression) },
        { ALT: () => this.SUBRULE(this.extractExpression) },
        { ALT: () => this.SUBRULE(this.caseExpression) },
        { ALT: () => this.SUBRULE(this.existsExpression) },
        { ALT: () => this.SUBRULE(this.subquery) },
        { ALT: () => this.SUBRULE(this.expressionList) },
        { ALT: () => this.SUBRULE(this.columnReference) },
        { ALT: () => this.CONSUME(Parameter) },
      ]);
    });
  }

  private getNetezzaRelaxedNameTokens() {
    return [
      Identifier,
      QuotedIdentifier,
      Owner,
      Start,
      Hash,
      Final,
      Next,
      Of,
      Value,
      netezzaSqlLexer.Escape,
      netezzaSqlLexer.Key,
      netezzaSqlLexer.User,
      netezzaSqlLexer.Group,
      netezzaSqlLexer.Type,
      netezzaSqlLexer.Materialized,
    ];
  }

  private getNetezzaIdentifierTokens() {
    return [
      netezzaSqlLexer.Identifier,
      netezzaSqlLexer.QuotedIdentifier,
      netezzaSqlLexer.Table,
      netezzaSqlLexer.Procedure,
      netezzaSqlLexer.Select,
      netezzaSqlLexer.From,
      netezzaSqlLexer.Where,
      netezzaSqlLexer.Insert,
      netezzaSqlLexer.Into,
      netezzaSqlLexer.Values,
      netezzaSqlLexer.Update,
      netezzaSqlLexer.Set,
      netezzaSqlLexer.Delete,
      netezzaSqlLexer.Create,
      netezzaSqlLexer.Replace,
      netezzaSqlLexer.Drop,
      netezzaSqlLexer.Alter,
      netezzaSqlLexer.Truncate,
      netezzaSqlLexer.Explain,
      netezzaSqlLexer.Verbose,
      netezzaSqlLexer.Distribution,
      netezzaSqlLexer.Plantext,
      netezzaSqlLexer.Plangraph,
      netezzaSqlLexer.Show,
      netezzaSqlLexer.Copy,
      netezzaSqlLexer.Lock,
      netezzaSqlLexer.Merge,
      netezzaSqlLexer.Reindex,
      netezzaSqlLexer.Reset,
      netezzaSqlLexer.Join,
      netezzaSqlLexer.Inner,
      netezzaSqlLexer.Left,
      netezzaSqlLexer.Right,
      netezzaSqlLexer.Full,
      netezzaSqlLexer.Outer,
      netezzaSqlLexer.Cross,
      netezzaSqlLexer.Natural,
      netezzaSqlLexer.On,
      netezzaSqlLexer.And,
      netezzaSqlLexer.Or,
      netezzaSqlLexer.Not,
      netezzaSqlLexer.As,
      netezzaSqlLexer.Distinct,
      netezzaSqlLexer.All,
      netezzaSqlLexer.Union,
      netezzaSqlLexer.Intersect,
      netezzaSqlLexer.Except,
      netezzaSqlLexer.MinusSet,
      netezzaSqlLexer.Having,
      netezzaSqlLexer.Limit,
      netezzaSqlLexer.Offset,
      netezzaSqlLexer.Null,
      netezzaSqlLexer.Is,
      netezzaSqlLexer.Like,
      netezzaSqlLexer.Escape,
      netezzaSqlLexer.In,
      netezzaSqlLexer.Between,
      netezzaSqlLexer.Exists,
      netezzaSqlLexer.Case,
      netezzaSqlLexer.When,
      netezzaSqlLexer.Then,
      netezzaSqlLexer.Elsif,
      netezzaSqlLexer.If,
      netezzaSqlLexer.Else,
      netezzaSqlLexer.End,
      netezzaSqlLexer.Begin,
      netezzaSqlLexer.BeginProc,
      netezzaSqlLexer.EndProc,
      netezzaSqlLexer.Temporary,
      netezzaSqlLexer.Temp,
      netezzaSqlLexer.Database,
      netezzaSqlLexer.Group,
      netezzaSqlLexer.History,
      netezzaSqlLexer.Configuration,
      netezzaSqlLexer.Scheduler,
      netezzaSqlLexer.Rule,
      netezzaSqlLexer.Schema,
      netezzaSqlLexer.Sequence,
      netezzaSqlLexer.Session,
      netezzaSqlLexer.Synonym,
      netezzaSqlLexer.User,
      netezzaSqlLexer.External,
      netezzaSqlLexer.With,
      netezzaSqlLexer.Final,
      netezzaSqlLexer.Recursive,
      netezzaSqlLexer.Distribute,
      netezzaSqlLexer.Random,
      netezzaSqlLexer.Organize,
      netezzaSqlLexer.Groom,
      netezzaSqlLexer.Versions,
      netezzaSqlLexer.Records,
      netezzaSqlLexer.Pages,
      netezzaSqlLexer.Ready,
      netezzaSqlLexer.Start,
      netezzaSqlLexer.Reclaim,
      netezzaSqlLexer.Backupset,
      netezzaSqlLexer.Default,
      netezzaSqlLexer.None,
      netezzaSqlLexer.Generate,
      netezzaSqlLexer.Next,
      netezzaSqlLexer.Express,
      netezzaSqlLexer.Statistics,
      netezzaSqlLexer.For,
      netezzaSqlLexer.Of,
      netezzaSqlLexer.Value,
      netezzaSqlLexer.Views,
      netezzaSqlLexer.View,
      netezzaSqlLexer.Materialized,
      netezzaSqlLexer.Comment,
      netezzaSqlLexer.Column,
      netezzaSqlLexer.Rename,
      netezzaSqlLexer.Modify,
      netezzaSqlLexer.Privileges,
      netezzaSqlLexer.Deferred,
      netezzaSqlLexer.Match,
      netezzaSqlLexer.Action,
      netezzaSqlLexer.Add,
      netezzaSqlLexer.Constraint,
      netezzaSqlLexer.Primary,
      netezzaSqlLexer.Key,
      netezzaSqlLexer.Foreign,
      netezzaSqlLexer.References,
      netezzaSqlLexer.Unique,
      netezzaSqlLexer.Check,
      netezzaSqlLexer.Global,
      netezzaSqlLexer.Returns,
      netezzaSqlLexer.Language,
      netezzaSqlLexer.Execute,
      netezzaSqlLexer.Owner,
      netezzaSqlLexer.Caller,
      netezzaSqlLexer.RefTable,
      netezzaSqlLexer.Varargs,
      netezzaSqlLexer.Nzplsql,
      netezzaSqlLexer.Declare,
      netezzaSqlLexer.Return,
      netezzaSqlLexer.Alias,
      netezzaSqlLexer.Constant,
      netezzaSqlLexer.Loop,
      netezzaSqlLexer.While,
      netezzaSqlLexer.Exit,
      netezzaSqlLexer.Raise,
      netezzaSqlLexer.Notice,
      netezzaSqlLexer.Debug,
      netezzaSqlLexer.Error,
      netezzaSqlLexer.Rollback,
      netezzaSqlLexer.Commit,
      netezzaSqlLexer.Call,
      netezzaSqlLexer.Immediate,
      netezzaSqlLexer.Using,
      netezzaSqlLexer.Over,
      netezzaSqlLexer.Rows,
      netezzaSqlLexer.Range,
      netezzaSqlLexer.Current,
      netezzaSqlLexer.Row,
      netezzaSqlLexer.Unbounded,
      netezzaSqlLexer.Preceding,
      netezzaSqlLexer.Following,
      netezzaSqlLexer.Asc,
      netezzaSqlLexer.Desc,
      netezzaSqlLexer.Grant,
      netezzaSqlLexer.Revoke,
      netezzaSqlLexer.To,
      netezzaSqlLexer.Public,
      netezzaSqlLexer.Type,
      netezzaSqlLexer.Cascade,
      netezzaSqlLexer.Restrict,
      netezzaSqlLexer.SameAs,
      netezzaSqlLexer.Hash,
      netezzaSqlLexer.Deferrable,
      netezzaSqlLexer.Initially,
      netezzaSqlLexer.Ilike,
      netezzaSqlLexer.Nulls,
      netezzaSqlLexer.Fetch,
      netezzaSqlLexer.First,
      netezzaSqlLexer.Only,
      netezzaSqlLexer.Any,
      netezzaSqlLexer.Some,
    ];
  }

  private registerNetezzaRules(): void {
        this.RULE("alterObjectStatement", () => {
          this.CONSUME(netezzaSqlLexer.Alter);
          this.OR([
            { ALT: () => this.CONSUME(netezzaSqlLexer.Database) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.Group) },
            {
              ALT: () => {
                this.CONSUME(netezzaSqlLexer.History);
                this.CONSUME(netezzaSqlLexer.Configuration);
              },
            },
            {
              ALT: () => {
                this.CONSUME(netezzaSqlLexer.Scheduler);
                this.CONSUME(netezzaSqlLexer.Rule);
              },
            },
            { ALT: () => this.CONSUME(netezzaSqlLexer.Schema) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.Sequence) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.Session) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.Synonym) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.User) },
            { ALT: () => this.CONSUME(Procedure) },
            { ALT: () => this.CONSUME(netezzaSqlLexer.View) },
            {
              ALT: () => {
                this.CONSUME(netezzaSqlLexer.Views);
                this.CONSUME(On);
              },
            },
          ]);
          this.SUBRULE(this.commandTail);
        });

        this.RULE("variableSetStatement", () => {
          this.CONSUME(AtSet);
          this.SUBRULE(this.identifier);
          this.CONSUME(Equals);
          this.SUBRULE(this.expression);
        });

        this.RULE("createExternalTableStatement", () => {
          this.CONSUME(Create);
          this.CONSUME(External);
          this.CONSUME(Table);
          this.SUBRULE(this.qualifiedName);
          this.OR([
            {
              GATE: () => this.LA(1).tokenType === SameAs,
              ALT: () => {
                this.CONSUME(SameAs);
                this.SUBRULE1(this.qualifiedName);
                this.OPTION(() => this.SUBRULE(this.externalTableUsingClause));
              },
            },
            {
              GATE: () => this.LA(1).tokenType === LParen,
              ALT: () => {
                this.CONSUME(LParen);
                this.SUBRULE(this.columnDefinitionList);
                this.CONSUME(RParen);
                this.OPTION1(() => this.SUBRULE1(this.externalTableUsingClause));
              },
            },
            {
              GATE: () => this.LA(1).tokenType === StringLiteral,
              ALT: () => {
                this.CONSUME(StringLiteral);
                this.OPTION2(() => this.SUBRULE2(this.externalTableUsingClause));
                this.CONSUME(As);
                this.OR1([
                  { ALT: () => this.SUBRULE(this.withStatement) },
                  { ALT: () => this.SUBRULE(this.selectStatement) },
                ]);
              },
            },
          ]);
        });

        this.RULE("createSynonymStatement", () => {
          this.CONSUME(Create);
          this.CONSUME(Synonym);
          this.SUBRULE(this.qualifiedName);
          this.CONSUME(For);
          this.SUBRULE1(this.qualifiedName);
          this.OPTION(() => this.SUBRULE(this.commandTail));
        });

        this.RULE("externalTableUsingClause", () => {
          this.CONSUME(Using);
          this.CONSUME(LParen);
          this.SUBRULE(this.externalTableOptionList);
          this.CONSUME(RParen);
        });

        this.RULE("externalTableOptionList", () => {
          this.AT_LEAST_ONE(() => {
            this.SUBRULE(this.externalTableOption);
          });
        });

        this.RULE("externalTableOption", () => {
          this.SUBRULE(this.identifier);
          this.OPTION({
            GATE: () => {
              const next = this.LA(1);
              if (next.tokenType === RParen) {
                return false;
              }

              const normalized = (next.image || "").replace(/"/g, "").toUpperCase();
              return !EXTERNAL_TABLE_OPTION_NAMES.has(normalized);
            },
            DEF: () => this.SUBRULE(this.externalTableOptionValue),
          });
        });

        this.RULE("externalTableOptionValue", () => {
          this.OR([
            { ALT: () => this.SUBRULE(this.externalTableParenthesizedValue) },
            { ALT: () => this.SUBRULE(this.externalTableNumericValue) },
            { ALT: () => this.CONSUME(StringLiteral) },
            { ALT: () => this.SUBRULE(this.identifier) },
          ]);
        });

        this.RULE("externalTableNumericValue", () => {
          this.OPTION(() => {
            this.OR([
              { ALT: () => this.CONSUME(Minus) },
              { ALT: () => this.CONSUME(Plus) },
            ]);
          });
          this.CONSUME(NumberLiteral);
        });

        this.RULE("externalTableParenthesizedValue", () => {
          this.CONSUME(LParen);
          this.AT_LEAST_ONE(() => {
            this.SUBRULE(this.externalTableParenthesizedElement);
          });
          this.CONSUME(RParen);
        });

        this.RULE("externalTableParenthesizedElement", () => {
          this.OR([
            { ALT: () => this.SUBRULE(this.externalTableParenthesizedValue) },
            { ALT: () => this.SUBRULE(this.identifier) },
            { ALT: () => this.CONSUME(NumberLiteral) },
            { ALT: () => this.CONSUME(StringLiteral) },
            { ALT: () => this.CONSUME(DollarNumber) },
            { ALT: () => this.CONSUME(DollarIdentifier) },
            { ALT: () => this.CONSUME(Parameter) },
            { ALT: () => this.CONSUME(Equals) },
            { ALT: () => this.CONSUME(NotEquals) },
            { ALT: () => this.CONSUME(LessThan) },
            { ALT: () => this.CONSUME(LessThanEquals) },
            { ALT: () => this.CONSUME(GreaterThan) },
            { ALT: () => this.CONSUME(GreaterThanEquals) },
            { ALT: () => this.CONSUME(Plus) },
            { ALT: () => this.CONSUME(Minus) },
            { ALT: () => this.CONSUME(Multiply) },
            { ALT: () => this.CONSUME(Divide) },
            { ALT: () => this.CONSUME(Concat) },
            { ALT: () => this.CONSUME(DoubleColon) },
            { ALT: () => this.CONSUME(Assign) },
            { ALT: () => this.CONSUME(Dot) },
            { ALT: () => this.CONSUME(Comma) },
            { ALT: () => this.CONSUME(LBracket) },
            { ALT: () => this.CONSUME(RBracket) },
          ]);
        });

        // CREATE [OR REPLACE] PROCEDURE ... LANGUAGE NZPLSQL AS/IS ...
        this.RULE("createProcedureStatement", () => {
          this.CONSUME(Create);
          this.OPTION(() => {
            this.CONSUME(Or);
            this.CONSUME(Replace);
          });
          this.CONSUME(Procedure);
          this.SUBRULE(this.qualifiedName);
          this.CONSUME(LParen);
          this.OPTION1(() => this.SUBRULE(this.procedureArguments));
          this.CONSUME(RParen);
          this.SUBRULE(this.procedureSignatureSpec);
          this.OR([
            { ALT: () => this.CONSUME(As) },
            { ALT: () => this.CONSUME(Is) },
          ]);
          this.SUBRULE2(this.procedureBody);
        });

        this.RULE("procedureArguments", () => {
          this.OR([
            { ALT: () => this.CONSUME(Varargs) },
            {
              GATE: () => this.LA(1).tokenType !== Varargs,
              ALT: () => {
                this.AT_LEAST_ONE_SEP({
                  SEP: Comma,
                  DEF: () => this.SUBRULE(this.procedureArgument),
                });
              },
            },
          ]);
        });

        this.RULE("procedureArgumentMode", () => {
          this.OR([
            { ALT: () => this.CONSUME(Inout) },
            { ALT: () => this.CONSUME(Out) },
            { ALT: () => this.CONSUME(In) },
          ]);
        });

        this.RULE("procedureArgument", () => {
          this.OR([
            {
              GATE: () => {
                let index = 1;
                const modeTypes = [In, Out, Inout];
                if (modeTypes.includes(this.LA(index).tokenType)) {
                  index++;
                }
                const nameToken = this.LA(index);
                const nextToken = this.LA(index + 1);
                return (
                  (nameToken.tokenType === Identifier ||
                    nameToken.tokenType === QuotedIdentifier) &&
                  nextToken.tokenType !== Comma &&
                  nextToken.tokenType !== RParen &&
                  nextToken.tokenType !== Assign
                );
              },
              ALT: () => {
                this.OPTION(() => this.SUBRULE(this.procedureArgumentMode));
                this.SUBRULE(this.identifier);
                this.SUBRULE(this.typeName);
              },
            },
            {
              ALT: () => {
                this.OPTION1(() => this.SUBRULE1(this.procedureArgumentMode));
                this.SUBRULE1(this.typeName);
              },
            },
          ]);
        });

        this.RULE("procedureReturnType", () => {
          this.OR([
            {
              ALT: () => {
                this.CONSUME(RefTable);
                this.CONSUME(LParen);
                this.SUBRULE(this.qualifiedName);
                this.CONSUME(RParen);
              },
            },
            { ALT: () => this.SUBRULE(this.typeName) },
          ]);
        });

        this.RULE("procedureSignatureSpec", () => {
          this.OR([
            {
              ALT: () => {
                this.CONSUME(Returns);
                this.SUBRULE(this.procedureReturnType);
                this.OPTION(() => this.SUBRULE(this.executeAsClause));
                this.CONSUME(Language);
                this.CONSUME(Nzplsql);
                this.OPTION3(() => this.SUBRULE3(this.executeAsClause));
              },
            },
            {
              ALT: () => {
                this.CONSUME1(Language);
                this.CONSUME1(Nzplsql);
                this.CONSUME1(Returns);
                this.SUBRULE1(this.procedureReturnType);
                this.OPTION1(() => this.SUBRULE1(this.executeAsClause));
              },
            },
            {
              ALT: () => {
                this.SUBRULE2(this.executeAsClause);
                this.CONSUME2(Returns);
                this.SUBRULE2(this.procedureReturnType);
                this.CONSUME2(Language);
                this.CONSUME2(Nzplsql);
              },
            },
          ]);
        });

        this.RULE("executeAsClause", () => {
          this.CONSUME(Execute);
          this.CONSUME(As);
          this.OR([
            { ALT: () => this.CONSUME(Owner) },
            { ALT: () => this.CONSUME(Caller) },
          ]);
        });

        this.RULE("procedureBody", () => {
          this.OR([
            { ALT: () => this.CONSUME(StringLiteral) },
            { ALT: () => this.SUBRULE(this.beginProcBody) },
          ]);
        });

        this.RULE("beginProcBody", () => {
          this.CONSUME(BeginProc);
          this.SUBRULE(this.procedureStatements);
          this.MANY(() => this.CONSUME(Semicolon));
          this.CONSUME(EndProc);
        });

        this.RULE("procedureLabel", () => {
          this.CONSUME(LabelStart);
          this.SUBRULE(this.identifier);
          this.CONSUME(LabelEnd);
        });

        this.RULE("procedureBlock", () => {
          this.OPTION(() => this.SUBRULE(this.procedureDeclareSection));
          this.OPTION1(() => this.SUBRULE(this.procedureLabel));
          this.CONSUME(Begin);
          this.OPTION2({
            GATE: () =>
              this.LA(1).tokenType === Identifier &&
              this.LA(1).image.toUpperCase() === "AUTOCOMMIT",
            DEF: () => this.SUBRULE(this.autocommitClause),
          });
          this.OPTION3(() => this.CONSUME(Semicolon));
          this.SUBRULE(this.procedureStatements);
          this.OPTION4(() => this.SUBRULE(this.exceptionBlock));
          this.CONSUME(End);
        });

        this.RULE("autocommitClause", () => {
          this.CONSUME(Identifier);
          this.OR([
            { ALT: () => this.CONSUME(On) },
            {
              GATE: () =>
                this.LA(1).tokenType === Identifier &&
                this.LA(1).image.toUpperCase() === "OFF",
              ALT: () => this.CONSUME1(Identifier),
            },
          ]);
        });

        this.RULE("procedureDeclareSection", () => {
          this.CONSUME(Declare);
          this.SUBRULE(this.variableDeclarations);
        });

        this.RULE("variableDeclarations", () => {
          this.SUBRULE(this.variableDeclaration);
          this.MANY(() => {
            this.CONSUME(Semicolon);
            this.OPTION(() => this.CONSUME(Declare));
            this.SUBRULE1(this.variableDeclaration);
          });
          this.MANY1(() => this.CONSUME1(Semicolon));
        });

        this.RULE("variableDeclaration", () => {
          this.OR([
            { ALT: () => this.CONSUME(Identifier) },
            { ALT: () => this.CONSUME(QuotedIdentifier) },
            { ALT: () => this.CONSUME(Owner) },
            { ALT: () => this.CONSUME(Start) },
          ]);
          this.OR1([
            {
              ALT: () => {
                this.CONSUME(Alias);
                this.CONSUME(For);
                this.OR2([
                  { ALT: () => this.CONSUME(DollarNumber) },
                  { ALT: () => this.CONSUME(DollarIdentifier) },
                  { ALT: () => this.CONSUME(NumberLiteral) },
                  { ALT: () => this.SUBRULE1(this.identifier) },
                ]);
              },
            },
            {
              GATE: () =>
                this.LA(1).tokenType === Identifier &&
                this.LA(1).image.toUpperCase() === "VARRAY",
              ALT: () => {
                this.CONSUME2(Identifier);
                this.CONSUME(LParen);
                this.SUBRULE2(this.expression);
                this.CONSUME(RParen);
                this.CONSUME(Of);
                this.SUBRULE2(this.typeName);
              },
            },
            {
              GATE: () =>
                this.LA(1).tokenType === Identifier &&
                this.LA(1).image.toUpperCase() === "RECORD",
              ALT: () => {
                this.CONSUME3(Identifier);
              },
            },
            {
              ALT: () => {
                this.OPTION(() => this.CONSUME(Constant));
                this.SUBRULE(this.typeName);
                this.OPTION1(() => {
                  this.CONSUME(Not);
                  this.CONSUME(Null);
                });
                this.OPTION2(() => {
                  this.CONSUME(Assign);
                  this.SUBRULE(this.expression);
                });
              },
            },
          ]);
        });

        this.RULE("procedureStatements", () => {
          this.OPTION(() => {
            this.SUBRULE(this.procedureStatement);
            this.MANY(() => {
              this.CONSUME(Semicolon);
              this.SUBRULE1(this.procedureStatement);
            });
            this.MANY1(() => this.CONSUME1(Semicolon));
          });
        });

        this.RULE("performStatement", () => {
          this.CONSUME(Perform);
          this.SUBRULE(this.expression);
        });

        this.RULE("arrayMethodStatement", () => {
          this.SUBRULE(this.identifier);
          this.CONSUME(Dot);
          this.CONSUME(Identifier);
          this.CONSUME(LParen);
          this.OPTION(() => {
            this.AT_LEAST_ONE_SEP({
              SEP: Comma,
              DEF: () => this.SUBRULE(this.expression),
            });
          });
          this.CONSUME(RParen);
        });

        this.RULE("procedureStatement", () => {
          this.OR([
            {
              GATE: () =>
                this.LA(1).tokenType === Declare ||
                this.LA(1).tokenType === Begin ||
                this.tokenTypeAfterProcedureLabel() === Begin,
              ALT: () => this.SUBRULE(this.procedureBlock),
            },
            { ALT: () => this.SUBRULE(this.ifStatement) },
            {
              GATE: () => this.startsLabeledOrPlain(Loop),
              ALT: () => this.SUBRULE(this.loopStatement),
            },
            {
              GATE: () => this.startsLabeledOrPlain(While),
              ALT: () => this.SUBRULE(this.whileStatement),
            },
            {
              GATE: () => this.startsLabeledOrPlain(For),
              ALT: () => this.SUBRULE(this.forStatement),
            },
            { ALT: () => this.SUBRULE(this.exitStatement) },
            { ALT: () => this.SUBRULE(this.raiseStatement) },
            { ALT: () => this.SUBRULE(this.returnStatement) },
            { ALT: () => this.SUBRULE(this.performStatement) },
            { ALT: () => this.SUBRULE(this.assignmentStatement) },
            { ALT: () => this.SUBRULE(this.rollbackStatement) },
            { ALT: () => this.SUBRULE(this.commitStatement) },
            {
              GATE: () =>
                this.LA(1).tokenType === Execute &&
                this.LA(2).tokenType === Immediate,
              ALT: () => this.SUBRULE(this.executeImmediateStatement),
            },
            {
              GATE: () =>
                !(
                  this.LA(1).tokenType === Execute &&
                  this.LA(2).tokenType === Immediate
                ),
              ALT: () => this.SUBRULE(this.callStatement),
            },
            { ALT: () => this.SUBRULE(this.selectStatement) },
            { ALT: () => this.SUBRULE(this.insertStatement) },
            { ALT: () => this.SUBRULE(this.updateStatement) },
            { ALT: () => this.SUBRULE(this.deleteStatement) },
            { ALT: () => this.SUBRULE(this.createTableStatement) },
            { ALT: () => this.SUBRULE(this.createViewStatement) },
            { ALT: () => this.SUBRULE(this.commentStatement) },
            { ALT: () => this.SUBRULE(this.alterTableStatement) },
            { ALT: () => this.SUBRULE(this.dropStatement) },
            { ALT: () => this.SUBRULE(this.truncateStatement) },
            { ALT: () => this.SUBRULE(this.groomStatement) },
            { ALT: () => this.SUBRULE(this.generateStatisticsStatement) },
            { ALT: () => this.SUBRULE(this.grantStatement) },
            { ALT: () => this.SUBRULE(this.revokeStatement) },
          ]);
        });

        this.RULE("assignmentStatement", () => {
          this.SUBRULE(this.columnReference);
          this.OR([
            {
              ALT: () => {
                this.CONSUME(Assign);
                this.SUBRULE(this.expression);
              },
            },
            {
              ALT: () => {
                this.CONSUME(Equals);
                this.SUBRULE3(this.expression);
              },
            },
            {
              ALT: () => {
                this.CONSUME(LParen);
                this.OPTION(() => {
                  this.AT_LEAST_ONE_SEP({
                    SEP: Comma,
                    DEF: () => this.SUBRULE1(this.expression),
                  });
                });
                this.CONSUME(RParen);
                this.OPTION1(() => {
                  this.CONSUME1(Assign);
                  this.SUBRULE2(this.expression);
                });
              },
            },
          ]);
        });

        this.RULE("returnStatement", () => {
          this.CONSUME(Return);
          this.OPTION(() => {
            this.OR([
              { ALT: () => this.SUBRULE(this.expression) },
              { ALT: () => this.CONSUME(RefTable) },
            ]);
          });
        });

        this.RULE("ifStatement", () => {
          this.CONSUME(If);
          this.SUBRULE(this.expression);
          this.CONSUME(Then);
          this.SUBRULE(this.procedureStatements);
          this.MANY(() => this.SUBRULE(this.elsifClause));
          this.OPTION(() => {
            this.CONSUME(Else);
            this.SUBRULE1(this.procedureStatements);
          });
          this.CONSUME(End);
          this.CONSUME1(If);
        });

        this.RULE("elsifClause", () => {
          this.CONSUME(Elsif);
          this.SUBRULE(this.expression);
          this.CONSUME(Then);
          this.SUBRULE(this.procedureStatements);
        });

        this.RULE("loopStatement", () => {
          this.OPTION(() => this.SUBRULE(this.procedureLabel));
          this.CONSUME(Loop);
          this.SUBRULE(this.procedureStatements);
          this.CONSUME(End);
          this.CONSUME1(Loop);
        });

        this.RULE("whileStatement", () => {
          this.OPTION(() => this.SUBRULE(this.procedureLabel));
          this.CONSUME(While);
          this.SUBRULE(this.expression);
          this.CONSUME(Loop);
          this.SUBRULE(this.procedureStatements);
          this.CONSUME(End);
          this.CONSUME1(Loop);
        });

        this.RULE("forStatement", () => {
          this.OPTION(() => this.SUBRULE(this.procedureLabel));
          this.CONSUME(For);
          this.SUBRULE(this.identifier);
          this.CONSUME(In);
          this.OR([
            {
              ALT: () => {
                this.OPTION1(() => this.CONSUME(Reverse));
                this.SUBRULE(this.expression);
                this.CONSUME(Dot);
                this.CONSUME1(Dot);
                this.SUBRULE1(this.expression);
              },
            },
            { ALT: () => this.SUBRULE(this.selectStatement) },
            {
              ALT: () => {
                this.CONSUME(Execute);
                this.SUBRULE2(this.expression);
              },
            },
          ]);
          this.CONSUME(Loop);
          this.SUBRULE3(this.procedureStatements);
          this.CONSUME(End);
          this.CONSUME1(Loop);
        });

        this.RULE("exitStatement", () => {
          this.CONSUME(Exit);
          this.OPTION({
            GATE: () => this.LA(1).tokenType !== When,
            DEF: () => this.SUBRULE(this.identifier),
          });
          this.OPTION1(() => {
            this.CONSUME(When);
            this.SUBRULE(this.expression);
          });
        });

        this.RULE("raiseStatement", () => {
          this.CONSUME(Raise);
          this.OR([
            { ALT: () => this.CONSUME(Notice) },
            { ALT: () => this.CONSUME(Warning) },
            { ALT: () => this.CONSUME(Debug) },
            { ALT: () => this.CONSUME(Error) },
            { ALT: () => this.CONSUME(Exception) },
          ]);
          this.OPTION(() => this.CONSUME(StringLiteral));
          this.MANY(() => {
            this.CONSUME(Comma);
            this.SUBRULE(this.expression);
          });
        });

        this.RULE("executeImmediateStatement", () => {
          this.CONSUME(Execute);
          this.CONSUME(Immediate);
          this.SUBRULE(this.expression);
          this.OPTION(() => {
            this.CONSUME(Using);
            this.AT_LEAST_ONE_SEP({
              SEP: Comma,
              DEF: () => this.SUBRULE1(this.expression),
            });
          });
        });

        this.RULE("exceptionBlock", () => {
          this.CONSUME(Exception);
          this.AT_LEAST_ONE(() => this.SUBRULE(this.whenClause));
        });

        this.RULE("whenClause", () => {
          this.CONSUME(When);
          this.OR([
            { ALT: () => this.CONSUME(Others) },
            {
              ALT: () => {
                this.CONSUME(Sqlstate);
                this.CONSUME(StringLiteral);
              },
            },
            { ALT: () => this.SUBRULE(this.identifier) },
          ]);
          this.CONSUME(Then);
          this.SUBRULE(this.procedureStatements);
        });

        this.RULE("groomStatement", () => {
          this.CONSUME(Groom);
          this.CONSUME(Table);
          this.SUBRULE(this.qualifiedName);
          this.OPTION(() => this.SUBRULE(this.groomModeClause));
          this.OPTION1(() => this.SUBRULE(this.groomReclaimClause));
        });

        this.RULE("groomModeClause", () => {
          this.OR([
            { ALT: () => this.CONSUME(Versions) },
            {
              ALT: () => {
                this.CONSUME(Records);
                this.OPTION(() =>
                  this.OR1([
                    { ALT: () => this.CONSUME(All) },
                    { ALT: () => this.CONSUME(Ready) },
                  ]),
                );
              },
            },
            {
              ALT: () => {
                this.CONSUME(Pages);
                this.OPTION1(() =>
                  this.OR2([
                    { ALT: () => this.CONSUME1(All) },
                    { ALT: () => this.CONSUME(Start) },
                  ]),
                );
              },
            },
          ]);
        });

        this.RULE("groomReclaimClause", () => {
          this.CONSUME(Reclaim);
          this.CONSUME(Backupset);
          this.OR([
            { ALT: () => this.CONSUME(Default) },
            { ALT: () => this.CONSUME(None) },
            { ALT: () => this.CONSUME(NumberLiteral) },
          ]);
        });

        this.RULE("generateStatisticsStatement", () => {
          this.CONSUME(Generate);
          this.OPTION(() => this.CONSUME(Express));
          this.CONSUME(Statistics);
          this.OPTION3(() =>
            this.OR([
              {
                ALT: () => {
                  this.CONSUME(On);
                  this.SUBRULE(this.qualifiedName);
                  this.OPTION1(() =>
                    this.SUBRULE(this.generateStatisticsColumnsClause),
                  );
                },
              },
              {
                ALT: () => {
                  this.CONSUME(For);
                  this.CONSUME(Table);
                  this.SUBRULE1(this.qualifiedName);
                  this.OPTION2(() =>
                    this.SUBRULE1(this.generateStatisticsColumnsClause),
                  );
                },
              },
            ]),
          );
        });

        this.RULE("generateStatisticsColumnsClause", () => {
          this.CONSUME(LParen);
          this.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => this.SUBRULE(this.columnReference),
          });
          this.CONSUME(RParen);
        });

        // DISTRIBUTE ON clause for Netezza
        this.RULE("distributeClause", () => {
          this.CONSUME(Distribute);
          this.CONSUME(On);
          this.OR([
            { ALT: () => this.CONSUME(Random) },
            {
              ALT: () => {
                this.OPTION(() => this.CONSUME(Hash));
                this.CONSUME(LParen);
                this.AT_LEAST_ONE_SEP({
                  SEP: Comma,
                  DEF: () => this.SUBRULE(this.columnReference),
                });
                this.CONSUME(RParen);
              },
            },
          ]);
        });

        // ORGANIZE ON clause for Netezza
        this.RULE("organizeClause", () => {
          this.CONSUME(Organize);
          this.CONSUME(On);
          this.OR([
            { ALT: () => this.CONSUME(None) },
            {
              ALT: () => {
                this.CONSUME(LParen);
                this.AT_LEAST_ONE_SEP({
                  SEP: Comma,
                  DEF: () => this.SUBRULE(this.columnReference),
                });
                this.CONSUME(RParen);
              },
            },
          ]);
        });

        this.RULE("alterTableAction", () => {
          this.OR([
            {
              GATE: () =>
                this.LA(1).tokenType === Add &&
                this.LA(2).tokenType === Column,
              ALT: () => this.SUBRULE(this.alterTableAddColumnAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Add,
              ALT: () => this.SUBRULE(this.alterTableAddConstraintAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Alter,
              ALT: () => this.SUBRULE(this.alterTableAlterColumnAction),
            },
            {
              GATE: () =>
                this.LA(1).tokenType === Drop &&
                this.LA(2).tokenType === Constraint,
              ALT: () => this.SUBRULE(this.alterTableDropConstraintAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Drop,
              ALT: () => this.SUBRULE(this.alterTableDropColumnAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Modify,
              ALT: () => this.SUBRULE(this.alterTableModifyColumnAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Owner,
              ALT: () => this.SUBRULE(this.alterTableOwnerAction),
            },
            {
              GATE: () =>
                this.LA(1).tokenType === Rename &&
                this.LA(2).tokenType === To,
              ALT: () => this.SUBRULE(this.alterTableRenameTableAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Rename,
              ALT: () => this.SUBRULE(this.alterTableRenameColumnAction),
            },
            {
              GATE: () => this.LA(1).tokenType === Set,
              ALT: () => this.SUBRULE(this.alterTableSetPrivilegesAction),
            },
          ]);
        });

        this.RULE("alterTableAddColumnAction", () => {
          this.CONSUME(Add);
          this.CONSUME(Column);
          this.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => this.SUBRULE(this.columnDefinition),
          });
        });

        this.RULE("alterTableAddConstraintAction", () => {
          this.CONSUME(Add);
          this.SUBRULE(this.tableConstraintDefinition);
        });

        this.RULE("alterTableAlterColumnAction", () => {
          this.CONSUME(Alter);
          this.OPTION(() => this.CONSUME(Column));
          this.SUBRULE(this.columnName);
          this.OR([
            {
              ALT: () => {
                this.CONSUME(Set);
                this.CONSUME(Default);
                this.SUBRULE(this.additiveExpression);
              },
            },
            {
              ALT: () => {
                this.CONSUME(Drop);
                this.CONSUME1(Default);
              },
            },
          ]);
        });

        this.RULE("alterTableDropColumnAction", () => {
          this.CONSUME(Drop);
          this.OPTION(() => this.CONSUME(Column));
          this.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => this.SUBRULE(this.columnName),
          });
          this.OPTION1(() => this.SUBRULE(this.alterTableCascadeRestrictClause));
        });

        this.RULE("alterTableDropConstraintAction", () => {
          this.CONSUME(Drop);
          this.CONSUME(Constraint);
          this.SUBRULE(this.identifier);
          this.OPTION(() => this.SUBRULE(this.alterTableCascadeRestrictClause));
        });

        this.RULE("alterTableModifyColumnAction", () => {
          this.CONSUME(Modify);
          this.CONSUME(Column);
          this.CONSUME(LParen);
          this.SUBRULE(this.columnName);
          this.SUBRULE(this.typeName);
          this.CONSUME(RParen);
        });

        this.RULE("alterTableOwnerAction", () => {
          this.CONSUME(Owner);
          this.CONSUME(To);
          this.SUBRULE(this.identifier);
        });

        this.RULE("alterTableRenameColumnAction", () => {
          this.CONSUME(Rename);
          this.OPTION(() => this.CONSUME(Column));
          this.SUBRULE(this.columnName);
          this.CONSUME(To);
          this.SUBRULE1(this.columnName);
        });

        this.RULE("alterTableRenameTableAction", () => {
          this.CONSUME(Rename);
          this.CONSUME(To);
          this.SUBRULE(this.qualifiedName);
        });

        this.RULE("alterTableSetPrivilegesAction", () => {
          this.CONSUME(Set);
          this.CONSUME(Privileges);
          this.CONSUME(To);
          this.SUBRULE(this.qualifiedName);
        });

        this.RULE("alterTableCascadeRestrictClause", () => {
          this.OR([
            { ALT: () => this.CONSUME(Cascade) },
            { ALT: () => this.CONSUME(Restrict) },
          ]);
        });

        this.OVERRIDE_RULE("alterTableStatement", () => {
          this.CONSUME(Alter);
          this.CONSUME(Table);
          this.SUBRULE(this.qualifiedName);
          this.OPTION(() => this.SUBRULE(this.alterTableAction));
          this.OPTION1(() => this.SUBRULE(this.organizeClause));
        });
  }
}

export class SqlParser extends NetezzaSqlParser {}

let _sqlParserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
  return new SqlParser();
}

/**
 * Get the lazily-initialized parser singleton.
 * performSelfAnalysis() runs on first access only.
 */
export function getSqlParserInstance(): SqlParser {
  if (!_sqlParserInstance) {
    _sqlParserInstance = createSqlParserInstance();
  }
  return _sqlParserInstance;
}

/**
 * @deprecated Use getSqlParserInstance() for lazy initialization.
 */
export const sqlParser = {
  get input(): unknown[] {
    return getSqlParserInstance().input;
  },
  set input(val: unknown[]) {
    getSqlParserInstance().input = val as never;
  },
  get errors(): unknown[] {
    return getSqlParserInstance().errors;
  },
  set errors(val: unknown[]) {
    getSqlParserInstance().errors = val as never;
  },
  getBaseCstVisitorConstructor(): ReturnType<SqlParser['getBaseCstVisitorConstructor']> {
    return getSqlParserInstance().getBaseCstVisitorConstructor();
  },
  getBaseCstVisitorConstructorWithDefaults(): ReturnType<
    SqlParser['getBaseCstVisitorConstructorWithDefaults']
  > {
    return getSqlParserInstance().getBaseCstVisitorConstructorWithDefaults();
  },
  getSerializedGastProductions(): ReturnType<SqlParser['getSerializedGastProductions']> {
    return getSqlParserInstance().getSerializedGastProductions();
  },
} as unknown as SqlParser;
