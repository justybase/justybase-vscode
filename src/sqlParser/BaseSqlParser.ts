import { CstParser, type TokenType } from 'chevrotain';
import type * as NetezzaSqlLexerModule from '../dialects/netezza/sql/lexer';
import { registerQueryClauseComparisonRules } from './rules/queryClauseComparisonRules';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRule = () => any;

export type OrAlternative = { GATE?: () => boolean; ALT: () => void };
export type SqlParserTokenBundle = typeof NetezzaSqlLexerModule;

function shouldLogParserPerformance(): boolean {
  if (typeof process === "undefined" || !process.env) {
    return false;
  }

  return process.env.JUSTYBASE_PARSER_PERF === "1";
}

/**
 * Shared SQL grammar used by the compatibility parser and dialect-specific subclasses.
 * Future dialects should extend this class, register any dialect-only RULEs after calling
 * super(), override the hook methods they need, and call finalizeParser() exactly once.
 */
export class BaseSqlParser extends CstParser {
  // Declare dynamically created methods for TypeScript
  statements!: AnyRule;
  statement!: AnyRule;
  setStatement!: AnyRule;
  showStatement!: AnyRule;
  copyStatement!: AnyRule;
  lockStatement!: AnyRule;
  mergeStatement!: AnyRule;
  reindexStatement!: AnyRule;
  resetStatement!: AnyRule;
  beginStatement!: AnyRule;
  variableSetStatement!: AnyRule;
  createTableStatement!: AnyRule;
  createSequenceStatement!: AnyRule;
  createDatabaseStatement!: AnyRule;
  createGroupStatement!: AnyRule;
  createExternalTableStatement!: AnyRule;
  externalTableUsingClause!: AnyRule;
  externalTableOptionList!: AnyRule;
  externalTableOption!: AnyRule;
  externalTableOptionValue!: AnyRule;
  externalTableNumericValue!: AnyRule;
  externalTableParenthesizedValue!: AnyRule;
  externalTableParenthesizedElement!: AnyRule;
  createProcedureStatement!: AnyRule;
  createSynonymStatement!: AnyRule;
  createViewStatement!: AnyRule;
  viewColumnAliasList!: AnyRule;
  commentStatement!: AnyRule;
  alterTableStatement!: AnyRule;
  alterObjectStatement!: AnyRule;
  dropStatement!: AnyRule;
  truncateStatement!: AnyRule;
  explainStatement!: AnyRule;
  dropTargetList!: AnyRule;
  dropTarget!: AnyRule;
  commandTail!: AnyRule;
  commandTailToken!: AnyRule;
  groomStatement!: AnyRule;
  generateStatisticsStatement!: AnyRule;
  groomModeClause!: AnyRule;
  groomReclaimClause!: AnyRule;
  generateStatisticsColumnsClause!: AnyRule;
  distributeClause!: AnyRule;
  organizeClause!: AnyRule;
  withAnyStatement!: AnyRule;
  withStatement!: AnyRule;
  cteDefinition!: AnyRule;
  cteColumnList!: AnyRule;
  selectStatement!: AnyRule;
  setOperation!: AnyRule;
  selectClause!: AnyRule;
  intoClause!: AnyRule;
  selectModifier!: AnyRule;
  selectList!: AnyRule;
  selectItem!: AnyRule;
  starExpression!: AnyRule;
  fromClause!: AnyRule;
  tableReference!: AnyRule;
  tableSource!: AnyRule;
  tableName!: AnyRule;
  qualifiedName!: AnyRule;
  alias!: AnyRule;
  netezzaRelaxedName!: AnyRule;
  aliasOptional!: AnyRule;
  subquery!: AnyRule;
  joinClause!: AnyRule;
  whereClause!: AnyRule;
  groupByClause!: AnyRule;
  groupByElement!: AnyRule;
  groupingSetsExpression!: AnyRule;
  groupingSet!: AnyRule;
  havingClause!: AnyRule;
  orderByClause!: AnyRule;
  orderByItem!: AnyRule;
  limitClause!: AnyRule;
  fetchFirstClause!: AnyRule;
  parenthesizedSetStatement!: AnyRule;
  comparisonRhs!: AnyRule;
  expression!: AnyRule;
  orExpression!: AnyRule;
  andExpression!: AnyRule;
  notExpression!: AnyRule;
  comparisonExpression!: AnyRule;
  inExpression!: AnyRule;
  betweenExpression!: AnyRule;
  isExpression!: AnyRule;
  additiveExpression!: AnyRule;
  multiplicativeExpression!: AnyRule;
  unaryExpression!: AnyRule;
  castExpression!: AnyRule;
  primaryExpression!: AnyRule;
  sequenceValueExpression!: AnyRule;
  existsExpression!: AnyRule;
  expressionList!: AnyRule;
  literal!: AnyRule;
  typeLiteral!: AnyRule;
  columnReference!: AnyRule;
  functionCall!: AnyRule;
  functionArguments!: AnyRule;
  filterClause!: AnyRule;
  caseExpression!: AnyRule;
  overClause!: AnyRule;
  partitionByClause!: AnyRule;
  windowFrameClause!: AnyRule;
  frameBound!: AnyRule;
  excludeClause!: AnyRule;
  typeName!: AnyRule;
  typeNameWord!: AnyRule;
  typeArgument!: AnyRule;
  castFunctionExpression!: AnyRule;
  extractExpression!: AnyRule;
  procedureArguments!: AnyRule;
  procedureArgument!: AnyRule;
  procedureArgumentMode!: AnyRule;
  procedureReturnType!: AnyRule;
  procedureSignatureSpec!: AnyRule;
  executeAsClause!: AnyRule;
  procedureBody!: AnyRule;
  beginProcBody!: AnyRule;
  procedureBlock!: AnyRule;
  procedureLabel!: AnyRule;
  autocommitClause!: AnyRule;
  procedureDeclareSection!: AnyRule;
  variableDeclarations!: AnyRule;
  variableDeclaration!: AnyRule;
  procedureStatements!: AnyRule;
  procedureStatement!: AnyRule;
  assignmentStatement!: AnyRule;
  returnStatement!: AnyRule;
  ifStatement!: AnyRule;
  elsifClause!: AnyRule;
  loopStatement!: AnyRule;
  whileStatement!: AnyRule;
  forStatement!: AnyRule;
  exitStatement!: AnyRule;
  raiseStatement!: AnyRule;
  rollbackStatement!: AnyRule;
  commitStatement!: AnyRule;
  callStatement!: AnyRule;
  executeImmediateStatement!: AnyRule;
  performStatement!: AnyRule;
  arrayMethodStatement!: AnyRule;
  exceptionBlock!: AnyRule;
  whenClause!: AnyRule;
  insertStatement!: AnyRule;
  insertWithClause!: AnyRule;
  insertCteDefinition!: AnyRule;
  valuesClause!: AnyRule;
  updateStatement!: AnyRule;
  updateSetItem!: AnyRule;
  deleteStatement!: AnyRule;
  tempClause!: AnyRule;
  tableTypeClause!: AnyRule;
  columnDefinitionList!: AnyRule;
  columnOrConstraintDefinition!: AnyRule;
  tableConstraintDefinition!: AnyRule;
  columnDefinition!: AnyRule;
  columnName!: AnyRule;
  columnList!: AnyRule;
  constraintDefinition!: AnyRule;
  primaryKeyConstraint!: AnyRule;
  uniqueConstraint!: AnyRule;
  foreignKeyConstraint!: AnyRule;
  checkConstraint!: AnyRule;
  grantStatement!: AnyRule;
  revokeStatement!: AnyRule;
  createUserStatement!: AnyRule;
  identifier!: AnyRule;
  private _isFinalized = false;

  protected getAdditionalStatementAlternatives(): OrAlternative[] {
    return [];
  }

  protected getAdditionalTableSourceAlternatives(): OrAlternative[] {
    return [];
  }

  protected getAdditionalDropObjectAlternatives(): OrAlternative[] {
    return [];
  }

  protected getAdditionalExplainOptionAlternatives(): OrAlternative[] {
    return [];
  }

  protected registerCreateTableDialectClauses(): void {}

  protected supportsEmptyQualifiedNameSegment(): boolean {
    return false;
  }

  protected getTokenAlternatives(tokens: TokenType[]): OrAlternative[] {
    return tokens.map(token => ({ ALT: () => this.CONSUME(token) }));
  }

  protected finalizeParser(): void {
    if (this._isFinalized) {
      return;
    }

    const _perfStart = performance.now();
    this.performSelfAnalysis();
    if (shouldLogParserPerformance()) {
      console.log(
        `[perf] ${this.constructor.name}.performSelfAnalysis: ${(performance.now() - _perfStart).toFixed(1)}ms`,
      );
    }
    this._isFinalized = true;
  }

  constructor(protected readonly tokenBundle: SqlParserTokenBundle) {
    const {
      Select,
      From,
      Where,
      Insert,
      Into,
      Values,
      Update,
      Set,
      Delete,
      Join,
      Inner,
      Left,
      Right,
      Full,
      Outer,
      Cross,
      Natural,
      On,
      And,
      Or,
      Not,
      As,
      Distinct,
      All,
      Union,
      Intersect,
      Except,
      MinusSet,
      GroupBy,
      OrderBy,
      Having,
      Limit,
      Offset,
      Null,
      NotNull,
      Is,
      Like,
      Ilike,
      Escape,
      In,
      Between,
      Exists,
      Case,
      When,
      Then,
      Else,
      End,
      If,
      Elsif,
      Create,
      Materialized,
      Replace,
      Table,
      Procedure,
      Temp,
      Temporary,
      With,
      Final,
      Recursive,
      Distribute,
      Random,
      Asc,
      Desc,
      Nulls,
      Organize,
      Alter,
      View,
      Views,
      Comment,
      Column,
      Add,
      Constraint,
      Primary,
      Key,
      Foreign,
      References,
      Unique,
      Check,
      Global,
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
      Express,
      Statistics,
      For,
      Of,
      Returns,
      Language,
      Execute,
      Exec,
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
      Return,
      Alias,
      Constant,
      Loop,
      While,
      Exit,
      Raise,
      Notice,
      Debug,
      Error,
      Rollback,
      Commit,
      Call,
      Using,
      Database,
      Group,
      History,
      Configuration,
      Scheduler,
      Rule,
      Schema,
      Sequence,
      Session,
      Synonym,
      User,
      External,
      Grant,
      Revoke,
      To,
      Public,
      Type,
      Cascade,
      Restrict,
      SameAs,
      Hash,
      Deferrable,
      Initially,
      Drop,
      Truncate,
      Explain,
      Verbose,
      Distribution,
      Plantext,
      Plangraph,
      Show,
      Copy,
      Lock,
      Merge,
      Reindex,
      Reset,
      Over,
      PartitionBy,
      Rows,
      Range,
      Groups,
      Current,
      Row,
      Unbounded,
      Preceding,
      Following,
      Filter,
      Exclude,
      Ties,
      Extract,
      Cast,
      Fetch,
      First,
      Only,
      Any,
      Some,
      NumberLiteral,
      StringLiteral,
      DollarNumber,
      DollarIdentifier,
      BracedVariable,
      BracesOnlyVariable,
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
      Modulo,
      Caret,
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
      allTokens,
    } = tokenBundle;
    // The shared parser accepts a superset token bundle so dialect subclasses can reuse the same
    // contract even when the base grammar intentionally ignores dialect-only tokens.
    void [
      Elsif,
      Final,
      Distribute,
      Random,
      Organize,
      Views,
      Add,
      Groom,
      Versions,
      Records,
      Pages,
      Ready,
      Start,
      Reclaim,
      Backupset,
      None,
      Generate,
      Express,
      Statistics,
      For,
      Of,
      Returns,
      Language,
      Owner,
      Caller,
      RefTable,
      Varargs,
      Nzplsql,
      BeginProc,
      EndProc,
      Declare,
      Return,
      Alias,
      Constant,
      Loop,
      While,
      Exit,
      Raise,
      Notice,
      Debug,
      Error,
      History,
      Configuration,
      Scheduler,
      Rule,
      External,
      Public,
      Type,
      Cascade,
      Restrict,
      SameAs,
      Hash,
      Deferrable,
      Initially,
      Distribution,
      Plantext,
      Plangraph,
    ];
    // IMPORTANT: During development/tests we sometimes add or remove tokens and grammar rules.
    // The `skipValidations` option controls whether Chevrotain validates the token/grammar
    // configuration. By default we keep the original behavior (skip validations) to
    // avoid noisy errors in production-like runs. However, while running unit tests
    // that modify lexer/parser rules it's useful to run validations (set to false)
    // so problems are caught early.
    //
    // Usage for tests / CI:
    // - To enable validator checks during tests set `NODE_ENV=test` (then skipValidations=false).
    // - To explicitly override use `SQLPARSER_SKIP_VALIDATIONS=0|false` (disable skipping) or
    //   `SQLPARSER_SKIP_VALIDATIONS=1|true` (enable skipping).
    let skipValidations = false;
    if (typeof process !== "undefined" && process.env) {
      if (process.env.NODE_ENV === "test") {
        skipValidations = false;
      }
      if (process.env.SQLPARSER_SKIP_VALIDATIONS !== undefined) {
        const v = String(process.env.SQLPARSER_SKIP_VALIDATIONS).toLowerCase();
        if (v === "0" || v === "false") skipValidations = false;
        if (v === "1" || v === "true") skipValidations = true;
      }
    }

    super(allTokens, { skipValidations: skipValidations, maxLookahead: 3 });
    // ====================================================================
    // Top-level statements
    // ====================================================================

    this.RULE("statements", () => {
      // Allow leading empty statements (e.g. ";;SELECT 1;").
      this.MANY(() => {
        this.CONSUME(Semicolon);
      });
      // Parse statements separated by one or more semicolons.
      // Extra semicolons between statements are tolerated as empty statements.
      this.OPTION(() => {
        this.SUBRULE(this.statement);
        this.MANY1(() => {
          this.AT_LEAST_ONE(() => {
            this.CONSUME1(Semicolon);
          });
          this.OPTION1(() => {
            this.SUBRULE1(this.statement);
          });
        });
      });
    });

    this.RULE("statement", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.createTableStatement) },
        { ALT: () => this.SUBRULE(this.createSequenceStatement) },
        { ALT: () => this.SUBRULE(this.createDatabaseStatement) },
        { ALT: () => this.SUBRULE(this.createGroupStatement) },
        ...this.getAdditionalStatementAlternatives(),
        {
          GATE: () =>
            this.LA(2).tokenType === View ||
            (this.LA(2).tokenType === Materialized &&
              this.LA(3).tokenType === View) ||
            (this.LA(2).tokenType === Or &&
              this.LA(3).tokenType === Replace &&
              (this.LA(4).tokenType === View ||
                (this.LA(4).tokenType === Materialized &&
                  this.LA(5).tokenType === View))),
          ALT: () => this.SUBRULE(this.createViewStatement),
        },
        { ALT: () => this.SUBRULE(this.commentStatement) },
        { ALT: () => this.SUBRULE(this.alterTableStatement) },
        { ALT: () => this.SUBRULE(this.dropStatement) },
        { ALT: () => this.SUBRULE(this.truncateStatement) },
        { ALT: () => this.SUBRULE(this.explainStatement) },
        { ALT: () => this.SUBRULE(this.grantStatement) },
        { ALT: () => this.SUBRULE(this.revokeStatement) },
        { ALT: () => this.SUBRULE(this.showStatement) },
        { ALT: () => this.SUBRULE(this.copyStatement) },
        { ALT: () => this.SUBRULE(this.lockStatement) },
        { ALT: () => this.SUBRULE(this.mergeStatement) },
        { ALT: () => this.SUBRULE(this.reindexStatement) },
        { ALT: () => this.SUBRULE(this.resetStatement) },
        {
          GATE: () => this.LA(2).tokenType === User,
          ALT: () => this.SUBRULE(this.createUserStatement),
        },
        { ALT: () => this.SUBRULE(this.withAnyStatement) },
        {
          GATE: () =>
            this.LA(1).tokenType === LParen && this.LA(2).tokenType === Select,
          ALT: () => this.SUBRULE(this.parenthesizedSetStatement),
        },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
        { ALT: () => this.SUBRULE(this.commitStatement) },
        { ALT: () => this.SUBRULE(this.rollbackStatement) },
        {
          GATE: () =>
            this.LA(1).tokenType === Call ||
            (this.LA(1).tokenType === Exec &&
              this.LA(2).tokenType !== Immediate) ||
            (this.LA(1).tokenType === Execute &&
              this.LA(2).tokenType !== Immediate),
          ALT: () => this.SUBRULE(this.callStatement),
        },
        { ALT: () => this.SUBRULE(this.beginStatement) },
        { ALT: () => this.SUBRULE(this.setStatement) },
      ]);
    });
    this.RULE("setStatement", () => {
      this.CONSUME(Set);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("showStatement", () => {
      this.CONSUME(Show);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("copyStatement", () => {
      this.CONSUME(Copy);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("lockStatement", () => {
      this.CONSUME(Lock);
      this.CONSUME(Table);
      this.SUBRULE(this.qualifiedName);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });

    this.RULE("mergeStatement", () => {
      this.CONSUME(Merge);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("reindexStatement", () => {
      this.CONSUME(Reindex);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("resetStatement", () => {
      this.CONSUME(Reset);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("beginStatement", () => {
      this.CONSUME(Begin);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });

    this.RULE("createTableStatement", () => {
      this.CONSUME(Create);
      this.OPTION(() => this.SUBRULE(this.tableTypeClause));
      this.CONSUME(Table);
      // Optional IF NOT EXISTS
      this.OPTION6(() => {
        this.CONSUME(If);
        this.CONSUME(Not);
        this.CONSUME(Exists);
      });
      this.SUBRULE(this.qualifiedName); // table name (can be database.schema.table)

      // CREATE TABLE can be either CTAS or DDL with column definitions.
      this.OR([
        {
          ALT: () => {
            this.CONSUME(As);
            // Parentheses must be balanced when present.
            this.OR1([
              {
                ALT: () => {
                  this.CONSUME(LParen);
                  this.OR2([
                    { ALT: () => this.SUBRULE(this.withStatement) },
                    { ALT: () => this.SUBRULE(this.selectStatement) },
                  ]);
                  this.CONSUME(RParen);
                },
              },
              {
                ALT: () => {
                  this.OR3([
                    { ALT: () => this.SUBRULE1(this.withStatement) },
                    { ALT: () => this.SUBRULE1(this.selectStatement) },
                  ]);
                },
              },
            ]);
          },
        },
        {
          ALT: () => {
            this.CONSUME1(LParen);
            this.SUBRULE(this.columnDefinitionList);
            this.CONSUME1(RParen);
          },
        },
      ]);

      // Dialects inject trailing table options here so subclasses can add syntax
      // before performSelfAnalysis() locks the grammar.
      this.registerCreateTableDialectClauses();
    });
    this.RULE("createDatabaseStatement", () => {
      this.CONSUME(Create);
      this.CONSUME(Database);
      this.SUBRULE(this.identifier);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });

    this.RULE("createSequenceStatement", () => {
      this.CONSUME(Create);
      this.CONSUME(Sequence);
      this.SUBRULE(this.qualifiedName);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });

    this.RULE("createGroupStatement", () => {
      this.CONSUME(Create);
      this.CONSUME(Group);
      this.SUBRULE(this.identifier);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });
    this.RULE("rollbackStatement", () => {
      this.CONSUME(Rollback);
    });

    this.RULE("commitStatement", () => {
      this.CONSUME(Commit);
    });

    this.RULE("callStatement", () => {
      this.OR([
        { ALT: () => this.CONSUME(Call) },
        {
          GATE: () => this.LA(2).tokenType !== Immediate,
          ALT: () => {
            this.CONSUME(Exec);
            this.OPTION1(() => this.CONSUME1(Procedure));
          },
        },
        {
          GATE: () => this.LA(2).tokenType !== Immediate,
          ALT: () => {
            this.CONSUME(Execute);
            this.OPTION2(() => this.CONSUME2(Procedure));
          },
        },
      ]);
      this.SUBRULE(this.qualifiedName);
      this.OPTION3(() => {
        this.CONSUME(LParen);
        this.OPTION4(() => this.SUBRULE(this.functionArguments));
        this.CONSUME(RParen);
      });
    });
    this.RULE("createViewStatement", () => {
      this.CONSUME(Create);
      this.OPTION(() => {
        this.CONSUME(Or);
        this.CONSUME(Replace);
      });
      this.OPTION1(() => this.CONSUME(Materialized));
      this.CONSUME(View);
      this.SUBRULE(this.qualifiedName);
      this.OPTION2(() => this.SUBRULE(this.viewColumnAliasList));
      this.CONSUME(As);
      this.OR([
        {
          ALT: () => {
            this.CONSUME(LParen);
            this.OR1([
              { ALT: () => this.SUBRULE(this.withStatement) },
              { ALT: () => this.SUBRULE(this.selectStatement) },
            ]);
            this.CONSUME(RParen);
          },
        },
        {
          ALT: () => {
            this.OR2([
              { ALT: () => this.SUBRULE1(this.withStatement) },
              { ALT: () => this.SUBRULE1(this.selectStatement) },
            ]);
          },
        },
      ]);
    });

    this.RULE("viewColumnAliasList", () => {
      this.CONSUME(LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.identifier),
      });
      this.CONSUME(RParen);
    });

    this.RULE("commentStatement", () => {
      this.CONSUME(Comment);
      this.CONSUME(On);
      this.OR([
        {
          ALT: () => {
            this.OR1([
              { ALT: () => this.CONSUME(Table) },
              { ALT: () => this.CONSUME(View) },
            ]);
            this.SUBRULE(this.qualifiedName);
            this.CONSUME(Is);
            this.CONSUME(StringLiteral);
          },
        },
        {
          ALT: () => {
            this.CONSUME(Procedure);
            this.SUBRULE1(this.qualifiedName);
            this.OPTION(() => {
              this.CONSUME(LParen);
              this.OPTION1(() => {
                this.AT_LEAST_ONE_SEP({
                  SEP: Comma,
                  DEF: () => this.SUBRULE(this.typeName),
                });
              });
              this.CONSUME(RParen);
            });
            this.CONSUME1(Is);
            this.CONSUME1(StringLiteral);
          },
        },
        {
          ALT: () => {
            this.CONSUME(Column);
            this.SUBRULE2(this.qualifiedName);
            this.CONSUME(Dot);
            this.SUBRULE2(this.identifier);
            this.CONSUME2(Is);
            this.CONSUME2(StringLiteral);
          },
        },
      ]);
    });

    this.RULE("alterTableStatement", () => {
      this.CONSUME(Alter);
      this.CONSUME(Table);
      this.SUBRULE(this.qualifiedName);
      this.SUBRULE(this.commandTail);
    });

    this.RULE("dropStatement", () => {
      this.CONSUME(Drop);
      this.OR([
        { ALT: () => this.CONSUME(Table) },
        { ALT: () => this.CONSUME(View) },
        { ALT: () => this.CONSUME(Procedure) },
        { ALT: () => this.CONSUME(Database) },
        { ALT: () => this.CONSUME(Group) },
        { ALT: () => this.CONSUME(Schema) },
        { ALT: () => this.CONSUME(Sequence) },
        { ALT: () => this.CONSUME(Session) },
        { ALT: () => this.CONSUME(Synonym) },
        { ALT: () => this.CONSUME(User) },
        ...this.getAdditionalDropObjectAlternatives(),
      ]);
      this.SUBRULE(this.dropTargetList);
      this.OPTION(() => {
        this.OR1([
          {
            GATE: () => this.LA(1).tokenType === If,
            ALT: () => {
              this.CONSUME(If);
              this.CONSUME(Exists);
            },
          },
          {
            GATE: () => this.LA(1).tokenType !== If,
            ALT: () => this.SUBRULE(this.commandTail),
          },
        ]);
      });
    });
    this.RULE("dropTargetList", () => {
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.dropTarget),
      });
    });

    this.RULE("dropTarget", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.qualifiedName) },
        { ALT: () => this.CONSUME(NumberLiteral) },
      ]);
    });

    this.RULE("truncateStatement", () => {
      this.CONSUME(Truncate);
      this.OPTION(() => this.CONSUME(Table));
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => this.SUBRULE(this.commandTail));
    });

    this.RULE("explainStatement", () => {
      this.CONSUME(Explain);
      this.MANY(() => {
        this.OR([
          { ALT: () => this.CONSUME(Verbose) },
          ...this.getAdditionalExplainOptionAlternatives(),
        ]);
      });
      this.SUBRULE(this.commandTail);
    });
    this.RULE("commandTail", () => {
      this.AT_LEAST_ONE(() => this.SUBRULE(this.commandTailToken));
    });

    this.RULE("commandTailToken", () => {
      this.OR([
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
        { ALT: () => this.CONSUME(LParen) },
        { ALT: () => this.CONSUME(RParen) },
        { ALT: () => this.CONSUME(LBracket) },
        { ALT: () => this.CONSUME(RBracket) },
      ]);
    });

    this.RULE("constraintDefinition", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.primaryKeyConstraint) },
        { ALT: () => this.SUBRULE(this.uniqueConstraint) },
        { ALT: () => this.SUBRULE(this.foreignKeyConstraint) },
        { ALT: () => this.SUBRULE(this.checkConstraint) },
      ]);
    });

    this.RULE("primaryKeyConstraint", () => {
      this.CONSUME(Primary);
      this.CONSUME(Key);
      this.OPTION(() => this.SUBRULE(this.columnList));
    });

    this.RULE("uniqueConstraint", () => {
      this.CONSUME(Unique);
      this.OPTION(() => this.SUBRULE(this.columnList));
    });

    this.RULE("foreignKeyConstraint", () => {
      this.OPTION(() => {
        this.CONSUME(Foreign);
        this.CONSUME(Key);
        this.OPTION1(() => this.SUBRULE(this.columnList));
      });
      this.CONSUME(References);
      this.SUBRULE(this.qualifiedName);
      this.OPTION2(() => this.SUBRULE1(this.columnList));
    });

    this.RULE("checkConstraint", () => {
      this.CONSUME(Check);
      this.CONSUME(LParen);
      this.SUBRULE(this.expression);
      this.CONSUME(RParen);
    });

    this.RULE("columnList", () => {
      this.CONSUME(LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.identifier),
      });
      this.CONSUME(RParen);
    });

    // ====================================================================
    // GRANT statement
    // ====================================================================
    this.RULE("grantStatement", () => {
      this.CONSUME(Grant);
      this.SUBRULE(this.commandTail);
    });

    // ====================================================================
    // REVOKE statement
    // ====================================================================
    this.RULE("revokeStatement", () => {
      this.CONSUME(Revoke);
      this.SUBRULE(this.commandTail);
    });

    // ====================================================================
    // CREATE USER statement
    // ====================================================================
    this.RULE("createUserStatement", () => {
      this.CONSUME(Create);
      this.CONSUME(User);
      this.SUBRULE(this.identifier);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });
    // Helper rule for TEMP/TEMPORARY / GLOBAL TEMP
    this.RULE("tableTypeClause", () => {
      this.OPTION(() => this.CONSUME(Global));
      this.OR([
        { ALT: () => this.CONSUME(Temp) },
        { ALT: () => this.CONSUME(Temporary) },
      ]);
    });

    // Back-compat helper
    this.RULE("tempClause", () => {
      this.OR([
        { ALT: () => this.CONSUME(Temp) },
        { ALT: () => this.CONSUME(Temporary) },
      ]);
    });

    // Column definitions for CREATE TABLE (...).
    // Can contain column definitions and table-level constraints.
    this.RULE("columnDefinitionList", () => {
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.columnOrConstraintDefinition),
      });
    });

    this.RULE("columnOrConstraintDefinition", () => {
      this.OR([
        {
          GATE: () => {
            const la1 = this.LA(1).tokenType;
            return (
              la1 === Primary ||
              la1 === Unique ||
              la1 === Foreign ||
              la1 === Check ||
              (la1 === Constraint &&
                (this.LA(3).tokenType === Primary ||
                  this.LA(3).tokenType === Unique ||
                  this.LA(3).tokenType === Foreign ||
                  this.LA(3).tokenType === Check))
            );
          },
          ALT: () => this.SUBRULE(this.tableConstraintDefinition),
        },
        { ALT: () => this.SUBRULE(this.columnDefinition) },
      ]);
    });

    this.RULE("tableConstraintDefinition", () => {
      this.OPTION(() => {
        this.CONSUME(Constraint);
        this.SUBRULE(this.identifier);
      });
      this.SUBRULE(this.constraintDefinition);
    });

    this.RULE("columnDefinition", () => {
      this.SUBRULE(this.columnName);
      this.SUBRULE(this.typeName);
      this.MANY(() => {
        this.OR([
          {
            ALT: () => {
              this.CONSUME(Constraint);
              this.SUBRULE(this.identifier);
              this.OR1([
                {
                  ALT: () => {
                    this.CONSUME(Not);
                    this.CONSUME(Null);
                  },
                },
                { ALT: () => this.CONSUME1(Null) },
                {
                  ALT: () => {
                    this.CONSUME(Default);
                    this.SUBRULE(this.additiveExpression);
                  },
                },
                { ALT: () => this.SUBRULE(this.constraintDefinition) },
              ]);
            },
          },
          {
            ALT: () => {
              this.CONSUME1(Not);
              this.CONSUME2(Null);
            },
          },
          { ALT: () => this.CONSUME3(Null) },
          {
            ALT: () => {
              this.CONSUME1(Default);
              this.SUBRULE1(this.additiveExpression);
            },
          },
          { ALT: () => this.SUBRULE1(this.constraintDefinition) },
        ]);
      });
    });

    this.RULE("columnName", () => {
      this.SUBRULE(this.identifier);
    });

    // ====================================================================
    // WITH clause (CTEs)
    // ====================================================================

    this.RULE("withAnyStatement", () => {
      this.CONSUME(With);
      this.OPTION(() => this.CONSUME(Recursive));
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.cteDefinition);
        },
      });
      this.OR([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
      ]);
    });

    this.RULE("withStatement", () => {
      this.CONSUME(With);
      this.OPTION(() => this.CONSUME(Recursive));
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.cteDefinition);
        },
      });
      this.SUBRULE(this.selectStatement);
    });

    this.RULE("cteDefinition", () => {
      this.CONSUME(Identifier);
      this.OPTION(() => this.SUBRULE(this.cteColumnList));
      this.CONSUME(As);
      this.OPTION1(() => this.CONSUME(All));
      this.CONSUME(LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
      ]);
      this.CONSUME(RParen);
    });

    this.RULE("cteColumnList", () => {
      this.CONSUME(LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.identifier),
      });
      this.CONSUME(RParen);
    });

    // ====================================================================
    // SELECT statement
    // ====================================================================

    this.RULE("selectStatement", () => {
      this.SUBRULE(this.selectClause);
      this.OPTION(() => this.SUBRULE(this.fromClause));
      this.OPTION1(() => this.SUBRULE(this.whereClause));
      this.OPTION2(() => this.SUBRULE(this.groupByClause));
      this.OPTION3(() => this.SUBRULE(this.havingClause));
      this.OPTION4(() => this.SUBRULE(this.orderByClause));
      this.OPTION5(() => this.SUBRULE(this.limitClause));
      this.OPTION6(() => this.SUBRULE(this.fetchFirstClause));
      this.MANY(() => {
        this.SUBRULE(this.setOperation);
        this.OR7([
          {
            ALT: () => {
              this.CONSUME(LParen);
              this.OR8([
                { ALT: () => this.SUBRULE1(this.withStatement) },
                { ALT: () => this.SUBRULE1(this.selectStatement) },
              ]);
              this.CONSUME(RParen);
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

    this.RULE("setOperation", () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(Union);
            this.OPTION(() => this.CONSUME(All));
          },
        },
        { ALT: () => this.CONSUME(Intersect) },
        { ALT: () => this.CONSUME(Except) },
        { ALT: () => this.CONSUME(MinusSet) },
      ]);
    });

    // (SELECT ...) UNION (SELECT ...) — parenthesized set operations
    this.RULE("parenthesizedSetStatement", () => {
      this.CONSUME(LParen);
      this.SUBRULE(this.selectStatement);
      this.CONSUME(RParen);
      this.AT_LEAST_ONE(() => {
        this.SUBRULE(this.setOperation);
        this.OR([
          {
            ALT: () => {
              this.CONSUME1(LParen);
              this.SUBRULE1(this.selectStatement);
              this.CONSUME1(RParen);
            },
          },
          { ALT: () => this.SUBRULE2(this.selectStatement) },
        ]);
      });
    });

    this.RULE("selectClause", () => {
      this.CONSUME(Select);
      this.OPTION(() => this.SUBRULE(this.selectModifier));
      this.SUBRULE(this.selectList);
      this.OPTION1(() => this.SUBRULE(this.intoClause));
    });

    this.RULE("intoClause", () => {
      this.CONSUME(Into);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.identifier),
      });
    });

    this.RULE("selectModifier", () => {
      this.OR([
        { ALT: () => this.CONSUME(Distinct) },
        { ALT: () => this.CONSUME(All) },
      ]);
    });

    this.RULE("selectList", () => {
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.selectItem);
        },
      });
    });

    this.RULE("selectItem", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.starExpression) },
        { ALT: () => this.SUBRULE(this.expression) },
      ]);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
    });

    this.RULE("starExpression", () => {
      // Handle: * or table.*
      this.OPTION(() => {
        this.CONSUME(Identifier);
        this.CONSUME(Dot);
      });
      this.CONSUME(Multiply);
    });

    // ====================================================================
    // FROM clause
    // ====================================================================

    this.RULE("fromClause", () => {
      this.CONSUME(From);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.tableReference);
        },
      });
    });

    this.RULE("tableReference", () => {
      this.SUBRULE(this.tableSource);
      this.MANY(() => this.SUBRULE(this.joinClause));
    });

    this.RULE("tableSource", () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.subquery) },
        ...this.getAdditionalTableSourceAlternatives(),
        { ALT: () => this.SUBRULE(this.tableName) },
      ]);
      // Alias can be with or without AS keyword
      this.OPTION({
        GATE: () => {
          const token1 = this.LA(1).tokenType;
          const token2 = this.LA(2).tokenType;
          const token3 = this.LA(3).tokenType;
          if (token1 === Join || token1 === Natural) {
            return false;
          }
          if (
            token1 === Inner ||
            token1 === Left ||
            token1 === Right ||
            token1 === Full ||
            token1 === Cross
          ) {
            return token2 !== Join && !(token2 === Outer && token3 === Join);
          }
          return true;
        },
        DEF: () => this.SUBRULE(this.aliasOptional),
      });
    });
    // Table name with optional schema and database qualifiers.
    this.RULE("tableName", () => {
      this.SUBRULE(this.qualifiedName);
    });
    // Identifier rule that accepts both Identifier tokens and keywords
    this.RULE("identifier", () => {
      this.OR([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
      ]);
    });

    // Qualified name: handles database.schema.table, schema.table, or table.
    // Dialects can opt into database..table style names via supportsEmptyQualifiedNameSegment().
    this.RULE("qualifiedName", () => {
      this.SUBRULE(this.identifier);
      this.OPTION(() => {
        this.CONSUME(Dot);
        if (this.supportsEmptyQualifiedNameSegment()) {
          this.OPTION1(() => this.SUBRULE1(this.identifier));
        } else {
          this.SUBRULE1(this.identifier);
        }
        this.OPTION2(() => {
          this.CONSUME1(Dot);
          this.SUBRULE2(this.identifier);
        });
      });
    });
    // Alias with optional AS keyword
    this.RULE("aliasOptional", () => {
      this.OPTION(() => this.CONSUME(As));
      this.SUBRULE(this.alias);
    });

    this.RULE("alias", () => {
      this.OR([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
      ]);
    });

    // Subquery with optional alias
    this.RULE("subquery", () => {
      this.CONSUME(LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.withStatement) },
      ]);
      this.CONSUME(RParen);
    });

    // ====================================================================
    // JOIN clause
    // ====================================================================

    this.RULE("joinClause", () => {
      let isNaturalJoin = false;
      this.OPTION(() => {
        this.CONSUME(Natural);
        isNaturalJoin = true;
      });
      // Join type (optional - defaults to INNER)
      this.OPTION1(() =>
        this.OR1([
          { ALT: () => this.CONSUME(Inner) },
          { ALT: () => this.CONSUME(Left) },
          { ALT: () => this.CONSUME(Right) },
          { ALT: () => this.CONSUME(Full) },
          { ALT: () => this.CONSUME(Cross) },
        ]),
      );
      this.OPTION2(() => this.CONSUME(Outer));
      this.CONSUME(Join);
      this.SUBRULE(this.tableSource);
      // ON/USING clause (not allowed for NATURAL JOIN)
      this.OPTION3({
        GATE: () => !isNaturalJoin,
        DEF: () =>
          this.OR2([
            {
              ALT: () => {
                this.CONSUME(On);
                this.SUBRULE(this.expression);
              },
            },
            {
              ALT: () => {
                this.CONSUME(Using);
                this.SUBRULE(this.columnList);
              },
            },
          ]),
      });
    });

    // ====================================================================
    // WHERE clause
    // ====================================================================

    this.RULE("whereClause", () => {
      this.CONSUME(Where);
      this.SUBRULE(this.expression);
    });

    // ====================================================================
    // GROUP BY clause
    // ====================================================================

    this.RULE("groupByClause", () => {
      this.CONSUME(GroupBy);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.groupByElement);
        },
      });
    });

    this.RULE("groupByElement", () => {
      this.OR([
        {
          GATE: () =>
            this.LA(1).tokenType === Identifier &&
            this.LA(1).image.toUpperCase() === "GROUPING" &&
            this.LA(2).tokenType === Identifier &&
            this.LA(2).image.toUpperCase() === "SETS",
          ALT: () => this.SUBRULE(this.groupingSetsExpression),
        },
        { ALT: () => this.SUBRULE(this.expression) },
      ]);
    });

    this.RULE("groupingSetsExpression", () => {
      this.CONSUME(Identifier); // GROUPING
      this.CONSUME1(Identifier); // SETS
      this.CONSUME(LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.groupingSet),
      });
      this.CONSUME(RParen);
    });

    this.RULE("groupingSet", () => {
      this.CONSUME(LParen);
      this.OPTION(() => {
        this.AT_LEAST_ONE_SEP({
          SEP: Comma,
          DEF: () => this.SUBRULE(this.expression),
        });
      });
      this.CONSUME(RParen);
    });

    // ====================================================================
    // HAVING clause
    // ====================================================================

    this.RULE("havingClause", () => {
      this.CONSUME(Having);
      this.SUBRULE(this.expression);
    });

    // ====================================================================
    // ORDER BY + expression/comparison clauses
    // ====================================================================
    registerQueryClauseComparisonRules(this, {
      OrderBy,
      Comma,
      Asc,
      Desc,
      Nulls,
      First,
      Identifier,
      Limit,
      NumberLiteral,
      Offset,
      Fetch,
      Rows,
      Row,
      Only,
      Or,
      And,
      Not,
      Equals,
      NotEquals,
      LessThan,
      GreaterThan,
      LessThanEquals,
      GreaterThanEquals,
      Like,
      Ilike,
      In,
      Between,
      Is,
      Null,
      NotNull,
      Escape,
      Any,
      Some,
      All,
      LParen,
      RParen,
    });

    this.RULE("additiveExpression", () => {
      this.SUBRULE(this.multiplicativeExpression);
      this.MANY(() => {
        this.OR([
          { ALT: () => this.CONSUME(Plus) },
          { ALT: () => this.CONSUME(Minus) },
          { ALT: () => this.CONSUME(Concat) },
        ]);
        this.SUBRULE1(this.multiplicativeExpression);
      });
    });

    this.RULE("multiplicativeExpression", () => {
      this.SUBRULE(this.unaryExpression);
      this.MANY(() => {
        this.OR([
          { ALT: () => this.CONSUME(Multiply) },
          { ALT: () => this.CONSUME(Divide) },
          { ALT: () => this.CONSUME(Modulo) },
          { ALT: () => this.CONSUME(Caret) },
        ]);
        this.SUBRULE1(this.unaryExpression);
      });
    });

    this.RULE("unaryExpression", () => {
      this.OPTION(() =>
        this.OR1([
          { ALT: () => this.CONSUME(Plus) },
          { ALT: () => this.CONSUME(Minus) },
        ]),
      );
      this.SUBRULE(this.castExpression);
    });

    this.RULE("castExpression", () => {
      this.SUBRULE(this.primaryExpression);
      this.MANY(() => {
        this.CONSUME(DoubleColon);
        this.SUBRULE(this.typeName);
      });
    });

    this.RULE("primaryExpression", () => {
      this.OR([
        {
          GATE: () => {
            const la1 = this.LA(1);
            const la2 = this.LA(2);
            return (
              la1.tokenType === NumberLiteral ||
              la1.tokenType === BracedVariable ||
              la1.tokenType === BracesOnlyVariable ||
              la1.tokenType === DollarNumber ||
              la1.tokenType === DollarIdentifier ||
              la1.tokenType === StringLiteral ||
              la1.tokenType === Null ||
              la1.tokenType === StringLiteral ||
              (la1.tokenType === Identifier &&
                la2.tokenType === StringLiteral) ||
              (la1.tokenType === QuotedIdentifier &&
                la2.tokenType === StringLiteral)
            );
          },
          ALT: () => this.SUBRULE(this.literal),
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

    this.RULE("existsExpression", () => {
      this.CONSUME(Exists);
      this.SUBRULE(this.subquery);
    });

    this.RULE("typeName", () => {
      // Support multi-word types (e.g. NATIONAL CHARACTER VARYING(43)).
      this.AT_LEAST_ONE(() => this.SUBRULE(this.typeNameWord));
      this.OPTION(() => {
        this.CONSUME(LParen);
        this.AT_LEAST_ONE_SEP({
          SEP: Comma,
          DEF: () => this.SUBRULE(this.typeArgument),
        });
        this.CONSUME(RParen);
      });
    });

    this.RULE("typeNameWord", () => {
      this.OR([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
        { ALT: () => this.CONSUME(To) },
      ]);
    });

    this.RULE("typeArgument", () => {
      this.OR([
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
      ]);
    });

    this.RULE("expressionList", () => {
      this.CONSUME(LParen);
      this.SUBRULE(this.expression);
      this.MANY(() => {
        this.CONSUME(Comma);
        this.SUBRULE1(this.expression);
      });
      this.CONSUME(RParen);
    });

    this.RULE("literal", () => {
      this.OR([
        { ALT: () => this.CONSUME(NumberLiteral) },
        { ALT: () => this.CONSUME(BracedVariable) },
        { ALT: () => this.CONSUME(BracesOnlyVariable) },
        { ALT: () => this.CONSUME(DollarNumber) },
        { ALT: () => this.CONSUME(DollarIdentifier) },
        {
          GATE: () => {
            const next = this.LA(2);
            return next.tokenType === StringLiteral;
          },
          ALT: () => this.SUBRULE(this.typeLiteral),
        },
        { ALT: () => this.CONSUME(StringLiteral) },
        { ALT: () => this.CONSUME(Null) },
      ]);
    });

    this.RULE("typeLiteral", () => {
      this.SUBRULE(this.typeName);
      this.CONSUME(StringLiteral);
    });

    // Column reference: col or table.col or schema.table.col
    this.RULE("columnReference", () => {
      this.OR([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
      ]);
      this.OPTION({
        GATE: () =>
          this.LA(1).tokenType === Dot && this.LA(2).tokenType !== Dot,
        DEF: () => {
          this.CONSUME(Dot);
          this.OR1([
            { ALT: () => this.CONSUME1(Identifier) },
            { ALT: () => this.CONSUME1(QuotedIdentifier) },
          ]);
          this.MANY(() => {
            this.CONSUME1(Dot);
            this.OR2([
              { ALT: () => this.CONSUME2(Identifier) },
              { ALT: () => this.CONSUME2(QuotedIdentifier) },
            ]);
          });
        },
      });
    });

    this.RULE("functionCall", () => {
      this.OR1([
        { ALT: () => this.CONSUME(Identifier) },
        { ALT: () => this.CONSUME(QuotedIdentifier) },
      ]);
      this.CONSUME(LParen);
      this.OPTION(() => {
        this.OR2([
          { ALT: () => this.CONSUME(Distinct) },
          { ALT: () => this.CONSUME(All) },
        ]);
      });
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.overClause));
    });

    this.RULE("functionArguments", () => {
      this.OR([
        { ALT: () => this.CONSUME(Multiply) }, // COUNT(*)
        {
          ALT: () => {
            this.AT_LEAST_ONE_SEP({
              SEP: Comma,
              DEF: () => {
                this.SUBRULE(this.expression);
              },
            });
          },
        },
      ]);
    });

    this.RULE("filterClause", () => {
      this.CONSUME(Filter);
      this.CONSUME(LParen);
      this.CONSUME(Where);
      this.SUBRULE(this.expression);
      this.CONSUME(RParen);
    });

    this.RULE("overClause", () => {
      this.CONSUME(Over);
      this.CONSUME(LParen);
      this.OPTION(() => this.SUBRULE(this.partitionByClause));
      this.OPTION1(() => this.SUBRULE(this.orderByClause));
      this.OPTION2(() => this.SUBRULE(this.windowFrameClause));
      this.CONSUME(RParen);
    });

    this.RULE("partitionByClause", () => {
      this.CONSUME(PartitionBy);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.expression),
      });
    });

    this.RULE("windowFrameClause", () => {
      this.OR([
        { ALT: () => this.CONSUME(Rows) },
        { ALT: () => this.CONSUME(Range) },
        { ALT: () => this.CONSUME(Groups) },
      ]);
      this.OR1([
        {
          ALT: () => {
            this.CONSUME(Between);
            this.SUBRULE(this.frameBound);
            this.CONSUME(And);
            this.SUBRULE1(this.frameBound);
          },
        },
        { ALT: () => this.SUBRULE2(this.frameBound) },
      ]);
      this.OPTION(() => this.SUBRULE(this.excludeClause));
    });

    this.RULE("frameBound", () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(Unbounded);
            this.OR1([
              { ALT: () => this.CONSUME(Preceding) },
              { ALT: () => this.CONSUME(Following) },
            ]);
          },
        },
        {
          ALT: () => {
            this.CONSUME(Current);
            this.CONSUME(Row);
          },
        },
        {
          ALT: () => {
            this.CONSUME(NumberLiteral);
            this.OR2([
              { ALT: () => this.CONSUME1(Preceding) },
              { ALT: () => this.CONSUME1(Following) },
            ]);
          },
        },
      ]);
    });

    this.RULE("excludeClause", () => {
      this.CONSUME(Exclude);
      this.OR([
        {
          ALT: () => {
            this.CONSUME(Current);
            this.CONSUME(Row);
          },
        },
        { ALT: () => this.CONSUME(Group) },
        { ALT: () => this.CONSUME(Ties) },
      ]);
    });

    this.RULE("castFunctionExpression", () => {
      this.CONSUME(Cast);
      this.CONSUME(LParen);
      this.SUBRULE(this.expression);
      this.CONSUME(As);
      this.SUBRULE(this.typeName);
      this.CONSUME(RParen);
    });

    this.RULE("extractExpression", () => {
      this.CONSUME(Extract);
      this.CONSUME(LParen);
      this.CONSUME(Identifier);
      this.CONSUME(From);
      this.SUBRULE(this.expression);
      this.CONSUME(RParen);
    });

    this.RULE("caseExpression", () => {
      this.CONSUME(Case);
      this.OPTION(() => this.SUBRULE(this.expression)); // Simple CASE
      this.AT_LEAST_ONE(() => {
        this.CONSUME(When);
        this.SUBRULE1(this.expression);
        this.CONSUME(Then);
        this.SUBRULE2(this.expression);
      });
      this.OPTION1(() => {
        this.CONSUME(Else);
        this.SUBRULE3(this.expression);
      });
      this.CONSUME(End);
    });

    // ====================================================================
    // INSERT statement
    // ====================================================================

    this.RULE("insertStatement", () => {
      this.CONSUME(Insert);
      this.CONSUME(Into);
      this.SUBRULE(this.tableName);
      this.OPTION(() => {
        this.CONSUME(LParen);
        this.AT_LEAST_ONE_SEP({
          SEP: Comma,
          DEF: () => this.CONSUME(Identifier),
        });
        this.CONSUME(RParen);
      });
      this.OR([
        { ALT: () => this.SUBRULE(this.valuesClause) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertWithClause) },
      ]);
    });

    this.RULE("insertWithClause", () => {
      this.CONSUME(With);
      this.OPTION(() => this.CONSUME(Recursive));
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => this.SUBRULE(this.insertCteDefinition),
      });
      this.SUBRULE(this.selectStatement);
    });

    this.RULE("insertCteDefinition", () => {
      this.CONSUME(Identifier);
      this.OPTION({
        GATE: () =>
          this.LA(1).tokenType === LParen &&
          this.LA(2).tokenType !== Select &&
          this.LA(2).tokenType !== With &&
          this.LA(2).tokenType !== Recursive,
        DEF: () => this.SUBRULE(this.cteColumnList),
      });
      this.OPTION1(() => this.CONSUME(As));
      this.CONSUME(LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
      ]);
      this.CONSUME(RParen);
    });

    this.RULE("valuesClause", () => {
      this.CONSUME(Values);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.CONSUME(LParen);
          this.AT_LEAST_ONE_SEP1({
            SEP: Comma,
            DEF: () => this.SUBRULE(this.expression),
          });
          this.CONSUME(RParen);
        },
      });
    });

    // ====================================================================
    // UPDATE statement
    // ====================================================================

    this.RULE("updateStatement", () => {
      this.CONSUME(Update);
      this.SUBRULE(this.tableName);
      // Optional alias (with or without AS)
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(Set);
      this.AT_LEAST_ONE_SEP({
        SEP: Comma,
        DEF: () => {
          this.SUBRULE(this.updateSetItem);
        },
      });
      // Optional FROM clause (Netezza/T-SQL UPDATE...FROM syntax)
      this.OPTION1(() => this.SUBRULE(this.fromClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
    });

    this.RULE("updateSetItem", () => {
      this.SUBRULE(this.columnReference);
      this.CONSUME(Equals);
      this.SUBRULE(this.expression);
    });

    // ====================================================================
    // DELETE statement
    // ====================================================================

    this.RULE("deleteStatement", () => {
      this.CONSUME(Delete);
      this.CONSUME(From);
      this.SUBRULE(this.tableName);
      // Optional alias (with or without AS)
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => this.SUBRULE(this.whereClause));
    });

  }
}
