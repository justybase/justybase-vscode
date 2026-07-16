import { TokenType } from 'chevrotain';
import type { SqlParser } from '../parser';

export interface QueryClauseComparisonTokens {
    OrderBy: TokenType;
    Comma: TokenType;
    Asc: TokenType;
    Desc: TokenType;
    Nulls: TokenType;
    First: TokenType;
    Identifier: TokenType;
    Limit: TokenType;
    NumberLiteral: TokenType;
    Offset: TokenType;
    Fetch: TokenType;
    Rows: TokenType;
    Row: TokenType;
    Only: TokenType;
    Or: TokenType;
    And: TokenType;
    Not: TokenType;
    Equals: TokenType;
    NotEquals: TokenType;
    LessThan: TokenType;
    GreaterThan: TokenType;
    LessThanEquals: TokenType;
    GreaterThanEquals: TokenType;
    Like: TokenType;
    Ilike: TokenType;
    Escape: TokenType;
    In: TokenType;
    Between: TokenType;
    Is: TokenType;
    Null: TokenType;
    IsNull: TokenType;
    NotNull: TokenType;
    Any: TokenType;
    Some: TokenType;
    All: TokenType;
    LParen: TokenType;
    RParen: TokenType;
}

type RuleRef = () => unknown;

interface ParserDsl {
    RULE(name: string, impl: () => void): void;
    CONSUME(token: TokenType): void;
    CONSUME1(token: TokenType): void;
    CONSUME2(token: TokenType): void;
    CONSUME3(token: TokenType): void;
    CONSUME4(token: TokenType): void;
    OPTION(def: () => void): void;
    OPTION1(def: () => void): void;
    OPTION2(def: () => void): void;
    OPTION3(def: () => void): void;
    OPTION4(def: () => void): void;
    MANY(def: () => void): void;
    OR(alts: Array<{ ALT: () => void; GATE?: () => boolean }>): void;
    OR1(alts: Array<{ ALT: () => void; GATE?: () => boolean }>): void;
    OR2(alts: Array<{ ALT: () => void; GATE?: () => boolean }>): void;
    AT_LEAST_ONE_SEP(def: { SEP: TokenType; DEF: () => void }): void;
    SUBRULE(rule: RuleRef): void;
    SUBRULE1(rule: RuleRef): void;
    SUBRULE2(rule: RuleRef): void;
    SUBRULE3(rule: RuleRef): void;
    SUBRULE4(rule: RuleRef): void;
    SUBRULE5(rule: RuleRef): void;
    SUBRULE6(rule: RuleRef): void;
    SUBRULE7(rule: RuleRef): void;
    SUBRULE8(rule: RuleRef): void;
    LA(howMuch: number): { tokenType: TokenType };
    orderByItem: RuleRef;
    expression: RuleRef;
    orExpression: RuleRef;
    andExpression: RuleRef;
    notExpression: RuleRef;
    comparisonExpression: RuleRef;
    additiveExpression: RuleRef;
    comparisonRhs: RuleRef;
    inExpression: RuleRef;
    betweenExpression: RuleRef;
    isExpression: RuleRef;
    selectStatement: RuleRef;
    withStatement: RuleRef;
}

export function registerQueryClauseComparisonRules(parser: SqlParser, tokens: QueryClauseComparisonTokens): void {
    const p = parser as unknown as ParserDsl;
    const {
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
        Escape,
        In,
        Between,
        Is,
        Null,
        IsNull,
        NotNull,
        Any,
        Some,
        All,
        LParen,
        RParen
    } = tokens;

    p.RULE('orderByClause', () => {
        p.CONSUME(OrderBy);
        p.AT_LEAST_ONE_SEP({
            SEP: Comma,
            DEF: () => {
                p.SUBRULE(p.orderByItem);
            }
        });
    });

    p.RULE('orderByItem', () => {
        p.SUBRULE(p.expression);
        p.OPTION(() => p.OR([
            { ALT: () => p.CONSUME(Asc) },
            { ALT: () => p.CONSUME(Desc) }
        ]));
        p.OPTION1(() => {
            p.CONSUME(Nulls);
            p.OR1([
                { ALT: () => p.CONSUME(First) },
                { ALT: () => p.CONSUME(Identifier) }
            ]);
        });
    });

    p.RULE('limitClause', () => {
        p.CONSUME(Limit);
        p.CONSUME(NumberLiteral);
        p.OPTION(() => {
            p.CONSUME(Offset);
            p.CONSUME1(NumberLiteral);
        });
    });

    p.RULE('fetchFirstClause', () => {
        p.CONSUME(Fetch);
        p.CONSUME(First);
        p.OPTION(() => p.CONSUME(NumberLiteral));
        p.OR([
            { ALT: () => p.CONSUME(Rows) },
            { ALT: () => p.CONSUME(Row) }
        ]);
        p.CONSUME(Only);
    });

    p.RULE('expression', () => {
        p.SUBRULE(p.orExpression);
    });

    p.RULE('orExpression', () => {
        p.SUBRULE(p.andExpression);
        p.MANY(() => {
            p.CONSUME(Or);
            p.SUBRULE1(p.andExpression);
        });
    });

    p.RULE('andExpression', () => {
        p.SUBRULE(p.notExpression);
        p.MANY(() => {
            p.CONSUME(And);
            p.SUBRULE1(p.notExpression);
        });
    });

    p.RULE('notExpression', () => {
        p.OPTION(() => p.CONSUME(Not));
        p.SUBRULE(p.comparisonExpression);
    });

    p.RULE('comparisonExpression', () => {
        p.SUBRULE(p.additiveExpression);
        p.OPTION(() => {
            p.OR1([
                {
                    ALT: () => {
                        p.CONSUME(Equals);
                        p.SUBRULE(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(NotEquals);
                        p.SUBRULE1(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(LessThan);
                        p.SUBRULE2(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(GreaterThan);
                        p.SUBRULE3(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(LessThanEquals);
                        p.SUBRULE4(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(GreaterThanEquals);
                        p.SUBRULE5(p.comparisonRhs);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(Like);
                        p.SUBRULE1(p.additiveExpression);
                        p.OPTION1(() => {
                            p.CONSUME(Escape);
                            p.SUBRULE2(p.additiveExpression);
                        });
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME(Ilike);
                        p.SUBRULE3(p.additiveExpression);
                        p.OPTION2(() => {
                            p.CONSUME1(Escape);
                            p.SUBRULE4(p.additiveExpression);
                        });
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME1(Not);
                        p.CONSUME1(Like);
                        p.SUBRULE5(p.additiveExpression);
                        p.OPTION3(() => {
                            p.CONSUME2(Escape);
                            p.SUBRULE6(p.additiveExpression);
                        });
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME2(Not);
                        p.CONSUME1(Ilike);
                        p.SUBRULE7(p.additiveExpression);
                        p.OPTION4(() => {
                            p.CONSUME3(Escape);
                            p.SUBRULE8(p.additiveExpression);
                        });
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME3(Not);
                        p.SUBRULE(p.inExpression);
                    }
                },
                {
                    ALT: () => {
                        p.CONSUME4(Not);
                        p.SUBRULE1(p.betweenExpression);
                    }
                },
                { ALT: () => p.SUBRULE1(p.inExpression) },
                { ALT: () => p.SUBRULE2(p.betweenExpression) },
                { ALT: () => p.SUBRULE3(p.isExpression) },
                { ALT: () => p.CONSUME(NotNull) },
                { ALT: () => p.CONSUME(IsNull) }
            ]);
        });
    });

    p.RULE('comparisonRhs', () => {
        p.OR([
            {
                GATE: () => {
                    const t = p.LA(1).tokenType;
                    return (t === Any || t === Some || t === All) && p.LA(2).tokenType === LParen;
                },
                ALT: () => {
                    p.OR1([
                        { ALT: () => p.CONSUME(Any) },
                        { ALT: () => p.CONSUME(Some) },
                        { ALT: () => p.CONSUME(All) }
                    ]);
                    p.CONSUME(LParen);
                    p.OR2([
                        { ALT: () => p.SUBRULE(p.selectStatement) },
                        { ALT: () => p.SUBRULE(p.withStatement) }
                    ]);
                    p.CONSUME(RParen);
                }
            },
            { ALT: () => p.SUBRULE(p.additiveExpression) }
        ]);
    });

    p.RULE('inExpression', () => {
        p.CONSUME(In);
        p.CONSUME(LParen);
        p.OR([
            { ALT: () => p.AT_LEAST_ONE_SEP({ SEP: Comma, DEF: () => p.SUBRULE(p.expression) }) },
            {
                ALT: () => p.OR1([
                    { ALT: () => p.SUBRULE(p.selectStatement) },
                    { ALT: () => p.SUBRULE(p.withStatement) }
                ])
            }
        ]);
        p.CONSUME(RParen);
    });

    p.RULE('betweenExpression', () => {
        p.CONSUME(Between);
        p.SUBRULE(p.additiveExpression);
        p.CONSUME(And);
        p.SUBRULE1(p.additiveExpression);
    });

    p.RULE('isExpression', () => {
        p.CONSUME(Is);
        p.OPTION(() => p.CONSUME(Not));
        p.OR([
            { ALT: () => p.CONSUME(Null) },
            { ALT: () => p.CONSUME(Identifier) }
        ]);
    });
}
