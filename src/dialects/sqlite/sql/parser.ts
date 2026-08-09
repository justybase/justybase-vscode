import type { CstNode, TokenType } from 'chevrotain';
import { BaseSqlParser } from '../../../sqlParser/BaseSqlParser';
import * as baseLexer from '../../netezza/sql/lexer';
import * as sqliteLexer from './lexer';

type AnyRule = () => CstNode;

/**
 * SQLite parser layered on the shared ANSI CST grammar.
 *
 * The shared lexer contains a superset of SQL tokens for compatibility with
 * the other dialects, but this parser deliberately exposes only SQLite
 * statements at the top level.  That prevents Netezza-only statements from
 * silently becoming valid SQLite SQL while retaining the CST rule names used
 * by completion and validation.
 */
export class SqliteSqlParser extends BaseSqlParser {
    sqliteCreateIndexStatement!: AnyRule;
    sqliteCreateTriggerStatement!: AnyRule;
    sqliteTriggerBodyStatement!: AnyRule;
    sqlitePragmaStatement!: AnyRule;
    sqliteAttachStatement!: AnyRule;
    sqliteDetachStatement!: AnyRule;
    sqliteVacuumStatement!: AnyRule;
    sqliteAnalyzeStatement!: AnyRule;
    sqliteSavepointStatement!: AnyRule;
    sqliteReleaseStatement!: AnyRule;
    sqlitePragmaValue!: AnyRule;
    sqliteUpsertClause!: AnyRule;
    sqliteReturningClause!: AnyRule;
    sqliteConflictAction!: AnyRule;
    sqliteDropObject!: AnyRule;
    sqliteAlterTableAction!: AnyRule;
    sqliteRelaxedName!: AnyRule;
    sqliteWindowClause!: AnyRule;
    sqliteWindowSpec!: AnyRule;
    sqliteVirtualTableModuleArg!: AnyRule;

    public constructor() {
        super(sqliteLexer);

        this.registerSqliteRules();
        this.overrideSqliteRules();
        this.finalizeParser();
    }

    protected supportsEmptyQualifiedNameSegment(): boolean {
        return false;
    }

    private isCreateTarget(target: TokenType): boolean {
        const first = this.LA(2).tokenType;
        if (first === target) {
            return true;
        }

        if (first === baseLexer.Temp || first === baseLexer.Temporary) {
            return this.LA(3).tokenType === target
                || (this.LA(3).tokenType === sqliteLexer.Virtual
                    && this.LA(4).tokenType === target);
        }

        if (first === sqliteLexer.Virtual) {
            return this.LA(3).tokenType === target;
        }

        return target === sqliteLexer.Index
            && first === baseLexer.Unique
            && this.LA(3).tokenType === sqliteLexer.Index;
    }

    /** SQLite non-reserved keyword tokens usable as identifiers/object names. */
    private getSqliteIdentifierTokens(): TokenType[] {
        return [
            baseLexer.Identifier,
            baseLexer.QuotedIdentifier,
            sqliteLexer.Rowid,
            sqliteLexer.IntType,
            sqliteLexer.DoubleType,
            sqliteLexer.Always,
            sqliteLexer.Stored,
            sqliteLexer.Strict,
            sqliteLexer.Autoincrement,
            sqliteLexer.Returning,
            sqliteLexer.Analyze,
            sqliteLexer.Vacuum,
        ];
    }

    /**
     * True when a token can follow a table name as a clause keyword instead
     * of being consumed as an alias (some clause keywords are non-reserved
     * and therefore also valid identifier tokens).
     */
    private canFollowTableAlias(): boolean {
        const tokenType = this.LA(1).tokenType;
        return tokenType !== baseLexer.Set
            && tokenType !== baseLexer.Where
            && tokenType !== baseLexer.OrderBy
            && tokenType !== baseLexer.Limit
            && tokenType !== baseLexer.Offset
            && tokenType !== sqliteLexer.Returning;
    }

    private overrideSqliteRules(): void {
        this.OVERRIDE_RULE('statement', () => {
            this.OR([
                {
                    GATE: () => this.isCreateTarget(baseLexer.Table),
                    ALT: () => this.SUBRULE(this.createTableStatement),
                },
                {
                    GATE: () => this.isCreateTarget(baseLexer.View),
                    ALT: () => this.SUBRULE(this.createViewStatement),
                },
                {
                    GATE: () => this.isCreateTarget(sqliteLexer.Index),
                    ALT: () => this.SUBRULE(this.sqliteCreateIndexStatement),
                },
                {
                    GATE: () => this.isCreateTarget(sqliteLexer.Trigger),
                    ALT: () => this.SUBRULE(this.sqliteCreateTriggerStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Alter,
                    ALT: () => this.SUBRULE(this.alterTableStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Drop,
                    ALT: () => this.SUBRULE(this.dropStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Explain,
                    ALT: () => this.SUBRULE(this.explainStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Pragma,
                    ALT: () => this.SUBRULE(this.sqlitePragmaStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Attach,
                    ALT: () => this.SUBRULE(this.sqliteAttachStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Detach,
                    ALT: () => this.SUBRULE(this.sqliteDetachStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Vacuum,
                    ALT: () => this.SUBRULE(this.sqliteVacuumStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Analyze,
                    ALT: () => this.SUBRULE(this.sqliteAnalyzeStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Savepoint,
                    ALT: () => this.SUBRULE(this.sqliteSavepointStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === sqliteLexer.Release,
                    ALT: () => this.SUBRULE(this.sqliteReleaseStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.With,
                    ALT: () => this.SUBRULE(this.withAnyStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Select,
                    ALT: () => this.SUBRULE(this.selectStatement),
                },
                {
                    GATE: () =>
                        this.LA(1).tokenType === baseLexer.Insert
                        || this.LA(1).tokenType === baseLexer.Replace,
                    ALT: () => this.SUBRULE(this.insertStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Update,
                    ALT: () => this.SUBRULE(this.updateStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Delete,
                    ALT: () => this.SUBRULE(this.deleteStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Begin,
                    ALT: () => this.SUBRULE(this.beginStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Commit,
                    ALT: () => this.SUBRULE(this.commitStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Rollback,
                    ALT: () => this.SUBRULE(this.rollbackStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Reindex,
                    ALT: () => this.SUBRULE(this.reindexStatement),
                },
            ]);
        });

        this.OVERRIDE_RULE('createTableStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => this.SUBRULE(this.tableTypeClause));
            this.OPTION1(() => this.CONSUME(sqliteLexer.Virtual));
            this.CONSUME(baseLexer.Table);
            this.OPTION2(() => {
                this.CONSUME(baseLexer.If);
                this.CONSUME(baseLexer.Not);
                this.CONSUME(baseLexer.Exists);
            });
            this.SUBRULE(this.qualifiedName);
            this.OR([
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Using,
                    ALT: () => {
                        this.CONSUME(baseLexer.Using);
                        this.SUBRULE1(this.qualifiedName);
                        this.OPTION3(() => {
                            this.CONSUME2(baseLexer.LParen);
                            this.AT_LEAST_ONE_SEP({
                                SEP: baseLexer.Comma,
                                DEF: () => this.SUBRULE(this.sqliteVirtualTableModuleArg),
                            });
                            this.CONSUME2(baseLexer.RParen);
                        });
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.As);
                        this.OR1([
                            {
                                ALT: () => {
                                    this.CONSUME(baseLexer.LParen);
                                    this.OR2([
                                        { ALT: () => this.SUBRULE(this.withStatement) },
                                        { ALT: () => this.SUBRULE(this.selectStatement) },
                                    ]);
                                    this.CONSUME(baseLexer.RParen);
                                },
                            },
                            {
                                ALT: () => this.SUBRULE1(this.selectStatement),
                            },
                        ]);
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME1(baseLexer.LParen);
                        this.SUBRULE(this.columnDefinitionList);
                        this.CONSUME1(baseLexer.RParen);
                    },
                },
            ]);
            this.OPTION4(() => {
                this.CONSUME(sqliteLexer.Without);
                this.CONSUME(sqliteLexer.Rowid);
            });
            this.OPTION5(() => this.CONSUME(sqliteLexer.Strict));
        });

        this.OVERRIDE_RULE('createViewStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => this.SUBRULE(this.tableTypeClause));
            this.CONSUME(baseLexer.View);
            this.OPTION1(() => {
                this.CONSUME(baseLexer.If);
                this.CONSUME(baseLexer.Not);
                this.CONSUME(baseLexer.Exists);
            });
            this.SUBRULE(this.qualifiedName);
            this.OPTION2(() => this.SUBRULE(this.viewColumnAliasList));
            this.CONSUME(baseLexer.As);
            this.OR([
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.LParen);
                        this.OR1([
                            { ALT: () => this.SUBRULE(this.withStatement) },
                            { ALT: () => this.SUBRULE(this.selectStatement) },
                        ]);
                        this.CONSUME(baseLexer.RParen);
                    },
                },
                { ALT: () => this.SUBRULE1(this.selectStatement) },
            ]);
        });

        this.OVERRIDE_RULE('typeNameWord', () => {
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Identifier) },
                { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
                { ALT: () => this.CONSUME(baseLexer.To) },
                { ALT: () => this.CONSUME(sqliteLexer.IntType) },
                { ALT: () => this.CONSUME(sqliteLexer.DoubleType) },
            ]);
        });

        // SQLite treats many keywords as non-reserved; accept them in
        // identifier positions (SELECT rowid FROM t, CREATE TABLE double ...).
        this.OVERRIDE_RULE('identifier', () => {
            this.OR(this.getTokenAlternatives(this.getSqliteIdentifierTokens()));
        });

        // Shared name rule avoids duplicate CONSUME entries when column
        // references allow qualified names (OR / OR1 / OR2 in one rule).
        this.RULE('sqliteRelaxedName', () => {
            this.OR1(this.getTokenAlternatives(this.getSqliteIdentifierTokens()));
        });

        this.OVERRIDE_RULE('alias', () => {
            this.SUBRULE(this.sqliteRelaxedName);
        });

        this.OVERRIDE_RULE('columnReference', () => {
            this.SUBRULE(this.sqliteRelaxedName);
            this.OPTION({
                GATE: () =>
                    this.LA(1).tokenType === baseLexer.Dot
                    && this.LA(2).tokenType !== baseLexer.Dot,
                DEF: () => {
                    this.CONSUME(baseLexer.Dot);
                    this.SUBRULE1(this.sqliteRelaxedName);
                    this.MANY(() => {
                        this.CONSUME1(baseLexer.Dot);
                        this.SUBRULE2(this.sqliteRelaxedName);
                    });
                },
            });
        });

        this.OVERRIDE_RULE('columnDefinition', () => {
            this.SUBRULE(this.columnName);
            // SQLite permits columns without a declared type, for example
            // `CREATE TABLE t (id)`.  The following constraint loop already
            // starts with the SQLite constraint tokens, so the shared type
            // rule can remain optional here.
            this.OPTION(() => this.SUBRULE1(this.typeName));
            this.MANY(() => {
                this.OR([
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.Constraint,
                        ALT: () => {
                            this.CONSUME(baseLexer.Constraint);
                            this.SUBRULE(this.identifier);
                            this.OR1([
                                {
                                    ALT: () => {
                                        this.CONSUME(baseLexer.Not);
                                        this.CONSUME(baseLexer.Null);
                                    },
                                },
                                { ALT: () => this.CONSUME2(baseLexer.Null) },
                                {
                                    ALT: () => {
                                        this.CONSUME(baseLexer.Default);
                                        this.SUBRULE(this.additiveExpression);
                                    },
                                },
                                { ALT: () => this.SUBRULE(this.constraintDefinition) },
                            ]);
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.Not,
                        ALT: () => {
                            this.CONSUME1(baseLexer.Not);
                            this.CONSUME1(baseLexer.Null);
                        },
                    },
                    { ALT: () => this.CONSUME3(baseLexer.Null) },
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.Default,
                        ALT: () => {
                            this.CONSUME1(baseLexer.Default);
                            this.SUBRULE1(this.additiveExpression);
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === sqliteLexer.Collate,
                        ALT: () => {
                            this.CONSUME(sqliteLexer.Collate);
                            this.SUBRULE2(this.identifier);
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === sqliteLexer.Generated,
                        ALT: () => {
                            this.CONSUME(sqliteLexer.Generated);
                            this.OPTION1(() => this.CONSUME(sqliteLexer.Always));
                            this.CONSUME(baseLexer.As);
                            this.CONSUME(baseLexer.LParen);
                            this.SUBRULE(this.expression);
                            this.CONSUME(baseLexer.RParen);
                            this.OPTION2(() => {
                                this.OR2([
                                    { ALT: () => this.CONSUME(sqliteLexer.Stored) },
                                    { ALT: () => this.CONSUME(sqliteLexer.Virtual) },
                                ]);
                            });
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === sqliteLexer.Autoincrement,
                        ALT: () => this.CONSUME(sqliteLexer.Autoincrement),
                    },
                    {
                        GATE: () =>
                            this.LA(1).tokenType === baseLexer.Primary
                            || this.LA(1).tokenType === baseLexer.Unique
                            || this.LA(1).tokenType === baseLexer.Foreign
                            || this.LA(1).tokenType === baseLexer.Check
                            || this.LA(1).tokenType === baseLexer.References,
                        ALT: () => this.SUBRULE1(this.constraintDefinition),
                    },
                    {
                        GATE: () =>
                            this.LA(1).tokenType === baseLexer.On
                            && this.LA(2).tokenType === sqliteLexer.Conflict,
                        ALT: () => {
                            this.CONSUME(baseLexer.On);
                            this.CONSUME(sqliteLexer.Conflict);
                            this.SUBRULE(this.sqliteConflictAction);
                        },
                    },
                ]);
            });
        });

        this.OVERRIDE_RULE('functionCall', () => {
            this.OR1([
                { ALT: () => this.CONSUME(baseLexer.Identifier) },
                { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
                { ALT: () => this.CONSUME(baseLexer.Raise) },
                { ALT: () => this.CONSUME(baseLexer.Random) },
                { ALT: () => this.CONSUME(baseLexer.Replace) },
                { ALT: () => this.CONSUME(baseLexer.Like) },
                { ALT: () => this.CONSUME(sqliteLexer.Glob) },
                { ALT: () => this.CONSUME(sqliteLexer.Regexp) },
                { ALT: () => this.CONSUME(baseLexer.Match) },
            ]);
            this.CONSUME(baseLexer.LParen);
            this.OPTION(() => {
                this.OR2([
                    { ALT: () => this.CONSUME(baseLexer.Distinct) },
                    { ALT: () => this.CONSUME(baseLexer.All) },
                ]);
            });
            this.OPTION1(() => this.SUBRULE(this.functionArguments));
            this.CONSUME1(baseLexer.RParen);
            this.OPTION2(() => this.SUBRULE(this.filterClause));
            this.OPTION3(() => this.SUBRULE(this.overClause));
        });

        this.OVERRIDE_RULE('foreignKeyConstraint', () => {
            this.OPTION(() => {
                this.CONSUME(baseLexer.Foreign);
                this.CONSUME(baseLexer.Key);
                this.OPTION1(() => this.SUBRULE(this.columnList));
            });
            this.CONSUME(baseLexer.References);
            this.SUBRULE(this.qualifiedName);
            this.OPTION2(() => this.SUBRULE1(this.columnList));
            this.MANY(() => {
                this.OR([
                    {
                        GATE: () =>
                            this.LA(1).tokenType === baseLexer.On
                            && (this.LA(2).tokenType === baseLexer.Delete
                                || this.LA(2).tokenType === baseLexer.Update),
                        ALT: () => {
                            this.CONSUME(baseLexer.On);
                            this.OR1([
                                { ALT: () => this.CONSUME(baseLexer.Delete) },
                                { ALT: () => this.CONSUME(baseLexer.Update) },
                            ]);
                            this.OR2([
                                { ALT: () => this.CONSUME(baseLexer.Cascade) },
                                { ALT: () => this.CONSUME(baseLexer.Restrict) },
                                {
                                    ALT: () => {
                                        this.CONSUME(baseLexer.Set);
                                        this.OR3([
                                            { ALT: () => this.CONSUME(baseLexer.Null) },
                                            { ALT: () => this.CONSUME(baseLexer.Default) },
                                        ]);
                                    },
                                },
                                {
                                    ALT: () => {
                                        this.CONSUME(sqliteLexer.No);
                                        this.CONSUME(baseLexer.Action);
                                    },
                                },
                            ]);
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.Match,
                        ALT: () => {
                            this.CONSUME(baseLexer.Match);
                            this.SUBRULE(this.identifier);
                        },
                    },
                    {
                        GATE: () =>
                            this.LA(1).tokenType === baseLexer.Deferrable
                            || (this.LA(1).tokenType === baseLexer.Not
                                && this.LA(2).tokenType === baseLexer.Deferrable),
                        ALT: () => {
                            this.OPTION3(() => this.CONSUME(baseLexer.Not));
                            this.CONSUME(baseLexer.Deferrable);
                            this.OPTION4(() => {
                                this.CONSUME(baseLexer.Initially);
                                this.OR4([
                                    { ALT: () => this.CONSUME(baseLexer.Deferred) },
                                    { ALT: () => this.CONSUME(baseLexer.Immediate) },
                                ]);
                            });
                        },
                    },
                ]);
            });
        });

        this.OVERRIDE_RULE('comparisonExpression', () => {
            this.SUBRULE(this.additiveExpression);
            // COLLATE binds tighter than comparison operators: x COLLATE NOCASE = 'a'
            this.OPTION(() => {
                this.CONSUME(sqliteLexer.Collate);
                this.SUBRULE(this.identifier);
            });
            this.OPTION1(() => {
                this.OR1([
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.Equals);
                            this.SUBRULE(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.NotEquals);
                            this.SUBRULE1(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.LessThan);
                            this.SUBRULE2(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.GreaterThan);
                            this.SUBRULE3(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.LessThanEquals);
                            this.SUBRULE4(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.GreaterThanEquals);
                            this.SUBRULE5(this.comparisonRhs);
                        },
                    },
                    {
                        ALT: () => {
                            this.OR2([
                                { ALT: () => this.CONSUME(baseLexer.Like) },
                                { ALT: () => this.CONSUME(sqliteLexer.Glob) },
                                { ALT: () => this.CONSUME(sqliteLexer.Regexp) },
                                { ALT: () => this.CONSUME(baseLexer.Match) },
                            ]);
                            this.SUBRULE1(this.additiveExpression);
                            this.OPTION2(() => {
                                this.CONSUME(baseLexer.Escape);
                                this.SUBRULE2(this.additiveExpression);
                            });
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME(baseLexer.Not);
                            this.OR3([
                                { ALT: () => this.CONSUME1(baseLexer.Like) },
                                { ALT: () => this.CONSUME1(sqliteLexer.Glob) },
                                { ALT: () => this.CONSUME1(sqliteLexer.Regexp) },
                                { ALT: () => this.CONSUME1(baseLexer.Match) },
                            ]);
                            this.SUBRULE3(this.additiveExpression);
                            this.OPTION3(() => {
                                this.CONSUME1(baseLexer.Escape);
                                this.SUBRULE4(this.additiveExpression);
                            });
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME4(baseLexer.Not);
                            this.SUBRULE1(this.inExpression);
                        },
                    },
                    {
                        ALT: () => {
                            this.CONSUME5(baseLexer.Not);
                            this.SUBRULE2(this.betweenExpression);
                        },
                    },
                    { ALT: () => this.SUBRULE2(this.inExpression) },
                    { ALT: () => this.SUBRULE3(this.betweenExpression) },
                    { ALT: () => this.SUBRULE4(this.isExpression) },
                    { ALT: () => this.CONSUME(baseLexer.NotNull) },
                    { ALT: () => this.CONSUME(baseLexer.IsNull) },
                ]);
            });
            // Postfix COLLATE on the right-hand side: x = 'a' COLLATE NOCASE
            this.OPTION4(() => {
                this.CONSUME1(sqliteLexer.Collate);
                this.SUBRULE1(this.identifier);
            });
        });

        this.OVERRIDE_RULE('selectStatement', () => {
            this.SUBRULE(this.selectClause);
            this.OPTION(() => this.SUBRULE(this.fromClause));
            this.OPTION1(() => this.SUBRULE(this.whereClause));
            this.OPTION2(() => this.SUBRULE(this.groupByClause));
            this.OPTION3(() => this.SUBRULE(this.havingClause));
            this.OPTION4(() => this.SUBRULE(this.sqliteWindowClause));
            this.OPTION5(() => this.SUBRULE(this.orderByClause));
            this.OPTION6(() => this.SUBRULE(this.limitClause));
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
            this.OR1([
                { ALT: () => this.SUBRULE(this.sqliteWindowSpec) },
                { ALT: () => this.SUBRULE(this.identifier) },
            ]);
        });

        this.OVERRIDE_RULE('limitClause', () => {
            this.CONSUME(baseLexer.Limit);
            this.OR1([
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.NumberLiteral);
                        this.OPTION(() => this.CONSUME(baseLexer.Comma));
                        this.OPTION1(() => this.CONSUME1(baseLexer.NumberLiteral));
                        this.OPTION2(() => {
                            this.CONSUME(baseLexer.Offset);
                            this.CONSUME2(baseLexer.NumberLiteral);
                        });
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Minus);
                        this.CONSUME3(baseLexer.NumberLiteral);
                        this.OPTION3(() => {
                            this.CONSUME1(baseLexer.Offset);
                            this.CONSUME4(baseLexer.NumberLiteral);
                        });
                    },
                },
            ]);
        });

        this.OVERRIDE_RULE('alterTableStatement', () => {
            this.CONSUME(baseLexer.Alter);
            this.CONSUME(baseLexer.Table);
            this.SUBRULE(this.qualifiedName);
            this.SUBRULE(this.sqliteAlterTableAction);
        });

        this.OVERRIDE_RULE('dropStatement', () => {
            this.CONSUME(baseLexer.Drop);
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Table) },
                { ALT: () => this.CONSUME(baseLexer.View) },
                { ALT: () => this.CONSUME(sqliteLexer.Index) },
                { ALT: () => this.CONSUME(sqliteLexer.Trigger) },
            ]);
            this.OPTION(() => {
                this.CONSUME(baseLexer.If);
                this.CONSUME(baseLexer.Exists);
            });
            this.SUBRULE(this.dropTargetList);
        });

        this.OVERRIDE_RULE('beginStatement', () => {
            this.CONSUME(baseLexer.Begin);
            this.OPTION(() => {
                this.OR([
                    { ALT: () => this.CONSUME(baseLexer.Deferred) },
                    { ALT: () => this.CONSUME(baseLexer.Immediate) },
                    { ALT: () => this.CONSUME(sqliteLexer.Exclusive) },
                ]);
            });
            this.OPTION1(() => this.CONSUME(sqliteLexer.Transaction));
        });

        this.OVERRIDE_RULE('commitStatement', () => {
            this.CONSUME(baseLexer.Commit);
            this.OPTION(() => this.CONSUME(sqliteLexer.Transaction));
        });

        this.OVERRIDE_RULE('rollbackStatement', () => {
            this.CONSUME(baseLexer.Rollback);
            this.OPTION(() => this.CONSUME(sqliteLexer.Transaction));
            this.OPTION1(() => this.CONSUME(baseLexer.To));
            this.OPTION2(() => this.CONSUME(sqliteLexer.Savepoint));
            this.OPTION3(() => this.SUBRULE(this.identifier));
        });

        this.OVERRIDE_RULE('explainStatement', () => {
            this.CONSUME(baseLexer.Explain);
            this.OPTION(() => {
                this.CONSUME(sqliteLexer.Query);
                this.CONSUME(sqliteLexer.Plan);
            });
            this.SUBRULE(this.statement);
        });

        this.OVERRIDE_RULE('insertStatement', () => {
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Insert) },
                { ALT: () => this.CONSUME1(baseLexer.Replace) },
            ]);
            this.OPTION(() => {
                this.CONSUME(baseLexer.Or);
                this.SUBRULE(this.sqliteConflictAction);
            });
            this.CONSUME(baseLexer.Into);
            this.SUBRULE(this.tableName);
            this.OPTION1(() => {
                this.CONSUME(baseLexer.LParen);
                this.AT_LEAST_ONE_SEP({
                    SEP: baseLexer.Comma,
                    DEF: () => this.SUBRULE(this.identifier),
                });
                this.CONSUME(baseLexer.RParen);
            });
            this.OR1([
                { ALT: () => this.SUBRULE(this.valuesClause) },
                { ALT: () => this.SUBRULE(this.selectStatement) },
                { ALT: () => this.SUBRULE(this.insertWithClause) },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Default);
                        this.CONSUME(baseLexer.Values);
                    },
                },
            ]);
            this.OPTION2(() => this.SUBRULE(this.sqliteUpsertClause));
            this.OPTION3(() => this.SUBRULE1(this.sqliteReturningClause));
        });

        this.OVERRIDE_RULE('updateStatement', () => {
            this.CONSUME(baseLexer.Update);
            this.OPTION(() => {
                this.CONSUME1(baseLexer.Or);
                this.SUBRULE1(this.sqliteConflictAction);
            });
            this.SUBRULE(this.tableName);
            this.OPTION1({
                GATE: () => this.canFollowTableAlias(),
                DEF: () => this.SUBRULE(this.aliasOptional),
            });
            this.CONSUME(baseLexer.Set);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.updateSetItem),
            });
            this.OPTION2(() => this.SUBRULE(this.fromClause));
            this.OPTION3(() => this.SUBRULE(this.whereClause));
            this.OPTION4(() => this.SUBRULE(this.orderByClause));
            this.OPTION5(() => this.SUBRULE(this.limitClause));
            this.OPTION6(() => this.SUBRULE(this.sqliteReturningClause));
        });

        this.OVERRIDE_RULE('deleteStatement', () => {
            this.CONSUME(baseLexer.Delete);
            this.CONSUME(baseLexer.From);
            this.SUBRULE(this.tableName);
            this.OPTION({
                GATE: () => this.canFollowTableAlias(),
                DEF: () => this.SUBRULE(this.aliasOptional),
            });
            this.OPTION1(() => this.SUBRULE(this.whereClause));
            this.OPTION2(() => this.SUBRULE(this.orderByClause));
            this.OPTION3(() => this.SUBRULE(this.limitClause));
            this.OPTION4(() => this.SUBRULE(this.sqliteReturningClause));
        });
    }

    private registerSqliteRules(): void {
        this.RULE('sqliteConflictAction', () => {
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Rollback) },
                { ALT: () => this.CONSUME(sqliteLexer.Abort) },
                { ALT: () => this.CONSUME(sqliteLexer.Fail) },
                { ALT: () => this.CONSUME(sqliteLexer.Ignore) },
                { ALT: () => this.CONSUME(baseLexer.Replace) },
            ]);
        });

        this.RULE('sqliteReturningClause', () => {
            this.CONSUME(sqliteLexer.Returning);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => {
                    this.OR([
                        { ALT: () => this.SUBRULE(this.starExpression) },
                        { ALT: () => this.SUBRULE(this.expression) },
                    ]);
                },
            });
        });

        this.RULE('sqliteUpsertClause', () => {
            this.CONSUME(baseLexer.On);
            this.CONSUME(sqliteLexer.Conflict);
            this.OPTION(() => this.SUBRULE(this.columnList));
            this.CONSUME(sqliteLexer.Do);
            this.OR([
                { ALT: () => this.CONSUME(sqliteLexer.Nothing) },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Update);
                        this.CONSUME(baseLexer.Set);
                        this.AT_LEAST_ONE_SEP({
                            SEP: baseLexer.Comma,
                            DEF: () => this.SUBRULE(this.updateSetItem),
                        });
                        this.OPTION1(() => this.SUBRULE(this.whereClause));
                    },
                },
            ]);
        });

        this.RULE('sqliteCreateIndexStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => this.CONSUME(baseLexer.Unique));
            this.CONSUME(sqliteLexer.Index);
            this.OPTION1(() => {
                this.CONSUME(baseLexer.If);
                this.CONSUME(baseLexer.Not);
                this.CONSUME(baseLexer.Exists);
            });
            this.SUBRULE(this.qualifiedName);
            this.CONSUME(baseLexer.On);
            this.SUBRULE1(this.qualifiedName);
            this.CONSUME(baseLexer.LParen);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => {
                    this.SUBRULE(this.expression);
                    this.OPTION2(() => {
                        this.CONSUME(sqliteLexer.Collate);
                        this.SUBRULE(this.identifier);
                    });
                    this.OPTION3(() => {
                        this.OR1([
                            { ALT: () => this.CONSUME(baseLexer.Asc) },
                            { ALT: () => this.CONSUME(baseLexer.Desc) },
                        ]);
                    });
                },
            });
            this.CONSUME(baseLexer.RParen);
            this.OPTION4(() => {
                this.CONSUME(baseLexer.Where);
                this.SUBRULE1(this.expression);
            });
        });

        this.RULE('sqliteCreateTriggerStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => this.SUBRULE(this.tableTypeClause));
            this.CONSUME(sqliteLexer.Trigger);
            this.OPTION1(() => {
                this.CONSUME(baseLexer.If);
                this.CONSUME(baseLexer.Not);
                this.CONSUME(baseLexer.Exists);
            });
            this.SUBRULE(this.qualifiedName);
            this.OPTION2(() => {
                this.OR([
                    { ALT: () => this.CONSUME(sqliteLexer.Before) },
                    { ALT: () => this.CONSUME(sqliteLexer.After) },
                    {
                        ALT: () => {
                            this.CONSUME(sqliteLexer.Instead);
                            this.CONSUME1(baseLexer.Of);
                        },
                    },
                ]);
            });
            this.AT_LEAST_ONE1(() => {
                this.OR1([
                    { ALT: () => this.CONSUME(baseLexer.Insert) },
                    { ALT: () => this.CONSUME(baseLexer.Update) },
                    { ALT: () => this.CONSUME(baseLexer.Delete) },
                ]);
                this.OPTION3(() => {
                    this.CONSUME(baseLexer.Of);
                    this.AT_LEAST_ONE_SEP({
                            SEP: baseLexer.Comma,
                            DEF: () => this.SUBRULE1(this.identifier),
                    });
                });
            });
            this.CONSUME(baseLexer.On);
            this.SUBRULE1(this.qualifiedName);
            this.OPTION4(() => {
                this.CONSUME(baseLexer.For);
                this.CONSUME(sqliteLexer.Each);
                this.CONSUME(baseLexer.Row);
            });
            this.OPTION5(() => {
                this.CONSUME(baseLexer.When);
                this.SUBRULE(this.expression);
            });
            this.CONSUME(baseLexer.Begin);
            this.AT_LEAST_ONE2(() => {
                this.SUBRULE(this.sqliteTriggerBodyStatement);
                this.CONSUME(baseLexer.Semicolon);
            });
            this.CONSUME(baseLexer.End);
        });

        this.RULE('sqliteTriggerBodyStatement', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.insertStatement) },
                { ALT: () => this.SUBRULE(this.updateStatement) },
                { ALT: () => this.SUBRULE(this.deleteStatement) },
                { ALT: () => this.SUBRULE(this.selectStatement) },
            ]);
        });

        this.RULE('sqlitePragmaStatement', () => {
            this.CONSUME(sqliteLexer.Pragma);
            // The pragma name may be schema-qualified; SQLite accepts the
            // reserved TEMP keyword as the "temp" schema qualifier here.
            this.OR1([
                { ALT: () => this.SUBRULE(this.identifier) },
                { ALT: () => this.CONSUME(baseLexer.Temp) },
            ]);
            this.OPTION(() => {
                this.CONSUME(baseLexer.Dot);
                this.SUBRULE1(this.identifier);
            });
            this.OPTION1(() => {
                this.OR2([
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.Equals,
                        ALT: () => {
                            this.CONSUME(baseLexer.Equals);
                            this.SUBRULE(this.sqlitePragmaValue);
                        },
                    },
                    {
                        GATE: () => this.LA(1).tokenType === baseLexer.LParen,
                        ALT: () => {
                            this.CONSUME(baseLexer.LParen);
                            this.SUBRULE1(this.sqlitePragmaValue);
                            this.CONSUME(baseLexer.RParen);
                        },
                    },
                ]);
            });
        });

        this.RULE('sqliteAttachStatement', () => {
            this.CONSUME(sqliteLexer.Attach);
            this.OPTION(() => this.CONSUME(baseLexer.Database));
            this.SUBRULE(this.expression);
            this.CONSUME(baseLexer.As);
            this.SUBRULE(this.identifier);
        });

        this.RULE('sqlitePragmaValue', () => {
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.On) },
                { ALT: () => this.CONSUME(baseLexer.Identifier) },
                { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
                { ALT: () => this.CONSUME(baseLexer.NumberLiteral) },
                { ALT: () => this.CONSUME(baseLexer.StringLiteral) },
                { ALT: () => this.CONSUME(baseLexer.Null) },
            ]);
        });

        this.RULE('sqliteDetachStatement', () => {
            this.CONSUME(sqliteLexer.Detach);
            this.OPTION(() => this.CONSUME(baseLexer.Database));
            this.SUBRULE(this.identifier);
        });

        this.RULE('sqliteVacuumStatement', () => {
            this.CONSUME(sqliteLexer.Vacuum);
            this.OPTION(() => this.SUBRULE(this.identifier));
            this.OPTION1(() => {
                this.CONSUME(baseLexer.Into);
                this.CONSUME(baseLexer.StringLiteral);
            });
        });

        this.RULE('sqliteAnalyzeStatement', () => {
            this.CONSUME(sqliteLexer.Analyze);
            this.OPTION(() => this.SUBRULE(this.qualifiedName));
        });

        this.RULE('sqliteSavepointStatement', () => {
            this.CONSUME(sqliteLexer.Savepoint);
            this.SUBRULE(this.identifier);
        });

        this.RULE('sqliteReleaseStatement', () => {
            this.CONSUME(sqliteLexer.Release);
            this.OPTION(() => this.CONSUME(sqliteLexer.Savepoint));
            this.SUBRULE(this.identifier);
        });

        this.RULE('sqliteWindowClause', () => {
            this.CONSUME(sqliteLexer.Window);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => {
                    this.SUBRULE(this.identifier);
                    this.CONSUME(baseLexer.As);
                    this.SUBRULE(this.sqliteWindowSpec);
                },
            });
        });

        this.RULE('sqliteWindowSpec', () => {
            this.CONSUME(baseLexer.LParen);
            this.OPTION(() => this.SUBRULE(this.partitionByClause));
            this.OPTION1(() => this.SUBRULE(this.orderByClause));
            this.OPTION2(() => this.SUBRULE(this.windowFrameClause));
            this.CONSUME(baseLexer.RParen);
        });

        this.RULE('sqliteVirtualTableModuleArg', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.identifier) },
                { ALT: () => this.CONSUME(baseLexer.StringLiteral) },
                { ALT: () => this.CONSUME(baseLexer.NumberLiteral) },
            ]);
        });

        this.RULE('sqliteAlterTableAction', () => {
            this.OR([
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Rename,
                    ALT: () => {
                        this.CONSUME(baseLexer.Rename);
                        this.OR1([
                            {
                                ALT: () => {
                                    this.CONSUME(baseLexer.To);
                                    this.SUBRULE(this.identifier);
                                },
                            },
                            {
                                ALT: () => {
                        this.CONSUME(baseLexer.Column);
                                    this.SUBRULE1(this.identifier);
                                    this.CONSUME1(baseLexer.To);
                                    this.SUBRULE2(this.identifier);
                                },
                            },
                        ]);
                    },
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Add,
                    ALT: () => {
                        this.CONSUME(baseLexer.Add);
                        this.OPTION(() => this.CONSUME1(baseLexer.Column));
                        this.SUBRULE(this.columnDefinition);
                    },
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Drop,
                    ALT: () => {
                        this.CONSUME(baseLexer.Drop);
                        this.OPTION1(() => this.CONSUME2(baseLexer.Column));
                        this.SUBRULE3(this.identifier);
                    },
                },
            ]);
        });
    }
}

export class SqlParser extends SqliteSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
    return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
    parserInstance ??= createSqlParserInstance();
    return parserInstance;
}
