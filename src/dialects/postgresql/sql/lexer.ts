import { createToken, Lexer } from 'chevrotain';
import * as shared from '../../netezza/sql/lexer';

/** PostgreSQL operators which are not present in the shared SQL token set. */
export const JsonTextPath = createToken({ name: 'JsonTextPath', pattern: /#>>/ });
export const JsonPath = createToken({ name: 'JsonPath', pattern: /#>/ });
export const JsonTextArrow = createToken({ name: 'JsonTextArrow', pattern: /->>/ });
export const JsonArrow = createToken({ name: 'JsonArrow', pattern: /->/ });
export const Lateral = createToken({ name: 'Lateral', pattern: /LATERAL\b/i, longer_alt: shared.Identifier });
export const Returning = createToken({ name: 'Returning', pattern: /RETURNING\b/i, longer_alt: shared.Identifier });
export const Conflict = createToken({ name: 'Conflict', pattern: /CONFLICT\b/i, longer_alt: shared.Identifier });
export const Do = createToken({ name: 'Do', pattern: /DO\b/i, longer_alt: shared.Identifier });
export const Nothing = createToken({ name: 'Nothing', pattern: /NOTHING\b/i, longer_alt: shared.Identifier });
export const ArrayKeyword = createToken({ name: 'ArrayKeyword', pattern: /ARRAY\b/i });

/** Tokens which must never be accepted as PostgreSQL syntax. */
export const UnsupportedNetezza = createToken({
  name: 'UnsupportedNetezza',
  pattern: /(?:DISTRIBUTE|ORGANIZE|GROOM|VERSIONS|RECLAIM|BACKUPSET)\b/i,
});

const unsupportedTokenTypes = new Set([
  shared.Distribute,
  shared.Organize,
  shared.Groom,
  shared.Versions,
  shared.Reclaim,
  shared.Backupset,
]);

export const allTokens = [
  UnsupportedNetezza,
  JsonTextPath,
  JsonPath,
  JsonTextArrow,
  JsonArrow,
  Lateral,
  Returning,
  Conflict,
  Do,
  Nothing,
  ArrayKeyword,
  ...shared.allTokens.filter(token => !unsupportedTokenTypes.has(token)),
];

export const SqlLexer = new Lexer(allTokens);

export * from '../../netezza/sql/lexer';
