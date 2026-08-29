import { createToken, Lexer } from 'chevrotain';
import * as netezzaLexer from '../../netezza/sql/lexer';

/** ClickHouse accepts backticks for identifiers and doubles embedded backticks. */
export const BacktickIdentifier = createToken({
    name: 'ClickHouseBacktickIdentifier',
    pattern: /`(?:``|[^`])*`/,
});

export const HashLineComment = createToken({
    name: 'ClickHouseHashLineComment',
    pattern: /#[^\r\n]*/,
    group: Lexer.SKIPPED,
});

export const Prewhere = createToken({ name: 'ClickHousePrewhere', pattern: /PREWHERE/i, longer_alt: netezzaLexer.Identifier });
export const ArrayJoin = createToken({ name: 'ClickHouseArrayJoin', pattern: /ARRAY\s+JOIN/i, longer_alt: netezzaLexer.Identifier });
export const Sample = createToken({ name: 'ClickHouseSample', pattern: /SAMPLE/i, longer_alt: netezzaLexer.Identifier });
export const Qualify = createToken({ name: 'ClickHouseQualify', pattern: /QUALIFY/i, longer_alt: netezzaLexer.Identifier });
export const By = createToken({ name: 'ClickHouseBy', pattern: /BY/i, longer_alt: netezzaLexer.Identifier });
export const Fill = createToken({ name: 'ClickHouseFill', pattern: /FILL/i, longer_alt: netezzaLexer.Identifier });
export const Step = createToken({ name: 'ClickHouseStep', pattern: /STEP/i, longer_alt: netezzaLexer.Identifier });
export const Optimize = createToken({ name: 'ClickHouseOptimize', pattern: /OPTIMIZE/i, longer_alt: netezzaLexer.Identifier });
export const Format = createToken({ name: 'ClickHouseFormat', pattern: /FORMAT/i, longer_alt: netezzaLexer.Identifier });
export const Engine = createToken({ name: 'ClickHouseEngine', pattern: /ENGINE/i, longer_alt: netezzaLexer.Identifier });
export const Ttl = createToken({ name: 'ClickHouseTtl', pattern: /TTL/i, longer_alt: netezzaLexer.Identifier });
export const Settings = createToken({ name: 'ClickHouseSettings', pattern: /SETTINGS/i, longer_alt: netezzaLexer.Identifier });

// ClickHouse-only tokens must appear before the shared Identifier token. The
// shared token identities are intentionally reused so the existing CST
// visitors and completion infrastructure continue to work.
export const allTokens = [
    HashLineComment,
    BacktickIdentifier,
    ArrayJoin,
    Prewhere,
    Qualify,
    Sample,
    Optimize,
    Fill,
    Step,
    Format,
    Engine,
    Ttl,
    Settings,
    By,
    ...netezzaLexer.allTokens,
];

export const SqlLexer = new Lexer(allTokens);

export * from '../../netezza/sql/lexer';
