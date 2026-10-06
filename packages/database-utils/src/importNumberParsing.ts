/**
 * Locale-aware parsing of formatted numbers pasted/copied from Excel.
 *
 * Covers PL (`1 234,56`, `1.234,56`, `123 456,78 zł`, `12,8%`, `(123,45)`)
 * and Anglo-Saxon (`1,234.56`, `$1,234.56`, `12.75%`, `1.23E+05`) forms.
 *
 * Policy (agreed with the user):
 * - decimal separator is detected once per import (global Auto), but cells
 *   containing both `.` and `,` always use the last separator as decimal;
 * - `%` is stripped without dividing by 100 (display value is kept);
 * - `w tysiącach` scaling is NOT applied (`123,5` stays `123.5`);
 * - a lone `-`/`–`/`—` is a conditional zero (0 in numeric columns, the
 *   dash itself in text columns — see {@link mapDashZeroImportCell});
 * - currency-marked values (`123 457 zł`, `$1,234.56`, `123€`) are reported
 *   via {@link CanonicalImportNumber.wasCurrency} so callers can infer NUMERIC
 *   even without a decimal part.
 */

export type ImportDecimalDelimiter = '.' | ',';

export interface CanonicalImportNumber {
    /** `-` for negatives, `''` otherwise. */
    sign: '' | '-';
    /** Digits before the decimal point (no separators, at least `0`). */
    integerDigits: string;
    /** Digits after the decimal point (may be empty). */
    fractionDigits: string;
    /** True when the source cell had a trailing `%`. */
    wasPercent: boolean;
    /** True when the source cell carried a currency symbol/code (`zł`, `$`, `USD`, …). */
    wasCurrency: boolean;
    /** Plain DB-ready form with `.` decimal separator (sign included). */
    plain: string;
}

const NBSP = '\u00A0';
const NARROW_NBSP = '\u202F';
const FIGURE_SPACE = '\u2009';
const THOUSAND_SPACES = new Set([' ', '\t', NBSP, NARROW_NBSP, FIGURE_SPACE, '\u2007', '\u200A']);

const DASH_ZERO_CELLS = new Set(['-', '–', '—', '−', '‒']);

const TRAILING_UNIT_PATTERN =
    /^(.*?)[\s\u00A0\u202F\u2009]+(zł\.?|pln|usd|gbp|eur|chf|cad|aud|sek|nok|dkk|czk|huf|ron|kg|tys\.?|tysiąc|tysiac|thousands?|ths\.?)$/i;
const TRAILING_ATTACHED_CURRENCY = /^(.*?)([$£€¥₹₴]|zł\.?|pln|usd|gbp|eur|chf)$/i;
const LEADING_CURRENCY_PATTERN = /^([$£€¥₹₴]|zł\.?|pln|usd|gbp|eur|chf)\s*([\s\S]*)$/i;
const LEADING_CODE_PATTERN = /^(pln|usd|gbp|eur|chf|cad|aud)\b\s*([\s\S]*)$/i;
const CURRENCY_TOKEN_PATTERN =
    /^(?:[$£€¥₹₴]|zł\.?|pln|usd|gbp|eur|chf|cad|aud|sek|nok|dkk|czk|huf|ron|jpy|cny|uah)$/i;

function isCurrencyToken(token: string): boolean {
    return CURRENCY_TOKEN_PATTERN.test(token.trim());
}

export function isDashZeroImportCell(value: string): boolean {
    return DASH_ZERO_CELLS.has(String(value ?? '').trim());
}

function stripWrappingParens(input: string): { text: string; negative: boolean } {
    const text = input.trim();
    if (text.length >= 2 && text.startsWith('(') && text.endsWith(')')) {
        return { text: text.slice(1, -1).trim(), negative: true };
    }
    return { text, negative: false };
}

function stripEdges(input: string): { text: string; wasPercent: boolean; wasCurrency: boolean } {
    let text = input.trim();
    let wasPercent = false;
    let wasCurrency = false;

    if (text.endsWith('%')) {
        wasPercent = true;
        text = text.slice(0, -1).trim();
    }

    for (let i = 0; i < 4; i++) {
        const before = text;
        let m = text.match(TRAILING_UNIT_PATTERN);
        if (m) {
            text = (m[1] ?? '').trim();
            if (isCurrencyToken(m[2] ?? '')) {
                wasCurrency = true;
            }
        } else {
            m = text.match(LEADING_CURRENCY_PATTERN);
            if (m) {
                text = (m[2] ?? '').trim();
                wasCurrency = true;
            } else {
                const code = text.match(LEADING_CODE_PATTERN);
                if (code) {
                    text = (code[2] ?? '').trim();
                    wasCurrency = true;
                }
            }
        }
        // Attached currency without space, e.g. `123€` — only when the
        // remainder still ends with a digit so plain text is not eaten.
        if (text === before) {
            const attached = text.match(TRAILING_ATTACHED_CURRENCY);
            if (attached && /\d$/.test((attached[1] ?? '').trim())) {
                text = (attached[1] ?? '').trim();
                wasCurrency = true;
            }
        }
        if (text === before) {
            break;
        }
        if (text.endsWith('%')) {
            wasPercent = true;
            text = text.slice(0, -1).trim();
        }
    }

    return { text, wasPercent, wasCurrency };
}

function splitExponent(input: string): { mantissa: string; exponent: number } {
    const m = input.match(/^(.*?)([eE][+-]?\d+)$/);
    if (!m) {
        return { mantissa: input, exponent: 0 };
    }
    const mantissa = (m[1] ?? '').trim();
    // `1E+05` (no mantissa separator) is still a number.
    if (!mantissa || !/\d$/.test(mantissa)) {
        return { mantissa: input, exponent: 0 };
    }
    const parsed = Number.parseInt((m[2] ?? '').replace(/^[eE]/, ''), 10);
    return { mantissa, exponent: Number.isFinite(parsed) ? parsed : 0 };
}

function removeThousandChars(input: string, chars: Set<string>): string {
    let out = '';
    for (const ch of input) {
        if (!chars.has(ch)) {
            out += ch;
        }
    }
    return out;
}

/**
 * Largest exponent magnitude worth expanding. Anything beyond this is
 * rejected by {@link parseFormattedImportNumber} before string allocation,
 * so cells like `1E+2147483648` fall back to text instead of throwing.
 */
const MAX_IMPORT_EXPONENT = 100;

/**
 * Digits plus locale grouping characters. Cells containing anything else
 * (clock times, IPs, mixed text) abstain from delimiter voting.
 */
const NUMERIC_VOTING_BODY = /^[\d\s\u00A0\u202F\u2009\u2007\u200A'’ʼ]+$/;
const MAX_IMPORT_DIGITS = 40;

function applyExponent(integerDigits: string, fractionDigits: string, exponent: number): {
    integerDigits: string;
    fractionDigits: string;
} {
    if (!exponent) {
        return { integerDigits, fractionDigits };
    }
    const digits = `${integerDigits}${fractionDigits}`;
    const pointPos = integerDigits.length + exponent;
    if (pointPos <= 0) {
        return {
            integerDigits: '0',
            fractionDigits: `${'0'.repeat(-pointPos)}${digits}`,
        };
    }
    if (pointPos >= digits.length) {
        return {
            integerDigits: `${digits}${'0'.repeat(pointPos - digits.length)}`,
            fractionDigits: '',
        };
    }
    return {
        integerDigits: digits.slice(0, pointPos),
        fractionDigits: digits.slice(pointPos),
    };
}

/**
 * Parse a locale-formatted number into a canonical DB-ready form.
 * Returns `null` for non-numeric input (including lone dash cells —
 * check those with {@link isDashZeroImportCell} first).
 */
export function parseFormattedImportNumber(
    rawValue: string,
    decimalDelimiter: string
): CanonicalImportNumber | null {
    const raw = String(rawValue ?? '').trim();
    if (!raw || isDashZeroImportCell(raw)) {
        return null;
    }

    const decimal: ImportDecimalDelimiter = decimalDelimiter === ',' ? ',' : '.';

    const wrapped = stripWrappingParens(raw);
    let text = wrapped.text;
    let negative = wrapped.negative;

    // Leading sign (hyphen-minus plus Excel/Unicode variants).
    const first = text.charAt(0);
    if (first === '-' || first === '−' || first === '–' || first === '—' || first === '+') {
        if (first !== '+') {
            negative = true;
        }
        text = text.slice(1).trim();
    }

    const edges = stripEdges(text);
    text = edges.text;

    // Sign may also follow a currency prefix, e.g. `$-123` / `-$123`.
    const innerFirst = text.charAt(0);
    if (innerFirst === '-' || innerFirst === '−' || innerFirst === '–' || innerFirst === '+' ) {
        if (innerFirst !== '+') {
            negative = true;
        }
        text = text.slice(1).trim();
    }
    if (!text) {
        return null;
    }

    const { mantissa, exponent } = splitExponent(text);
    // Reject absurd exponents before expansion allocates huge digit strings.
    if (Math.abs(exponent) > MAX_IMPORT_EXPONENT) {
        return null;
    }

    const hasDot = mantissa.includes('.');
    const hasComma = mantissa.includes(',');
    // Cells with both separators decide per-cell by last occurrence so a
    // global misdetection (or a mixed paste) cannot corrupt them.
    const effectiveDecimal: ImportDecimalDelimiter =
        hasDot && hasComma
            ? mantissa.lastIndexOf('.') > mantissa.lastIndexOf(',')
                ? '.'
                : ','
            : decimal;

    const thousandChars = new Set<string>([...THOUSAND_SPACES, "'", '’', 'ʼ']);
    if (effectiveDecimal === ',') {
        thousandChars.add('.');
    } else {
        thousandChars.add(',');
    }

    const compact = removeThousandChars(mantissa, thousandChars);
    const parts = compact.split(effectiveDecimal);
    if (parts.length > 2) {
        return null;
    }
    let intRaw = (parts[0] ?? '').trim();
    let fracRaw = parts.length === 2 ? (parts[1] ?? '').trim() : '';
    // Trailing separator without fraction (`123,` / `123.`) means integer.
    if (parts.length === 2 && !fracRaw) {
        fracRaw = '';
    }
    if (!/^\d+$/.test(intRaw || '0') || (fracRaw && !/^\d+$/.test(fracRaw))) {
        return null;
    }
    if (!intRaw) {
        intRaw = '0';
    }
    // Reject absurd lengths early (mirrors the BIGINT<15 / NUMERIC<20 guards).
    if (intRaw.length + fracRaw.length > MAX_IMPORT_DIGITS) {
        return null;
    }

    const shifted = applyExponent(
        intRaw.replace(/^0+(?=\d)/, ''),
        fracRaw,
        Number.isFinite(exponent) ? exponent : 0
    );
    const integerDigits = shifted.integerDigits.replace(/^0+(?=\d)/, '') || '0';
    const fractionDigits = shifted.fractionDigits;
    if (!/^\d+$/.test(integerDigits) || (fractionDigits && !/^\d+$/.test(fractionDigits))) {
        return null;
    }
    // Expansion can produce more digits than the raw mantissa (`1E+100`);
    // apply the same bound after shifting.
    if (integerDigits.length + fractionDigits.length > MAX_IMPORT_DIGITS) {
        return null;
    }

    const sign = negative ? '-' : '';
    return {
        sign,
        integerDigits,
        fractionDigits,
        wasPercent: edges.wasPercent,
        wasCurrency: edges.wasCurrency,
        plain: `${sign}${integerDigits}${fractionDigits ? `.${fractionDigits}` : ''}`,
    };
}

/** Precision/scale of a formatted number, or `null` when not numeric. */
export function getFormattedImportNumberPrecision(
    rawValue: string,
    decimalDelimiter: string
): { precision: number; scale: number } | null {
    const parsed = parseFormattedImportNumber(rawValue, decimalDelimiter);
    if (!parsed) {
        return null;
    }
    const intLen = parsed.integerDigits.replace(/^0+(?=\d)/, '').length || 1;
    return {
        precision: intLen + parsed.fractionDigits.length,
        scale: parsed.fractionDigits.length,
    };
}

function countImportSeparator(text: string, separator: string): number {
    let count = 0;
    for (let index = 0; index < text.length; index += 1) {
        if (text.charAt(index) === separator) {
            count += 1;
        }
    }
    return count;
}

/**
 * Vote for the global decimal separator over raw sample cells.
 * Currency/percent/unit/exponent wrappers are stripped before voting and
 * lone dashes are ignored. Cells that only look numeric because of dots in
 * dates (`07.06.2024`), IP addresses (`192.168.0.1`) or clock times
 * (`12:30:45.1234`) abstain, as do ambiguous 3-digit groups (`1,234`) and
 * multi-separator thousands (`1.234.567`). Cells carrying both `.` and `,`
 * vote twice for the last separator, so `1.234.567,89` still votes comma.
 */
export function detectImportDecimalDelimiter(values: Iterable<string>): ImportDecimalDelimiter {
    let commaVotes = 0;
    let dotVotes = 0;

    for (const raw of values) {
        const cell = String(raw ?? '').trim();
        if (!cell || isDashZeroImportCell(cell)) {
            continue;
        }
        const wrapped = stripWrappingParens(cell);
        let text = wrapped.text.replace(/^[-−–—+]\s*/, '');
        const hasLeadingCurrency = LEADING_CURRENCY_PATTERN.test(text) || LEADING_CODE_PATTERN.test(text);
        const edges = stripEdges(text);
        text = edges.text;
        // Currency may precede the sign (`$-123,45`, `USD -123,45`).
        // Strip that sign only when a leading currency token was present, so
        // malformed values such as `--123 EUR` still abstain from voting.
        if (hasLeadingCurrency) {
            text = text.replace(/^[-−–—+]\s*/, '');
        }
        if (!text) {
            continue;
        }
        text = splitExponent(text).mantissa.trim();
        if (!text) {
            continue;
        }
        const hasDot = text.includes('.');
        const hasComma = text.includes(',');
        if (!hasDot && !hasComma) {
            continue;
        }
        // Only numeric bodies vote: clock times (`12:30:45.1234`) abstain on
        // their colons here, while dotted dates (`07.06.2024`) pass this guard
        // and are rejected by the multi-separator counts below.
        if (!NUMERIC_VOTING_BODY.test(text.replace(/[.,]/g, ''))) {
            continue;
        }
        if (hasDot && hasComma) {
            if (text.lastIndexOf('.') > text.lastIndexOf(',')) {
                dotVotes += 2;
            } else {
                commaVotes += 2;
            }
            continue;
        }
        if (hasComma) {
            if (countImportSeparator(text, ',') !== 1) {
                continue;
            }
            const frac = text.split(',').pop() ?? '';
            if (/^\d+$/.test(frac) && frac.length !== 3) {
                commaVotes += 1;
            }
            continue;
        }
        if (countImportSeparator(text, '.') !== 1) {
            continue;
        }
        const frac = text.split('.').pop() ?? '';
        if (/^\d+$/.test(frac) && frac.length !== 3) {
            dotVotes += 1;
        }
    }

    return commaVotes > dotVotes ? ',' : '.';
}

/**
 * Normalize a formatted cell to a DB-ready numeric literal.
 * Returns `null` for non-numeric input; lone dashes are mapped by
 * {@link mapDashZeroImportCell} instead.
 */
export function normalizeImportNumberForDb(
    rawValue: string,
    decimalDelimiter: string,
    scale?: number
): string | null {
    const parsed = parseFormattedImportNumber(rawValue, decimalDelimiter);
    if (!parsed) {
        return null;
    }
    let fraction = parsed.fractionDigits;
    if (typeof scale === 'number' && scale >= 0 && fraction.length > scale) {
        fraction = fraction.slice(0, scale);
    }
    return `${parsed.sign}${parsed.integerDigits}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Map a lone dash cell: `0` in numeric columns, the dash itself otherwise
 * (text columns keep the literal `-`/`–`). Returns `undefined` when the value
 * is not a dash cell.
 */
export function mapDashZeroImportCell(rawValue: string, isNumericColumn: boolean): string | undefined {
    const trimmed = String(rawValue ?? '').trim();
    if (!isDashZeroImportCell(trimmed)) {
        return undefined;
    }
    return isNumericColumn ? '0' : trimmed;
}
