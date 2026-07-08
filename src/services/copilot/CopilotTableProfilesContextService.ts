import { CopilotTableProfilesManager, WorkspaceTableProfile } from './CopilotTableProfilesManager';
import { TableReference } from './types';
import { getExtensionConfiguration } from '../../compatibility/configuration';

export interface WorkspaceProfilesContextSelection {
    notesSummary: string;
    tableReferences: TableReference[];
    sqlSnippets: { name: string; content: string }[];
}

export class CopilotTableProfilesContextService {
    constructor(private readonly profilesManager: CopilotTableProfilesManager) { }

    public async buildSelectionForPrompt(): Promise<WorkspaceProfilesContextSelection> {
        const selectedProfiles = await this.profilesManager.consumeProfilesForPrompt();
        if (selectedProfiles.length === 0) {
            return {
                notesSummary: 'No favorite tables or SQL selected for Copilot context.',
                tableReferences: [],
                sqlSnippets: []
            };
        }

        const maxProfiles = getExtensionConfiguration('copilot').get<number>('maxWorkspaceProfilesInContext', 5) ?? 5;
        const profilesToUse = selectedProfiles.slice(0, maxProfiles);
        const notesSummary = this.buildNotesSummary(profilesToUse, selectedProfiles.length, maxProfiles);

        const tableProfiles = profilesToUse.filter(p => p.type !== 'sql');
        const sqlProfiles = profilesToUse.filter(p => p.type === 'sql');

        return {
            notesSummary,
            tableReferences: tableProfiles.map(profile => ({
                database: profile.database,
                schema: profile.schema,
                name: profile.table
            })),
            sqlSnippets: sqlProfiles.map(profile => ({
                name: profile.table, // for sql profiles, table is the label
                content: profile.sqlContent || ''
            }))
        };
    }

    private buildNotesSummary(profiles: WorkspaceTableProfile[], selectedCount: number, maxProfiles: number): string {
        const lines: string[] = ['Favorite tables and SQL notes:'];
        for (const profile of profiles) {
            const name = profile.type === 'sql' ? `SQL: ${profile.table}` : `${profile.database}.${profile.schema}.${profile.table}`;
            const notes = profile.notes.trim().length > 0 ? profile.notes.trim() : 'No user notes.';
            lines.push(`- ${name}: ${notes}`);
        }
        if (selectedCount > maxProfiles) {
            lines.push(`- NOTE: Showing ${maxProfiles} of ${selectedCount} selected profiles (context limit reached).`);
        }
        return lines.join('\n');
    }
}
