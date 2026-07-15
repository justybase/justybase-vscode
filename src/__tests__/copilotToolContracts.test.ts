import * as fs from 'fs';
import * as path from 'path';

interface ManifestTool {
    name: string;
    when?: string;
    inputSchema?: {
        properties?: Record<string, unknown>;
    };
}

const TOOL_FILE_BY_NAME: Record<string, string> = {
    netezza_get_sql_schema: 'src/services/copilotTools/schemaTool.ts',
    netezza_get_columns: 'src/services/copilotTools/columnsTool.ts',
    netezza_get_tables: 'src/services/copilotTools/tablesTool.ts',
    netezza_get_databases: 'src/services/copilotTools/databasesTool.ts',
    netezza_get_schemas: 'src/services/copilotTools/schemasTool.ts',
    netezza_get_views: 'src/services/copilotTools/viewsTool.ts',
    netezza_get_procedures: 'src/services/copilotTools/proceduresTool.ts',
    netezza_get_ddl: 'src/services/copilotTools/getDDLTool.ts',
    netezza_get_table_stats: 'src/services/copilotTools/tableStatsTool.ts',
    netezza_search_schema: 'src/services/copilotTools/searchSchemaTool.ts',
    netezza_get_dependencies: 'src/services/copilotTools/dependenciesTool.ts',
    netezza_get_external_tables: 'src/services/copilotTools/externalTablesTool.ts',
    netezza_find_table_locations: 'src/services/copilotTools/findTableLocationsTool.ts',
    netezza_get_comments: 'src/services/copilotTools/getCommentsTool.ts',
    netezza_get_favorites: 'src/services/copilotTools/favoritesTool.ts',
    netezza_validate_sql: 'src/services/copilotTools/validateSqlTool.ts',
    netezza_validate_sql_on_database: 'src/services/copilotTools/validateSqlOnDatabaseTool.ts',
    netezza_get_sql_diagnostics: 'src/services/copilotTools/getSqlDiagnosticsTool.ts',
    netezza_inspect_import_file: 'src/services/copilotTools/inspectImportFileTool.ts',
    netezza_propose_import_mapping: 'src/services/copilotTools/proposeImportMappingTool.ts',
    netezza_explain_plan: 'src/services/copilotTools/explainPlanTool.ts',
    netezza_get_tuning_advice: 'src/services/copilotTools/tuningAdviceTool.ts'
};

function getManifestTools(): ManifestTool[] {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        contributes?: { languageModelTools?: ManifestTool[] };
    };
    return packageJson.contributes?.languageModelTools || [];
}

function getConfigurationProperties(): Record<string, { default?: unknown }> {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
    };
    return packageJson.contributes?.configuration?.properties || {};
}

function getRegisteredToolNames(): string[] {
    const registrationPath = path.join(process.cwd(), 'src/activation/copilotRegistration.ts');
    const registrationSource = fs.readFileSync(registrationPath, 'utf8');
    const regex = /registerTool(?:WithContract)?\('([^']+)'/g;
    const names: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(registrationSource)) !== null) {
        names.push(match[1]);
    }
    return names;
}

function getInterfacePropertyNames(relativePath: string): Set<string> {
    const sourcePath = path.join(process.cwd(), relativePath);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const interfaceMatch = source.match(/export interface I\w+ToolParameters\s*\{([\s\S]*?)\n\}/);
    if (!interfaceMatch) {
        return new Set();
    }

    const propertyRegex = /^\s*([A-Za-z_]\w*)\??\s*:/gm;
    const propertyNames = new Set<string>();
    let propertyMatch: RegExpExecArray | null;
    while ((propertyMatch = propertyRegex.exec(interfaceMatch[1])) !== null) {
        propertyNames.add(propertyMatch[1]);
    }
    return propertyNames;
}

describe('Copilot tool contracts', () => {
    it('does not expose retired AI SQL execution tools or their settings', () => {
        const manifestTools = getManifestTools();
        const toolsByName = new Map(manifestTools.map(tool => [tool.name, tool]));

        const configurationProperties = getConfigurationProperties();
        for (const name of [
            'netezza_execute_query', 'netezza_get_sample_data', 'netezza_execute_import',
            'netezza_export_query_results', 'netezza_compile_procedure',
            'netezza_execute_procedure', 'netezza_run_diagnostic_queries'
        ]) expect(toolsByName.has(name)).toBe(false);
        expect(configurationProperties['justybase.copilot.tools.executeQueryEnabled']).toBeUndefined();
        expect(configurationProperties['justybase.copilot.tools.sampleDataEnabled']).toBeUndefined();
    });

    it('keeps manifest tool names in sync with runtime registrations', () => {
        const manifestTools = getManifestTools();
        const manifestNames = manifestTools.map(tool => tool.name).sort();
        const registrationNames = getRegisteredToolNames().sort();

        expect(registrationNames).toEqual(manifestNames);
    });

    it('ensures manifest input keys exist in runtime tool interfaces', () => {
        const manifestTools = getManifestTools();

        for (const tool of manifestTools) {
            const toolFile = TOOL_FILE_BY_NAME[tool.name];
            expect(toolFile).toBeDefined();

            const interfaceProps = getInterfacePropertyNames(toolFile);
            const manifestProps = Object.keys(tool.inputSchema?.properties || {});

            for (const prop of manifestProps) {
                expect(interfaceProps.has(prop)).toBe(true);
            }
        }
    });
});
