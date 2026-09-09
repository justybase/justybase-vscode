interface RetryToken {
  kind: 'word' | 'quoted' | 'left-paren' | 'other';
  word?: string;
}

interface RetryScan {
  tokens: RetryToken[];
  valid: boolean;
  statements: number;
}

function identifierStart(value: string): boolean {
  return /[A-Za-z_\p{L}\p{Nl}]/u.test(value);
}

function identifierPart(value: string): boolean {
  return /[A-Za-z0-9_$#\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}]/u.test(value);
}

function quotedEnd(sql: string, start: number, close: string, backslashEscapes: boolean): number | undefined {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (backslashEscapes && sql[index] === '\\' && index + 1 < sql.length) {
      index += 1;
      continue;
    }
    if (sql[index] !== close) continue;
    if (sql[index + 1] === close) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  return undefined;
}

function blockCommentEnd(sql: string, start: number): number | undefined {
  let depth = 1;
  for (let index = start + 2; index < sql.length - 1; index += 1) {
    if (sql[index] === '/' && sql[index + 1] === '*') {
      depth += 1;
      index += 1;
      continue;
    }
    if (sql[index] === '*' && sql[index + 1] === '/') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

function dollarQuotedEnd(sql: string, start: number): number | undefined {
  if (sql[start] !== '$') return undefined;
  let delimiterEnd = start + 1;
  if (sql[delimiterEnd] === '$') {
    delimiterEnd += 1;
  } else {
    if (!/[A-Za-z_]/u.test(sql[delimiterEnd] ?? '')) return undefined;
    delimiterEnd += 1;
    while (/[A-Za-z0-9_]/u.test(sql[delimiterEnd] ?? '')) delimiterEnd += 1;
    if (sql[delimiterEnd] !== '$') return undefined;
    delimiterEnd += 1;
  }
  const delimiter = sql.slice(start, delimiterEnd);
  const closing = sql.indexOf(delimiter, delimiterEnd);
  return closing < 0 ? undefined : closing + delimiter.length;
}

function positionalParameterEnd(sql: string, start: number): number | undefined {
  if (sql[start] !== '$' || !/\d/u.test(sql[start + 1] ?? '')) return undefined;
  let end = start + 2;
  while (/\d/u.test(sql[end] ?? '')) end += 1;
  return identifierPart(sql[end] ?? '') ? undefined : end;
}

function scan(sql: string): RetryScan {
  const tokens: RetryToken[] = [];
  let statements = 0;
  let sawExecutable = false;

  for (let index = 0; index < sql.length;) {
    const character = sql[index] ?? '';
    const next = sql[index + 1] ?? '';

    if (/\s/u.test(character) || character === '\uFEFF') {
      index += 1;
      continue;
    }

    if (character === ';') {
      if (sawExecutable) statements += 1;
      sawExecutable = false;
      index += 1;
      continue;
    }

    if (character === '-' && next === '-') {
      const compact = sql[index + 2] !== undefined && !/\s/u.test(sql[index + 2] ?? '');
      if (compact && tokens.length > 0) return { tokens, valid: false, statements };
      const lineEnd = sql.slice(index + 2).search(/[\r\n]/u);
      index = lineEnd < 0 ? sql.length : index + 2 + lineEnd + 1;
      continue;
    }

    if (character === '/' && next === '*') {
      if (sql[index + 2] === '!') return { tokens, valid: false, statements };
      const end = blockCommentEnd(sql, index);
      if (end === undefined) return { tokens, valid: false, statements };
      index = end;
      continue;
    }

    if (character === '#') {
      if (next !== '>') return { tokens, valid: false, statements };
      tokens.push({ kind: 'other' });
      sawExecutable = true;
      index += sql[index + 2] === '>' ? 3 : 2;
      continue;
    }

    if (character === "'") {
      const end = quotedEnd(sql, index, "'", true);
      if (end === undefined) return { tokens, valid: false, statements };
      sawExecutable = true;
      index = end;
      continue;
    }

    if (character === '"' || character === '`' || character === '[') {
      const end = quotedEnd(sql, index, character === '[' ? ']' : character, character !== '[');
      if (end === undefined) return { tokens, valid: false, statements };
      tokens.push({ kind: 'quoted' });
      sawExecutable = true;
      index = end;
      continue;
    }

    if (character === '$') {
      const parameterEnd = positionalParameterEnd(sql, index);
      if (parameterEnd !== undefined) {
        sawExecutable = true;
        index = parameterEnd;
        continue;
      }
      const literalEnd = dollarQuotedEnd(sql, index);
      if (literalEnd === undefined) return { tokens, valid: false, statements };
      sawExecutable = true;
      index = literalEnd;
      continue;
    }

    if (identifierStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && identifierPart(sql[index] ?? '')) index += 1;
      tokens.push({ kind: 'word', word: sql.slice(start, index).toUpperCase() });
      sawExecutable = true;
      continue;
    }

    tokens.push({ kind: character === '(' ? 'left-paren' : 'other' });
    sawExecutable = true;
    index += 1;
  }

  if (sawExecutable) statements += 1;
  return { tokens, valid: true, statements };
}

function hasSequence(words: readonly string[], sequence: readonly string[]): boolean {
  for (let index = 0; index <= words.length - sequence.length; index += 1) {
    if (sequence.every((word, offset) => words[index + offset] === word)) return true;
  }
  return false;
}

/**
 * Conservative, dialect-neutral replay classifier. A positive result means
 * that the SQL has one allow-listed read shape and no known stateful or
 * ambiguous expression. Unknown syntax is rejected rather than replayed.
 */
export function isSafeToRetrySql(sql: string): boolean {
  const result = scan(sql);
  if (!result.valid || result.statements !== 1) return false;

  const words = result.tokens
    .filter((token): token is RetryToken & { kind: 'word'; word: string } => token.kind === 'word' && token.word !== undefined)
    .map(token => token.word);
  const first = words[0];
  const allowedFirstWords = ['SELECT', 'VALUES', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];
  if (!first || !allowedFirstWords.includes(first)) return false;

  if (words.includes('INTO') || words.includes('NEXTVAL') || words.includes('SETVAL')) return false;
  if (hasSequence(words, ['NEXT', 'VALUE', 'FOR']) || hasSequence(words, ['FOR', 'UPDATE']) || hasSequence(words, ['FOR', 'SHARE'])) return false;

  // Skip only the command's first word so `VALUES (1)` and `SELECT (1)` are
  // accepted, while `SELECT user_function(value)` is rejected.
  let firstWordSeen = false;
  for (let index = 0; index < result.tokens.length; index += 1) {
    const token = result.tokens[index];
    if (token?.kind === 'word' && !firstWordSeen) {
      firstWordSeen = true;
      continue;
    }
    if ((token?.kind === 'word' || token?.kind === 'quoted') && result.tokens[index + 1]?.kind === 'left-paren') return false;
  }

  if (first !== 'EXPLAIN') return true;
  const explainIndex = words.findIndex(word => word !== 'EXPLAIN' && word !== 'VERBOSE');
  if (explainIndex < 0) return false;
  return ['SELECT', 'VALUES', 'SHOW', 'DESCRIBE', 'DESC'].includes(words[explainIndex] ?? '');
}
