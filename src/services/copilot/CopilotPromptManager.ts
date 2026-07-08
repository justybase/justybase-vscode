import type { DatabaseCopilotReferenceProvider } from '../../contracts/database';
import { CopilotContext } from './types';
import { getExtensionConfiguration } from '../../compatibility/configuration';

export interface CopilotPromptDialectContext {
    displayName: string;
    referenceProvider: DatabaseCopilotReferenceProvider;
}

export class CopilotPromptManager {
    constructor(private resolveDialectContext: () => CopilotPromptDialectContext) { }

    public getPrompt(type: 'optimize' | 'fix' | 'explain' | 'bestPractices'): string {
        const config = getExtensionConfiguration('copilot.prompts');
        const { displayName } = this.resolveDialectContext();
        const defaults: Record<string, string> = {
            optimize: `Optimize the following ${displayName} SQL query for performance and readability. Keep ${displayName}-specific syntax and features.`,
            fix: `Fix the syntax errors in the following ${displayName} SQL query. Preserve ${displayName}-specific SQL dialect features.`,
            explain: `Explain what this ${displayName} SQL query does, including any dialect-specific features used.`,
            bestPractices: `Rewrite the following ${displayName} SQL query to follow ${displayName} best practices. Apply dialect-aware performance improvements and modernize the syntax where safe.`
        };
        const customValue = config.get<string>(type);
        // Return custom value even if empty string, otherwise return default
        return customValue !== undefined ? customValue : defaults[type];
    }

    public buildSystemPrompt(context: CopilotContext): string {
        const { displayName, referenceProvider } = this.resolveDialectContext();
        const dialectRules = referenceProvider.getReference('optimization');

        return `You are an expert ${displayName} SQL developer and DBA.
Your goal is to assist the user with ${displayName} SQL queries, stored procedures, and database optimizations.

STRICT RULES:
1. ALWAYS use syntax and features supported by the active ${displayName} dialect.
2. Do NOT suggest features that belong to a different database engine when they are not supported here.
3. When optimizing, explain WHY changes improve performance for ${displayName} and its execution model.
4. If the user asks to fix a query, return ONLY the corrected SQL code block first, followed by a brief explanation.

CONTEXT INFORMATION:
${context.connectionInfo}

DATABASE SCHEMA (DDL) FOR REFERENCED TABLES:
${context.ddlContext}

DETECTED VARIABLES:
${context.variables}

RECENT QUERY HISTORY:
${context.recentQueries}

WORKSPACE CURATED TABLES:
${context.workspaceTableProfilesContext || 'No workspace curated tables selected.'}

SELECTED SQL:
${context.selectedSql}

${dialectRules}
`;
    }
}
