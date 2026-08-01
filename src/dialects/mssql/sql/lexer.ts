import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * T-SQL lexical additions. Multi-word / special forms are listed first so they
 * win over Identifier. Shared tokens are reused for SELECT/DML CST shape.
 */
export const MsSqlTop = createToken({
	name: 'MsSqlTop',
	pattern: /TOP\b/i,
	longer_alt: baseLexer.Identifier,
});

export const MsSqlOutput = createToken({
	name: 'MsSqlOutput',
	pattern: /OUTPUT\b/i,
	longer_alt: baseLexer.Identifier,
});

export const MsSqlApply = createToken({
	name: 'MsSqlApply',
	pattern: /APPLY\b/i,
	longer_alt: baseLexer.Identifier,
});

export const MsSqlOuterApply = createToken({
	name: 'MsSqlOuterApply',
	pattern: /OUTER\s+APPLY\b/i,
});

export const MsSqlCrossApply = createToken({
	name: 'MsSqlCrossApply',
	pattern: /CROSS\s+APPLY\b/i,
});

export const MsSqlTry = createToken({
	name: 'MsSqlTry',
	pattern: /TRY\b/i,
	longer_alt: baseLexer.Identifier,
});

export const MsSqlCatch = createToken({
  name: 'MsSqlCatch',
  pattern: /CATCH\b/i,
  longer_alt: baseLexer.Identifier,
});

export const MsSqlProc = createToken({
  name: 'MsSqlProc',
  pattern: /PROC\b/i,
  longer_alt: baseLexer.Identifier,
});

export const MsSqlRecompile = createToken({
  name: 'MsSqlRecompile',
  pattern: /RECOMPILE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const MsSqlEncryption = createToken({
  name: 'MsSqlEncryption',
  pattern: /ENCRYPTION\b/i,
  longer_alt: baseLexer.Identifier,
});

export const MsSqlPercent = createToken({
  name: 'MsSqlPercent',
  pattern: /PERCENT\b/i,
  longer_alt: baseLexer.Identifier,
});

/** Bracketed T-SQL identifier: [name] or [na]]me] */
export const MsSqlBracketedIdentifier = createToken({
	name: 'MsSqlBracketedIdentifier',
	pattern: /\[(?:[^\]]|\])*\]/,
});

/** T-SQL local/global variable: @name or @@name */
export const MsSqlVariable = createToken({
	name: 'MsSqlVariable',
	pattern: /@@?[A-Za-z_][\w$]*/,
});

const mssqlOnlyTokens = [
  MsSqlCrossApply,
  MsSqlOuterApply,
  MsSqlTop,
  MsSqlOutput,
  MsSqlApply,
  MsSqlTry,
  MsSqlCatch,
  MsSqlProc,
  MsSqlRecompile,
  MsSqlEncryption,
  MsSqlPercent,
  MsSqlBracketedIdentifier,
  MsSqlVariable,
];

const mssqlAllTokens = [...mssqlOnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(mssqlAllTokens);

export * from '../../netezza/sql/lexer';
