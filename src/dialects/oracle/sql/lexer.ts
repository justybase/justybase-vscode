import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * Oracle-only lexical forms. The shared token objects are deliberately reused
 * so the common parser rules keep the same CST shape for SELECT/CTE/DML.
 * Oracle-specific tokens are placed before the shared token list so exact
 * Oracle keywords win over the broad identifier fallback.
 */
export const OracleConnect = createToken({
    name: 'OracleConnect',
    pattern: /CONNECT\b/i,
});

export const OracleBy = createToken({
    name: 'OracleBy',
    pattern: /BY\b/i,
});

export const OraclePrior = createToken({
    name: 'OraclePrior',
    pattern: /PRIOR\b/i,
});

export const OracleNocycle = createToken({
    name: 'OracleNocycle',
    pattern: /NOCYCLE\b/i,
});

export const OraclePivot = createToken({
    name: 'OraclePivot',
    pattern: /PIVOT\b/i,
});

export const OracleUnpivot = createToken({
    name: 'OracleUnpivot',
    pattern: /UNPIVOT\b/i,
});

export const OracleReturning = createToken({
    name: 'OracleReturning',
    pattern: /RETURNING\b/i,
});

export const OraclePragma = createToken({
    name: 'OraclePragma',
    pattern: /PRAGMA\b/i,
});

export const OracleBindVariable = createToken({
    name: 'OracleBindVariable',
    pattern: /:[A-Za-z_][A-Za-z0-9_$#]*(?:\.[A-Za-z_][A-Za-z0-9_$#]*)*/,
    categories: [baseLexer.Parameter],
});

export const OracleQualifiedFunction = createToken({
    name: 'OracleQualifiedFunction',
    pattern: /[A-Za-z_][A-Za-z0-9_$#]*(?:\.[A-Za-z_][A-Za-z0-9_$#]*)+(?=\s*\()/,
});

export const OracleAtSign = createToken({
    name: 'OracleAtSign',
    pattern: /@/,
});

export const OracleOrderSiblingsBy = createToken({
    name: 'OracleOrderSiblingsBy',
    pattern: /ORDER\s+SIBLINGS\s+BY\b/i,
});

const oracleOnlyTokens = [
    OracleQualifiedFunction,
    OracleOrderSiblingsBy,
    OracleConnect,
    OracleBy,
    OraclePrior,
    OracleNocycle,
    OraclePivot,
    OracleUnpivot,
    OracleReturning,
    OraclePragma,
    OracleBindVariable,
    OracleAtSign,
];

const oracleAllTokens = [...oracleOnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(oracleAllTokens);

export * from '../../netezza/sql/lexer';
