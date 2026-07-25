/**
 * Static guard against catastrophic TextMate lookbehinds.
 *
 * Per-rule line lookbehinds like `(?m)(?<!^\s*--[^\n]*)`, variable-length
 * CREATE TABLE lookbehinds, and `\s+` / `\s*` inside lookbehinds (P16/P17)
 * caused severe tokenization cost on long lines. Comment/string exclusion
 * must use injectionSelector only; qualified-name context uses begin/end.
 *
 * Allowed in lookbehinds: literal space, `\s`, or bounded `\s{1,N}` / `\s{N}`.
 */

import * as fs from 'fs';
import * as path from 'path';

const SYNTAXES_ROOT = path.join(process.cwd(), 'dialects');

interface LookbehindHit {
  readonly file: string;
  readonly field: string;
  readonly kind: '<=' | '<!';
  readonly body: string;
  readonly reason: string;
}

function listTmLanguageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTmLanguageFiles(full));
    } else if (entry.name.endsWith('.tmLanguage.json')) {
      out.push(full);
    }
  }
  return out;
}

/** Walk grammar JSON and collect match/begin/end string fields. */
function collectPatternStrings(
  node: unknown,
  pathParts: string[],
  out: Array<{ field: string; value: string }>,
): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) =>
      collectPatternStrings(child, [...pathParts, String(index)], out),
    );
    return;
  }
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const nextPath = [...pathParts, key];
    if (
      (key === 'match' || key === 'begin' || key === 'end') &&
      typeof value === 'string'
    ) {
      out.push({ field: nextPath.join('.'), value });
    } else {
      collectPatternStrings(value, nextPath, out);
    }
  }
}

function extractLookbehinds(
  pattern: string,
): Array<{ kind: '<=' | '<!'; body: string }> {
  const hits: Array<{ kind: '<=' | '<!'; body: string }> = [];
  for (let i = 0; i < pattern.length; i++) {
    let kind: '<=' | '<!';
    if (pattern.startsWith('(?<=', i)) {
      kind = '<=';
    } else if (pattern.startsWith('(?<!', i)) {
      kind = '<!';
    } else {
      continue;
    }
    const bodyStart = i + 4;

    let depth = 0;
    let j = i;
    for (; j < pattern.length; j++) {
      const ch = pattern[j];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          j += 1;
          break;
        }
      }
    }
    hits.push({ kind, body: pattern.slice(bodyStart, j - 1) });
  }
  return hits;
}

/**
 * Classify a lookbehind body. Returns a reason string if forbidden, else null.
 * Open-ended `\s+` / `\s*` are forbidden; bounded `\s{1,N}` is allowed.
 */
function forbiddenLookbehindReason(
  kind: '<=' | '<!',
  body: string,
): string | null {
  // Line-start / comment line-guards (the O(n²) class from 27ccd079).
  if (kind === '<!' && /^\^/.test(body)) {
    return 'negative lookbehind anchored at start of line (^) — use injectionSelector instead';
  }
  if (/\\s\*--/.test(body) || /\^\\s\*/.test(body)) {
    return 'line-comment lookbehind guard — use injectionSelector instead';
  }

  // Open-ended whitespace in lookbehinds (P16/P17 pathology).
  if (/\\s[+*]/.test(body)) {
    return 'open-ended \\s+ / \\s* inside lookbehind — use begin/end or bounded \\s{1,N}';
  }

  // Strip allowed bounded whitespace, then reject other open-ended repeats.
  const withoutBoundedWs = body
    .replace(/\\s\{\d+(?:,\d+)?\}/g, '')
    .replace(/\\s(?![{*+?])/g, '');
  if (/\.\*|\.\+|\[\^\\n\][*+]|\{\d+,\}/.test(withoutBoundedWs)) {
    return 'unbounded wildcard or open-ended quantifier inside lookbehind';
  }
  if (/[*+]/.test(withoutBoundedWs.replace(/\{\d+,\d+\}/g, ''))) {
    return 'variable-length quantifier (* or +) inside lookbehind';
  }

  // Optional groups that themselves contain whitespace → P0d-style variable length.
  if (/\(\?:[^)]*\\s[^)]*\)\?/.test(body)) {
    return 'optional group containing whitespace inside lookbehind (variable-length CREATE/TABLE style)';
  }

  return null;
}

function scanFile(filePath: string): LookbehindHit[] {
  const grammar = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const patterns: Array<{ field: string; value: string }> = [];
  collectPatternStrings(grammar, [], patterns);

  const rel = path.relative(process.cwd(), filePath);
  const hits: LookbehindHit[] = [];
  for (const { field, value } of patterns) {
    for (const lb of extractLookbehinds(value)) {
      const reason = forbiddenLookbehindReason(lb.kind, lb.body);
      if (reason) {
        hits.push({
          file: rel,
          field,
          kind: lb.kind,
          body: lb.body,
          reason,
        });
      }
    }
  }
  return hits;
}

describe('TextMate lookbehind static guard', () => {
  it('finds no catastrophic lookbehinds in dialect grammars', () => {
    const files = listTmLanguageFiles(SYNTAXES_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const violations = files.flatMap(scanFile);
    expect(violations).toEqual([]);
  });

  it('flags line-guards, P0d, and open-ended \\s+ lookbehinds', () => {
    expect(
      forbiddenLookbehindReason('<!', '^\\s*--[^\\n]*'),
    ).toMatch(/injectionSelector|line-comment|start of line|open-ended/);

    expect(
      forbiddenLookbehindReason(
        '<=',
        '\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:GLOBAL\\s+)?(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?',
      ),
    ).toMatch(/optional group containing whitespace|open-ended/);

    expect(
      forbiddenLookbehindReason(
        '<=',
        '\\b(?:FROM|JOIN|INTO|UPDATE|TABLE|VIEW|DROP|ALTER|TRUNCATE|GROOM)\\s+',
      ),
    ).toMatch(/open-ended/);

    expect(forbiddenLookbehindReason('<=', '\\b(?:FROM|JOIN)\\s+')).toMatch(
      /open-ended/,
    );
    expect(forbiddenLookbehindReason('<=', '\\btable\\s+')).toMatch(/open-ended/);

    expect(forbiddenLookbehindReason('<=', '\\btable\\s{1,16}')).toBeNull();
    expect(forbiddenLookbehindReason('<=', '\\b(?:FROM|JOIN)\\s')).toBeNull();
  });
});
