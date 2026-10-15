import { createToken, Lexer } from 'chevrotain';
import * as shared from '../../netezza/sql/lexer';
import { findPostgresqlQuotedRegion } from '@justybase/sql-core/postgresqlLexical';

/** Match the exact delimiter without interpreting SQL inside the body. */
export function matchDollarQuotedString(text: string, offset: number): RegExpExecArray | null {
  const region = findPostgresqlQuotedRegion(text, offset);
  if (text[offset] !== '$' || !region?.closed) return null;
  const match = [text.slice(offset, region.end)] as RegExpExecArray;
  match.index = offset;
  match.input = text;
  return match;
}
export const DollarQuotedString = createToken({ name: 'DollarQuotedString', pattern: { exec: matchDollarQuotedString }, categories: shared.StringLiteral, line_breaks: true, start_chars_hint: ['$'] });
export const QuotedIdentifier = createToken({ name: 'QuotedIdentifier', pattern: /"(?:""|[^"])+"/, line_breaks: true });
export const UnicodeIdentifier = createToken({ name: 'UnicodeIdentifier', pattern: /(?=[\p{L}\p{N}_$]*\P{ASCII})[\p{L}_][\p{L}\p{N}_$]*/u, categories: shared.Identifier });
export const EscapeString = createToken({ name: 'EscapeString', pattern: /[Ee]'(?:[^'\\]|\\[\s\S]|'')*'/, categories: shared.StringLiteral, line_breaks: true });
export const UnterminatedEscapeString = createToken({ name: 'UnterminatedEscapeString', pattern: { exec: (text: string, offset: number) => {
  if (!/[Ee]/.test(text[offset] ?? '') || text[offset + 1] !== "'") return null;
  const region = findPostgresqlQuotedRegion(text, offset);
  if (!region || region.closed) return null;
  const match = [text.slice(offset)] as RegExpExecArray;
  match.index = offset; match.input = text;
  return match;
} }, line_breaks: true, start_chars_hint: ['E', 'e'] });
export const JsonTextPath = createToken({ name: 'JsonTextPath', pattern: /#>>/ });
export const JsonPath = createToken({ name: 'JsonPath', pattern: /#>/ });
export const JsonTextArrow = createToken({ name: 'JsonTextArrow', pattern: /->>/ });
export const JsonArrow = createToken({ name: 'JsonArrow', pattern: /->/ });
export const JsonExistsAny = createToken({ name: 'JsonExistsAny', pattern: /\?\|/ });
export const JsonExistsAll = createToken({ name: 'JsonExistsAll', pattern: /\?&/ });
export const JsonExists = createToken({ name: 'JsonExists', pattern: /\?/ });
export const JsonContains = createToken({ name: 'JsonContains', pattern: /@>/ });
export const JsonContained = createToken({ name: 'JsonContained', pattern: /<@/ });
export const Colon = createToken({ name: 'Colon', pattern: /:(?!:)/ });
const keyword = (name: string, word = name) => createToken({ name, pattern: new RegExp(word + '\\b', 'i'), longer_alt: shared.Identifier });
export const Lateral = keyword('Lateral');
export const Returning = keyword('Returning');
export const Conflict = keyword('Conflict');
export const Do = keyword('Do');
export const Nothing = keyword('Nothing');
export const ArrayKeyword = keyword('ArrayKeyword', 'ARRAY');
export const Window = keyword('Window');
export const Ordinality = keyword('Ordinality');
export const Overriding = keyword('Overriding');
export const System = keyword('System');
export const Value = keyword('Value');
export const FunctionKeyword = keyword('FunctionKeyword', 'FUNCTION');
export const Index = keyword('Index');
export const Domain = keyword('Domain');
export const Enum = keyword('Enum');
export const Generated = keyword('Generated');
export const Always = keyword('Always');
export const Identity = keyword('Identity');
export const Stored = keyword('Stored');
export const Virtual = keyword('Virtual');
export const By = keyword('By');
export const Atomic = keyword('Atomic');
export const Include = keyword('Include');
export const Collate = keyword('Collate');


export const Matched = keyword('Matched');
export const Source = keyword('Source');
export const Target = keyword('Target');
export const Old = keyword('Old');
export const New = keyword('New');
export const JsonTable = keyword('JsonTable', 'JSON_TABLE');
export const Columns = keyword('Columns');
export const Path = keyword('Path');
export const Concurrently = keyword('Concurrently');

// These are ordinary names in PostgreSQL. Reject foreign instructions in the
// grammar instead of rejecting identifiers such as SELECT 1 AS groom.
const netezzaOnly = new Set(['Distribute', 'Organize', 'Groom', 'Versions', 'Reclaim', 'Backupset', 'Nzplsql', 'BeginProc', 'EndProc', 'Synonym', 'Generate', 'Statistics', 'History', 'Scheduler', 'DollarIdentifier', 'Parameter']);
export const allTokens = [
  DollarQuotedString, EscapeString, UnterminatedEscapeString, QuotedIdentifier, UnicodeIdentifier, JsonTextPath, JsonPath, JsonTextArrow, JsonArrow,
  JsonExistsAny, JsonExistsAll, JsonExists, JsonContains, JsonContained, Colon,
  Matched, Source, Target, Old, New, JsonTable, Columns, Path, Concurrently,
  Lateral, Returning, Conflict, Do, Nothing, ArrayKeyword, Window, Ordinality,
  Overriding, System, Value, FunctionKeyword, Index, Domain, Enum, Generated,
  Always, Identity, Stored, Virtual, By, Atomic, Include, Collate,
  ...shared.allTokens.filter(token => !netezzaOnly.has(token.name) && !['Value', 'QuotedIdentifier'].includes(token.name)),
];
export const SqlLexer = new Lexer(allTokens);
export * from '../../netezza/sql/lexer';
