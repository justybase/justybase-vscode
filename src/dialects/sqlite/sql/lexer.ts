import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * SQLite keeps a deliberately small keyword set, but several constructs are
 * not present in the shared/Netezza token bundle.  They are defined here so
 * the SQLite parser can recognize native statements without making the shared
 * grammar more permissive for every dialect.
 */
const sqliteKeyword = (name: string, pattern: RegExp) => createToken({
    name,
    pattern,
    longer_alt: baseLexer.Identifier
});

export const Attach = sqliteKeyword('Attach', /ATTACH\b/i);
export const Detach = sqliteKeyword('Detach', /DETACH\b/i);
export const Pragma = sqliteKeyword('Pragma', /PRAGMA\b/i);
export const Vacuum = sqliteKeyword('Vacuum', /VACUUM\b/i);
export const Analyze = sqliteKeyword('Analyze', /ANALYZE\b/i);
export const Savepoint = sqliteKeyword('Savepoint', /SAVEPOINT\b/i);
export const Release = sqliteKeyword('Release', /RELEASE\b/i);
export const Returning = sqliteKeyword('Returning', /RETURNING\b/i);
export const Conflict = sqliteKeyword('Conflict', /CONFLICT\b/i);
export const Nothing = sqliteKeyword('Nothing', /NOTHING\b/i);
export const Index = sqliteKeyword('Index', /INDEX\b/i);
export const Trigger = sqliteKeyword('Trigger', /TRIGGER\b/i);
export const Before = sqliteKeyword('Before', /BEFORE\b/i);
export const After = sqliteKeyword('After', /AFTER\b/i);
export const Instead = sqliteKeyword('Instead', /INSTEAD\b/i);
export const Each = sqliteKeyword('Each', /EACH\b/i);
export const Collate = sqliteKeyword('Collate', /COLLATE\b/i);
export const Generated = sqliteKeyword('Generated', /GENERATED\b/i);
export const Always = sqliteKeyword('Always', /ALWAYS\b/i);
export const Stored = sqliteKeyword('Stored', /STORED\b/i);
export const Virtual = sqliteKeyword('Virtual', /VIRTUAL\b/i);
export const Without = sqliteKeyword('Without', /WITHOUT\b/i);
export const Rowid = sqliteKeyword('Rowid', /ROWID\b/i);
export const Strict = sqliteKeyword('Strict', /STRICT\b/i);
export const Autoincrement = sqliteKeyword('Autoincrement', /AUTOINCREMENT\b/i);
export const Window = sqliteKeyword('Window', /WINDOW\b/i);
export const Abort = sqliteKeyword('Abort', /ABORT\b/i);
export const Fail = sqliteKeyword('Fail', /FAIL\b/i);
export const Ignore = sqliteKeyword('Ignore', /IGNORE\b/i);
export const Exclusive = sqliteKeyword('Exclusive', /EXCLUSIVE\b/i);
export const Query = sqliteKeyword('Query', /QUERY\b/i);
export const Plan = sqliteKeyword('Plan', /PLAN\b/i);
export const IntType = sqliteKeyword('IntType', /INT\b/i);
export const DoubleType = sqliteKeyword('DoubleType', /DOUBLE\b/i);
export const Do = sqliteKeyword('Do', /DO\b/i);
export const Transaction = sqliteKeyword('Transaction', /TRANSACTION\b/i);
export const Glob = sqliteKeyword('Glob', /GLOB\b/i);
export const Regexp = sqliteKeyword('Regexp', /REGEXP\b/i);
export const No = sqliteKeyword('No', /NO\b/i);

const sqliteOnlyTokens = [
    Attach,
    Detach,
    Pragma,
    Vacuum,
    Analyze,
    Savepoint,
    Release,
    Returning,
    Conflict,
    Nothing,
    Index,
    Trigger,
    Before,
    After,
    Instead,
    Each,
    Collate,
    Generated,
    Always,
    Stored,
    Virtual,
    Without,
    Rowid,
    Strict,
    Autoincrement,
    Window,
    Abort,
    Fail,
    Ignore,
    Exclusive,
    Query,
    Plan,
    IntType,
    DoubleType,
    Do,
    Transaction,
    Glob,
    Regexp,
    No,
];

export const allTokens = [...sqliteOnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(allTokens);

export * from '../../netezza/sql/lexer';
