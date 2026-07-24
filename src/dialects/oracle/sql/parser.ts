import type { CstNode, TokenType } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';
import * as oracleLexer from './lexer';
import type { OrAlternative } from '../../../sqlParser/BaseSqlParser';
import { NetezzaSqlParser } from '../../netezza/sql/parser';

type AnyRule = () => CstNode;

const ORACLE_PROGRAM_TOKENS: TokenType[] = [
    oracleLexer.OracleConnect,
    oracleLexer.OracleBy,
    oracleLexer.OraclePrior,
    oracleLexer.OracleNocycle,
    oracleLexer.OraclePivot,
    oracleLexer.OracleUnpivot,
    oracleLexer.OracleReturning,
    oracleLexer.OraclePragma,
    oracleLexer.OracleBindVariable,
    oracleLexer.OracleQualifiedFunction,
    oracleLexer.OracleAtSign,
    oracleLexer.OracleOrderSiblingsBy,
    baseLexer.Create,
    baseLexer.Or,
    baseLexer.Replace,
    baseLexer.Procedure,
    baseLexer.Declare,
    baseLexer.Begin,
    baseLexer.End,
    baseLexer.Exception,
    baseLexer.When,
    baseLexer.Others,
    baseLexer.Then,
    baseLexer.Else,
    baseLexer.If,
    baseLexer.Return,
    baseLexer.Returns,
    baseLexer.As,
    baseLexer.On,
    baseLexer.Row,
    baseLexer.Loop,
    baseLexer.While,
    baseLexer.Select,
    baseLexer.From,
    baseLexer.Where,
    baseLexer.Into,
    baseLexer.Values,
    baseLexer.Value,
    baseLexer.Update,
    baseLexer.Set,
    baseLexer.Insert,
    baseLexer.Delete,
    baseLexer.Call,
    baseLexer.Execute,
    baseLexer.Immediate,
    baseLexer.Is,
    baseLexer.Null,
    baseLexer.And,
    baseLexer.Not,
    baseLexer.In,
    baseLexer.For,
    baseLexer.Like,
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

function tokenImage(token: { image?: string } | undefined): string {
    return (token?.image ?? '').replace(/^"|"$/g, '').toUpperCase();
}

/**
 * Oracle parser layered on the shared CST grammar.
 *
 * The common query rules remain shared so metadata-aware completion and scope
 * analysis keep their existing CST contracts. Oracle-only clauses are added as
 * explicit rules, while PL/SQL units are preserved as an offset-stable token
 * CST until their semantic visitor is applied.
 */
export class OracleSqlParser extends NetezzaSqlParser {
    oracleProgramToken!: AnyRule;
    oracleHierarchyClause!: AnyRule;
    oracleOrderSiblingsByClause!: AnyRule;
    oraclePivotClause!: AnyRule;
    oracleUnpivotClause!: AnyRule;
    oracleReturningClause!: AnyRule;
    oracleReturningTarget!: AnyRule;
    oraclePivotValue!: AnyRule;
    oracleUnpivotValue!: AnyRule;
    oracleHierarchyExpression!: AnyRule;
    oraclePivotExpression!: AnyRule;
    oracleNullStatement!: AnyRule;
    oracleVariableDeclarations!: AnyRule;
    oracleVariableDeclaration!: AnyRule;
    oracleProgramTokenSequence!: AnyRule;
    oracleBlockBody!: AnyRule;
    oracleBlockStatement!: AnyRule;
    oracleTokenStatement!: AnyRule;
    oracleIfStatement!: AnyRule;
    oracleElsifClause!: AnyRule;
    oracleConditionalBody!: AnyRule;
    oracleLoopStatement!: AnyRule;
    oracleWhileStatement!: AnyRule;
    oracleForStatement!: AnyRule;
    oracleForHeader!: AnyRule;
    oracleExceptionBlock!: AnyRule;
    oracleWhenClause!: AnyRule;
    oracleExceptionBody!: AnyRule;
    oracleAnonymousBlock!: AnyRule;
    oracleProcedureArgumentWithMode!: AnyRule;
    oracleProcedureArgumentWithoutMode!: AnyRule;
    oracleParameterDefault!: AnyRule;
    oraclePackageUnit!: AnyRule;
    oraclePackageMember!: AnyRule;
    oraclePackageRoutine!: AnyRule;
    oracleTriggerUnit!: AnyRule;
    oracleTriggerHeader!: AnyRule;

    public constructor() {
        super(oracleLexer);
    }

    protected getAdditionalStatementAlternatives(): OrAlternative[] {
        return [
            {
                GATE: () => this.startsOracleRoutine(),
                ALT: () => this.SUBRULE(this.createProcedureStatement),
            },
            {
                GATE: () => this.LA(1).tokenType === baseLexer.Declare
                    || this.LA(1).tokenType === baseLexer.Begin,
                ALT: () => this.SUBRULE(this.oracleAnonymousBlock),
            },
            {
                GATE: () => this.startsOraclePackage(),
                ALT: () => this.SUBRULE(this.oraclePackageUnit),
            },
            {
                GATE: () => this.startsOracleTrigger(),
                ALT: () => this.SUBRULE(this.oracleTriggerUnit),
            },
            {
                GATE: () => this.startsOracleSynonym(),
                ALT: () => this.SUBRULE(this.createSynonymStatement),
            },
        ];
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

    protected supportsEmptyQualifiedNameSegment(): boolean {
        return false;
    }

    protected registerCreateTableDialectClauses(): void {
        // Oracle has no Netezza DISTRIBUTE/ORGANIZE clauses.
    }

    protected registerAlterTableDialectRule(): void {
        this.OVERRIDE_RULE("alterTableStatement", () => {
            this.CONSUME(baseLexer.Alter);
            this.CONSUME(baseLexer.Table);
            this.SUBRULE(this.qualifiedName);
            this.OPTION(() => this.SUBRULE(this.alterTableAction));
        });
    }

    protected registerDialectProcedureRules(): void {
        this.RULE('oracleNullStatement', () => {
            this.CONSUME(baseLexer.Null);
        });
    }

    protected getAdditionalProcedureStatementAlternatives(): OrAlternative[] {
        return [{ ALT: () => this.SUBRULE(this.oracleNullStatement) }];
    }

    protected registerDialectExtensions(): void {
        this.RULE('oracleProgramToken', () => {
            this.OR(this.getTokenAlternatives(ORACLE_PROGRAM_TOKENS));
        });

        this.RULE('oracleProgramTokenSequence', () => {
            this.AT_LEAST_ONE(() => this.SUBRULE(this.oracleProgramToken));
        });

        this.RULE('oracleBlockBody', () => {
            this.MANY({
                GATE: () => !this.isOracleOuterBlockEnd(),
                DEF: () => this.SUBRULE(this.oracleBlockStatement),
            });
        });

        this.RULE('oracleBlockStatement', () => {
            this.OR([
                {
                    GATE: () => tokenImage(this.LA(1)) === 'IF',
                    ALT: () => this.SUBRULE(this.oracleIfStatement),
                },
                {
                    GATE: () => tokenImage(this.LA(1)) === 'LOOP',
                    ALT: () => this.SUBRULE1(this.oracleLoopStatement),
                },
                {
                    GATE: () => tokenImage(this.LA(1)) === 'WHILE',
                    ALT: () => this.SUBRULE2(this.oracleWhileStatement),
                },
                {
                    GATE: () => tokenImage(this.LA(1)) === 'FOR',
                    ALT: () => this.SUBRULE3(this.oracleForStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Return,
                    ALT: () => this.SUBRULE(this.returnStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Null,
                    ALT: () => this.SUBRULE(this.oracleNullStatement),
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
                    GATE: () => this.LA(1).tokenType === baseLexer.Begin,
                    ALT: () => this.SUBRULE(this.oracleAnonymousBlock),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Select,
                    ALT: () => this.SUBRULE(this.selectStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Insert,
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
                    GATE: () => this.LA(1).tokenType === baseLexer.Call,
                    ALT: () => this.SUBRULE(this.callStatement),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Execute
                        && this.LA(2).tokenType === baseLexer.Immediate,
                    ALT: () => this.SUBRULE(this.executeImmediateStatement),
                },
                {
                    GATE: () => this.isOracleAssignmentStart(),
                    ALT: () => this.SUBRULE(this.assignmentStatement),
                },
                { ALT: () => this.SUBRULE(this.oracleTokenStatement) },
            ]);
            this.OPTION(() => this.CONSUME(baseLexer.Semicolon));
        });

        this.RULE('oracleTokenStatement', () => {
            this.SUBRULE(this.oracleProgramToken);
        });

        this.RULE('oracleConditionalBody', () => {
            this.MANY({
                GATE: () => {
                    const image = tokenImage(this.LA(1));
                    return image !== 'ELSIF'
                        && image !== 'ELSE'
                        && this.LA(1).tokenType !== baseLexer.End;
                },
                DEF: () => this.SUBRULE(this.oracleBlockStatement),
            });
        });

        this.RULE('oracleIfStatement', () => {
            this.CONSUME(baseLexer.If);
            this.SUBRULE(this.expression);
            this.CONSUME(baseLexer.Then);
            this.SUBRULE(this.oracleConditionalBody);
            this.MANY({
                GATE: () => tokenImage(this.LA(1)) === 'ELSIF',
                DEF: () => this.SUBRULE(this.oracleElsifClause),
            });
            this.OPTION({
                GATE: () => tokenImage(this.LA(1)) === 'ELSE',
                DEF: () => {
                    this.CONSUME(baseLexer.Else);
                    this.SUBRULE1(this.oracleConditionalBody);
                },
            });
            this.CONSUME(baseLexer.End);
            this.CONSUME1(baseLexer.If);
        });

        this.RULE('oracleElsifClause', () => {
            this.CONSUME(baseLexer.Elsif);
            this.SUBRULE(this.expression);
            this.CONSUME(baseLexer.Then);
            this.SUBRULE(this.oracleConditionalBody);
        });

        this.RULE('oracleLoopStatement', () => {
            this.CONSUME(baseLexer.Loop);
            this.SUBRULE(this.oracleConditionalBody);
            this.CONSUME(baseLexer.End);
            this.CONSUME1(baseLexer.Loop);
        });

        this.RULE('oracleWhileStatement', () => {
            this.CONSUME(baseLexer.While);
            this.SUBRULE(this.expression);
            this.CONSUME(baseLexer.Loop);
            this.SUBRULE(this.oracleConditionalBody);
            this.CONSUME(baseLexer.End);
            this.CONSUME1(baseLexer.Loop);
        });

        this.RULE('oracleForStatement', () => {
            this.CONSUME(baseLexer.For);
            this.SUBRULE(this.identifier);
            this.CONSUME(baseLexer.In);
            this.SUBRULE(this.oracleForHeader);
            this.CONSUME(baseLexer.Loop);
            this.SUBRULE(this.oracleConditionalBody);
            this.CONSUME(baseLexer.End);
            this.CONSUME1(baseLexer.Loop);
        });

        this.RULE('oracleForHeader', () => {
            this.AT_LEAST_ONE({
                GATE: () => tokenImage(this.LA(1)) !== 'LOOP',
                DEF: () => this.SUBRULE(this.oracleProgramToken),
            });
        });

        this.RULE('oracleExceptionBlock', () => {
            this.CONSUME(baseLexer.Exception);
            this.AT_LEAST_ONE(() => this.SUBRULE(this.oracleWhenClause));
        });

        this.RULE('oracleWhenClause', () => {
            this.CONSUME(baseLexer.When);
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Others) },
                { ALT: () => this.SUBRULE(this.identifier) },
            ]);
            this.CONSUME(baseLexer.Then);
            this.SUBRULE(this.oracleExceptionBody);
        });

        this.RULE('oracleExceptionBody', () => {
            this.MANY({
                GATE: () => tokenImage(this.LA(1)) !== 'WHEN'
                    && this.LA(1).tokenType !== baseLexer.End,
                DEF: () => this.SUBRULE(this.oracleBlockStatement),
            });
        });

        this.RULE('oracleAnonymousBlock', () => {
            this.OPTION({
                GATE: () => this.LA(1).tokenType === baseLexer.Declare,
                DEF: () => {
                    this.CONSUME(baseLexer.Declare);
                },
            });
            this.OPTION1({
                GATE: () => this.isOracleVariableDeclarationStart(),
                DEF: () => this.SUBRULE(this.oracleVariableDeclarations),
            });
            this.CONSUME(baseLexer.Begin);
            this.SUBRULE(this.oracleBlockBody);
            this.OPTION3({
                GATE: () => this.LA(1).tokenType === baseLexer.Exception,
                DEF: () => this.SUBRULE(this.oracleExceptionBlock),
            });
            this.CONSUME(baseLexer.End);
            this.OPTION4({
                GATE: () => this.isOracleEndLabel(this.LA(1)),
                DEF: () => {
                    this.SUBRULE(this.identifier);
                },
            });
        });

        this.RULE('oraclePackageUnit', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => {
                this.CONSUME(baseLexer.Or);
                this.CONSUME(baseLexer.Replace);
            });
            this.CONSUME(baseLexer.Identifier);
            this.OPTION1({
                GATE: () => tokenImage(this.LA(1)) === 'BODY',
                DEF: () => this.CONSUME1(baseLexer.Identifier),
            });
            this.SUBRULE(this.qualifiedName);
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.As) },
                { ALT: () => this.CONSUME(baseLexer.Is) },
            ]);
            this.MANY({
                GATE: () => !this.isOracleOuterBlockEnd() && Boolean(tokenImage(this.LA(1))),
                DEF: () => this.SUBRULE1(this.oraclePackageMember),
            });
            this.CONSUME(baseLexer.End);
            this.OPTION2({
                GATE: () => this.isOracleEndLabel(this.LA(1)),
                DEF: () => this.SUBRULE1(this.identifier),
            });
        });

        this.RULE('oraclePackageMember', () => {
            this.OR([
                {
                    GATE: () => this.isOracleRoutineKeyword(this.LA(1)),
                    ALT: () => this.SUBRULE(this.oraclePackageRoutine),
                },
                { ALT: () => this.SUBRULE1(this.oracleProgramToken) },
            ]);
        });

        this.RULE('oraclePackageRoutine', () => {
            this.OR([
                {
                    GATE: () => tokenImage(this.LA(1)) === 'FUNCTION',
                    ALT: () => this.CONSUME(baseLexer.Identifier),
                },
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Procedure,
                    ALT: () => this.CONSUME1(baseLexer.Procedure),
                },
            ]);
            this.SUBRULE(this.qualifiedName);
            this.OPTION({
                GATE: () => this.LA(1).tokenType === baseLexer.LParen,
                DEF: () => {
                    this.CONSUME(baseLexer.LParen);
                    this.OPTION1({
                        GATE: () => this.LA(1).tokenType !== baseLexer.RParen,
                        DEF: () => this.SUBRULE(this.procedureArguments),
                    });
                    this.CONSUME(baseLexer.RParen);
                },
            });
            this.OPTION2({
                GATE: () => this.LA(1).tokenType === baseLexer.Return,
                DEF: () => this.SUBRULE1(this.procedureSignatureSpec),
            });
            this.OPTION3({
                GATE: () => this.isOracleUnitBodyIntro(this.LA(1)),
                DEF: () => {
                    this.OR1([
                        { ALT: () => this.CONSUME(baseLexer.As) },
                        { ALT: () => this.CONSUME1(baseLexer.Is) },
                    ]);
                    this.SUBRULE2(this.oracleAnonymousBlock);
                },
            });
        });

        this.RULE('oracleTriggerHeader', () => {
            this.MANY({
                GATE: () => Boolean(tokenImage(this.LA(1)))
                    && this.LA(1).tokenType !== baseLexer.Begin
                    && this.LA(1).tokenType !== baseLexer.Declare,
                DEF: () => this.SUBRULE(this.oracleProgramToken),
            });
        });

        this.RULE('oracleTriggerUnit', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION5(() => {
                this.CONSUME(baseLexer.Or);
                this.CONSUME(baseLexer.Replace);
            });
            this.CONSUME1(baseLexer.Identifier);
            this.SUBRULE(this.qualifiedName);
            this.SUBRULE(this.oracleTriggerHeader);
            this.SUBRULE(this.oracleAnonymousBlock);
        });

        this.RULE('oracleVariableDeclaration', () => {
            this.OPTION(() => this.CONSUME(baseLexer.Constant));
            this.SUBRULE(this.identifier);
            this.SUBRULE(this.typeName);
            this.OPTION1(() => {
                this.CONSUME(baseLexer.Not);
                this.CONSUME(baseLexer.Null);
            });
            this.OPTION2(() => {
                this.OR([
                    { ALT: () => this.CONSUME(baseLexer.Assign) },
                    { ALT: () => this.CONSUME(baseLexer.Default) },
                ]);
                this.SUBRULE(this.expression);
            });
        });

        this.RULE('oracleVariableDeclarations', () => {
            this.SUBRULE(this.oracleVariableDeclaration);
            this.MANY(() => {
                this.CONSUME(baseLexer.Semicolon);
                this.OPTION({
                    GATE: () => this.isOracleVariableDeclarationStart(),
                    DEF: () => this.SUBRULE1(this.oracleVariableDeclaration),
                });
            });
            this.MANY1(() => this.CONSUME1(baseLexer.Semicolon));
        });

        this.OVERRIDE_RULE('procedureArgumentMode', () => {
            this.OR([
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.In
                        && tokenImage(this.LA(2)) === 'OUT',
                    ALT: () => {
                        this.CONSUME(baseLexer.In);
                        this.CONSUME(baseLexer.Out);
                    },
                },
                { ALT: () => this.CONSUME1(baseLexer.Inout) },
                { ALT: () => this.CONSUME1(baseLexer.Out) },
                { ALT: () => this.CONSUME1(baseLexer.In) },
            ]);
        });

        this.RULE('oracleParameterDefault', () => {
            this.OR([
                { ALT: () => this.CONSUME(baseLexer.Assign) },
                { ALT: () => this.CONSUME(baseLexer.Default) },
            ]);
            this.SUBRULE(this.expression);
        });

        this.RULE('oracleProcedureArgumentWithMode', () => {
            this.SUBRULE(this.identifier);
            this.SUBRULE(this.procedureArgumentMode);
            this.SUBRULE(this.typeName);
            this.OPTION(() => this.SUBRULE(this.oracleParameterDefault));
        });

        this.RULE('oracleProcedureArgumentWithoutMode', () => {
            this.SUBRULE(this.identifier);
            this.SUBRULE(this.typeName);
            this.OPTION(() => this.SUBRULE(this.oracleParameterDefault));
        });

        this.OVERRIDE_RULE('procedureArgument', () => {
            this.OR([
                {
                    GATE: () => this.isIdentifierLike(this.LA(1))
                        && this.isOracleArgumentMode(this.LA(2)),
                    ALT: () => this.SUBRULE(this.oracleProcedureArgumentWithMode),
                },
                {
                    GATE: () => this.isIdentifierLike(this.LA(1)),
                    ALT: () => this.SUBRULE1(this.oracleProcedureArgumentWithoutMode),
                },
            ]);
        });

        this.OVERRIDE_RULE('procedureArguments', () => {
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.procedureArgument),
            });
        });

        this.OVERRIDE_RULE('procedureSignatureSpec', () => {
            this.CONSUME(baseLexer.Return);
            this.SUBRULE(this.procedureReturnType);
        });

        this.OVERRIDE_RULE('procedureBlock', () => {
            this.OPTION({
                GATE: () => this.LA(1).tokenType === baseLexer.Declare,
                DEF: () => this.SUBRULE(this.procedureDeclareSection),
            });
            this.OPTION1({
                GATE: () => this.isOracleVariableDeclarationStart(),
                DEF: () => this.SUBRULE(this.oracleVariableDeclarations),
            });
            this.CONSUME(baseLexer.Begin);
            this.SUBRULE(this.procedureStatements);
            this.OPTION2(() => this.SUBRULE(this.exceptionBlock));
            this.CONSUME(baseLexer.End);
            this.OPTION3({
                GATE: () => this.isIdentifierLike(this.LA(1)),
                DEF: () => this.SUBRULE(this.identifier),
            });
        });

        this.OVERRIDE_RULE('createProcedureStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => {
                this.CONSUME(baseLexer.Or);
                this.CONSUME(baseLexer.Replace);
            });
            this.OR([
                {
                    GATE: () => this.LA(1).tokenType === baseLexer.Procedure,
                    ALT: () => this.CONSUME(baseLexer.Procedure),
                },
                {
                    GATE: () => tokenImage(this.LA(1)) === 'FUNCTION',
                    ALT: () => this.CONSUME1(baseLexer.Identifier),
                },
            ]);
            this.OR1([
                {
                    GATE: () => this.LA(1).tokenType === oracleLexer.OracleQualifiedFunction,
                    ALT: () => this.CONSUME(oracleLexer.OracleQualifiedFunction),
                },
                {
                    ALT: () => this.SUBRULE(this.qualifiedName),
                },
            ]);
            this.OPTION1({
                GATE: () => this.LA(1).tokenType === baseLexer.LParen,
                DEF: () => {
                    this.CONSUME(baseLexer.LParen);
                    this.OPTION2({
                        GATE: () => this.LA(1).tokenType !== baseLexer.RParen,
                        DEF: () => this.SUBRULE(this.procedureArguments),
                    });
                    this.CONSUME(baseLexer.RParen);
                },
            });
            this.OPTION3({
                GATE: () => this.LA(1).tokenType === baseLexer.Return,
                DEF: () => this.SUBRULE(this.procedureSignatureSpec),
            });
            this.OR2([
                { ALT: () => this.CONSUME(baseLexer.As) },
                { ALT: () => this.CONSUME(baseLexer.Is) },
            ]);
            this.SUBRULE2(this.oracleAnonymousBlock);
        });

        this.OVERRIDE_RULE('createSynonymStatement', () => {
            this.CONSUME(baseLexer.Create);
            this.OPTION(() => {
                this.CONSUME(baseLexer.Or);
                this.CONSUME(baseLexer.Replace);
            });
            this.CONSUME(baseLexer.Synonym);
            this.SUBRULE(this.qualifiedName);
            this.CONSUME(baseLexer.For);
            this.SUBRULE1(this.qualifiedName);
            this.OPTION1(() => this.SUBRULE(this.commandTail));
        });

        this.OVERRIDE_RULE('typeName', () => {
            this.SUBRULE(this.typeNameWord);
            this.MANY({
                GATE: () => this.LA(1).tokenType === baseLexer.Identifier
                    || this.LA(1).tokenType === baseLexer.QuotedIdentifier
                    || this.LA(1).tokenType === baseLexer.To
                    || this.LA(1).tokenType === baseLexer.With,
                DEF: () => {
                    this.OR([
                        { ALT: () => this.SUBRULE2(this.typeNameWord) },
                        { ALT: () => this.CONSUME(baseLexer.With) },
                    ]);
                },
            });
            this.OPTION(() => {
                this.CONSUME(baseLexer.LParen);
                this.AT_LEAST_ONE_SEP({
                    SEP: baseLexer.Comma,
                    DEF: () => this.SUBRULE(this.typeArgument),
                });
                this.CONSUME(baseLexer.RParen);
            });
        });

        this.OVERRIDE_RULE('assignmentStatement', () => {
            this.OR([
                {
                    GATE: () => this.LA(1).tokenType === oracleLexer.OracleBindVariable,
                    ALT: () => this.CONSUME(oracleLexer.OracleBindVariable),
                },
                { ALT: () => this.SUBRULE(this.columnReference) },
            ]);
            this.OR1([
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Assign);
                        this.SUBRULE(this.expression);
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Equals);
                        this.SUBRULE1(this.expression);
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.LParen);
                        this.OPTION(() => {
                            this.AT_LEAST_ONE_SEP({
                                SEP: baseLexer.Comma,
                                DEF: () => this.SUBRULE2(this.expression),
                            });
                        });
                        this.CONSUME(baseLexer.RParen);
                        this.OPTION1(() => {
                            this.CONSUME1(baseLexer.Assign);
                            this.SUBRULE3(this.expression);
                        });
                    },
                },
            ]);
        });

        this.OVERRIDE_RULE('functionCall', () => {
            this.OR1([
                { ALT: () => this.CONSUME(oracleLexer.OracleQualifiedFunction) },
                { ALT: () => this.CONSUME(baseLexer.Identifier) },
                { ALT: () => this.CONSUME(baseLexer.QuotedIdentifier) },
                { ALT: () => this.CONSUME(baseLexer.Next) },
                { ALT: () => this.CONSUME(baseLexer.Replace) },
                { ALT: () => this.CONSUME(baseLexer.Random) },
                { ALT: () => this.CONSUME(baseLexer.Value) },
                { ALT: () => this.CONSUME(baseLexer.IsNull) },
            ]);
            this.CONSUME(baseLexer.LParen);
            this.OPTION(() => {
                this.OR3([
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

        this.RULE('oracleHierarchyClause', () => {
            this.OR([
                {
                    ALT: () => {
                        this.CONSUME(baseLexer.Start);
                        this.CONSUME(baseLexer.With);
                        this.SUBRULE(this.expression);
                        this.CONSUME(oracleLexer.OracleConnect);
                        this.CONSUME(oracleLexer.OracleBy);
                        this.OPTION(() => this.CONSUME(oracleLexer.OracleNocycle));
                        this.SUBRULE1(this.oracleHierarchyExpression);
                    },
                },
                {
                    ALT: () => {
                        this.CONSUME1(oracleLexer.OracleConnect);
                        this.CONSUME1(oracleLexer.OracleBy);
                        this.OPTION1(() => this.CONSUME1(oracleLexer.OracleNocycle));
                        this.SUBRULE2(this.oracleHierarchyExpression);
                        this.OPTION2(() => {
                            this.CONSUME1(baseLexer.Start);
                            this.CONSUME1(baseLexer.With);
                            this.SUBRULE3(this.expression);
                        });
                    },
                },
            ]);
        });

        this.RULE('oracleOrderSiblingsByClause', () => {
            this.CONSUME(oracleLexer.OracleOrderSiblingsBy);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.orderByItem),
            });
        });

        this.RULE('oracleHierarchyExpression', () => {
            this.OPTION(() => this.CONSUME(oracleLexer.OraclePrior));
            this.SUBRULE(this.expression);
        });

        this.RULE('oraclePivotExpression', () => {
            this.SUBRULE(this.additiveExpression);
        });

        this.RULE('oraclePivotClause', () => {
            this.CONSUME(oracleLexer.OraclePivot);
            this.CONSUME(baseLexer.LParen);
            this.SUBRULE(this.oraclePivotExpression);
            this.CONSUME(baseLexer.For);
            this.SUBRULE1(this.oraclePivotExpression);
            this.CONSUME(baseLexer.In);
            this.CONSUME1(baseLexer.LParen);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE2(this.oraclePivotValue),
            });
            this.CONSUME1(baseLexer.RParen);
            this.CONSUME2(baseLexer.RParen);
        });

        this.RULE('oracleUnpivotClause', () => {
            this.CONSUME(oracleLexer.OracleUnpivot);
            this.CONSUME(baseLexer.LParen);
            this.SUBRULE(this.oraclePivotExpression);
            this.CONSUME(baseLexer.For);
            this.SUBRULE1(this.oraclePivotExpression);
            this.CONSUME(baseLexer.In);
            this.CONSUME1(baseLexer.LParen);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE2(this.oracleUnpivotValue),
            });
            this.CONSUME1(baseLexer.RParen);
            this.CONSUME2(baseLexer.RParen);
        });

        this.RULE('oraclePivotValue', () => {
            this.SUBRULE(this.expression);
            this.OPTION(() => {
                this.CONSUME(baseLexer.As);
                this.SUBRULE(this.identifier);
            });
        });

        this.RULE('oracleUnpivotValue', () => {
            this.SUBRULE(this.expression);
            this.OPTION(() => {
                this.CONSUME(baseLexer.As);
                this.SUBRULE(this.identifier);
            });
        });

        this.RULE('oracleReturningTarget', () => {
            this.OR([
                { ALT: () => this.CONSUME(oracleLexer.OracleBindVariable) },
                { ALT: () => this.SUBRULE(this.identifier) },
            ]);
        });

        this.RULE('oracleReturningClause', () => {
            this.CONSUME(oracleLexer.OracleReturning);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.expression),
            });
            this.CONSUME(baseLexer.Into);
            this.AT_LEAST_ONE_SEP1({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.oracleReturningTarget),
            });
        });

        this.OVERRIDE_RULE('selectStatement', () => {
            this.SUBRULE(this.selectClause);
            this.OPTION(() => this.SUBRULE(this.fromClause));
            this.OPTION1(() => this.SUBRULE(this.whereClause));
            this.OPTION2(() => this.SUBRULE(this.oracleHierarchyClause));
            this.OPTION3(() => this.SUBRULE(this.oracleOrderSiblingsByClause));
            this.OPTION4(() => this.SUBRULE(this.groupByClause));
            this.OPTION5(() => this.SUBRULE(this.havingClause));
            this.OPTION6(() => this.SUBRULE(this.orderByClause));
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

        this.OVERRIDE_RULE('cteDefinition', () => {
            this.SUBRULE(this.identifier);
            this.OPTION(() => this.SUBRULE(this.cteColumnList));
            this.CONSUME(baseLexer.As);
            this.OPTION1(() => this.CONSUME(baseLexer.All));
            this.CONSUME(baseLexer.LParen);
            this.OR([
                { ALT: () => this.SUBRULE(this.withStatement) },
                { ALT: () => this.SUBRULE(this.selectStatement) },
            ]);
            this.CONSUME(baseLexer.RParen);
        });

        this.OVERRIDE_RULE('tableSource', () => {
            this.OR([
                { ALT: () => this.SUBRULE(this.subquery) },
                ...this.getAdditionalTableSourceAlternatives(),
                { ALT: () => this.SUBRULE(this.tableName) },
            ]);
            this.OPTION(() => {
                this.OR1([
                    { ALT: () => this.SUBRULE(this.oraclePivotClause) },
                    { ALT: () => this.SUBRULE(this.oracleUnpivotClause) },
                ]);
            });
            this.OPTION1({
                GATE: () => this.LA(1).tokenType === oracleLexer.OracleAtSign,
                DEF: () => {
                    this.CONSUME(oracleLexer.OracleAtSign);
                    this.SUBRULE(this.qualifiedName);
                },
            });
            this.OPTION2({
                GATE: () => !this.startsJoinOrClause(),
                DEF: () => this.SUBRULE(this.aliasOptional),
            });
        });

        this.OVERRIDE_RULE('insertStatement', () => {
            this.CONSUME(baseLexer.Insert);
            this.CONSUME(baseLexer.Into);
            this.SUBRULE(this.tableName);
            this.OPTION(() => {
                this.CONSUME(baseLexer.LParen);
                this.AT_LEAST_ONE_SEP({
                    SEP: baseLexer.Comma,
                    DEF: () => this.CONSUME(baseLexer.Identifier),
                });
                this.CONSUME(baseLexer.RParen);
            });
            this.OR([
                { ALT: () => this.SUBRULE(this.valuesClause) },
                { ALT: () => this.SUBRULE(this.selectStatement) },
                { ALT: () => this.SUBRULE(this.insertWithClause) },
            ]);
            this.OPTION1(() => this.SUBRULE(this.oracleReturningClause));
        });

        this.OVERRIDE_RULE('updateStatement', () => {
            this.CONSUME(baseLexer.Update);
            this.SUBRULE(this.tableName);
            this.OPTION(() => this.SUBRULE(this.aliasOptional));
            this.CONSUME(baseLexer.Set);
            this.AT_LEAST_ONE_SEP({
                SEP: baseLexer.Comma,
                DEF: () => this.SUBRULE(this.updateSetItem),
            });
            this.OPTION1(() => this.SUBRULE(this.whereClause));
            this.OPTION2(() => this.SUBRULE(this.oracleReturningClause));
        });

        this.OVERRIDE_RULE('deleteStatement', () => {
            this.CONSUME(baseLexer.Delete);
            this.CONSUME(baseLexer.From);
            this.SUBRULE(this.tableName);
            this.OPTION(() => this.SUBRULE(this.aliasOptional));
            this.OPTION1(() => this.SUBRULE(this.whereClause));
            this.OPTION2(() => this.SUBRULE(this.oracleReturningClause));
        });
    }

    private startsOracleRoutine(): boolean {
        if (this.LA(1).tokenType !== baseLexer.Create) {
            return false;
        }

        const second = tokenImage(this.LA(2));
        const kind = second === 'OR' && tokenImage(this.LA(3)) === 'REPLACE'
            ? tokenImage(this.LA(4))
            : second;
        return kind === 'PROCEDURE' || kind === 'FUNCTION';
    }

    private startsOraclePackage(): boolean {
        if (this.LA(1).tokenType !== baseLexer.Create) {
            return false;
        }

        const second = tokenImage(this.LA(2));
        const kind = second === 'OR' && tokenImage(this.LA(3)) === 'REPLACE'
            ? tokenImage(this.LA(4))
            : second;
        return kind === 'PACKAGE';
    }

    private startsOracleTrigger(): boolean {
        if (this.LA(1).tokenType !== baseLexer.Create) {
            return false;
        }

        const second = tokenImage(this.LA(2));
        const kind = second === 'OR' && tokenImage(this.LA(3)) === 'REPLACE'
            ? tokenImage(this.LA(4))
            : second;
        return kind === 'TRIGGER';
    }

    private startsOracleSynonym(): boolean {
        if (this.LA(1).tokenType !== baseLexer.Create) {
            return false;
        }

        const second = tokenImage(this.LA(2));
        const kind = second === 'OR' && tokenImage(this.LA(3)) === 'REPLACE'
            ? tokenImage(this.LA(4))
            : second;
        return kind === 'SYNONYM';
    }

    private isIdentifierLike(token: { tokenType: TokenType; image?: string }): boolean {
        return token.tokenType === baseLexer.Identifier
            || token.tokenType === baseLexer.QuotedIdentifier;
    }

    private isOracleArgumentMode(token: { tokenType: TokenType; image?: string }): boolean {
        return token.tokenType === baseLexer.In
            || token.tokenType === baseLexer.Inout
            || token.tokenType === baseLexer.Out;
    }

    private isOracleVariableDeclarationStart(): boolean {
        if (!this.isIdentifierLike(this.LA(1))) {
            return false;
        }

        const word = tokenImage(this.LA(1));
        return word !== 'BEGIN' && word !== 'EXCEPTION' && word !== 'END';
    }

    private isOracleRoutineKeyword(token: { tokenType: TokenType; image?: string }): boolean {
        return tokenImage(token) === 'FUNCTION' || token.tokenType === baseLexer.Procedure;
    }

    private isOracleUnitBodyIntro(token: { tokenType: TokenType; image?: string }): boolean {
        return token.tokenType === baseLexer.As || token.tokenType === baseLexer.Is;
    }

    private isOracleAssignmentStart(): boolean {
        return this.isOracleEndLabel(this.LA(1))
            && (this.LA(2).tokenType === baseLexer.Assign
                || this.LA(2).tokenType === baseLexer.Equals);
    }

    private isOracleOuterBlockEnd(): boolean {
        if (!tokenImage(this.LA(1))) {
            return true;
        }

        if (this.LA(1).tokenType === baseLexer.Exception) {
            return true;
        }

        if (this.LA(1).tokenType !== baseLexer.End) {
            return false;
        }

        if (['IF', 'LOOP', 'WHILE', 'FOR', 'CASE'].includes(tokenImage(this.LA(2)))) {
            return false;
        }

        return true;
    }

    private isOracleEndLabel(token: { tokenType: TokenType; image?: string }): boolean {
        const image = tokenImage(token);
        return Boolean(image)
            && token.tokenType !== baseLexer.Semicolon
            && !['IF', 'LOOP', 'WHILE', 'FOR', 'CASE'].includes(image);
    }

    private startsJoinOrClause(): boolean {
        const image = tokenImage(this.LA(1));
        return image === 'JOIN'
            || image === 'INNER'
            || image === 'LEFT'
            || image === 'RIGHT'
            || image === 'FULL'
            || image === 'CROSS'
            || image === 'WHERE'
            || image === 'GROUP'
            || image === 'HAVING'
            || image === 'ORDER'
            || image === 'CONNECT'
            || image === 'START'
            || image === 'PIVOT'
            || image === 'UNPIVOT';
    }
}

export class SqlParser extends OracleSqlParser {}

let parserInstance: SqlParser | undefined;

export function createSqlParserInstance(): SqlParser {
    return new SqlParser();
}

export function getSqlParserInstance(): SqlParser {
    parserInstance ??= createSqlParserInstance();
    return parserInstance;
}
