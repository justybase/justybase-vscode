import { createToken, Lexer } from 'chevrotain'
import { findNestedBlockCommentEnd } from '../../../sql/sqlSourceScan'
import { NETEZZA_IDENTIFIER_TOKEN_PATTERN } from '../identifierPattern'

function matchNestedBlockComment(
  text: string,
  startOffset: number,
): RegExpExecArray | null {
  const endOffset = findNestedBlockCommentEnd(text, startOffset);
  if (endOffset === undefined) {
    return null;
  }
  const matchedText = text.substring(startOffset, endOffset);
  const match = [matchedText] as RegExpExecArray;
  match.index = startOffset;
  match.input = text;
  return match;
}

// ============================================================================
// Identifier - must be defined first for longer_alt to work on keywords
// ============================================================================

export const Identifier = createToken({
    name: 'Identifier',
    pattern: NETEZZA_IDENTIFIER_TOKEN_PATTERN
})

// ============================================================================
// SQL Keywords - Netezza Dialect
// All keywords use longer_alt: Identifier so INNER_COL is tokenized as
// Identifier, not as INNER + _COL
// ============================================================================

// DML Keywords
export const Select = createToken({ name: 'Select', pattern: /SELECT/i, longer_alt: Identifier })
export const From = createToken({ name: 'From', pattern: /FROM/i, longer_alt: Identifier })
export const Where = createToken({ name: 'Where', pattern: /WHERE/i, longer_alt: Identifier })
export const Insert = createToken({ name: 'Insert', pattern: /INSERT/i, longer_alt: Identifier })
export const Into = createToken({ name: 'Into', pattern: /INTO/i, longer_alt: Identifier })
export const Values = createToken({ name: 'Values', pattern: /VALUES/i, longer_alt: Identifier })
export const Value = createToken({ name: 'Value', pattern: /VALUE\b/i, longer_alt: Identifier })
export const Update = createToken({ name: 'Update', pattern: /UPDATE/i, longer_alt: Identifier })
export const Set = createToken({ name: 'Set', pattern: /SET/i, longer_alt: Identifier })
export const Delete = createToken({ name: 'Delete', pattern: /DELETE/i, longer_alt: Identifier })
export const AtSet = createToken({ name: 'AtSet', pattern: /@SET\b/i })

// JOIN Keywords
export const Join = createToken({ name: 'Join', pattern: /JOIN/i, longer_alt: Identifier })
export const Inner = createToken({ name: 'Inner', pattern: /INNER/i, longer_alt: Identifier })
export const Left = createToken({ name: 'Left', pattern: /LEFT/i, longer_alt: Identifier })
export const Right = createToken({ name: 'Right', pattern: /RIGHT/i, longer_alt: Identifier })
export const Full = createToken({ name: 'Full', pattern: /FULL/i, longer_alt: Identifier })
export const Outer = createToken({ name: 'Outer', pattern: /OUTER/i, longer_alt: Identifier })
export const Cross = createToken({ name: 'Cross', pattern: /CROSS/i, longer_alt: Identifier })
export const Natural = createToken({ name: 'Natural', pattern: /NATURAL/i, longer_alt: Identifier })
export const Only = createToken({ name: 'Only', pattern: /ONLY/i, longer_alt: Identifier })
export const On = createToken({ name: 'On', pattern: /ON/i, longer_alt: Identifier })

// Logical Operators
export const And = createToken({ name: 'And', pattern: /AND/i, longer_alt: Identifier })
export const Or = createToken({ name: 'Or', pattern: /OR/i, longer_alt: Identifier })
export const Not = createToken({ name: 'Not', pattern: /NOT\b/i, longer_alt: Identifier })

// SELECT Modifiers
export const As = createToken({ name: 'As', pattern: /AS/i, longer_alt: Identifier })
export const Distinct = createToken({ name: 'Distinct', pattern: /DISTINCT/i, longer_alt: Identifier })
export const All = createToken({ name: 'All', pattern: /ALL/i, longer_alt: Identifier })

// Set Operations
export const Union = createToken({ name: 'Union', pattern: /UNION/i, longer_alt: Identifier })
export const Intersect = createToken({ name: 'Intersect', pattern: /INTERSECT/i, longer_alt: Identifier })
export const Except = createToken({ name: 'Except', pattern: /EXCEPT\b/i, longer_alt: Identifier })
export const MinusSet = createToken({ name: 'MinusSet', pattern: /MINUS\b/i, longer_alt: Identifier })

// Clauses
export const GroupBy = createToken({ name: 'GroupBy', pattern: /GROUP\s+BY/i, longer_alt: Identifier })
export const OrderBy = createToken({ name: 'OrderBy', pattern: /ORDER\s+BY/i, longer_alt: Identifier })
export const Having = createToken({ name: 'Having', pattern: /HAVING/i, longer_alt: Identifier })
export const Limit = createToken({ name: 'Limit', pattern: /LIMIT/i, longer_alt: Identifier })
export const Offset = createToken({ name: 'Offset', pattern: /OFFSET/i, longer_alt: Identifier })

// NULL handling
export const NotNull = createToken({ name: 'NotNull', pattern: /NOTNULL/i, longer_alt: Identifier })
export const Nulls = createToken({ name: 'Nulls', pattern: /NULLS/i, longer_alt: Identifier })
export const Null = createToken({ name: 'Null', pattern: /NULL/i, longer_alt: Identifier })
export const Is = createToken({ name: 'Is', pattern: /IS/i, longer_alt: Identifier })

// Pattern matching
export const Ilike = createToken({ name: 'Ilike', pattern: /ILIKE/i, longer_alt: Identifier })
export const Like = createToken({ name: 'Like', pattern: /LIKE/i, longer_alt: Identifier })
export const Escape = createToken({ name: 'Escape', pattern: /ESCAPE/i, longer_alt: Identifier })
export const In = createToken({ name: 'In', pattern: /IN\b/i, longer_alt: Identifier })
export const Between = createToken({ name: 'Between', pattern: /BETWEEN/i, longer_alt: Identifier })
export const Exists = createToken({ name: 'Exists', pattern: /EXISTS/i, longer_alt: Identifier })

// CASE expression
export const Case = createToken({ name: 'Case', pattern: /CASE/i, longer_alt: Identifier })
export const When = createToken({ name: 'When', pattern: /WHEN/i, longer_alt: Identifier })
export const Then = createToken({ name: 'Then', pattern: /THEN/i, longer_alt: Identifier })
export const Else = createToken({ name: 'Else', pattern: /ELSE/i, longer_alt: Identifier })
export const End = createToken({ name: 'End', pattern: /END/i, longer_alt: Identifier })

// DDL Keywords
export const Create = createToken({ name: 'Create', pattern: /CREATE/i, longer_alt: Identifier })
export const Materialized = createToken({ name: 'Materialized', pattern: /MATERIALIZED/i, longer_alt: Identifier })
export const Table = createToken({ name: 'Table', pattern: /TABLE/i, longer_alt: Identifier })
export const Temporary = createToken({ name: 'Temporary', pattern: /TEMPORARY/i, longer_alt: Identifier })
export const Temp = createToken({ name: 'Temp', pattern: /TEMP/i, longer_alt: Temporary })
export const Drop = createToken({ name: 'Drop', pattern: /DROP/i, longer_alt: Identifier })
export const Truncate = createToken({ name: 'Truncate', pattern: /TRUNCATE/i, longer_alt: Identifier })
export const Explain = createToken({ name: 'Explain', pattern: /EXPLAIN/i, longer_alt: Identifier })
export const Verbose = createToken({ name: 'Verbose', pattern: /VERBOSE/i, longer_alt: Identifier })
export const Distribution = createToken({ name: 'Distribution', pattern: /DISTRIBUTION/i, longer_alt: Identifier })
export const Plantext = createToken({ name: 'Plantext', pattern: /PLANTEXT/i, longer_alt: Identifier })
export const Plangraph = createToken({ name: 'Plangraph', pattern: /PLANGRAPH/i, longer_alt: Identifier })
export const Alter = createToken({ name: 'Alter', pattern: /ALTER/i, longer_alt: Identifier })
export const Show = createToken({ name: 'Show', pattern: /SHOW/i, longer_alt: Identifier })
export const Copy = createToken({ name: 'Copy', pattern: /COPY/i, longer_alt: Identifier })
export const Lock = createToken({ name: 'Lock', pattern: /LOCK/i, longer_alt: Identifier })
export const Merge = createToken({ name: 'Merge', pattern: /MERGE/i, longer_alt: Identifier })
export const Reindex = createToken({ name: 'Reindex', pattern: /REINDEX/i, longer_alt: Identifier })
export const Reset = createToken({ name: 'Reset', pattern: /RESET/i, longer_alt: Identifier })
export const Procedure = createToken({ name: 'Procedure', pattern: /PROCEDURE/i, longer_alt: Identifier })
export const Replace = createToken({ name: 'Replace', pattern: /REPLACE/i, longer_alt: Identifier })
export const Database = createToken({ name: 'Database', pattern: /DATABASE/i, longer_alt: Identifier })
export const Group = createToken({ name: 'Group', pattern: /GROUP/i, longer_alt: Identifier })
export const History = createToken({ name: 'History', pattern: /HISTORY/i, longer_alt: Identifier })
export const Configuration = createToken({ name: 'Configuration', pattern: /CONFIGURATION/i, longer_alt: Identifier })
export const Scheduler = createToken({ name: 'Scheduler', pattern: /SCHEDULER/i, longer_alt: Identifier })
export const Rule = createToken({ name: 'Rule', pattern: /RULE/i, longer_alt: Identifier })
export const Schema = createToken({ name: 'Schema', pattern: /SCHEMA/i, longer_alt: Identifier })
export const Sequence = createToken({ name: 'Sequence', pattern: /SEQUENCE/i, longer_alt: Identifier })
export const Session = createToken({ name: 'Session', pattern: /SESSION/i, longer_alt: Identifier })
export const Synonym = createToken({ name: 'Synonym', pattern: /SYNONYM/i, longer_alt: Identifier })
export const User = createToken({ name: 'User', pattern: /USER/i, longer_alt: Identifier })
export const External = createToken({ name: 'External', pattern: /EXTERNAL/i, longer_alt: Identifier })
export const Views = createToken({ name: 'Views', pattern: /VIEWS/i, longer_alt: Identifier })
export const View = createToken({ name: 'View', pattern: /VIEW/i, longer_alt: Identifier })
export const Comment = createToken({ name: 'Comment', pattern: /COMMENT/i, longer_alt: Identifier })
export const Add = createToken({ name: 'Add', pattern: /ADD/i, longer_alt: Identifier })
export const Constraint = createToken({ name: 'Constraint', pattern: /CONSTRAINT/i, longer_alt: Identifier })
export const Primary = createToken({ name: 'Primary', pattern: /PRIMARY/i, longer_alt: Identifier })
export const Key = createToken({ name: 'Key', pattern: /KEY/i, longer_alt: Identifier })
export const Foreign = createToken({ name: 'Foreign', pattern: /FOREIGN/i, longer_alt: Identifier })
export const References = createToken({ name: 'References', pattern: /REFERENCES/i, longer_alt: Identifier })
export const Unique = createToken({ name: 'Unique', pattern: /UNIQUE/i, longer_alt: Identifier })
export const Check = createToken({ name: 'Check', pattern: /CHECK/i, longer_alt: Identifier })
export const Global = createToken({ name: 'Global', pattern: /GLOBAL/i, longer_alt: Identifier })
export const Returns = createToken({ name: 'Returns', pattern: /RETURNS/i, longer_alt: Identifier })
export const Language = createToken({ name: 'Language', pattern: /LANGUAGE/i, longer_alt: Identifier })
export const Execute = createToken({ name: 'Execute', pattern: /EXECUTE/i, longer_alt: Identifier })
export const Exec = createToken({ name: 'Exec', pattern: /EXEC\b/i, longer_alt: Identifier })
export const Owner = createToken({ name: 'Owner', pattern: /OWNER/i, longer_alt: Identifier })
export const Caller = createToken({ name: 'Caller', pattern: /CALLER/i, longer_alt: Identifier })
export const RefTable = createToken({ name: 'RefTable', pattern: /REFTABLE/i, longer_alt: Identifier })
export const Varargs = createToken({ name: 'Varargs', pattern: /VARARGS/i, longer_alt: Identifier })

// CTE Keywords
export const With = createToken({ name: 'With', pattern: /WITH/i, longer_alt: Identifier })
export const Final = createToken({ name: 'Final', pattern: /FINAL/i, longer_alt: Identifier })
export const Recursive = createToken({ name: 'Recursive', pattern: /RECURSIVE/i, longer_alt: Identifier })

// NZPLSQL / Stored procedure keywords
export const Nzplsql = createToken({ name: 'Nzplsql', pattern: /NZPLSQL/i, longer_alt: Identifier })
export const BeginProc = createToken({ name: 'BeginProc', pattern: /BEGIN_PROC/i, longer_alt: Identifier })
export const EndProc = createToken({ name: 'EndProc', pattern: /END_PROC/i, longer_alt: Identifier })
export const Declare = createToken({ name: 'Declare', pattern: /DECLARE/i, longer_alt: Identifier })
export const Begin = createToken({ name: 'Begin', pattern: /BEGIN/i, longer_alt: Identifier })
export const Exception = createToken({ name: 'Exception', pattern: /EXCEPTION/i, longer_alt: Identifier })
export const Return = createToken({ name: 'Return', pattern: /RETURN\b/i, longer_alt: Identifier })
export const Alias = createToken({ name: 'Alias', pattern: /ALIAS/i, longer_alt: Identifier })
export const Constant = createToken({ name: 'Constant', pattern: /CONSTANT/i, longer_alt: Identifier })
export const If = createToken({ name: 'If', pattern: /IF/i, longer_alt: Identifier })
export const Elsif = createToken({ name: 'Elsif', pattern: /ELSIF/i, longer_alt: Identifier })
export const Loop = createToken({ name: 'Loop', pattern: /LOOP/i, longer_alt: Identifier })
export const While = createToken({ name: 'While', pattern: /WHILE/i, longer_alt: Identifier })
export const Exit = createToken({ name: 'Exit', pattern: /EXIT/i, longer_alt: Identifier })
export const Raise = createToken({ name: 'Raise', pattern: /RAISE/i, longer_alt: Identifier })
export const Notice = createToken({ name: 'Notice', pattern: /NOTICE/i, longer_alt: Identifier })
export const Debug = createToken({ name: 'Debug', pattern: /DEBUG/i, longer_alt: Identifier })
export const Warning = createToken({ name: 'Warning', pattern: /WARNING/i, longer_alt: Identifier })
export const Error = createToken({ name: 'Error', pattern: /ERROR/i, longer_alt: Identifier })
export const Perform = createToken({ name: 'Perform', pattern: /PERFORM\b/i, longer_alt: Identifier })
export const Reverse = createToken({ name: 'Reverse', pattern: /REVERSE\b/i, longer_alt: Identifier })
export const Out = createToken({ name: 'Out', pattern: /OUT\b/i, longer_alt: Identifier })
export const Inout = createToken({ name: 'Inout', pattern: /INOUT\b/i, longer_alt: Identifier })
export const Sqlstate = createToken({ name: 'Sqlstate', pattern: /SQLSTATE/i, longer_alt: Identifier })
export const Others = createToken({ name: 'Others', pattern: /OTHERS\b/i, longer_alt: Identifier })
export const Rollback = createToken({ name: 'Rollback', pattern: /ROLLBACK/i, longer_alt: Identifier })
export const Commit = createToken({ name: 'Commit', pattern: /COMMIT/i, longer_alt: Identifier })
export const Call = createToken({ name: 'Call', pattern: /CALL\b/i, longer_alt: Identifier })
export const Immediate = createToken({ name: 'Immediate', pattern: /IMMEDIATE/i, longer_alt: Identifier })
export const Using = createToken({ name: 'Using', pattern: /USING/i, longer_alt: Identifier })

// GRANT / REVOKE / DCL keywords
export const Grant = createToken({ name: 'Grant', pattern: /GRANT/i, longer_alt: Identifier })
export const Revoke = createToken({ name: 'Revoke', pattern: /REVOKE/i, longer_alt: Identifier })
export const To = createToken({ name: 'To', pattern: /TO/i, longer_alt: Identifier })
export const Public = createToken({ name: 'Public', pattern: /PUBLIC/i, longer_alt: Identifier })
export const Type = createToken({ name: 'Type', pattern: /TYPE/i, longer_alt: Identifier })
export const Cascade = createToken({ name: 'Cascade', pattern: /CASCADE/i, longer_alt: Identifier })
export const Restrict = createToken({ name: 'Restrict', pattern: /RESTRICT/i, longer_alt: Identifier })
export const SameAs = createToken({ name: 'SameAs', pattern: /SAMEAS/i, longer_alt: Identifier })
export const Hash = createToken({ name: 'Hash', pattern: /HASH/i, longer_alt: Identifier })
export const Deferrable = createToken({ name: 'Deferrable', pattern: /DEFERRABLE/i, longer_alt: Identifier })
export const Initially = createToken({ name: 'Initially', pattern: /INITIALLY/i, longer_alt: Identifier })

// Netezza-specific Keywords
export const Distribute = createToken({ name: 'Distribute', pattern: /DISTRIBUTE/i, longer_alt: Identifier })
export const Random = createToken({ name: 'Random', pattern: /RANDOM/i, longer_alt: Identifier })
export const Organize = createToken({ name: 'Organize', pattern: /ORGANIZE/i, longer_alt: Identifier })
export const Groom = createToken({ name: 'Groom', pattern: /GROOM/i, longer_alt: Identifier })
export const Versions = createToken({ name: 'Versions', pattern: /VERSIONS/i, longer_alt: Identifier })
export const Records = createToken({ name: 'Records', pattern: /RECORDS/i, longer_alt: Identifier })
export const Pages = createToken({ name: 'Pages', pattern: /PAGES/i, longer_alt: Identifier })
export const Ready = createToken({ name: 'Ready', pattern: /READY/i, longer_alt: Identifier })
export const Start = createToken({ name: 'Start', pattern: /START/i, longer_alt: Identifier })
export const Reclaim = createToken({ name: 'Reclaim', pattern: /RECLAIM/i, longer_alt: Identifier })
export const Backupset = createToken({ name: 'Backupset', pattern: /BACKUPSET/i, longer_alt: Identifier })
export const Default = createToken({ name: 'Default', pattern: /DEFAULT/i, longer_alt: Identifier })
export const None = createToken({ name: 'None', pattern: /NONE/i, longer_alt: Identifier })
export const Generate = createToken({ name: 'Generate', pattern: /GENERATE/i, longer_alt: Identifier })
export const Next = createToken({ name: 'Next', pattern: /NEXT\b/i, longer_alt: Identifier })
export const Express = createToken({ name: 'Express', pattern: /EXPRESS/i, longer_alt: Identifier })
export const Statistics = createToken({ name: 'Statistics', pattern: /STATISTICS/i, longer_alt: Identifier })
export const For = createToken({ name: 'For', pattern: /FOR/i, longer_alt: Identifier })
export const Of = createToken({ name: 'Of', pattern: /OF\b/i, longer_alt: Identifier })

// Additional keywords for ORDER BY
export const Asc = createToken({ name: 'Asc', pattern: /ASC/i, longer_alt: Identifier })
export const Desc = createToken({ name: 'Desc', pattern: /DESC/i, longer_alt: Identifier })

// FETCH FIRST
export const Fetch = createToken({ name: 'Fetch', pattern: /FETCH/i, longer_alt: Identifier })
export const First = createToken({ name: 'First', pattern: /FIRST/i, longer_alt: Identifier })

// Quantified comparisons
export const Any = createToken({ name: 'Any', pattern: /ANY/i, longer_alt: Identifier })
export const Some = createToken({ name: 'Some', pattern: /SOME/i, longer_alt: Identifier })

// Window functions
export const Over = createToken({ name: 'Over', pattern: /OVER/i, longer_alt: Identifier })
export const PartitionBy = createToken({ name: 'PartitionBy', pattern: /PARTITION\s+BY/i, longer_alt: Identifier })
export const Rows = createToken({ name: 'Rows', pattern: /ROWS/i, longer_alt: Identifier })
export const Range = createToken({ name: 'Range', pattern: /RANGE/i, longer_alt: Identifier })
export const Groups = createToken({ name: 'Groups', pattern: /GROUPS/i, longer_alt: Identifier })
export const Current = createToken({ name: 'Current', pattern: /CURRENT/i, longer_alt: Identifier })
export const Row = createToken({ name: 'Row', pattern: /ROW/i, longer_alt: Identifier })
export const Unbounded = createToken({ name: 'Unbounded', pattern: /UNBOUNDED/i, longer_alt: Identifier })
export const Preceding = createToken({ name: 'Preceding', pattern: /PRECEDING/i, longer_alt: Identifier })
export const Following = createToken({ name: 'Following', pattern: /FOLLOWING/i, longer_alt: Identifier })
export const Filter = createToken({ name: 'Filter', pattern: /FILTER/i, longer_alt: Identifier })
export const Exclude = createToken({ name: 'Exclude', pattern: /EXCLUDE/i, longer_alt: Identifier })
export const Ties = createToken({ name: 'Ties', pattern: /TIES/i, longer_alt: Identifier })

// Expressions / built-ins
export const Extract = createToken({ name: 'Extract', pattern: /EXTRACT/i, longer_alt: Identifier })
export const Cast = createToken({ name: 'Cast', pattern: /CAST/i, longer_alt: Identifier })
export const Column = createToken({ name: 'Column', pattern: /COLUMN/i, longer_alt: Identifier })
export const Rename = createToken({ name: 'Rename', pattern: /RENAME/i, longer_alt: Identifier })
export const Modify = createToken({ name: 'Modify', pattern: /MODIFY/i, longer_alt: Identifier })
export const Privileges = createToken({ name: 'Privileges', pattern: /PRIVILEGES/i, longer_alt: Identifier })
export const Deferred = createToken({ name: 'Deferred', pattern: /DEFERRED/i, longer_alt: Identifier })
export const Match = createToken({ name: 'Match', pattern: /MATCH/i, longer_alt: Identifier })
export const Action = createToken({ name: 'Action', pattern: /ACTION/i, longer_alt: Identifier })

// ============================================================================
// Literals
// ============================================================================

export const NumberLiteral = createToken({ 
    name: 'NumberLiteral', 
    pattern: /\d+(\.\d+)?([eE][+-]?\d+)?/ 
})

export const StringLiteral = createToken({
    name: 'StringLiteral',
    pattern: /'([^']|'')*'/
})

// Parameter markers
export const Parameter = createToken({
    name: 'Parameter',
    pattern: /\?/
})

// ============================================================================
// Identifiers
// ============================================================================

// Identifier is already defined above for longer_alt to work
export const QuotedIdentifier = createToken({
    name: 'QuotedIdentifier',
    pattern: /"[^"]*"/
})

export const DollarNumber = createToken({
    name: 'DollarNumber',
    pattern: /\$\d+/
})

export const DollarIdentifier = createToken({
    name: 'DollarIdentifier',
    pattern: /\$[a-zA-Z_][a-zA-Z0-9_]*/
})

export const BracedVariable = createToken({
    name: 'BracedVariable',
    pattern: /\$\{[a-zA-Z_][a-zA-Z0-9_]*\}/
})

export const BracesOnlyVariable = createToken({
    name: 'BracesOnlyVariable',
    pattern: /\{[a-zA-Z_][a-zA-Z0-9_]*\}/
})

// ============================================================================
// Operators and Punctuation
// ============================================================================

// Comparison operators (longer patterns first!)
export const NotEquals = createToken({ name: 'NotEquals', pattern: /(!=|<>)/ })
export const LessThanEquals = createToken({ name: 'LessThanEquals', pattern: /<=/ })
export const GreaterThanEquals = createToken({ name: 'GreaterThanEquals', pattern: />=/ })
export const Concat = createToken({ name: 'Concat', pattern: /\|\|/ })
export const DoubleColon = createToken({ name: 'DoubleColon', pattern: /::/ })
export const Assign = createToken({ name: 'Assign', pattern: /:=/ })
export const LabelStart = createToken({ name: 'LabelStart', pattern: /<</ })
export const LabelEnd = createToken({ name: 'LabelEnd', pattern: />>/ })

export const Equals = createToken({ name: 'Equals', pattern: /=/ })
export const LessThan = createToken({ name: 'LessThan', pattern: /</ })
export const GreaterThan = createToken({ name: 'GreaterThan', pattern: />/ })

// Arithmetic operators
export const Plus = createToken({ name: 'Plus', pattern: /\+/ })
export const Minus = createToken({ name: 'Minus', pattern: /-/ })
export const Multiply = createToken({ name: 'Multiply', pattern: /\*/ })
export const Divide = createToken({ name: 'Divide', pattern: /\// })
export const Modulo = createToken({ name: 'Modulo', pattern: /%/ })
export const Caret = createToken({ name: 'Caret', pattern: /\^/ })

// Punctuation
export const Dot = createToken({ name: 'Dot', pattern: /\./ })
export const Comma = createToken({ name: 'Comma', pattern: /,/ })
export const Semicolon = createToken({ name: 'Semicolon', pattern: /;/ })
export const LParen = createToken({ name: 'LParen', pattern: /\(/ })
export const RParen = createToken({ name: 'RParen', pattern: /\)/ })
export const LBracket = createToken({ name: 'LBracket', pattern: /\[/ })
export const RBracket = createToken({ name: 'RBracket', pattern: /\]/ })

// ============================================================================
// Comments (skipped)
// ============================================================================

export const LineComment = createToken({
    name: 'LineComment',
    pattern: /--[^\n]*/,
    group: Lexer.SKIPPED
})

export const BlockComment = createToken({
    name: 'BlockComment',
    pattern: { exec: matchNestedBlockComment },
    start_chars_hint: ['/'.charCodeAt(0)],
    line_breaks: true,
    group: Lexer.SKIPPED
})

// ============================================================================
// Whitespace (skipped)
// ============================================================================

export const WhiteSpace = createToken({
    name: 'WhiteSpace',
    pattern: /\s+/,
    group: Lexer.SKIPPED
})

// ============================================================================
// Token Order - IMPORTANT: More specific patterns must come first!
// ============================================================================

export const allTokens = [
    // Comments first (to be skipped)
    LineComment,
    BlockComment,
    
     // Multi-word keywords first (before single-word keywords)
     GroupBy,
     OrderBy,
     PartitionBy,
    
    // Keywords (case insensitive)
    AtSet,
    Select,
    From,
    Where,
    Insert,
    Into,
    Values,
    Value,
    Update,
    Set,
    Delete,
    Join,
    Inner,
    Left,
    Right,
    Full,
    Outer,
    Cross,
    Natural,
    Only,
    On,
    And,
    Organize,
    Or,
    NotNull,
    Not,
    Asc,
    As,
    Distinct,
    All,
    Any,
    Some,
    Union,
    Intersect,
    Except,
    MinusSet,
    Having,
    Limit,
    Offset,
    Nulls,
    Null,
    Is,
    Like,
    Ilike,
    Escape,
    Initially,
    Inout,
    In,
    Between,
    Exists,
    Case,
    When,
    Then,
    Elsif,
    If,
    Else,
    BeginProc,
    EndProc,
    Begin,
    Declare,
    Exception,
    Return,
    Alias,
    Constant,
    Loop,
    While,
    Exit,
    Raise,
    Notice,
    Debug,
    Warning,
    Error,
    Perform,
    Reverse,
    Out,
    Sqlstate,
    Others,
    Rollback,
    Commit,
    Call,
    Immediate,
    Using,
    Grant,
    Revoke,
    To,
    Public,
    Type,
    Cascade,
    Restrict,
    SameAs,
    Hash,
    Deferrable,
    End,
    Create,
    Materialized,
    Replace,
    Database,
    Groups,
    Group,
    History,
    Configuration,
    Scheduler,
    Rule,
    Schema,
    Table,
    Sequence,
    Session,
    Synonym,
    User,
    Procedure,
    Temporary,
    Temp,
    Drop,
    Truncate,
    Explain,
    Verbose,
    Distribution,
    Plantext,
    Plangraph,
    Alter,
    Show,
    Copy,
    Lock,
    Merge,
    Reindex,
    Reset,
    External,
    Views,
    View,
    Comment,
    Column,
    Rename,
    Modify,
    Privileges,
    Deferred,
    Match,
    Action,
    Add,
    Constraint,
    Primary,
    Key,
    Foreign,
    References,
    Unique,
    Check,
    Global,
    Returns,
    Language,
    Execute,
    Exec,
    Owner,
    Caller,
    RefTable,
    Varargs,
    Nzplsql,
    With,
    Final,
    Recursive,
    Distribute,
    Random,
    Groom,
    Versions,
    Records,
    Pages,
    Ready,
    Start,
    Reclaim,
    Backupset,
    Default,
    None,
    Generate,
    Next,
    Express,
    Statistics,
    For,
    Of,
    Over,
    Filter,
    Rows,
    Range,
    Current,
    Row,
    Unbounded,
    Preceding,
    Following,
    Exclude,
    Ties,
    Extract,
    Cast,
    Desc,
    Fetch,
    First,
    
    // Operators (longer patterns first)
     NotEquals,
     LessThanEquals,
     GreaterThanEquals,
     Concat,
     DoubleColon,
     Assign,
     LabelStart,
     LabelEnd,
     Equals,
     LessThan,
     GreaterThan,
    Plus,
    Minus,
    Multiply,
    Divide,
    Modulo,
    Caret,
    Dot,
    Comma,
    Semicolon,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Parameter,
    
    // Literals
    BracedVariable,
    BracesOnlyVariable,
    DollarNumber,
    DollarIdentifier,
    NumberLiteral,
    StringLiteral,
    
    // Identifiers
    QuotedIdentifier,
    Identifier,
    
    // Whitespace (last)
    WhiteSpace
]

export const SqlLexer = new Lexer(allTokens)
