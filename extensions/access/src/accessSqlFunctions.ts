/**
 * Access/VBA function translation for the DuckDB mirror.
 *
 * DuckDB has no UDF registration in the JS binding, so Access function
 * names are rewritten to DuckDB expressions at translation time.
 * Functions without a direct DuckDB name (IIf, Nz, InStrRev, Val, Int/Fix,
 * Weekday, DateAdd/DateDiff/DatePart with Access intervals, Space, String,
 * Rnd, StrReverse, ...) are expanded inline; everything else maps to the
 * DuckDB built-in of the same name.
 */

/** maps an Access function name + argument count to a DuckDB rewrite */
export interface AccessFunctionRewrite {
    /** function name (lowercase) */
    readonly name: string;
    /** replaces the whole call; args are the raw comma-separated inner text */
    expand(args: string): string;
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && (trimmed[0] === '\'' || trimmed[0] === '"')) {
        return trimmed.slice(1, -1).replace(trimmed[0] === '\'' ? /''/g : /""/g, trimmed[0] === '\'' ? '\'' : '"');
    }
    return trimmed;
}

/** splits a comma-separated argument list at top level */
function splitArgs(args: string): string[] {
    const result: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | null = null;
    for (let index = 0; index < args.length; index++) {
        const c = args[index]!;
        if (quote) {
            if (c === quote && args[index + 1] === quote) {
                index++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"') {
            quote = c;
            continue;
        }
        if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
        } else if (c === ',' && depth === 0) {
            result.push(args.slice(start, index).trim());
            start = index + 1;
        }
    }
    result.push(args.slice(start).trim());
    return result;
}

function intervalFor(interval: string): string {
    const i = unquote(interval).trim().toLowerCase();
    switch (i) {
        case 'yyyy':
        case 'yy':
            return 'year';
        case 'q':
            return 'quarter';
        case 'm':
            return 'month';
        case 'y':
        case 'd':
            return 'day';
        case 'w':
            return 'day';
        case 'ww':
            return 'week';
        case 'h':
            return 'hour';
        case 'n':
            return 'minute';
        case 's':
            return 'second';
        default:
            return 'day';
    }
}

const ACCESS_FUNCTIONS: ReadonlyMap<string, AccessFunctionRewrite> = new Map<string, AccessFunctionRewrite>([
    ['ucase', { name: 'ucase', expand: args => `upper(${args})` }],
    ['upper', { name: 'upper', expand: args => `upper(${args})` }],
    ['lcase', { name: 'lcase', expand: args => `lower(${args})` }],
    ['lower', { name: 'lower', expand: args => `lower(${args})` }],
    ['trim', { name: 'trim', expand: args => `trim(${args})` }],
    ['ltrim', { name: 'ltrim', expand: args => `ltrim(${args})` }],
    ['rtrim', { name: 'rtrim', expand: args => `rtrim(${args})` }],
    ['len', { name: 'len', expand: args => `length(${args})` }],
    ['left', { name: 'left', expand: args => `left(${args})` }],
    ['right', { name: 'right', expand: args => `right(${args})` }],
    [
        'mid',
        {
            name: 'mid',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `substr(${args})`;
                }
                const expr = parts[0]!;
                const start = parts[1]!;
                if (parts.length >= 3) {
                    return `substr(${expr}, ${start}, ${parts[2]})`;
                }
                return `substr(${expr}, ${start})`;
            },
        },
    ],
    [
        'instr',
        {
            name: 'instr',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length === 2) {
                    return `instr(${parts[0]}, ${parts[1]})`;
                }
                if (parts.length >= 3) {
                    return `instr(substr(${parts[1]}, ${parts[0]}), ${parts[2]}) + ${parts[0]} - 1`;
                }
                return `instr(${args})`;
            },
        },
    ],
    [
        'instrrev',
        {
            name: 'instrrev',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `instr(${args})`;
                }
                return `length(${parts[0]}) - instr(reverse(${parts[0]}), reverse(${parts[1]})) - length(${parts[1]}) + 2`;
            },
        },
    ],
    ['strreverse', { name: 'strreverse', expand: args => `reverse(${args})` }],
    ['asc', { name: 'asc', expand: args => `ascii(${args})` }],
    ['chr', { name: 'chr', expand: args => `chr(${args})` }],
    ['space', { name: 'space', expand: args => `repeat(' ', ${args})` }],
    [
        'string',
        {
            name: 'string',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `repeat(${parts[0] ?? "' '"}, 1)`;
                }
                const character = parts[1]!;
                const numericTypes = "'TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT', 'DECIMAL', 'FLOAT', 'DOUBLE'";
                return `repeat(CASE WHEN typeof(${character}) IN (${numericTypes}) THEN chr(CAST(${character} AS INTEGER)) ELSE left(CAST(${character} AS VARCHAR), 1) END, ${parts[0]})`;
            },
        },
    ],
    ['concat', { name: 'concat', expand: args => `concat(${args})` }],
    ['replace', { name: 'replace', expand: args => `replace(${args})` }],
    ['abs', { name: 'abs', expand: args => `abs(${args})` }],
    ['sgn', { name: 'sgn', expand: args => `sign(${args})` }],
    ['sqr', { name: 'sqr', expand: args => `sqrt(${args})` }],
    ['sin', { name: 'sin', expand: args => `sin(${args})` }],
    ['cos', { name: 'cos', expand: args => `cos(${args})` }],
    ['tan', { name: 'tan', expand: args => `tan(${args})` }],
    ['asin', { name: 'asin', expand: args => `asin(${args})` }],
    ['acos', { name: 'acos', expand: args => `acos(${args})` }],
    ['atan', { name: 'atan', expand: args => `atan(${args})` }],
    ['exp', { name: 'exp', expand: args => `exp(${args})` }],
    ['log', { name: 'log', expand: args => `ln(${args})` }],
    ['log10', { name: 'log10', expand: args => `log10(${args})` }],
    ['int', { name: 'int', expand: args => `floor(${args})` }],
    ['fix', { name: 'fix', expand: args => `trunc(${args})` }],
    ['rnd', { name: 'rnd', expand: () => `random()` }],
    ['round', { name: 'round', expand: args => `round(${args})` }],
    ['now', { name: 'now', expand: () => `now()` }],
    ['date', { name: 'date', expand: () => `current_date` }],
    ['time', { name: 'time', expand: () => `current_time` }],
    ['year', { name: 'year', expand: args => `year(${args})` }],
    ['month', { name: 'month', expand: args => `month(${args})` }],
    ['day', { name: 'day', expand: args => `day(${args})` }],
    ['hour', { name: 'hour', expand: args => `hour(${args})` }],
    ['minute', { name: 'minute', expand: args => `minute(${args})` }],
    ['second', { name: 'second', expand: args => `second(${args})` }],
    [
        'weekday',
        {
            name: 'weekday',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `(dayofweek(${parts[0] ?? args}) + 1)`;
                }
                const firstDay = `CASE WHEN CAST(${parts[1]} AS INTEGER) = 0 THEN 1 ELSE CAST(${parts[1]} AS INTEGER) END`;
                return `((dayofweek(${parts[0]}) - ((${firstDay}) - 1) + 7) % 7) + 1`;
            },
        },
    ],
    [
        'datepart',
        {
            name: 'datepart',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `date_part(${args})`;
                }
                const interval = unquote(parts[0]!).trim().toLowerCase();
                if (interval === 'w') {
                    return `(date_part('dayofweek', ${parts[1]}) + 1)`;
                }
                if (interval === 'y') {
                    return `date_part('dayofyear', ${parts[1]})`;
                }
                return `date_part('${intervalFor(parts[0]!)}', ${parts[1]})`;
            },
        },
    ],
    [
        'dateadd',
        {
            name: 'dateadd',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 3) {
                    return `date_add(${args})`;
                }
                return `(${parts[2]}) + INTERVAL (${parts[1]}) ${intervalFor(parts[0]!)}`;
            },
        },
    ],
    [
        'datediff',
        {
            name: 'datediff',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 3) {
                    return `date_diff(${args})`;
                }
                return `date_diff('${intervalFor(parts[0]!)}', ${parts[1]}, ${parts[2]})`;
            },
        },
    ],
    [
        'dateserial',
        {
            name: 'dateserial',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 3) {
                    return `make_date(${args})`;
                }
                return `make_date(${parts[0]}, ${parts[1]}, ${parts[2]})`;
            },
        },
    ],
    [
        'timeserial',
        {
            name: 'timeserial',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 3) {
                    return `make_time(${args})`;
                }
                return `make_time(${parts[0]}, ${parts[1]}, ${parts[2]})`;
            },
        },
    ],
    ['cdate', { name: 'cdate', expand: args => `CAST(${args} AS TIMESTAMP)` }],
    ['datevalue', { name: 'datevalue', expand: args => `CAST(${args} AS DATE)` }],
    ['timevalue', { name: 'timevalue', expand: args => `CAST(${args} AS TIME)` }],
    [
        'iif',
        {
            name: 'iif',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `if(${args})`;
                }
                const [cond, ifTrue, ifFalse] = parts;
                return `if(${cond}, ${ifTrue ?? 'NULL'}, ${ifFalse ?? 'NULL'})`;
            },
        },
    ],
    [
        'nz',
        {
            name: 'nz',
            expand: args => {
                const parts = splitArgs(args);
                if (parts.length < 2) {
                    return `coalesce(${parts[0] ?? 'NULL'}, '')`;
                }
                return `coalesce(${parts[0]}, ${parts[1]})`;
            },
        },
    ],
    ['isnull', { name: 'isnull', expand: args => `(${args}) IS NULL` }],
    ['isdate', { name: 'isdate', expand: args => `try_cast(${args} AS TIMESTAMP) IS NOT NULL` }],
    ['isnumeric', { name: 'isnumeric', expand: args => `try_cast(${args} AS DOUBLE) IS NOT NULL` }],
    [
        'val',
        {
            name: 'val',
            expand: args => `try_cast(regexp_extract(CAST(${args} AS VARCHAR), '^[\\\\-]?[0-9]+(\\\\.[0-9]+)?') AS DOUBLE)`,
        },
    ],
    ['cint', { name: 'cint', expand: args => `CAST(${args} AS INTEGER)` }],
    ['clng', { name: 'clng', expand: args => `CAST(${args} AS BIGINT)` }],
    ['cdbl', { name: 'cdbl', expand: args => `CAST(${args} AS DOUBLE)` }],
    ['csng', { name: 'csng', expand: args => `CAST(${args} AS REAL)` }],
    ['cstr', { name: 'cstr', expand: args => `CAST(${args} AS VARCHAR)` }],
    ['cbool', { name: 'cbool', expand: args => `CAST(${args} AS BOOLEAN)` }],
    ['str', { name: 'str', expand: args => `CAST(${args} AS VARCHAR)` }],
    ['hex', { name: 'hex', expand: args => `to_hex(${args})` }],
    ['count', { name: 'count', expand: args => `count(${args})` }],
    ['sum', { name: 'sum', expand: args => `sum(${args})` }],
    ['avg', { name: 'avg', expand: args => `avg(${args})` }],
    ['min', { name: 'min', expand: args => `min(${args})` }],
    ['max', { name: 'max', expand: args => `max(${args})` }],
    ['first', { name: 'first', expand: args => `first(${args})` }],
    ['last', { name: 'last', expand: args => `last(${args})` }],
    ['stdev', { name: 'stdev', expand: args => `stddev(${args})` }],
    ['stdevp', { name: 'stdevp', expand: args => `stddev_pop(${args})` }],
    ['var', { name: 'var', expand: args => `variance(${args})` }],
    ['varp', { name: 'varp', expand: args => `var_pop(${args})` }],
]);

/**
 * Rewrites Access function calls in raw (unprotected) SQL.  String literals
 * are skipped so function-like text inside them is left untouched.
 */
export function translateAccessFunctions(code: string): string {
    let result = '';
    let index = 0;
    while (index < code.length) {
        const c = code[index]!;
        if (c === '-' && code[index + 1] === '-') {
            const end = code.indexOf('\n', index + 2);
            const stop = end < 0 ? code.length : end;
            result += code.slice(index, stop);
            index = stop;
            continue;
        }
        if (c === '/' && code[index + 1] === '*') {
            const end = code.indexOf('*/', index + 2);
            const stop = end < 0 ? code.length : end + 2;
            result += code.slice(index, stop);
            index = stop;
            continue;
        }
        if (c === '#') {
            const end = code.indexOf('#', index + 1);
            const stop = end < 0 ? code.length : end + 1;
            result += code.slice(index, stop);
            index = stop;
            continue;
        }
        if (c === '\'' || c === '"') {
            result += copyQuoted(code, index);
            index += copyQuotedLength(code, index);
            continue;
        }
        if (c === '[') {
            const length = copyBracketLength(code, index);
            result += code.slice(index, index + length);
            index += length;
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const idMatch = code.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
            const id = idMatch![0];
            let next = index + id.length;
            while (next < code.length && /\s/.test(code[next]!)) {
                next++;
            }
            if (next < code.length && code[next] === '(' && ACCESS_FUNCTIONS.has(id.toLowerCase())) {
                result += `\uE002${id}\uE003`;
            } else {
                result += id;
            }
            index += id.length;
            continue;
        }
        result += c;
        index++;
    }
    return expandMarkedCalls(result);
}

function copyQuoted(code: string, index: number): string {
    return code.slice(index, index + copyQuotedLength(code, index));
}

function copyQuotedLength(code: string, index: number): number {
    const quote = code[index]!;
    let stop = index + 1;
    while (stop < code.length) {
        if (code[stop] === quote) {
            if (code[stop + 1] === quote) {
                stop += 2;
                continue;
            }
            stop++;
            break;
        }
        stop++;
    }
    return stop - index;
}

function copyBracketLength(code: string, index: number): number {
    let stop = index + 1;
    while (stop < code.length) {
        if (code[stop] !== ']') {
            stop++;
            continue;
        }
        if (code[stop + 1] === ']') {
            stop += 2;
            continue;
        }
        return stop + 1 - index;
    }
    return code.length - index;
}

function expandMarkedCalls(code: string): string {
    let result = code;
    // repeatedly find a marked call, extract balanced args, replace
    let guard = 0;
    while (guard < 1000) {
        guard++;
        const match = result.match(/\uE002([a-z0-9_]+)\uE003\s*\(/i);
        if (!match) {
            break;
        }
        const name = match[1]!.toLowerCase();
        const openIndex = (match.index ?? 0) + match[0].length - 1;
        const closeIndex = findMatchingParen(result, openIndex);
        if (closeIndex < 0) {
            break;
        }
        const args = result.slice(openIndex + 1, closeIndex);
        const rewrite = ACCESS_FUNCTIONS.get(name);
        if (!rewrite) {
            // unknown: drop the marker
            result = result.slice(0, match.index ?? 0) + name + '(' + result.slice(openIndex + 1);
            continue;
        }
        const replacement = rewrite.expand(args);
        result = result.slice(0, match.index ?? 0) + replacement + result.slice(closeIndex + 1);
    }
    return result;
}

function findMatchingParen(code: string, openIndex: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let index = openIndex; index < code.length; index++) {
        const c = code[index]!;
        if (quote) {
            if (c === quote && code[index + 1] === quote) {
                index++;
            } else if (c === quote) {
                quote = null;
            }
            continue;
        }
        if (c === '\'' || c === '"') {
            quote = c;
            continue;
        }
        if (c === '(') {
            depth++;
        } else if (c === ')') {
            depth--;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

export { splitArgs, unquote, intervalFor };
