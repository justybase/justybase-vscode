import type { CstNode, TokenType } from 'chevrotain';
import * as netezzaLexer from '../../netezza/sql/lexer';
import * as clickhouseLexer from './lexer';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

/**
 * High-frequency ClickHouse SQL grammar layered on the shared CST grammar.
 * ClickHouse's engine and SETTINGS clauses intentionally remain token-based;
 * this keeps the parser strict around statement boundaries without pretending
 * to model every version-specific engine argument.
 */
export class ClickHouseSqlParser extends NetezzaSqlParser {
    prewhereClause!: AnyRule;
    arrayJoinClause!: AnyRule;
    sampleClause!: AnyRule;
    qualifyClause!: AnyRule;
    withFillClause!: AnyRule;
    clickhouseTableOptions!: AnyRule;
    clickhouseEngineClause!: AnyRule;
    clickhousePartitionClause!: AnyRule;
    clickhousePrimaryKeyClause!: AnyRule;
    clickhouseOrderByClause!: AnyRule;
    clickhouseSampleByClause!: AnyRule;
    clickhouseTtlClause!: AnyRule;
    clickhouseSettingsClause!: AnyRule;
    optionalClickhouseSettingsClause!: AnyRule;
    clickhouseSettingValueToken!: AnyRule;
    clickhouseStorageExpressionToken!: AnyRule;
    optimizeStatement!: AnyRule;
    systemStatement!: AnyRule;
    killQueryStatement!: AnyRule;

    public constructor() {
        super(clickhouseLexer);
    }

    protected supportsEmptyQualifiedNameSegment(): boolean {
        return false;
    }

    protected getNetezzaRelaxedNameTokens(): TokenType[] {
        return [
            ...super.getNetezzaRelaxedNameTokens().filter(token => token !== netezzaLexer.Final),
            clickhouseLexer.BacktickIdentifier,
            clickhouseLexer.AsOf,
            clickhouseLexer.Anti,
            clickhouseLexer.Semi,
            clickhouseLexer.System,
            clickhouseLexer.Kill,
            clickhouseLexer.Query,
        ];
    }

    protected getNetezzaIdentifierTokens(): TokenType[] {
        return [
            ...super.getNetezzaIdentifierTokens().filter(token => token !== netezzaLexer.Final),
            clickhouseLexer.BacktickIdentifier,
            clickhouseLexer.AsOf,
            clickhouseLexer.Anti,
            clickhouseLexer.Semi,
            clickhouseLexer.System,
            clickhouseLexer.Kill,
            clickhouseLexer.Query,
        ];
    }

    protected getAdditionalStatementAlternatives() {
        return [
            ...super.getAdditionalStatementAlternatives(),
            {
                GATE: () => this.LA(1).tokenType === clickhouseLexer.Optimize,
                ALT: () => this.SUBRULE(this.optimizeStatement),
            },
            {
                GATE: () => this.LA(1).tokenType === clickhouseLexer.System,
                ALT: () => this.SUBRULE(this.systemStatement),
            },
            {
                GATE: () => this.LA(1).tokenType === clickhouseLexer.Kill
                    && this.LA(2).tokenType === clickhouseLexer.Query,
                ALT: () => this.SUBRULE(this.killQueryStatement),
            },
        ];
    }

    protected getAdditionalTableSourceAlternatives() {
        // The Netezza-only TABLE WITH FINAL(...) table function conflicts with
        // ClickHouse's ordinary FINAL table modifier and is not valid here.
        return [];
    }

    protected registerDialectExtensions(): void {
        this.RULE('prewhereClause', () => {
            this.CONSUME(clickhouseLexer.Prewhere);
            this.SUBRULE(this.expression);
        });

        this.RULE('arrayJoinClause', () => {
            this.CONSUME(clickhouseLexer.ArrayJoin);
            this.AT_LEAST_ONE_SEP({
                SEP: netezzaLexer.Comma,
                DEF: () => this.SUBRULE(this.expression),
            });
        });

        this.RULE('sampleClause', () => {
            this.CONSUME(clickhouseLexer.Sample);
            this.SUBRULE(this.expression);
            this.OPTION(() => {
                this.CONSUME(netezzaLexer.Offset);
                this.SUBRULE1(this.expression);
            });
        });

        this.RULE('qualifyClause', () => {
            this.CONSUME(clickhouseLexer.Qualify);
            this.SUBRULE(this.expression);
        });

        this.RULE('withFillClause', () => {
            this.CONSUME(netezzaLexer.With);
            this.CONSUME(clickhouseLexer.Fill);
            this.OPTION(() => {
                this.CONSUME(netezzaLexer.From);
                this.SUBRULE(this.expression);
            });
            this.OPTION1(() => {
                this.CONSUME(netezzaLexer.To);
                this.SUBRULE1(this.expression);
            });
            this.OPTION2(() => {
                this.CONSUME(clickhouseLexer.Step);
                this.SUBRULE2(this.expression);
            });
        });

        // Storage engines and TTL clauses are expression-like, but their
        // arguments must stop before structural ClickHouse clauses such as
        // AS, TO, ORDER BY, or SETTINGS. The shared command-tail rule treats
        // some of those words as identifiers, which is too greedy for
        // CREATE MATERIALIZED VIEW ... ENGINE ... AS SELECT ... .
        this.RULE('clickhouseStorageExpressionToken', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.netezzaRelaxedName) },
                { ALT: () => this.CONSUME(netezzaLexer.To) },
                { ALT: () => this.CONSUME(netezzaLexer.NumberLiteral) },
                { ALT: () => this.CONSUME(netezzaLexer.StringLiteral) },
                { ALT: () => this.CONSUME(netezzaLexer.Equals) },
                { ALT: () => this.CONSUME(netezzaLexer.Plus) },
                { ALT: () => this.CONSUME(netezzaLexer.Minus) },
                { ALT: () => this.CONSUME(netezzaLexer.Multiply) },
                { ALT: () => this.CONSUME(netezzaLexer.Divide) },
                { ALT: () => this.CONSUME(netezzaLexer.Dot) },
                { ALT: () => this.CONSUME(netezzaLexer.Comma) },
                { ALT: () => this.CONSUME(netezzaLexer.LParen) },
                { ALT: () => this.CONSUME(netezzaLexer.RParen) },
                { ALT: () => this.CONSUME(netezzaLexer.LBracket) },
                { ALT: () => this.CONSUME(netezzaLexer.RBracket) },
            ]);
        });

        this.RULE('clickhouseEngineClause', () => {
            this.CONSUME(clickhouseLexer.Engine);
            this.CONSUME(netezzaLexer.Equals);
            this.AT_LEAST_ONE(() => this.SUBRULE(this.clickhouseStorageExpressionToken));
        });

        this.RULE('clickhousePartitionClause', () => {
            this.CONSUME(netezzaLexer.PartitionBy);
            this.SUBRULE(this.expression);
        });

        this.RULE('clickhousePrimaryKeyClause', () => {
            this.CONSUME(netezzaLexer.Primary);
            this.CONSUME(netezzaLexer.Key);
            this.SUBRULE(this.expression);
        });

        this.RULE('clickhouseOrderByClause', () => {
            this.CONSUME(netezzaLexer.OrderBy);
            this.SUBRULE(this.expression);
        });

        this.RULE('clickhouseSampleByClause', () => {
            this.CONSUME(clickhouseLexer.Sample);
            this.CONSUME(clickhouseLexer.By);
            this.SUBRULE(this.expression);
        });

        this.RULE('clickhouseTtlClause', () => {
            this.CONSUME(clickhouseLexer.Ttl);
            this.AT_LEAST_ONE(() => this.SUBRULE(this.clickhouseStorageExpressionToken));
        });

        this.RULE('clickhouseSettingValueToken', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.identifier) },
                { ALT: () => this.CONSUME(netezzaLexer.NumberLiteral) },
                { ALT: () => this.CONSUME(netezzaLexer.StringLiteral) },
                { ALT: () => this.CONSUME(netezzaLexer.LParen) },
                { ALT: () => this.CONSUME(netezzaLexer.RParen) },
                { ALT: () => this.CONSUME(netezzaLexer.Plus) },
                { ALT: () => this.CONSUME(netezzaLexer.Minus) },
            ]);
        });

        // ClickHouse types are recursive: Array(Nullable(UInt64)), Map(String,
        // Array(DateTime64(3))), and named Tuple members are all common in
        // production schemas. Reuse the shared typeName/typeNameWord CST
        // shape so existing visitors and DDL analysis retain type information.
        this.OVERRIDE_RULE('typeArgument', () => {
            this.OR([
                { ALT: () => this.CONSUME(netezzaLexer.StringLiteral) },
                { ALT: () => this.CONSUME(netezzaLexer.NumberLiteral) },
                { ALT: () => this.SUBRULE(this.typeName) },
            ]);
            this.OPTION(() => {
                this.CONSUME(netezzaLexer.Equals);
                this.OR1([
                    { ALT: () => this.CONSUME1(netezzaLexer.StringLiteral) },
                    { ALT: () => this.CONSUME1(netezzaLexer.NumberLiteral) },
                    { ALT: () => this.SUBRULE1(this.typeName) },
                ]);
            });
        });

        this.RULE('clickhouseSettingsClause', () => {
            this.CONSUME(clickhouseLexer.Settings);
            this.AT_LEAST_ONE_SEP({
                SEP: netezzaLexer.Comma,
                DEF: () => {
                    this.SUBRULE(this.identifier);
                    this.CONSUME(netezzaLexer.Equals);
                    this.AT_LEAST_ONE(() => this.SUBRULE(this.clickhouseSettingValueToken));
                },
            });
        });

        this.RULE('optionalClickhouseSettingsClause', () => {
            this.OPTION(() => this.SUBRULE(this.clickhouseSettingsClause));
        });

        this.RULE('clickhouseTableOptions', () => {
            this.MANY(() => {
                this.OR([
                    {
                        GATE: () => this.LA(1).tokenType === clickhouseLexer.Engine,
                        ALT: () => this.SUBRULE(this.clickhouseEngineClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === netezzaLexer.PartitionBy,
                        ALT: () => this.SUBRULE(this.clickhousePartitionClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === netezzaLexer.Primary,
                        ALT: () => this.SUBRULE(this.clickhousePrimaryKeyClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === netezzaLexer.OrderBy,
                        ALT: () => this.SUBRULE(this.clickhouseOrderByClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === clickhouseLexer.Sample,
                        ALT: () => this.SUBRULE(this.clickhouseSampleByClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === clickhouseLexer.Ttl,
                        ALT: () => this.SUBRULE(this.clickhouseTtlClause),
                    },
                    {
                        GATE: () => this.LA(1).tokenType === clickhouseLexer.Settings,
                        ALT: () => this.SUBRULE(this.clickhouseSettingsClause),
                    },
                ]);
            });
        });

        this.RULE('optimizeStatement', () => {
            this.CONSUME(clickhouseLexer.Optimize);
            this.OPTION(() => this.CONSUME(netezzaLexer.Table));
            this.SUBRULE(this.qualifiedName);
            this.OPTION1(() => this.CONSUME(netezzaLexer.Final));
            this.OPTION2(() => this.SUBRULE(this.commandTail));
        });

        this.RULE('systemStatement', () => {
            this.CONSUME(clickhouseLexer.System);
            this.SUBRULE(this.commandTail);
        });

        this.RULE('killQueryStatement', () => {
            this.CONSUME(clickhouseLexer.Kill);
            this.CONSUME(clickhouseLexer.Query);
            this.SUBRULE(this.commandTail);
        });

        this.OVERRIDE_RULE('joinClause', () => {
            let isNaturalJoin = false;
            this.OPTION(() => {
                this.CONSUME(netezzaLexer.Natural);
                isNaturalJoin = true;
            });
            this.OPTION1(() => {
                this.OR([
                    { ALT: () => this.CONSUME(netezzaLexer.Global) },
                    { ALT: () => this.CONSUME(netezzaLexer.Any) },
                    { ALT: () => this.CONSUME(netezzaLexer.All) },
                    { ALT: () => this.CONSUME(clickhouseLexer.Anti) },
                    { ALT: () => this.CONSUME(clickhouseLexer.Semi) },
                    { ALT: () => this.CONSUME(clickhouseLexer.AsOf) },
                ]);
            });
            this.OPTION2(() => {
                this.OR1([
                    { ALT: () => this.CONSUME(netezzaLexer.Inner) },
                    { ALT: () => this.CONSUME(netezzaLexer.Left) },
                    { ALT: () => this.CONSUME(netezzaLexer.Right) },
                    { ALT: () => this.CONSUME(netezzaLexer.Full) },
                    { ALT: () => this.CONSUME(netezzaLexer.Cross) },
                ]);
            });
            this.OPTION3(() => this.CONSUME(netezzaLexer.Outer));
            this.CONSUME(netezzaLexer.Join);
            this.SUBRULE(this.tableSource);
            this.OPTION4({
                GATE: () => !isNaturalJoin,
                DEF: () => this.OR2([
                    {
                        ALT: () => {
                            this.CONSUME(netezzaLexer.On);
                            this.SUBRULE(this.expression);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(netezzaLexer.Using);
                            this.SUBRULE(this.columnList);
                        },
                    },
                ]),
            });
        });

        this.OVERRIDE_RULE('tableSource', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.subquery) },
                ...this.getAdditionalTableSourceAlternatives(),
                { ALT: () => this.SUBRULE(this.tableName) },
            ]);
            this.OPTION({
                GATE: () => this.LA(1).tokenType === netezzaLexer.Final,
                DEF: () => this.CONSUME(netezzaLexer.Final),
            });
            this.OPTION1({
                GATE: () => this.LA(1).tokenType === clickhouseLexer.Sample,
                DEF: () => this.SUBRULE(this.sampleClause),
            });
            this.OPTION2({
                GATE: () => {
                    const token = this.LA(1).tokenType;
                    return token !== netezzaLexer.Join
                        && token !== netezzaLexer.Natural
                        && token !== netezzaLexer.Inner
                        && token !== netezzaLexer.Left
                        && token !== netezzaLexer.Right
                        && token !== netezzaLexer.Full
                        && token !== netezzaLexer.Cross
                        && token !== netezzaLexer.Global
                        && token !== netezzaLexer.Any
                        && token !== netezzaLexer.All
                        && token !== clickhouseLexer.AsOf
                        && token !== clickhouseLexer.Anti
                        && token !== clickhouseLexer.Semi
                        && token !== clickhouseLexer.Prewhere
                        && token !== clickhouseLexer.ArrayJoin
                        && token !== clickhouseLexer.Sample
                        && token !== clickhouseLexer.Qualify
                        && token !== netezzaLexer.Where
                        && token !== netezzaLexer.GroupBy
                        && token !== netezzaLexer.Having
                        && token !== netezzaLexer.OrderBy
                        && token !== netezzaLexer.Limit
                        && token !== netezzaLexer.Fetch
                        && token !== netezzaLexer.Union
                        && token !== netezzaLexer.Intersect
                        && token !== netezzaLexer.Except;
                },
                DEF: () => this.SUBRULE(this.aliasOptional),
            });
        });

        this.OVERRIDE_RULE('createViewStatement', () => {
            let isMaterializedView = false;
            this.CONSUME(netezzaLexer.Create);
            this.OPTION(() => {
                this.CONSUME(netezzaLexer.Or);
                this.CONSUME(netezzaLexer.Replace);
            });
            this.OPTION1(() => {
                this.CONSUME(netezzaLexer.Materialized);
                isMaterializedView = true;
            });
            this.CONSUME(netezzaLexer.View);
            this.OPTION2(() => {
                this.CONSUME(netezzaLexer.If);
                this.CONSUME(netezzaLexer.Not);
                this.CONSUME(netezzaLexer.Exists);
            });
            this.SUBRULE(this.qualifiedName);
            this.OPTION3(() => this.SUBRULE(this.viewColumnAliasList));
            this.OPTION4({
                GATE: () => isMaterializedView && this.LA(1).tokenType === netezzaLexer.To,
                DEF: () => {
                    this.CONSUME(netezzaLexer.To);
                    this.SUBRULE1(this.qualifiedName);
                },
            });
            this.OPTION5(() => this.SUBRULE(this.clickhouseTableOptions));
            this.OPTION6({
                GATE: () => isMaterializedView && this.LA(1).tokenType === clickhouseLexer.Populate,
                DEF: () => this.CONSUME(clickhouseLexer.Populate),
            });
            this.CONSUME(netezzaLexer.As);
            this.OR([
                {
                    ALT: () => {
                        this.CONSUME(netezzaLexer.LParen);
                        this.OR1([
                            { ALT: () => this.SUBRULE(this.withStatement) },
                            { ALT: () => this.SUBRULE(this.selectStatement) },
                        ]);
                        this.CONSUME1(netezzaLexer.RParen);
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

        this.OVERRIDE_RULE('selectStatement', () => {
            this.SUBRULE(this.selectClause);
            this.OPTION(() => this.SUBRULE(this.fromClause));
            this.OPTION1(() => this.SUBRULE(this.arrayJoinClause));
            this.OPTION2(() => this.SUBRULE(this.prewhereClause));
            this.OPTION3(() => this.SUBRULE(this.whereClause));
            this.OPTION4(() => this.SUBRULE(this.groupByClause));
            this.OPTION5(() => this.SUBRULE(this.havingClause));
            this.OPTION6(() => this.SUBRULE(this.qualifyClause));
            this.OPTION7(() => this.SUBRULE(this.orderByClause));
            this.OPTION8(() => this.SUBRULE(this.limitClause));
            this.OPTION9(() => this.SUBRULE(this.fetchFirstClause));
            this.MANY(() => {
                this.SUBRULE(this.setOperation);
                this.OR7([
                    {
                        ALT: () => {
                            this.CONSUME(netezzaLexer.LParen);
                            this.OR8([
                                { ALT: () => this.SUBRULE1(this.withStatement) },
                                { ALT: () => this.SUBRULE1(this.selectStatement) },
                            ]);
                            this.CONSUME1(netezzaLexer.RParen);
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
            this.SUBRULE(this.optionalClickhouseSettingsClause);
        });

        this.OVERRIDE_RULE('orderByClause', () => {
            this.CONSUME(netezzaLexer.OrderBy);
            this.AT_LEAST_ONE_SEP({
                SEP: netezzaLexer.Comma,
                DEF: () => {
                    this.SUBRULE(this.orderByItem);
                    this.OPTION(() => this.SUBRULE(this.withFillClause));
                },
            });
        });

        this.OVERRIDE_RULE('limitClause', () => {
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
            this.OPTION1(() => {
                this.CONSUME(clickhouseLexer.By);
                this.AT_LEAST_ONE_SEP({
                    SEP: netezzaLexer.Comma,
                    DEF: () => this.SUBRULE(this.expression),
                });
            });
            this.OPTION2(() => {
                this.CONSUME(netezzaLexer.With);
                this.CONSUME(netezzaLexer.Ties);
            });
        });

        this.OVERRIDE_RULE('insertStatement', () => {
            this.CONSUME(netezzaLexer.Insert);
            this.OPTION(() => this.CONSUME(netezzaLexer.Into));
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
                {
                    ALT: () => {
                        this.CONSUME(clickhouseLexer.Format);
                        this.SUBRULE(this.commandTail);
                    },
                },
            ]);
        });

        this.OVERRIDE_RULE('alterTableStatement', () => {
            this.CONSUME(netezzaLexer.Alter);
            this.CONSUME(netezzaLexer.Table);
            this.SUBRULE(this.qualifiedName);
            this.SUBRULE(this.commandTail);
        });
    }

    protected registerCreateTableDialectClauses(): void {
        this.OPTION7(() => this.SUBRULE(this.clickhouseTableOptions));
    }
}

export class SqlParser extends ClickHouseSqlParser {}

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
    getBaseCstVisitorConstructor(): ReturnType<SqlParser['getBaseCstVisitorConstructor']> {
        return getSqlParserInstance().getBaseCstVisitorConstructor();
    },
    getBaseCstVisitorConstructorWithDefaults(): ReturnType<SqlParser['getBaseCstVisitorConstructorWithDefaults']> {
        return getSqlParserInstance().getBaseCstVisitorConstructorWithDefaults();
    },
    getSerializedGastProductions(): ReturnType<SqlParser['getSerializedGastProductions']> {
        return getSqlParserInstance().getSerializedGastProductions();
    },
} as unknown as SqlParser;
