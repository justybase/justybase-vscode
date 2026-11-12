/**
 * Small response-formatting helpers shared by the remaining editor commands.
 *
 * Model orchestration now belongs to the Copilot agent and the registered
 * language-model tools; this class intentionally has no model or chat logic.
 */
export class CopilotResponseHandler {
    /**
     * Detects if SQL contains a stored procedure definition.
     */
    public isProcedureCode(sql: string): boolean {
        const procedurePattern = /CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\s+/i;
        return procedurePattern.test(sql);
    }

    /**
     * Converts a data array to a markdown table (max 50 rows).
     */
    public convertDataToMarkdown(data: Record<string, unknown>[]): string {
        if (data.length === 0) {
            return '*No data*';
        }

        const displayData = data.slice(0, 50);
        const hasMore = data.length > 50;
        const columns = Object.keys(displayData[0]);

        let markdown = '| ' + columns.join(' | ') + ' |\n';
        markdown += '| ' + columns.map(() => '---').join(' | ') + ' |\n';

        for (const row of displayData) {
            const values = columns.map(col => {
                const val = row[col];
                if (val === null || val === undefined) {
                    return 'NULL';
                }
                const str = String(val).replace(/\|/g, '\\|');
                return str.length > 100 ? str.substring(0, 97) + '...' : str;
            });
            markdown += '| ' + values.join(' | ') + ' |\n';
        }

        if (hasMore) {
            markdown += `\n*... and ${data.length - 50} more rows (total: ${data.length} rows)*`;
        }

        return markdown;
    }
}
