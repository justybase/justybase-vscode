import type { CstNode, TokenType } from 'chevrotain';
import type { OrAlternative } from '../../../sqlParser/BaseSqlParser';
import * as baseLexer from '../../netezza/sql/lexer';
import * as duckdbLexer from './lexer';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

const DUCKDB_IDENTIFIER_TOKENS: TokenType[] = [
  duckdbLexer.DuckDbQualify,
  duckdbLexer.DuckDbSample,
  duckdbLexer.DuckDbAsOf,
  duckdbLexer.DuckDbPositional,
  duckdbLexer.DuckDbPivot,
  duckdbLexer.DuckDbUnpivot,
  duckdbLexer.DuckDbInstall,
  duckdbLexer.DuckDbLoad,
  duckdbLexer.DuckDbAttach,
  duckdbLexer.DuckDbDetach,
  duckdbLexer.DuckDbMacro,
  duckdbLexer.DuckDbReservoir,
  duckdbLexer.DuckDbBernoulli,
  duckdbLexer.DuckDbSystem,
  duckdbLexer.DuckDbTableSample,
];

/**
 * DuckDB parser layered on the shared CST grammar.
 *
 * Shared SELECT/DML rules remain the source of CST compatibility. DuckDB-only
 * syntax is kept in thin rules so Chevrotain self-analysis stays bounded.
 */
export class DuckDbSqlParser extends NetezzaSqlParser {
  duckdbQualifyClause!: AnyRule;
  duckdbSampleClause!: AnyRule;
  duckdbSampleSize!: AnyRule;
  duckdbSampleMethod!: AnyRule;
  duckdbSampleOptions!: AnyRule;
  duckdbRepeatableClause!: AnyRule;
  duckdbWithOrdinalityClause!: AnyRule;
  duckdbTableFunctionSource!: AnyRule;
  duckdbLateralTableSource!: AnyRule;
  duckdbStarExclude!: AnyRule;
  duckdbStarReplace!: AnyRule;
  duckdbStarRename!: AnyRule;
  duckdbPivotStatement!: AnyRule;
  duckdbStandardPivotClause!: AnyRule;
  duckdbStandardUnpivotClause!: AnyRule;
  duckdbCreateMacroStatement!: AnyRule;
  duckdbMacroArgument!: AnyRule;
  duckdbInstallStatement!: AnyRule;
  duckdbAttachStatement!: AnyRule;
  duckdbUseStatement!: AnyRule;
  duckdbCreateTypeStatement!: AnyRule;
  duckdbCreateOrReplaceTableStatement!: AnyRule;
  duckdbNullHandlingClause!: AnyRule;
  duckdbWhereAndSampleClause!: AnyRule;
  duckdbWindowAndQualifyClause!: AnyRule;
  duckdbWindowClause!: AnyRule;
  duckdbFromFirstStatement!: AnyRule;

  public constructor() {
    super(duckdbLexer);
  }

  protected getNetezzaIdentifierTokens(): TokenType[] {
    return [
      ...super.getNetezzaIdentifierTokens(),
      ...DUCKDB_IDENTIFIER_TOKENS,
      duckdbLexer.DuckDbBy,
      duckdbLexer.DuckDbFunction,
      duckdbLexer.DuckDbUse,
      duckdbLexer.DuckDbWindow,
      duckdbLexer.DuckDbInclude,
    ];
  }

  protected getNetezzaRelaxedNameTokens(): TokenType[] {
    return [...super.getNetezzaRelaxedNameTokens(), duckdbLexer.DuckDbBy];
  }

  protected supportsEmptyQualifiedNameSegment(): boolean {
    return false;
  }

  protected registerCreateTableDialectClauses(): void {
    // DuckDB has no Netezza DISTRIBUTE ON / ORGANIZE ON clauses.
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
    return [
      { ALT: () => this.CONSUME(duckdbLexer.DuckDbMacro) },
      { ALT: () => this.CONSUME(baseLexer.Type) },
    ];
  }

  protected getAdditionalExplainOptionAlternatives(): OrAlternative[] {
    return [];
  }

  protected getAdditionalTableSourceAlternatives(): OrAlternative[] {
    return [
      {
        GATE: () => {
          const first = this.LA(1).tokenType;
          const second = this.LA(2).tokenType;
          return second === baseLexer.LParen
            && first !== baseLexer.StringLiteral
            && first !== baseLexer.LParen
            && first !== duckdbLexer.DuckDbLateral;
        },
        ALT: () => this.SUBRULE(this.duckdbTableFunctionSource),
      },
      {
        GATE: () => this.LA(1).tokenType === baseLexer.StringLiteral,
        ALT: () => this.CONSUME(baseLexer.StringLiteral),
      },
      {
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbLateral,
        ALT: () => this.SUBRULE(this.duckdbLateralTableSource),
      },
    ];
  }

  protected getAdditionalStatementAlternatives(): OrAlternative[] {
    return [
      {
        GATE: () =>
          this.LA(1).tokenType === duckdbLexer.DuckDbPivot
          || this.LA(1).tokenType === duckdbLexer.DuckDbUnpivot
          || this.LA(1).tokenType === duckdbLexer.DuckDbPivotWider
          || this.LA(1).tokenType === duckdbLexer.DuckDbPivotLonger,
        ALT: () => this.SUBRULE(this.duckdbPivotStatement),
      },
      {
        GATE: () => {
          const isMacroToken = (index: number): boolean =>
            this.LA(index).tokenType === duckdbLexer.DuckDbMacro
            || this.LA(index).tokenType === duckdbLexer.DuckDbFunction;
          return this.LA(1).tokenType === baseLexer.Create
            && (
              isMacroToken(2)
              || ((this.LA(2).tokenType === baseLexer.Temp
                || this.LA(2).tokenType === baseLexer.Temporary) && isMacroToken(3))
              || (
                this.LA(2).tokenType === baseLexer.Or
                && this.LA(3).tokenType === baseLexer.Replace
                && (
                  isMacroToken(4)
                  || ((this.LA(4).tokenType === baseLexer.Temp
                    || this.LA(4).tokenType === baseLexer.Temporary) && isMacroToken(5))
                )
              )
            );
        },
        ALT: () => this.SUBRULE(this.duckdbCreateMacroStatement),
      },
      {
        GATE: () =>
          this.LA(1).tokenType === baseLexer.Create
          && this.LA(2).tokenType === baseLexer.Type,
        ALT: () => this.SUBRULE(this.duckdbCreateTypeStatement),
      },
      {
        GATE: () =>
          this.LA(1).tokenType === baseLexer.Create
          && this.LA(2).tokenType === baseLexer.Or
          && this.LA(3).tokenType === baseLexer.Replace
          && this.LA(4).tokenType === baseLexer.Type,
        ALT: () => this.SUBRULE1(this.duckdbCreateTypeStatement),
      },
      {
        GATE: () =>
          this.LA(1).tokenType === baseLexer.Create
          && this.LA(2).tokenType === baseLexer.Or
          && this.LA(3).tokenType === baseLexer.Replace
          && this.LA(4).tokenType === baseLexer.Table,
        ALT: () => this.SUBRULE(this.duckdbCreateOrReplaceTableStatement),
      },
      {
        GATE: () =>
          this.LA(1).tokenType === duckdbLexer.DuckDbInstall
          || this.LA(1).tokenType === duckdbLexer.DuckDbLoad,
        ALT: () => this.SUBRULE(this.duckdbInstallStatement),
      },
      {
        GATE: () =>
          this.LA(1).tokenType === duckdbLexer.DuckDbAttach
          || this.LA(1).tokenType === duckdbLexer.DuckDbDetach,
        ALT: () => this.SUBRULE(this.duckdbAttachStatement),
      },
      {
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbUse,
        ALT: () => this.SUBRULE(this.duckdbUseStatement),
      },
      {
        GATE: () => this.LA(1).tokenType === baseLexer.From,
        ALT: () => this.SUBRULE(this.duckdbFromFirstStatement),
      },
    ];
  }

  protected registerDialectExtensions(): void {
    this.RULE('duckdbQualifyClause', () => {
      this.CONSUME(duckdbLexer.DuckDbQualify);
      this.SUBRULE(this.expression);
    });

    this.RULE('duckdbSampleSize', () => {
      this.CONSUME(baseLexer.NumberLiteral);
      this.OPTION(() => {
        this.OR([
          { ALT: () => this.CONSUME(baseLexer.Modulo) },
          { ALT: () => this.CONSUME(duckdbLexer.DuckDbPercent) },
          { ALT: () => this.CONSUME(baseLexer.Rows) },
        ]);
      });
    });

    this.RULE('duckdbSampleMethod', () => {
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbReservoir) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbBernoulli) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbSystem) },
      ]);
      this.CONSUME(baseLexer.LParen);
      this.SUBRULE(this.duckdbSampleSize);
      this.OPTION(() => {
        this.CONSUME(baseLexer.Comma);
        this.CONSUME1(baseLexer.NumberLiteral);
      });
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbSampleOptions', () => {
      this.CONSUME(baseLexer.LParen);
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbReservoir) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbBernoulli) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbSystem) },
      ]);
      this.OPTION(() => {
        this.CONSUME(baseLexer.Comma);
        this.CONSUME1(baseLexer.NumberLiteral);
      });
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbSampleClause', () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(duckdbLexer.DuckDbUsingSample);
            this.OR1([
              {
                GATE: () => this.LA(1).tokenType === baseLexer.NumberLiteral,
                ALT: () => {
                  this.SUBRULE(this.duckdbSampleSize);
                  this.OPTION(() => this.SUBRULE(this.duckdbSampleOptions));
                },
              },
              { ALT: () => this.SUBRULE(this.duckdbSampleMethod) },
            ]);
          },
        },
        {
          ALT: () => {
            this.OR2([
              { ALT: () => this.CONSUME(duckdbLexer.DuckDbSample) },
              { ALT: () => this.CONSUME(duckdbLexer.DuckDbTableSample) },
            ]);
            this.OR3([
              { ALT: () => this.SUBRULE1(this.duckdbSampleMethod) },
              { ALT: () => this.SUBRULE1(this.duckdbSampleSize) },
            ]);
          },
        },
      ]);
    });

    this.RULE('duckdbRepeatableClause', () => {
      this.CONSUME(duckdbLexer.DuckDbRepeatable);
      this.CONSUME(baseLexer.LParen);
      this.CONSUME(baseLexer.NumberLiteral);
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbWithOrdinalityClause', () => {
      this.CONSUME(duckdbLexer.DuckDbWithOrdinality);
    });

    this.RULE('duckdbTableFunctionSource', () => {
      this.SUBRULE(this.identifier);
      this.CONSUME(baseLexer.LParen);
      this.OPTION(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbLateralTableSource', () => {
      this.CONSUME(duckdbLexer.DuckDbLateral);
      this.SUBRULE(this.subquery);
    });

    this.RULE('duckdbStarExclude', () => {
      this.CONSUME(baseLexer.Exclude);
      this.SUBRULE(this.columnList);
    });

    this.RULE('duckdbStarReplace', () => {
      this.CONSUME(baseLexer.Replace);
      this.CONSUME(baseLexer.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => {
          this.SUBRULE(this.expression);
          this.CONSUME(baseLexer.As);
          this.SUBRULE(this.identifier);
        },
      });
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbStarRename', () => {
      this.CONSUME(baseLexer.Rename);
      this.CONSUME(baseLexer.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => {
          this.SUBRULE(this.identifier);
          this.CONSUME(baseLexer.As);
          this.SUBRULE1(this.identifier);
        },
      });
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbPivotStatement', () => {
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbPivot) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbUnpivot) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbPivotWider) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbPivotLonger) },
      ]);
      this.OR1([
        { ALT: () => this.SUBRULE(this.qualifiedName) },
        { ALT: () => this.SUBRULE(this.subquery) },
      ]);
      this.OPTION(() => {
        this.CONSUME(baseLexer.On);
        this.AT_LEAST_ONE_SEP({
          SEP: baseLexer.Comma,
          DEF: () => this.SUBRULE(this.expression),
        });
      });
      this.OPTION1(() => {
        this.CONSUME(baseLexer.Using);
        this.AT_LEAST_ONE_SEP1({
          SEP: baseLexer.Comma,
          DEF: () => this.SUBRULE1(this.expression),
        });
      });
      this.OPTION2(() => this.SUBRULE(this.groupByClause));
      this.OPTION3(() => this.SUBRULE(this.orderByClause));
      this.OPTION4(() => {
        this.CONSUME(baseLexer.Into);
        this.SUBRULE(this.commandTail);
      });
    });

    this.RULE('duckdbStandardPivotClause', () => {
      this.CONSUME(duckdbLexer.DuckDbPivot);
      this.CONSUME(baseLexer.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => {
          this.SUBRULE(this.expression);
          this.OPTION(() => {
            this.CONSUME(baseLexer.As);
            this.SUBRULE(this.identifier);
          });
        },
      });
      this.CONSUME(baseLexer.For);
      this.SUBRULE1(this.identifier);
      this.CONSUME(baseLexer.In);
      this.SUBRULE(this.expressionList);
      this.MANY(() => {
        this.CONSUME1(baseLexer.For);
        this.SUBRULE2(this.identifier);
        this.CONSUME1(baseLexer.In);
        this.SUBRULE1(this.expressionList);
      });
      this.OPTION1(() => this.SUBRULE(this.groupByClause));
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbStandardUnpivotClause', () => {
      this.CONSUME(duckdbLexer.DuckDbUnpivot);
      this.OPTION(() => {
        this.CONSUME(duckdbLexer.DuckDbInclude);
        this.CONSUME(baseLexer.Nulls);
      });
      this.CONSUME(baseLexer.LParen);
      this.SUBRULE(this.identifier);
      this.CONSUME(baseLexer.For);
      this.SUBRULE1(this.identifier);
      this.CONSUME(baseLexer.In);
      this.CONSUME1(baseLexer.LParen);
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => this.SUBRULE2(this.identifier),
      });
      this.CONSUME1(baseLexer.RParen);
      this.CONSUME(baseLexer.RParen);
    });

    this.RULE('duckdbMacroArgument', () => {
      this.SUBRULE(this.identifier);
      this.OPTION({
        GATE: () => {
          const next = this.LA(1).tokenType;
          return next === baseLexer.Identifier || next === baseLexer.QuotedIdentifier;
        },
        DEF: () => this.SUBRULE(this.typeName),
      });
      this.OPTION1(() => {
        this.OR([
          { ALT: () => this.CONSUME(baseLexer.Assign) },
          { ALT: () => this.CONSUME(baseLexer.Equals) },
        ]);
        this.SUBRULE(this.expression);
      });
    });

    this.RULE('duckdbCreateMacroStatement', () => {
      this.CONSUME(baseLexer.Create);
      this.OPTION(() => {
        this.CONSUME(baseLexer.Or);
        this.CONSUME(baseLexer.Replace);
      });
      this.OPTION1(() => {
        this.OR([
          { ALT: () => this.CONSUME(baseLexer.Temporary) },
          { ALT: () => this.CONSUME(baseLexer.Temp) },
        ]);
      });
      this.OR1([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbMacro) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbFunction) },
      ]);
      this.OPTION2(() => {
        this.CONSUME(baseLexer.If);
        this.CONSUME(baseLexer.Not);
        this.CONSUME(baseLexer.Exists);
      });
      this.SUBRULE(this.qualifiedName);
      this.OPTION3(() => {
        this.CONSUME(baseLexer.LParen);
        this.OPTION4(() => {
          this.AT_LEAST_ONE_SEP({
            SEP: baseLexer.Comma,
            DEF: () => this.SUBRULE(this.duckdbMacroArgument),
          });
        });
        this.CONSUME(baseLexer.RParen);
      });
      this.CONSUME(baseLexer.As);
      this.OPTION5(() => this.CONSUME(baseLexer.Table));
      this.OR2([
        {
          GATE: () => this.LA(1).tokenType === baseLexer.Select,
          ALT: () => this.SUBRULE(this.selectStatement),
        },
        { ALT: () => this.SUBRULE(this.expression) },
      ]);
    });

    this.RULE('duckdbInstallStatement', () => {
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbInstall) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbLoad) },
      ]);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('duckdbAttachStatement', () => {
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbAttach) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbDetach) },
      ]);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('duckdbUseStatement', () => {
      this.CONSUME(duckdbLexer.DuckDbUse);
      this.SUBRULE(this.commandTail);
    });

    this.RULE('duckdbNullHandlingClause', () => {
      this.OR([
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbIgnoreNulls) },
        { ALT: () => this.CONSUME(duckdbLexer.DuckDbRespectNulls) },
      ]);
    });

    this.RULE('duckdbWhereAndSampleClause', () => {
      this.OPTION({
        GATE: () => this.LA(1).tokenType === baseLexer.Where,
        DEF: () => this.SUBRULE(this.whereClause),
      });
      this.OPTION1({
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbUsingSample,
        DEF: () => this.SUBRULE(this.duckdbSampleClause),
      });
      this.OPTION2({
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbRepeatable,
        DEF: () => this.SUBRULE(this.duckdbRepeatableClause),
      });
    });

    this.RULE('duckdbWindowAndQualifyClause', () => {
      this.OPTION({
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbWindow,
        DEF: () => this.SUBRULE(this.duckdbWindowClause),
      });
      this.OPTION1({
        GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbQualify,
        DEF: () => this.SUBRULE(this.duckdbQualifyClause),
      });
    });

    this.RULE('duckdbFromFirstStatement', () => {
      this.SUBRULE(this.fromClause);
      this.OPTION(() => this.SUBRULE(this.selectClause));
      this.OPTION1(() => this.SUBRULE(this.duckdbWhereAndSampleClause));
      this.OPTION2(() => this.SUBRULE(this.groupByClause));
      this.OPTION3(() => this.SUBRULE(this.havingClause));
      this.OPTION4(() => this.SUBRULE(this.duckdbWindowAndQualifyClause));
      this.OPTION5(() => this.SUBRULE(this.orderByClause));
      this.OPTION6(() => this.SUBRULE(this.limitClause));
    });

    this.RULE('duckdbCreateTypeStatement', () => {
      this.CONSUME(baseLexer.Create);
      this.OPTION(() => {
        this.CONSUME(baseLexer.Or);
        this.CONSUME(baseLexer.Replace);
      });
      this.CONSUME(baseLexer.Type);
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => this.SUBRULE(this.commandTail));
    });

    this.RULE('duckdbCreateOrReplaceTableStatement', () => {
      this.CONSUME(baseLexer.Create);
      this.CONSUME(baseLexer.Or);
      this.CONSUME(baseLexer.Replace);
      this.CONSUME(baseLexer.Table);
      this.OPTION(() => {
        this.CONSUME(baseLexer.If);
        this.CONSUME(baseLexer.Not);
        this.CONSUME(baseLexer.Exists);
      });
      this.SUBRULE(this.qualifiedName);
      this.OPTION1(() => this.SUBRULE(this.commandTail));
    });

    this.OVERRIDE_RULE('typeArgument', () => {
      this.OR([
        {
          GATE: () => {
            const first = this.LA(1).tokenType;
            const second = this.LA(2).tokenType;
            return (
              (first === baseLexer.Identifier || first === baseLexer.QuotedIdentifier)
              && (
                second === baseLexer.Identifier
                || second === baseLexer.QuotedIdentifier
                || second === baseLexer.To
              )
            );
          },
          ALT: () => {
            this.SUBRULE(this.identifier);
            this.SUBRULE(this.typeName);
          },
        },
        { ALT: () => this.SUBRULE1(this.typeName) },
        { ALT: () => this.CONSUME(baseLexer.NumberLiteral) },
        { ALT: () => this.CONSUME(baseLexer.StringLiteral) },
      ]);
    });

    this.OVERRIDE_RULE('functionArguments', () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(baseLexer.Multiply);
            this.MANY(() => {
              this.OR1([
                { ALT: () => this.SUBRULE(this.duckdbStarExclude) },
                { ALT: () => this.SUBRULE1(this.duckdbStarReplace) },
                { ALT: () => this.SUBRULE(this.duckdbStarRename) },
              ]);
            });
          },
        },
        {
          ALT: () => {
            this.AT_LEAST_ONE_SEP({
              SEP: baseLexer.Comma,
              DEF: () => {
                this.SUBRULE(this.expression);
                this.OPTION(() => this.SUBRULE(this.duckdbNullHandlingClause));
              },
            });
          },
        },
      ]);
    });

    this.OVERRIDE_RULE('functionCall', () => {
      this.OR1([
        { ALT: () => this.CONSUME(baseLexer.Identifier) },
        { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
        { ALT: () => this.CONSUME(baseLexer.Next) },
        { ALT: () => this.CONSUME(baseLexer.Replace) },
        { ALT: () => this.CONSUME(baseLexer.Random) },
        { ALT: () => this.CONSUME(baseLexer.Value) },
        { ALT: () => this.CONSUME(baseLexer.IsNull) },
        { ALT: () => this.CONSUME(baseLexer.First) },
      ]);
      this.CONSUME(baseLexer.LParen);
      this.OPTION(() => {
        this.OR2([
          { ALT: () => this.CONSUME(baseLexer.Distinct) },
          { ALT: () => this.CONSUME(baseLexer.All) },
        ]);
      });
      this.OPTION1(() => this.SUBRULE(this.functionArguments));
      this.CONSUME(baseLexer.RParen);
      this.OPTION2(() => this.SUBRULE(this.filterClause));
      this.OPTION3(() => this.SUBRULE(this.withinGroupClause));
      this.OPTION4(() => this.SUBRULE(this.overClause));
    });

    this.OVERRIDE_RULE('limitClause', () => {
      this.CONSUME(baseLexer.Limit);
      this.OR([
        { ALT: () => this.CONSUME(baseLexer.All) },
        {
          ALT: () => {
            this.CONSUME(baseLexer.NumberLiteral);
            this.OPTION(() => {
              this.CONSUME(baseLexer.Offset);
              this.CONSUME1(baseLexer.NumberLiteral);
            });
          },
        },
      ]);
    });

    this.OVERRIDE_RULE('setOperation', () => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(baseLexer.Union);
            this.OPTION(() => this.CONSUME(baseLexer.All));
            this.OPTION1({
              GATE: () => this.LA(1).tokenType === duckdbLexer.DuckDbBy,
              DEF: () => {
                this.CONSUME(duckdbLexer.DuckDbBy);
                this.CONSUME(baseLexer.Identifier);
              },
            });
          },
        },
        {
          ALT: () => {
            this.CONSUME(baseLexer.Intersect);
            this.OPTION2(() => this.CONSUME1(baseLexer.All));
          },
        },
        {
          ALT: () => {
            this.CONSUME(baseLexer.Except);
            this.OPTION3(() => this.CONSUME2(baseLexer.All));
          },
        },
        { ALT: () => this.CONSUME(baseLexer.MinusSet) },
      ]);
    });

    this.OVERRIDE_RULE('tableSource', () => {
      this.OR([
        { ALT: () => this.SUBRULE(this.subquery) },
        ...this.getAdditionalTableSourceAlternatives(),
        { ALT: () => this.SUBRULE(this.tableName) },
      ]);
      this.OPTION(() => this.SUBRULE(this.duckdbWithOrdinalityClause));
      this.OPTION1({
        GATE: () =>
          this.LA(1).tokenType === duckdbLexer.DuckDbPivot
          || this.LA(1).tokenType === duckdbLexer.DuckDbUnpivot,
        DEF: () => {
          this.OR1([
            { ALT: () => this.SUBRULE(this.duckdbStandardPivotClause) },
            { ALT: () => this.SUBRULE(this.duckdbStandardUnpivotClause) },
          ]);
        },
      });
      this.OPTION2({
        GATE: () => {
          const token1 = this.LA(1).tokenType;
          const token2 = this.LA(2).tokenType;
          const token3 = this.LA(3).tokenType;
          if (
            token1 === baseLexer.Join
            || token1 === baseLexer.Natural
            || token1 === duckdbLexer.DuckDbAsOf
            || token1 === duckdbLexer.DuckDbPositional
            || token1 === duckdbLexer.DuckDbSemi
            || token1 === duckdbLexer.DuckDbAnti
            || token1 === duckdbLexer.DuckDbLateral
            || token1 === duckdbLexer.DuckDbPivot
            || token1 === duckdbLexer.DuckDbUnpivot
            || token1 === duckdbLexer.DuckDbPivotWider
            || token1 === duckdbLexer.DuckDbPivotLonger
            || token1 === duckdbLexer.DuckDbSample
            || token1 === duckdbLexer.DuckDbTableSample
            || token1 === duckdbLexer.DuckDbUsingSample
          ) {
            return false;
          }
          if (
            token1 === baseLexer.Inner
            || token1 === baseLexer.Left
            || token1 === baseLexer.Right
            || token1 === baseLexer.Full
            || token1 === baseLexer.Cross
          ) {
            return token2 !== baseLexer.Join
              && token2 !== duckdbLexer.DuckDbAsOf
              && token2 !== duckdbLexer.DuckDbSemi
              && token2 !== duckdbLexer.DuckDbAnti
              && !(token2 === baseLexer.Outer && token3 === baseLexer.Join);
          }
          return true;
        },
        DEF: () => this.SUBRULE(this.aliasOptional),
      });
      this.OPTION3({
        GATE: () => this.LA(1).tokenType === baseLexer.LParen,
        DEF: () => this.SUBRULE(this.cteColumnList),
      });
      this.OPTION4({
        GATE: () =>
          this.LA(1).tokenType === duckdbLexer.DuckDbSample
          || this.LA(1).tokenType === duckdbLexer.DuckDbTableSample
          || this.LA(1).tokenType === duckdbLexer.DuckDbUsingSample,
        DEF: () => this.SUBRULE(this.duckdbSampleClause),
      });
    });

    this.OVERRIDE_RULE('joinClause', () => {
      let isNaturalJoin = false;
      this.OPTION(() => {
        this.CONSUME(baseLexer.Natural);
        isNaturalJoin = true;
      });
      this.OPTION1(() => {
        this.OR1([
          { ALT: () => this.CONSUME(baseLexer.Inner) },
          { ALT: () => this.CONSUME(baseLexer.Left) },
          { ALT: () => this.CONSUME(baseLexer.Right) },
          { ALT: () => this.CONSUME(baseLexer.Full) },
          { ALT: () => this.CONSUME(baseLexer.Cross) },
          { ALT: () => this.CONSUME(duckdbLexer.DuckDbAsOf) },
          { ALT: () => this.CONSUME(duckdbLexer.DuckDbPositional) },
          { ALT: () => this.CONSUME(duckdbLexer.DuckDbSemi) },
          { ALT: () => this.CONSUME(duckdbLexer.DuckDbAnti) },
        ]);
      });
      this.OPTION2(() => this.CONSUME1(duckdbLexer.DuckDbAsOf));
      this.OPTION3(() => this.CONSUME(baseLexer.Outer));
      this.CONSUME(baseLexer.Join);
      this.SUBRULE(this.tableSource);
      this.OPTION4({
        GATE: () => !isNaturalJoin,
        DEF: () => {
          this.OR2([
            {
              ALT: () => {
                this.CONSUME(baseLexer.On);
                this.SUBRULE(this.expression);
              },
            },
            {
              ALT: () => {
                this.CONSUME(baseLexer.Using);
                this.SUBRULE(this.columnList);
              },
            },
          ]);
        },
      });
    });

    this.OVERRIDE_RULE('starExpression', () => {
      this.OPTION(() => {
        this.CONSUME(baseLexer.Identifier);
        this.CONSUME(baseLexer.Dot);
      });
      this.CONSUME(baseLexer.Multiply);
      this.MANY(() => {
        this.OR([
          {
            GATE: () => this.LA(1).tokenType === baseLexer.Exclude,
            ALT: () => this.SUBRULE(this.duckdbStarExclude),
          },
          {
            GATE: () => this.LA(1).tokenType === baseLexer.Replace,
            ALT: () => this.SUBRULE(this.duckdbStarReplace),
          },
          {
            GATE: () => this.LA(1).tokenType === baseLexer.Rename,
            ALT: () => this.SUBRULE(this.duckdbStarRename),
          },
        ]);
      });
    });

    this.RULE('duckdbWindowClause', () => {
      this.CONSUME(duckdbLexer.DuckDbWindow);
      this.AT_LEAST_ONE_SEP({
        SEP: baseLexer.Comma,
        DEF: () => {
          this.SUBRULE(this.identifier);
          this.CONSUME(baseLexer.As);
          this.CONSUME(baseLexer.LParen);
          this.OPTION(() => this.SUBRULE(this.partitionByClause));
          this.OPTION1(() => this.SUBRULE(this.orderByClause));
          this.OPTION2(() => this.SUBRULE(this.windowFrameClause));
          this.CONSUME(baseLexer.RParen);
        },
      });
    });

    this.OVERRIDE_RULE('selectStatement', () => {
      this.SUBRULE(this.selectClause);
      this.OPTION(() => this.SUBRULE(this.fromClause));
      this.OPTION1(() => this.SUBRULE(this.duckdbWhereAndSampleClause));
      this.OPTION2(() => this.SUBRULE(this.groupByClause));
      this.OPTION3(() => this.SUBRULE(this.havingClause));
      this.OPTION4(() => this.SUBRULE(this.duckdbWindowAndQualifyClause));
      this.OPTION5(() => this.SUBRULE(this.orderByClause));
      this.OPTION6(() => this.SUBRULE(this.limitClause));
      this.OPTION7(() => this.SUBRULE(this.fetchFirstClause));
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

    this.OVERRIDE_RULE('overClause', () => {
      this.CONSUME(baseLexer.Over);
      this.OR([
        {
          ALT: () => {
            this.CONSUME(baseLexer.LParen);
            this.OPTION(() => this.SUBRULE(this.partitionByClause));
            this.OPTION1(() => this.SUBRULE(this.orderByClause));
            this.OPTION2(() => this.SUBRULE(this.windowFrameClause));
            this.CONSUME(baseLexer.RParen);
          },
        },
        { ALT: () => this.SUBRULE(this.identifier) },
      ]);
    });
  }
}

export class SqlParser extends DuckDbSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
  return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
  parserInstance ??= createSqlParserInstance();
  return parserInstance;
}
