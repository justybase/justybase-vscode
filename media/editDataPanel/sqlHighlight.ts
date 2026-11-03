/**
 * Minimal SQL tokenizer for read-only code blocks (DDL tab, SQL preview).
 * Output is HTML-escaped and wrapped in `tok-*` spans.
 */

const KEYWORDS = new Set([
    'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BEGIN', 'BETWEEN', 'BY', 'CASE', 'CHECK', 'COLUMN', 'COMMENT',
    'COMMIT', 'CONSTRAINT', 'CREATE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DISTRIBUTE', 'DROP', 'ELSE', 'END',
    'EXISTS', 'FOREIGN', 'FROM', 'GRANT', 'GROUP', 'HASH', 'IF', 'IN', 'INDEX', 'INSERT', 'INTO', 'IS', 'JOIN', 'KEY',
    'LIKE', 'LIMIT', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'ORGANIZE', 'OWNER', 'PRIMARY', 'RANDOM', 'REFERENCES',
    'ROLLBACK', 'SELECT', 'SET', 'TABLE', 'THEN', 'TO', 'UNIQUE', 'UPDATE', 'USING', 'VALUES', 'VIEW', 'WHEN',
    'WHERE', 'WITH', 'NONE', 'TEMP', 'TEMPORARY', 'EXTERNAL', 'SEQUENCE', 'SCHEMA', 'DATABASE', 'TRUE', 'FALSE',
]);

const TYPES = new Set([
    'BIGINT', 'BOOLEAN', 'BOOL', 'BYTEINT', 'CHAR', 'CHARACTER', 'DATE', 'DECIMAL', 'DOUBLE', 'FLOAT', 'INT', 'INTEGER',
    'INTERVAL', 'NCHAR', 'NUMERIC', 'NVARCHAR', 'PRECISION', 'REAL', 'SMALLINT', 'TIME', 'TIMESTAMP', 'VARCHAR',
    'VARYING', 'JSON', 'VARBINARY', 'ST_GEOMETRY', 'INT1', 'INT2', 'INT4', 'INT8', 'TIMETZ',
]);

function escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const TOKEN = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$]*)|(\s+)|([\s\S])/g;

export function highlightSql(sql: string): string {
    let html = '';
    TOKEN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN.exec(sql)) !== null) {
        const [text, comment, str, quoted, num, word] = match;
        if (comment) html += `<span class="tok-comment">${escape(text)}</span>`;
        else if (str) html += `<span class="tok-string">${escape(text)}</span>`;
        else if (quoted) html += `<span class="tok-ident">${escape(text)}</span>`;
        else if (num) html += `<span class="tok-number">${escape(text)}</span>`;
        else if (word) {
            const upper = word.toUpperCase();
            if (KEYWORDS.has(upper)) html += `<span class="tok-keyword">${escape(text)}</span>`;
            else if (TYPES.has(upper)) html += `<span class="tok-type">${escape(text)}</span>`;
            else html += escape(text);
        } else html += escape(text);
    }
    return html;
}

/** Renders SQL as a code block with a line-number gutter. */
export function renderCodeBlock(sql: string): string {
    const lines = highlightSql(sql).split('\n');
    const numbers = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
    return `<div class="code-block"><div class="code-gutter" aria-hidden="true">${numbers}</div><pre class="code-text">${lines.join('\n')}</pre></div>`;
}
