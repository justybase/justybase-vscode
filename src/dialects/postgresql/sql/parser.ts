import { tokenMatcher, type CstNode, type TokenType } from 'chevrotain';
import { BaseSqlParser } from '../../../sqlParser/BaseSqlParser';
import * as t from './lexer';

type Rule = () => CstNode;

/** PostgreSQL rules keep shared CST names without inheriting Netezza grammar. */
export class PostgreSqlParser extends BaseSqlParser {
  declare postgresqlReturning: Rule;
  declare postgresqlOnConflict: Rule;
  declare arrayExpression: Rule;
  declare postgresqlPostfixExpression: Rule;
  declare postgresqlJsonExpression: Rule;
  declare postgresqlWindowClause: Rule;
  declare postgresqlWindowSpec: Rule;
  declare postgresqlValuesQuery: Rule;
  declare postgresqlUsingClause: Rule;
  declare postgresqlTransaction: Rule;
  declare postgresqlCreateRoutine: Rule;
  declare postgresqlDoStatement: Rule;
  declare postgresqlCreateType: Rule;
  declare postgresqlCreateIndex: Rule;
  declare postgresqlMergeWhen: Rule;
  declare postgresqlJsonTable: Rule;
  declare postgresqlRoutineArgument: Rule;
  declare postgresqlAtomicBody: Rule;
  declare postgresqlAlterAction: Rule;
  declare postgresqlTableOption: Rule;

  constructor() {
    super(t);
    this.registerPostgresqlRules();
    this.registerAdvancedPostgresqlRules();
    this.finalizeParser();
  }

  protected supportsDropIfExistsBeforeTarget(): boolean { return true; }
  protected supportsStandaloneOffsetClause(): boolean { return true; }

  protected getForeignKeyActions(): readonly string[] { return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']; }

  protected registerCreateTableDialectClauses(): void {
    this.MANY(() => this.SUBRULE(this.postgresqlTableOption));
  }

  private functionAhead(): boolean {
    let i = 1;
    while (i < 12) {
      if (this.LA(i + 1).tokenType === t.LParen) return true;
      if (this.LA(i + 1).tokenType !== t.Dot) return false;
      i += 2;
    }
    return false;
  }


  private registerAdvancedPostgresqlRules(): void {
    this.RULE('postgresqlTableOption', () => this.OR([
      { ALT: () => {
        this.CONSUME(t.PartitionBy);
        this.OR1([
          { ALT: () => this.CONSUME(t.Range) },
          { ALT: () => this.CONSUME(t.Hash) },
          { GATE: () => this.LA(1).image.toUpperCase() === 'LIST', ALT: () => this.CONSUME(t.Identifier) },
        ]);
        this.SUBRULE(this.columnList);
      } },
      { GATE: () => this.LA(1).image.toUpperCase() === 'TABLESPACE', ALT: () => {
        this.CONSUME1(t.Identifier); this.SUBRULE(this.identifier);
      } },
      { ALT: () => {
        this.CONSUME(t.On); this.CONSUME(t.Commit);
        this.OR2([
          { ALT: () => this.CONSUME(t.Drop) },
          { ALT: () => { this.CONSUME(t.Delete); this.CONSUME(t.Rows); } },
          { GATE: () => this.LA(1).image.toUpperCase() === 'PRESERVE', ALT: () => { this.CONSUME2(t.Identifier); this.CONSUME1(t.Rows); } },
        ]);
      } },
    ]));

    this.RULE('postgresqlAlterAction', () => {
      let addIfNotExists = false;
      this.OR([
      { ALT: () => {
        this.CONSUME(t.Add); this.OPTION(() => this.CONSUME(t.Column));
        this.OPTION6(() => {
          this.CONSUME(t.If); this.CONSUME2(t.Not); this.CONSUME(t.Exists);
          addIfNotExists = true;
        });
        this.OR1([
          { GATE: () => !addIfNotExists, ALT: () => this.SUBRULE(this.tableConstraintDefinition) },
          { ALT: () => this.SUBRULE(this.columnDefinition) },
        ]);
      } },
      { ALT: () => {
        this.CONSUME(t.Drop);
        this.OPTION1(() => this.OR2([{ ALT: () => this.CONSUME1(t.Column) }, { ALT: () => this.CONSUME(t.Constraint) }]));
        this.OPTION7(() => { this.CONSUME1(t.If); this.CONSUME1(t.Exists); });
        this.SUBRULE(this.identifier);
        this.OPTION2(() => this.OR3([{ ALT: () => this.CONSUME(t.Cascade) }, { ALT: () => this.CONSUME(t.Restrict) }]));
      } },
      { ALT: () => {
        this.CONSUME(t.Alter); this.OPTION3(() => this.CONSUME2(t.Column)); this.SUBRULE1(this.identifier);
        this.OR4([
          { ALT: () => { this.CONSUME(t.Type); this.SUBRULE(this.typeName); this.OPTION4(() => { this.CONSUME(t.Using); this.SUBRULE(this.expression); }); } },
          { ALT: () => { this.CONSUME(t.Set); this.OR5([
            { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
            { ALT: () => { this.CONSUME(t.Default); this.SUBRULE1(this.expression); } },
          ]); } },
          { ALT: () => { this.CONSUME1(t.Drop); this.OR6([
            { ALT: () => { this.CONSUME1(t.Not); this.CONSUME1(t.Null); } },
            { ALT: () => this.CONSUME1(t.Default) },
          ]); } },
        ]);
      } },
      { ALT: () => {
        this.CONSUME(t.Rename);
        this.OPTION5(() => { this.CONSUME3(t.Column); this.SUBRULE2(this.identifier); });
        this.CONSUME(t.To); this.SUBRULE3(this.identifier);
      } },
      { ALT: () => { this.CONSUME(t.Owner); this.CONSUME1(t.To); this.SUBRULE4(this.identifier); } },
      ]);
    });
    this.OVERRIDE_RULE('alterTableStatement', () => {
      this.CONSUME(t.Alter); this.CONSUME(t.Table); this.SUBRULE(this.qualifiedName);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlAlterAction) });
    });

    this.RULE('postgresqlJsonTable', () => {
      this.CONSUME(t.JsonTable); this.CONSUME(t.LParen);
      this.SUBRULE(this.expression); this.CONSUME(t.Comma); this.CONSUME(t.StringLiteral);
      this.CONSUME(t.Columns); this.CONSUME1(t.LParen);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
        this.SUBRULE(this.identifier); this.SUBRULE(this.typeName);
        this.CONSUME(t.Path); this.CONSUME1(t.StringLiteral);
      } });
      this.CONSUME(t.RParen); this.CONSUME1(t.RParen);
    });
    this.RULE('postgresqlMergeWhen', () => {
      let notMatched = false;
      let bySource = false;
      this.CONSUME(t.When);
      this.OPTION(() => { this.CONSUME(t.Not); notMatched = true; });
      this.CONSUME(t.Matched);
      this.OPTION1({ GATE: () => notMatched, DEF: () => {
        this.CONSUME(t.By);
        this.OR([{ ALT: () => { this.CONSUME(t.Source); bySource = true; } }, { ALT: () => this.CONSUME(t.Target) }]);
      } });
      this.OPTION2(() => { this.CONSUME(t.And); this.SUBRULE(this.expression); });
      this.CONSUME(t.Then);
      this.OR1([
        { GATE: () => !notMatched || bySource, ALT: () => {
          this.CONSUME(t.Update); this.CONSUME(t.Set);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
        } },
        { GATE: () => !notMatched || bySource, ALT: () => this.CONSUME(t.Delete) },
        { ALT: () => { this.CONSUME(t.Do); this.CONSUME(t.Nothing); } },
        { GATE: () => notMatched && !bySource, ALT: () => {
          this.CONSUME(t.Insert);
          this.OPTION3(() => this.SUBRULE(this.columnList));
          this.OR2([{ ALT: () => this.SUBRULE(this.valuesClause) }, { ALT: () => { this.CONSUME(t.Default); this.CONSUME(t.Values); } }]);
        } },
      ]);
    });
    this.OVERRIDE_RULE('mergeStatement', () => {
      this.CONSUME(t.Merge); this.CONSUME(t.Into); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(t.Using); this.SUBRULE(this.tableSource);
      this.CONSUME(t.On); this.SUBRULE(this.expression);
      this.AT_LEAST_ONE(() => this.SUBRULE(this.postgresqlMergeWhen));
      this.OPTION1(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.RULE('postgresqlRoutineArgument', () => {
      this.OPTION(() => this.OR([{ ALT: () => this.CONSUME(t.In) }, { ALT: () => this.CONSUME(t.Out) }, { ALT: () => this.CONSUME(t.Inout) }]));
      this.SUBRULE(this.typeName);
      this.OPTION1(() => { this.OR1([{ ALT: () => this.CONSUME(t.Default) }, { ALT: () => this.CONSUME(t.Equals) }]); this.SUBRULE(this.expression); });
    });
    this.RULE('postgresqlAtomicBody', () => {
      this.CONSUME(t.Begin); this.CONSUME(t.Atomic);
      this.AT_LEAST_ONE(() => { this.SUBRULE(this.statement); this.CONSUME(t.Semicolon); });
      this.CONSUME(t.End);
    });
    this.RULE('postgresqlCreateRoutine', () => {
      this.CONSUME(t.Create);
      this.OPTION(() => { this.CONSUME(t.Or); this.CONSUME(t.Replace); });
      this.OR([{ ALT: () => this.CONSUME(t.FunctionKeyword) }, { ALT: () => this.CONSUME(t.Procedure) }]);
      this.SUBRULE(this.qualifiedName); this.CONSUME(t.LParen);
      this.OPTION1(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.postgresqlRoutineArgument) }));
      this.CONSUME(t.RParen);
      this.OPTION2(() => { this.CONSUME(t.Returns); this.SUBRULE(this.typeName); });
      this.OR1([
        { ALT: () => {
          this.CONSUME(t.Language); this.SUBRULE(this.identifier);
          this.OR2([{ ALT: () => { this.CONSUME(t.As); this.CONSUME(t.StringLiteral); } }, { ALT: () => this.SUBRULE(this.postgresqlAtomicBody) }]);
        } },
        { ALT: () => {
          this.CONSUME1(t.As); this.CONSUME1(t.StringLiteral);
          this.CONSUME1(t.Language); this.SUBRULE1(this.identifier);
        } },
      ]);
    });
    this.RULE('postgresqlDoStatement', () => {
      this.CONSUME(t.Do);
      this.OPTION(() => { this.CONSUME(t.Language); this.SUBRULE(this.identifier); });
      this.CONSUME(t.StringLiteral);
      this.OPTION1(() => { this.CONSUME1(t.Language); this.SUBRULE1(this.identifier); });
    });
    this.RULE('postgresqlCreateType', () => {
      this.CONSUME(t.Create);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.Type); this.SUBRULE(this.qualifiedName); this.CONSUME(t.As);
          this.OR1([
            { ALT: () => { this.CONSUME(t.Enum); this.CONSUME(t.LParen); this.MANY_SEP({ SEP: t.Comma, DEF: () => this.CONSUME(t.StringLiteral) }); this.CONSUME(t.RParen); } },
            { ALT: () => { this.CONSUME1(t.LParen); this.SUBRULE(this.columnDefinitionList); this.CONSUME1(t.RParen); } },
          ]);
        } },
        { ALT: () => {
          this.CONSUME(t.Domain); this.SUBRULE1(this.qualifiedName);
          this.OPTION(() => this.CONSUME1(t.As)); this.SUBRULE(this.typeName);
          this.MANY(() => this.OR2([
            { ALT: () => { this.CONSUME(t.Default); this.SUBRULE(this.additiveExpression); } },
            { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
            { ALT: () => this.SUBRULE(this.checkConstraint) },
          ]));
        } },
      ]);
    });
    this.RULE('postgresqlCreateIndex', () => {
      this.CONSUME(t.Create); this.OPTION(() => this.CONSUME(t.Unique));
      this.CONSUME(t.Index); this.OPTION1(() => this.CONSUME(t.Concurrently));
      this.OPTION2(() => { this.CONSUME(t.If); this.CONSUME(t.Not); this.CONSUME(t.Exists); });
      this.SUBRULE(this.identifier); this.CONSUME(t.On); this.SUBRULE(this.tableName);
      this.OPTION3(() => { this.CONSUME(t.Using); this.SUBRULE1(this.identifier); });
      this.CONSUME(t.LParen);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.orderByItem) });
      this.CONSUME(t.RParen);
      this.OPTION4(() => { this.CONSUME(t.Include); this.SUBRULE(this.columnList); });
      this.OPTION5(() => this.SUBRULE(this.whereClause));
    });
    this.OVERRIDE_RULE('columnDefinition', () => {
      this.SUBRULE(this.columnName); this.SUBRULE(this.typeName);
      this.MANY(() => this.OR([
        { ALT: () => { this.CONSUME(t.Not); this.CONSUME(t.Null); } },
        { ALT: () => this.CONSUME1(t.Null) },
        { ALT: () => { this.CONSUME(t.Default); this.SUBRULE(this.additiveExpression); } },
        { ALT: () => this.SUBRULE(this.constraintDefinition) },
        { ALT: () => {
          this.CONSUME(t.Generated);
          this.OR1([{ ALT: () => this.CONSUME(t.Always) }, { ALT: () => { this.CONSUME(t.By); this.CONSUME1(t.Default); } }]);
          this.CONSUME(t.As);
          this.OR2([
            { ALT: () => this.CONSUME(t.Identity) },
            { ALT: () => {
              this.CONSUME(t.LParen); this.SUBRULE(this.expression); this.CONSUME(t.RParen);
              this.OR3([{ ALT: () => this.CONSUME(t.Stored) }, { ALT: () => this.CONSUME(t.Virtual) }]);
            } },
          ]);
        } },
      ]));
    });
    this.OVERRIDE_RULE('dropStatement', () => {
      this.CONSUME(t.Drop);
      this.OR([
        { ALT: () => this.CONSUME(t.Table) }, { ALT: () => this.CONSUME(t.View) },
        { ALT: () => { this.CONSUME(t.Materialized); this.CONSUME1(t.View); } },
        { ALT: () => this.CONSUME(t.Index) }, { ALT: () => this.CONSUME(t.Type) },
        { ALT: () => this.CONSUME(t.Domain) }, { ALT: () => this.CONSUME(t.FunctionKeyword) },
        { ALT: () => this.CONSUME(t.Procedure) }, { ALT: () => this.CONSUME(t.Sequence) },
        { ALT: () => this.CONSUME(t.Schema) },
      ]);
      this.OPTION(() => { this.CONSUME(t.If); this.CONSUME(t.Exists); });
      this.SUBRULE(this.dropTargetList);
      this.OPTION1(() => this.OR1([{ ALT: () => this.CONSUME(t.Cascade) }, { ALT: () => this.CONSUME(t.Restrict) }]));
    });
  }

  private registerPostgresqlRules(): void {
    const nameTokens: TokenType[] = [
      t.Identifier, t.QuotedIdentifier, t.Replace, t.Left, t.Right,
      t.User, t.Type, t.Key, t.Public, t.Schema, t.Database, t.Materialized, t.Conflict, t.Nothing,
      t.FunctionKeyword, t.Index, t.Domain, t.Enum, t.Value, t.System,
      t.Identity, t.Stored, t.Virtual, t.Generated, t.Always, t.Include, t.Old, t.New, t.Path,
    ];
    this.OVERRIDE_RULE('identifier', () => this.OR(this.getTokenAlternatives(nameTokens)));
    this.OVERRIDE_RULE('alias', () => this.SUBRULE(this.identifier));
    this.OVERRIDE_RULE('columnReference', () => {
      this.SUBRULE(this.identifier);
      this.MANY(() => { this.CONSUME(t.Dot); this.SUBRULE1(this.identifier); });
    });
    this.OVERRIDE_RULE('starExpression', () => {
      this.OPTION(() => { this.SUBRULE(this.identifier); this.CONSUME(t.Dot); });
      this.CONSUME(t.Multiply);
    });

    this.RULE('arrayExpression', () => {
      this.CONSUME(t.ArrayKeyword);
      this.CONSUME(t.LBracket);
      this.OPTION(() => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }));
      this.CONSUME(t.RBracket);
    });
    this.RULE('postgresqlPostfixExpression', () => {
      this.SUBRULE(this.primaryExpression);
      this.MANY(() => this.OR([
        { ALT: () => {
          this.CONSUME(t.DoubleColon);
          this.SUBRULE(this.typeName);
          this.MANY1(() => { this.CONSUME(t.LBracket); this.CONSUME(t.RBracket); });
        } },
        { ALT: () => {
          this.CONSUME1(t.LBracket);
          this.OR1([
            { ALT: () => { this.SUBRULE(this.expression); this.OPTION(() => { this.CONSUME(t.Colon); this.OPTION1(() => this.SUBRULE1(this.expression)); }); } },
            { ALT: () => { this.CONSUME1(t.Colon); this.OPTION2(() => this.SUBRULE2(this.expression)); } },
          ]);
          this.CONSUME1(t.RBracket);
        } },
      ]));
    });
    this.RULE('postgresqlJsonExpression', () => {
      this.SUBRULE(this.postgresqlPostfixExpression);
      this.MANY(() => {
        this.OR(this.getTokenAlternatives([
          t.JsonTextPath, t.JsonPath, t.JsonTextArrow, t.JsonArrow,
          t.JsonExists, t.JsonExistsAny, t.JsonExistsAll, t.JsonContains, t.JsonContained,
        ]));
        this.SUBRULE1(this.postgresqlPostfixExpression);
      });
    });
    this.OVERRIDE_RULE('castExpression', () => this.SUBRULE(this.postgresqlJsonExpression));
    this.OVERRIDE_RULE('primaryExpression', () => {
      this.OR([
        { GATE: () => this.LA(1).tokenType === t.ArrayKeyword, ALT: () => this.SUBRULE(this.arrayExpression) },
        { GATE: () => tokenMatcher(this.LA(1), t.StringLiteral) || [t.NumberLiteral, t.Null, t.DollarNumber].includes(this.LA(1).tokenType) || tokenMatcher(this.LA(2), t.StringLiteral), ALT: () => this.SUBRULE(this.literal) },
        { GATE: () => this.functionAhead(), ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.castFunctionExpression) },
        { ALT: () => this.SUBRULE(this.extractExpression) },
        { ALT: () => this.SUBRULE(this.caseExpression) },
        { ALT: () => this.SUBRULE(this.existsExpression) },
        { GATE: () => this.LA(2).tokenType === t.Select || this.LA(2).tokenType === t.With || this.LA(2).tokenType === t.Values, ALT: () => this.SUBRULE(this.subquery) },
        { ALT: () => this.SUBRULE(this.expressionList) },
        { ALT: () => this.CONSUME(t.Default) },
        { ALT: () => this.SUBRULE(this.columnReference) },
      ]);
    });
    this.OVERRIDE_RULE('functionCall', () => {
      this.SUBRULE(this.identifier);
      this.MANY(() => { this.CONSUME(t.Dot); this.SUBRULE1(this.identifier); });
      this.CONSUME(t.LParen);
      this.OPTION(() => this.OR([{ ALT: () => this.CONSUME(t.Distinct) }, { ALT: () => this.CONSUME(t.All) }]));
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(t.RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.withinGroupClause));
      this.OPTION4(() => this.SUBRULE(this.overClause));
    });
    this.OVERRIDE_RULE('functionArguments', () => {
      this.OR([
        { ALT: () => this.CONSUME(t.Multiply) },
        { ALT: () => this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.expression) }) },
      ]);
      this.OPTION(() => this.SUBRULE(this.orderByClause));
    });

    this.RULE('postgresqlValuesQuery', () => this.SUBRULE(this.valuesClause));
    this.OVERRIDE_RULE('subquery', () => {
      this.CONSUME(t.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
      ]);
      this.CONSUME(t.RParen);
    });
    this.OVERRIDE_RULE('tableSource', () => {
      this.OPTION(() => this.CONSUME(t.Lateral));
      this.OR([
        { ALT: () => this.SUBRULE(this.postgresqlJsonTable) },
        { ALT: () => this.SUBRULE(this.subquery) },
        { GATE: () => this.functionAhead(), ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.tableName) },
      ]);
      this.OPTION1(() => { this.CONSUME(t.With); this.CONSUME(t.Ordinality); });
      this.OPTION2(() => this.SUBRULE(this.aliasOptional));
      this.OPTION3(() => this.SUBRULE(this.cteColumnList));
    });
    this.OVERRIDE_RULE('cteDefinition', () => {
      this.CONSUME(t.Identifier);
      this.OPTION(() => this.SUBRULE(this.cteColumnList));
      this.CONSUME(t.As);
      this.OPTION1(() => { this.OPTION2(() => this.CONSUME(t.Not)); this.CONSUME(t.Materialized); });
      this.CONSUME(t.LParen);
      this.OR([
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
      ]);
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlWindowSpec', () => {
      this.CONSUME(t.LParen);
      this.OPTION(() => this.CONSUME(t.Identifier));
      this.OPTION1(() => this.SUBRULE(this.partitionByClause));
      this.OPTION2(() => this.SUBRULE(this.orderByClause));
      this.OPTION3(() => this.SUBRULE(this.windowFrameClause));
      this.CONSUME(t.RParen);
    });
    this.RULE('postgresqlWindowClause', () => {
      this.CONSUME(t.Window);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
        this.SUBRULE(this.identifier);
        this.CONSUME(t.As);
        this.SUBRULE(this.postgresqlWindowSpec);
      } });
    });
    this.OVERRIDE_RULE('overClause', () => {
      this.CONSUME(t.Over);
      this.OR([{ ALT: () => this.SUBRULE(this.postgresqlWindowSpec) }, { ALT: () => this.SUBRULE(this.identifier) }]);
    });
    this.OVERRIDE_RULE('selectStatement', () => {
      this.SUBRULE(this.selectClause);
      this.OPTION(() => this.SUBRULE(this.fromClause));
      this.OPTION1(() => this.SUBRULE(this.whereClause));
      this.OPTION2(() => this.SUBRULE(this.groupByClause));
      this.OPTION3(() => this.SUBRULE(this.havingClause));
      this.OPTION4(() => this.SUBRULE(this.postgresqlWindowClause));
      this.OPTION5(() => this.SUBRULE(this.orderByClause));
      this.OPTION6(() => this.SUBRULE(this.limitClause));
      this.OPTION7(() => this.SUBRULE(this.offsetClause));
      this.OPTION8(() => this.SUBRULE(this.fetchFirstClause));
      this.MANY(() => { this.SUBRULE(this.setOperation); this.SUBRULE1(this.selectStatement); });
    });
    this.OVERRIDE_RULE('setOperation', () => {
      this.OR([{ ALT: () => this.CONSUME(t.Union) }, { ALT: () => this.CONSUME(t.Intersect) }, { ALT: () => this.CONSUME(t.Except) }]);
      this.OPTION(() => this.OR1([{ ALT: () => this.CONSUME(t.All) }, { ALT: () => this.CONSUME(t.Distinct) }]));
    });
    this.OVERRIDE_RULE('selectModifier', () => this.OR([
      { ALT: () => { this.CONSUME(t.Distinct); this.OPTION(() => { this.CONSUME(t.On); this.SUBRULE(this.expressionList); }); } },
      { ALT: () => this.CONSUME(t.All) },
    ]));

    this.RULE('postgresqlReturning', () => {
      this.CONSUME(t.Returning);
      this.OPTION(() => {
        this.CONSUME(t.With); this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP1({ SEP: t.Comma, DEF: () => {
          this.OR([{ ALT: () => this.CONSUME(t.Old) }, { ALT: () => this.CONSUME(t.New) }]);
          this.CONSUME(t.As); this.SUBRULE(this.identifier);
        } });
        this.CONSUME(t.RParen);
      });
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.selectItem) });
    });
    this.RULE('postgresqlOnConflict', () => {
      let hasTarget = false;
      this.CONSUME(t.On); this.CONSUME(t.Conflict);
      this.OPTION(() => {
        hasTarget = true;
        this.OR([
          { ALT: () => {
            this.SUBRULE(this.expressionList);
            this.OPTION1(() => this.SUBRULE(this.whereClause));
          } },
          { ALT: () => { this.CONSUME1(t.On); this.CONSUME(t.Constraint); this.SUBRULE(this.identifier); } },
        ]);
      });
      this.CONSUME(t.Do);
      this.OR1([
        { ALT: () => this.CONSUME(t.Nothing) },
        { GATE: () => hasTarget, ALT: () => {
          this.CONSUME(t.Update); this.CONSUME(t.Set);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
          this.OPTION2(() => this.SUBRULE1(this.whereClause));
        } },
      ]);
    });
    this.OVERRIDE_RULE('insertStatement', () => {
      this.CONSUME(t.Insert); this.CONSUME(t.Into); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => {
        this.CONSUME(t.LParen);
        this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.OR2([
          { ALT: () => this.CONSUME(t.Identifier) },
          { ALT: () => this.CONSUME(t.QuotedIdentifier) },
        ]) });
        this.CONSUME(t.RParen);
      });
      this.OPTION2(() => {
        this.CONSUME(t.Overriding);
        this.OR([{ ALT: () => this.CONSUME(t.System) }, { ALT: () => this.CONSUME(t.User) }]);
        this.CONSUME(t.Value);
      });
      this.OR1([
        { ALT: () => this.SUBRULE(this.valuesClause) },
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.insertWithClause) },
        { ALT: () => { this.CONSUME(t.Default); this.CONSUME(t.Values); } },
      ]);
      this.OPTION3(() => this.SUBRULE(this.postgresqlOnConflict));
      this.OPTION4(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.OVERRIDE_RULE('updateStatement', () => {
      this.CONSUME(t.Update); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.CONSUME(t.Set);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.updateSetItem) });
      this.OPTION1(() => this.SUBRULE(this.fromClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.RULE('postgresqlUsingClause', () => {
      this.CONSUME(t.Using);
      this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => this.SUBRULE(this.tableReference) });
    });
    this.OVERRIDE_RULE('deleteStatement', () => {
      this.CONSUME(t.Delete); this.CONSUME(t.From); this.SUBRULE(this.tableName);
      this.OPTION(() => this.SUBRULE(this.aliasOptional));
      this.OPTION1(() => this.SUBRULE(this.postgresqlUsingClause));
      this.OPTION2(() => this.SUBRULE(this.whereClause));
      this.OPTION3(() => this.SUBRULE(this.postgresqlReturning));
    });
    this.OVERRIDE_RULE('explainStatement', () => {
      this.CONSUME(t.Explain);
      this.OR([
        { ALT: () => {
          this.CONSUME(t.LParen);
          this.AT_LEAST_ONE_SEP({ SEP: t.Comma, DEF: () => {
            const format = this.LA(1).image.toUpperCase() === 'FORMAT';
            this.OR1([
              { GATE: () => /^(ANALYZE|COSTS|SETTINGS|GENERIC_PLAN|BUFFERS|WAL|TIMING|SUMMARY|FORMAT)$/i.test(this.LA(1).image), ALT: () => this.CONSUME(t.Identifier) },
              { ALT: () => this.CONSUME(t.Verbose) },
            ]);
            this.OR2([
              { GATE: () => format, ALT: () => {
                this.OR3([{ GATE: () => /^(TEXT|XML|JSON|YAML)$/i.test(this.LA(1).image), ALT: () => this.CONSUME1(t.Identifier) }]);
              } },
              { ALT: () => this.OPTION({ GATE: () => /^(TRUE|FALSE|ON|OFF|0|1)$/i.test(this.LA(1).image), DEF: () => {
                this.OR4([
                  { ALT: () => this.CONSUME2(t.Identifier) },
                  { ALT: () => this.CONSUME(t.On) },
                  { ALT: () => this.CONSUME(t.NumberLiteral) },
                ]);
              } }) },
            ]);
          } });
          this.CONSUME(t.RParen);
        } },
        { ALT: () => {
          this.OPTION1({ GATE: () => /^ANALYZE$/i.test(this.LA(1).image), DEF: () => this.CONSUME3(t.Identifier) });
          this.OPTION2(() => this.CONSUME1(t.Verbose));
        } },
      ]);
      this.OR5([
        { ALT: () => this.SUBRULE(this.selectStatement) },
        { ALT: () => this.SUBRULE(this.withStatement) },
        { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
        { ALT: () => this.SUBRULE(this.insertStatement) },
        { ALT: () => this.SUBRULE(this.updateStatement) },
        { ALT: () => this.SUBRULE(this.deleteStatement) },
        { ALT: () => this.SUBRULE(this.mergeStatement) },
      ]);
    });
    this.RULE('postgresqlTransaction', () => {
      this.OR([{ ALT: () => this.CONSUME(t.Begin) }, { ALT: () => this.CONSUME(t.Commit) }, { ALT: () => this.CONSUME(t.Rollback) }]);
      this.OPTION(() => this.SUBRULE(this.commandTail));
    });
    this.OVERRIDE_RULE('statement', () => this.OR([
      { GATE: () => this.LA(2).tokenType === t.FunctionKeyword || this.LA(2).tokenType === t.Procedure || (this.LA(2).tokenType === t.Or && [t.FunctionKeyword, t.Procedure].includes(this.LA(4).tokenType)), ALT: () => this.SUBRULE(this.postgresqlCreateRoutine) },
      { GATE: () => [t.Type, t.Domain].includes(this.LA(2).tokenType), ALT: () => this.SUBRULE(this.postgresqlCreateType) },
      { GATE: () => this.LA(2).tokenType === t.Index || (this.LA(2).tokenType === t.Unique && this.LA(3).tokenType === t.Index), ALT: () => this.SUBRULE(this.postgresqlCreateIndex) },
      { ALT: () => this.SUBRULE(this.postgresqlDoStatement) },
      { ALT: () => this.SUBRULE(this.mergeStatement) },
      { ALT: () => this.SUBRULE(this.createTableStatement) },
      { ALT: () => this.SUBRULE(this.createSequenceStatement) },
      { ALT: () => this.SUBRULE(this.createSchemaStatement) },
      { ALT: () => this.SUBRULE(this.createViewStatement) },
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
      { ALT: () => this.SUBRULE(this.resetStatement) },
      { ALT: () => this.SUBRULE(this.withAnyStatement) },
      { ALT: () => this.SUBRULE(this.parenthesizedSetStatement) },
      { ALT: () => this.SUBRULE(this.selectStatement) },
      { ALT: () => this.SUBRULE(this.insertStatement) },
      { ALT: () => this.SUBRULE(this.updateStatement) },
      { ALT: () => this.SUBRULE(this.deleteStatement) },
      { ALT: () => this.SUBRULE(this.postgresqlValuesQuery) },
      { ALT: () => this.SUBRULE(this.postgresqlTransaction) },
      { ALT: () => this.SUBRULE(this.setStatement) },
    ]));
  }
}
export class SqlParser extends PostgreSqlParser {}
let parserInstance: SqlParser | undefined;
/** Create an independent parser for nested/reentrant authoring requests. */
export function createSqlParserInstance(): SqlParser { return new SqlParser(); }
/** Reuse the parser for ordinary document sessions. */
export function getSqlParserInstance(): SqlParser { return parserInstance ??= createSqlParserInstance(); }
