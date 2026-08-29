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
    clickhouseSettingValueToken!: AnyRule;
    optimizeStatement!: AnyRule;

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
        ];
    }

    protected getNetezzaIdentifierTokens(): TokenType[] {
        return [
            ...super.getNetezzaIdentifierTokens().filter(token => token !== netezzaLexer.Final),
            clickhouseLexer.BacktickIdentifier,
        ];
    }

    protected getAdditionalStatementAlternatives() {
        return [
            ...super.getAdditionalStatementAlternatives(),
            {
                GATE: () => this.LA(1).tokenType === clickhouseLexer.Optimize,
                ALT: () => this.SUBRULE(this.optimizeStatement),
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

        this.RULE('clickhouseEngineClause', () => {
            this.CONSUME(clickhouseLexer.Engine);
            this.CONSUME(netezzaLexer.Equals);
            this.AT_LEAST_ONE(() => this.SUBRULE(this.commandTailToken));
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
            this.AT_LEAST_ONE(() => this.SUBRULE(this.commandTailToken));
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

        this.OVERRIDE_RULE('selectStatement', () => {
            this.SUBRULE(this.selectClause);
            this.OPTION(() => this.SUBRULE(this.fromClause));
            this.OPTION1(() => this.SUBRULE(this.prewhereClause));
            this.OPTION2(() => this.SUBRULE(this.whereClause));
            this.OPTION3(() => this.SUBRULE(this.arrayJoinClause));
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
            this.OPTION2(() => this.SUBRULE(this.withFillClause));
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
