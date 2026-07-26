import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * Db2 LUW lexical additions. Shared tokens are reused for SELECT/DML CST shape.
 * Multi-word phrases are listed first so they win over Identifier / WITH / FOR.
 */
export const Db2OptimizeFor = createToken({
	name: 'Db2OptimizeFor',
	pattern: /OPTIMIZE\s+FOR\b/i,
});

export const Db2WithUr = createToken({
	name: 'Db2WithUr',
	pattern: /WITH\s+UR\b/i,
});

export const Db2WithCs = createToken({
	name: 'Db2WithCs',
	pattern: /WITH\s+CS\b/i,
});

export const Db2WithRs = createToken({
	name: 'Db2WithRs',
	pattern: /WITH\s+RS\b/i,
});

export const Db2WithRr = createToken({
	name: 'Db2WithRr',
	pattern: /WITH\s+RR\b/i,
});

export const Db2ForReadOnly = createToken({
	name: 'Db2ForReadOnly',
	pattern: /FOR\s+READ\s+ONLY\b/i,
});

export const Db2ForUpdate = createToken({
	name: 'Db2ForUpdate',
	pattern: /FOR\s+UPDATE\b/i,
});

export const Db2FinalTable = createToken({
	name: 'Db2FinalTable',
	pattern: /FINAL\s+TABLE\b/i,
});

export const Db2OldTable = createToken({
	name: 'Db2OldTable',
	pattern: /OLD\s+TABLE\b/i,
});

export const Db2NewTable = createToken({
	name: 'Db2NewTable',
	pattern: /NEW\s+TABLE\b/i,
});

export const Db2ModifiedBy = createToken({
	name: 'Db2ModifiedBy',
	pattern: /MODIFIED\s+BY\b/i,
});

export const Db2DeclareGlobalTemporary = createToken({
	name: 'Db2DeclareGlobalTemporary',
	pattern: /DECLARE\s+GLOBAL\s+TEMPORARY\b/i,
});

export const Db2GeneratedAlways = createToken({
	name: 'Db2GeneratedAlways',
	pattern: /GENERATED\s+ALWAYS\b/i,
});

export const Db2GeneratedByDefault = createToken({
	name: 'Db2GeneratedByDefault',
	pattern: /GENERATED\s+BY\s+DEFAULT\b/i,
});

export const Db2Identity = createToken({
	name: 'Db2Identity',
	pattern: /IDENTITY\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2OrganizeBy = createToken({
	name: 'Db2OrganizeBy',
	pattern: /ORGANIZE\s+BY\b/i,
});

export const Db2DataCapture = createToken({
	name: 'Db2DataCapture',
	pattern: /DATA\s+CAPTURE\b/i,
});

export const Db2CurrentSchema = createToken({
	name: 'Db2CurrentSchema',
	pattern: /CURRENT\s+SCHEMA\b/i,
});

export const Db2CurrentServer = createToken({
	name: 'Db2CurrentServer',
	pattern: /CURRENT\s+SERVER\b/i,
});

export const Db2CurrentDate = createToken({
	name: 'Db2CurrentDate',
	pattern: /CURRENT\s+DATE\b/i,
});

export const Db2CurrentTime = createToken({
	name: 'Db2CurrentTime',
	pattern: /CURRENT\s+TIME\b/i,
});

export const Db2CurrentTimestamp = createToken({
	name: 'Db2CurrentTimestamp',
	pattern: /CURRENT\s+TIMESTAMP\b/i,
});

export const Db2CurrentUser = createToken({
	name: 'Db2CurrentUser',
	pattern: /CURRENT\s+USER\b/i,
});

export const Db2LanguageSql = createToken({
	name: 'Db2LanguageSql',
	pattern: /LANGUAGE\s+SQL\b/i,
});

export const Db2Nickname = createToken({
	name: 'Db2Nickname',
	pattern: /NICKNAME\b/i,
	longer_alt: baseLexer.Identifier,
});

const db2OnlyTokens = [
	Db2OptimizeFor,
	Db2WithUr,
	Db2WithCs,
	Db2WithRs,
	Db2WithRr,
	Db2ForReadOnly,
	Db2ForUpdate,
	Db2FinalTable,
	Db2OldTable,
	Db2NewTable,
	Db2ModifiedBy,
	Db2DeclareGlobalTemporary,
	Db2GeneratedAlways,
	Db2GeneratedByDefault,
	Db2OrganizeBy,
	Db2DataCapture,
	Db2CurrentSchema,
	Db2CurrentServer,
	Db2CurrentDate,
	Db2CurrentTime,
	Db2CurrentTimestamp,
	Db2CurrentUser,
	Db2LanguageSql,
	Db2Nickname,
	Db2Identity,
];

const db2AllTokens = [...db2OnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(db2AllTokens);

export * from '../../netezza/sql/lexer';
