import type { ValidationError } from '../../sqlParser/types';
import { SqlLexer, JsonTable, Merge, Returning, Generated, Virtual, With, By, Source, Target } from './sql/lexer';

/** Parsing uses the 16–18 union; known older servers receive contextual warnings. */
export function getPostgresqlVersionDiagnostics(sql: string, serverVersionNum?: number): ValidationError[] {
  if (!serverVersionNum) return [];
  const major = Math.floor(serverVersionNum / 10000);
  const { tokens } = SqlLexer.tokenize(sql);
  const issues: ValidationError[] = [];
  let merge = false;
  let generated = false;
  tokens.forEach((token, index) => {
    if (token.tokenType.name === 'Semicolon') { merge = false; generated = false; }
    if (token.tokenType === Merge) merge = true;
    if (token.tokenType === Generated) generated = true;
    const required = token.tokenType === JsonTable ? 17
      : merge && token.tokenType === Returning ? 17
      : merge && token.tokenType === By && [Source, Target].includes(tokens[index + 1]?.tokenType) ? 17
      : token.tokenType === Returning && tokens[index + 1]?.tokenType === With ? 18
      : generated && token.tokenType === Virtual ? 18 : undefined;
    if (!required || major >= required) return;
    const line = token.startLine ?? 1;
    const column = token.startColumn ?? 1;
    issues.push({
      code: 'PG001', severity: 'warning',
      message: token.image.toUpperCase() + ' requires PostgreSQL ' + required + ' or newer (connected to ' + major + ').',
      position: { startLine: line, endLine: line, startColumn: column, endColumn: column + token.image.length, offset: token.startOffset },
    });
  });
  return issues;
}
