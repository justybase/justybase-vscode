import { TableReference } from './types';

/**
 * Extracts table references from SQL queries
 */
export class TableReferenceExtractor {
    /**
     * Extracts table references from SQL using improved regex patterns
     * Handles: TABLE, SCHEMA.TABLE, DB.SCHEMA.TABLE, and DB..TABLE (Netezza two-dot syntax)
     */
    public extract(sql: string): TableReference[] {
        try {
            // Clean SQL: remove comments and string literals to avoid false positives
            let cleanedSql = sql
                .replace(/--.*$/gm, '') // Remove single-line comments
                .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
                .replace(/'([^'\\]|\\.)*'/g, ''); // Remove string literals in single quotes

            const tables = new Map<string, TableReference>();

            // STEP 1: First extract DB..TABLE (Netezza two-dot syntax) and remove from SQL
            // This prevents the standard patterns from incorrectly parsing these
            const twoDotPatterns = [
                /FROM\s+(\w+)\.\.(\w+)/gi,
                /JOIN\s+(\w+)\.\.(\w+)/gi,
                /INSERT\s+INTO\s+(\w+)\.\.(\w+)/gi,
                /UPDATE\s+(\w+)\.\.(\w+)/gi,
                /DELETE\s+FROM\s+(\w+)\.\.(\w+)/gi
            ];

            for (const pattern of twoDotPatterns) {
                cleanedSql = cleanedSql.replace(pattern, (match, database, tableName) => {
                    const key = `${database}||${tableName}`.toUpperCase();
                    tables.set(key, {
                        database: database?.toUpperCase(),
                        schema: undefined,
                        name: tableName?.toUpperCase()
                    });
                    // Replace with placeholder to prevent re-matching
                    return match.replace(/\w+\.\.\w+/, '__EXTRACTED__');
                });
            }

            // STEP 2: Now extract standard patterns: DB.SCHEMA.TABLE, SCHEMA.TABLE, TABLE
            // Patterns require a word character after the keyword (not whitespace or end of string)
            // to avoid matching SQL keywords themselves as table names
            const patterns = [
                /FROM\s+(\w+)(?:\.(\w+))?(?:\.(\w+))?/gi,
                /JOIN\s+(\w+)(?:\.(\w+))?(?:\.(\w+))?/gi,
                /INSERT\s+INTO\s+(\w+)(?:\.(\w+))?(?:\.(\w+))?/gi,
                /UPDATE\s+(\w+)(?:\.(\w+))?(?:\.(\w+))?/gi,
                /DELETE\s+FROM\s+(\w+)(?:\.(\w+))?(?:\.(\w+))?/gi
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(cleanedSql)) !== null) {
                    let database: string | undefined;
                    let schema: string | undefined;
                    let tableName: string | undefined;

                    // match[1] = first part after keyword
                    // match[2] = second part (optional)
                    // match[3] = third part (optional)

                    if (match[3]) {
                        // DB.SCHEMA.TABLE
                        database = match[1];
                        schema = match[2];
                        tableName = match[3];
                    } else if (match[2]) {
                        // SCHEMA.TABLE
                        schema = match[1];
                        tableName = match[2];
                    } else if (match[1]) {
                        // TABLE
                        tableName = match[1];
                    }

                    if (tableName && tableName !== '__EXTRACTED__') {
                        const key = `${database || ''}|${schema || ''}|${tableName}`.toUpperCase();
                        tables.set(key, {
                            database: database?.toUpperCase(),
                            schema: schema?.toUpperCase(),
                            name: tableName?.toUpperCase()
                        });
                    }
                }
            }

            return Array.from(tables.values());
        } catch (e) {
            console.error('[TableReferenceExtractor] Error extracting table references:', e);
            return [];
        }
    }
}
