import { CopilotToolRuntime } from './copilotToolRuntime';

interface CopilotQueryToolsDeps {
    runtime: CopilotToolRuntime;
}

export class CopilotQueryTools {
    constructor(private readonly deps: CopilotQueryToolsDeps) { }

    async executeSelectQuery(sql: string, maxRows: number, database?: string): Promise<string> {
        if (!sql.trim().toUpperCase().startsWith('SELECT') && !sql.trim().toUpperCase().startsWith('WITH')) {
            throw new Error('Only SELECT queries are allowed.');
        }

        const limitSql = `${sql} LIMIT ${maxRows}`;
        return this.deps.runtime.runQuerySafe(limitSql, 'execute query', database);
    }

}
