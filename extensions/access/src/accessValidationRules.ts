/**
 * Translates Access `ValidationRule` expressions into DuckDB boolean
 * expressions, so the SQL mirror rejects the same values Access would reject.
 *
 * Access stores the rule as raw expression text; the shapes accepted here were
 * verified against DAO 16 (see `src/__tests__/accessValidationRule.test.ts`):
 *
 *   >0                      NULL passes, 0 and -1 rejected
 *   Between 1 And 100       NULL passes, 0 and 101 rejected
 *   Is Null Or [num] > 3    NULL passes, 2 rejected, 7 accepted
 *   Not ([num] = 7)         everything but 7 passes
 *   In (1,2,3)              NULL passes, 2 accepted, 7 rejected
 *   CLng("a1")>2            "a1" is a string literal, not the column
 *
 * Double quotes are string literals in Access rules just as in Access SQL;
 * only `[brackets]` address a column, and an unknown bracketed name is refused.
 * Anything outside this subset returns `undefined`: the mirror then loads the
 * table without a CHECK constraint instead of guessing and blocking values
 * Access accepts.  SQL `CHECK` treats a NULL result as a pass, which matches
 * Access: a rule only rejects when it evaluates to false.
 */

type TokenKind = 'identifier' | 'string' | 'number' | 'symbol' | 'word';

interface Token {
    readonly kind: TokenKind;
    readonly text: string;
}

const CAST_FUNCTIONS: Readonly<Record<string, string>> = {
    clng: 'BIGINT',
    cint: 'SMALLINT',
    cdbl: 'DOUBLE',
    csng: 'REAL',
    ccur: 'DECIMAL(19,4)',
    cbool: 'BOOLEAN',
    cdate: 'TIMESTAMP',
    cstr: 'VARCHAR',
};

/** Rules that start with an operator compare against the owning column. */
const IMPLICIT_OPERATOR_PREFIXES = ['>=', '<=', '<>', '!=', '>', '<', '='];

/** Rules that start with a keyword compare against the owning column. */
const IMPLICIT_WORD_PREFIXES = ['between', 'in', 'is'];

class UnsupportedRule extends Error {}

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function escapeString(text: string): string {
    return `'${text.replace(/'/g, "''")}'`;
}

function tokenize(rule: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;
    while (index < rule.length) {
        const character = rule[index]!;
        if (/\s/.test(character)) {
            index++;
            continue;
        }
        if (character === '[') {
            let stop = index + 1;
            let name = '';
            let closed = false;
            while (stop < rule.length) {
                if (rule[stop] === ']' && rule[stop + 1] === ']') {
                    name += ']';
                    stop += 2;
                    continue;
                }
                if (rule[stop] === ']') {
                    stop++;
                    closed = true;
                    break;
                }
                name += rule[stop] ?? '';
                stop++;
            }
            if (!closed) throw new UnsupportedRule('unclosed bracket');
            tokens.push({ kind: 'identifier', text: name });
            index = stop;
            continue;
        }
        if (character === '\'' || character === '"') {
            const quote = character;
            let stop = index + 1;
            let text = '';
            let closed = false;
            while (stop < rule.length) {
                if (rule[stop] === quote && rule[stop + 1] === quote) {
                    text += quote;
                    stop += 2;
                    continue;
                }
                if (rule[stop] === quote) {
                    stop++;
                    closed = true;
                    break;
                }
                text += rule[stop] ?? '';
                stop++;
            }
            if (!closed) throw new UnsupportedRule('unclosed quote');
            // Access SQL treats double quotes as string literals, not as
            // identifiers (ANSI-89).  A rule such as `CLng("a1")>2` casts the
            // text "a1" and always fails in Access; identifiers in rules must
            // be bracketed, so both quote styles become literals here.
            tokens.push({ kind: 'string', text });
            index = stop;
            continue;
        }
        if (/[0-9]/.test(character)) {
            let stop = index + 1;
            while (stop < rule.length && /[0-9.]/.test(rule[stop]!)) stop++;
            tokens.push({ kind: 'number', text: rule.slice(index, stop) });
            index = stop;
            continue;
        }
        if (/[A-Za-z_]/.test(character)) {
            let stop = index + 1;
            while (stop < rule.length && /[A-Za-z0-9_]/.test(rule[stop]!)) stop++;
            tokens.push({ kind: 'word', text: rule.slice(index, stop) });
            index = stop;
            continue;
        }
        const pair = rule.slice(index, index + 2);
        if (pair === '>=' || pair === '<=' || pair === '<>' || pair === '!=') {
            tokens.push({ kind: 'symbol', text: pair === '!=' ? '<>' : pair });
            index += 2;
            continue;
        }
        if ('()=<>+-,.'.includes(character)) {
            tokens.push({ kind: 'symbol', text: character });
            index++;
            continue;
        }
        throw new UnsupportedRule(`unsupported character ${character}`);
    }
    return tokens;
}

interface ParseContext {
    readonly columnNames: readonly string[];
}

class RuleParser {
    private _index = 0;

    public constructor(
        private readonly _tokens: readonly Token[],
        private readonly _context: ParseContext,
    ) {}

    public parse(): string {
        const expression = this.parseOr();
        if (this.peek()) throw new UnsupportedRule('trailing tokens');
        return expression;
    }

    private peek(offset = 0): Token | undefined {
        return this._tokens[this._index + offset];
    }

    private matchSymbol(symbol: string): boolean {
        const token = this.peek();
        if (!token || token.kind !== 'symbol' || token.text !== symbol) return false;
        this._index++;
        return true;
    }

    private matchWord(word: string): boolean {
        const token = this.peek();
        if (!token || token.kind !== 'word' || token.text.toLowerCase() !== word) return false;
        this._index++;
        return true;
    }

    private parseOr(): string {
        const parts = [this.parseAnd()];
        while (this.matchWord('or')) parts.push(this.parseAnd());
        return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
    }

    private parseAnd(): string {
        const parts = [this.parseNot()];
        while (this.matchWord('and')) parts.push(this.parseNot());
        return parts.length === 1 ? parts[0]! : `(${parts.join(' AND ')})`;
    }

    private parseNot(): string {
        if (this.matchWord('not')) return `(NOT ${this.parseNot()})`;
        return this.parseComparison();
    }

    private parseComparison(): string {
        const left = this.parsePrimary();
        const token = this.peek();
        if (!token) return left;

        if (token.kind === 'symbol' && ['=', '<>', '<', '>', '<=', '>='].includes(token.text)) {
            this._index++;
            return `(${left} ${token.text} ${this.parsePrimary()})`;
        }
        if (token.kind === 'word' && token.text.toLowerCase() === 'is') {
            this._index++;
            const negated = this.matchWord('not');
            if (!this.matchWord('null')) throw new UnsupportedRule('IS without NULL');
            return `(${left} IS ${negated ? 'NOT ' : ''}NULL)`;
        }
        if (token.kind === 'word' && token.text.toLowerCase() === 'between') {
            this._index++;
            const lower = this.parsePrimary();
            if (!this.matchWord('and')) throw new UnsupportedRule('BETWEEN without AND');
            const upper = this.parsePrimary();
            return `(${left} BETWEEN ${lower} AND ${upper})`;
        }
        if (token.kind === 'word' && token.text.toLowerCase() === 'in') {
            this._index++;
            if (!this.matchSymbol('(')) throw new UnsupportedRule('IN without list');
            const items: string[] = [];
            while (true) {
                items.push(this.parsePrimary());
                if (this.matchSymbol(',')) continue;
                if (this.matchSymbol(')')) break;
                throw new UnsupportedRule('IN list');
            }
            return `(${left} IN (${items.join(', ')}))`;
        }
        return left;
    }

    private parsePrimary(): string {
        const token = this.peek();
        if (!token) throw new UnsupportedRule('missing operand');

        if (token.kind === 'symbol' && token.text === '(') {
            this._index++;
            const inner = this.parseOr();
            if (!this.matchSymbol(')')) throw new UnsupportedRule('unbalanced parenthesis');
            return `(${inner})`;
        }
        if (token.kind === 'symbol' && (token.text === '-' || token.text === '+')) {
            this._index++;
            return `${token.text}${this.parsePrimary()}`;
        }
        if (token.kind === 'number') {
            this._index++;
            return token.text;
        }
        if (token.kind === 'string') {
            this._index++;
            return escapeString(token.text);
        }
        if (token.kind === 'identifier') {
            // Brackets are how Access spells an identifier, so an unknown name
            // is a reference this table cannot resolve (another table, a
            // VBA-only field).  Refusing it is safer than turning it into a
            // string literal the rule never meant.
            const lower = token.text.toLowerCase();
            if (!this._context.columnNames.some(name => name.toLowerCase() === lower)) {
                throw new UnsupportedRule(`unknown column ${token.text}`);
            }
            this._index++;
            return quoteIdentifier(token.text);
        }
        if (token.kind === 'word') {
            const lower = token.text.toLowerCase();
            if (lower === 'null') {
                this._index++;
                return 'NULL';
            }
            if (lower === 'true' || lower === 'yes') {
                this._index++;
                return 'TRUE';
            }
            if (lower === 'false' || lower === 'no') {
                this._index++;
                return 'FALSE';
            }
            if (this.peek(1)?.text === '(') {
                this._index += 2;
                const argument = this.parseOr();
                if (!this.matchSymbol(')')) throw new UnsupportedRule('unbalanced call');
                if (lower === 'isnull') {
                    return `(${argument} IS NULL)`;
                }
                const target = CAST_FUNCTIONS[lower];
                if (!target) throw new UnsupportedRule(`unsupported function ${token.text}`);
                return `CAST(${argument} AS ${target})`;
            }
            if (this._context.columnNames.some(name => name.toLowerCase() === lower)) {
                this._index++;
                return quoteIdentifier(token.text);
            }
        }
        throw new UnsupportedRule(`unsupported operand ${token.text}`);
    }
}

export interface AccessValidationRuleContext {
    /** Column that owns the rule; used when the rule starts with an operator. */
    readonly columnName?: string;
    /** All column names of the table, so identifiers are recognised. */
    readonly columnNames?: readonly string[];
}

/**
 * Returns a DuckDB boolean expression for an Access `ValidationRule`, or
 * `undefined` when the rule is outside the supported subset.
 */
export function translateAccessValidationRule(
    rule: string | undefined,
    context: AccessValidationRuleContext = {},
): string | undefined {
    try {
        let source = rule?.trim();
        if (!source) return undefined;
        if (source.startsWith('=')) source = source.slice(1).trim();
        if (!source) return undefined;

        const columnNames = context.columnNames ?? (context.columnName ? [context.columnName] : []);
        const tokens = tokenize(source);
        if (tokens.length === 0) return undefined;

        // `>0`, `Between 1 And 100`, `In (1,2,3)` and `Is Null Or ...` apply to
        // the owning column, so the rule text starts without its left operand.
        const first = tokens[0]!;
        const implicitOperator = first.kind === 'symbol'
            && IMPLICIT_OPERATOR_PREFIXES.includes(first.text);
        const implicitWord = first.kind === 'word'
            && IMPLICIT_WORD_PREFIXES.includes(first.text.toLowerCase());
        if ((implicitOperator || implicitWord) && context.columnName) {
            tokens.unshift({ kind: 'identifier', text: context.columnName });
        }

        const expression = new RuleParser(tokens, { columnNames }).parse();
        return expression || undefined;
    } catch {
        return undefined;
    }
}

/**
 * CHECK clauses for a table: one per translated column rule plus the
 * record-level rule.  Empty when nothing is translatable.
 */
export function buildAccessCheckConstraints(
    columns: readonly { readonly name: string; readonly validationRule?: string }[],
    tableRule: string | undefined,
): string[] {
    const columnNames = columns.map(column => column.name);
    const checks: string[] = [];
    for (const column of columns) {
        const expression = translateAccessValidationRule(column.validationRule, {
            columnName: column.name,
            columnNames,
        });
        if (expression) checks.push(expression);
    }
    const tableExpression = translateAccessValidationRule(tableRule, { columnNames });
    if (tableExpression) checks.push(tableExpression);
    return checks;
}

/**
 * CHECK clause for Access `AllowZeroLength = False`.
 *
 * Access rejects `''` but still accepts NULL, and SQL `CHECK` treats a NULL
 * result as a pass, so a plain inequality reproduces both behaviours.
 */
export function buildAccessZeroLengthCheck(columnName: string): string {
    return `(${quoteIdentifier(columnName)} <> '')`;
}
