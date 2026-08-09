import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * DuckDB lexical additions. Multi-word phrases must precede the shared token
 * bundle so USING SAMPLE and TABLESAMPLE are not split into generic keywords.
 */
export const DuckDbUsingSample = createToken({
  name: 'DuckDbUsingSample',
  pattern: /USING\s+SAMPLE\b/i,
});

export const DuckDbWithOrdinality = createToken({
  name: 'DuckDbWithOrdinality',
  pattern: /WITH\s+ORDINALITY\b/i,
});

export const DuckDbTableSample = createToken({
  name: 'DuckDbTableSample',
  pattern: /TABLESAMPLE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbQualify = createToken({
  name: 'DuckDbQualify',
  pattern: /QUALIFY\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbSample = createToken({
  name: 'DuckDbSample',
  pattern: /SAMPLE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbAsOf = createToken({
  name: 'DuckDbAsOf',
  pattern: /ASOF\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbPositional = createToken({
  name: 'DuckDbPositional',
  pattern: /POSITIONAL\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbPivot = createToken({
  name: 'DuckDbPivot',
  pattern: /PIVOT\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbUnpivot = createToken({
  name: 'DuckDbUnpivot',
  pattern: /UNPIVOT\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbPivotWider = createToken({
  name: 'DuckDbPivotWider',
  pattern: /PIVOT_WIDER\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbPivotLonger = createToken({
  name: 'DuckDbPivotLonger',
  pattern: /PIVOT_LONGER\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbInstall = createToken({
  name: 'DuckDbInstall',
  pattern: /INSTALL\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbLoad = createToken({
  name: 'DuckDbLoad',
  pattern: /LOAD\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbAttach = createToken({
  name: 'DuckDbAttach',
  pattern: /ATTACH\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbDetach = createToken({
  name: 'DuckDbDetach',
  pattern: /DETACH\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbMacro = createToken({
  name: 'DuckDbMacro',
  pattern: /MACRO\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbFunction = createToken({
  name: 'DuckDbFunction',
  pattern: /FUNCTION\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbUse = createToken({
  name: 'DuckDbUse',
  pattern: /USE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbSemi = createToken({
  name: 'DuckDbSemi',
  pattern: /SEMI\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbAnti = createToken({
  name: 'DuckDbAnti',
  pattern: /ANTI\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbLateral = createToken({
  name: 'DuckDbLateral',
  pattern: /LATERAL\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbWindow = createToken({
  name: 'DuckDbWindow',
  pattern: /WINDOW\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbRepeatable = createToken({
  name: 'DuckDbRepeatable',
  pattern: /REPEATABLE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbPercent = createToken({
  name: 'DuckDbPercent',
  pattern: /PERCENT\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbInclude = createToken({
  name: 'DuckDbInclude',
  pattern: /INCLUDE\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbReservoir = createToken({
  name: 'DuckDbReservoir',
  pattern: /RESERVOIR\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbBernoulli = createToken({
  name: 'DuckDbBernoulli',
  pattern: /BERNOULLI\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbSystem = createToken({
  name: 'DuckDbSystem',
  pattern: /SYSTEM\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbBy = createToken({
  name: 'DuckDbBy',
  pattern: /BY\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbIgnoreNulls = createToken({
  name: 'DuckDbIgnoreNulls',
  pattern: /IGNORE\s+NULLS\b/i,
  longer_alt: baseLexer.Identifier,
});

export const DuckDbRespectNulls = createToken({
  name: 'DuckDbRespectNulls',
  pattern: /RESPECT\s+NULLS\b/i,
  longer_alt: baseLexer.Identifier,
});

const duckDbOnlyTokens = [
  DuckDbUsingSample,
  DuckDbWithOrdinality,
  DuckDbTableSample,
  DuckDbQualify,
  DuckDbSample,
  DuckDbAsOf,
  DuckDbPositional,
  DuckDbPivot,
  DuckDbUnpivot,
  DuckDbPivotWider,
  DuckDbPivotLonger,
  DuckDbInstall,
  DuckDbLoad,
  DuckDbAttach,
  DuckDbDetach,
  DuckDbMacro,
  DuckDbFunction,
  DuckDbUse,
  DuckDbSemi,
  DuckDbAnti,
  DuckDbLateral,
  DuckDbWindow,
  DuckDbRepeatable,
  DuckDbPercent,
  DuckDbInclude,
  DuckDbReservoir,
  DuckDbBernoulli,
  DuckDbSystem,
  DuckDbBy,
  DuckDbIgnoreNulls,
  DuckDbRespectNulls,
];

export const allTokens = [...duckDbOnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(allTokens);

export * from '../../netezza/sql/lexer';
