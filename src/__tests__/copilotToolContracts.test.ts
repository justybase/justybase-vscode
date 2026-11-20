import * as fs from 'fs';
import * as path from 'path';
import {
    ASSISTANT_TOOL_CATALOG,
    copilotToolName,
    type AssistantToolDefinition
} from '../core/assistant/toolCatalog';

interface ManifestTool {
    name: string;
    when?: string;
    inputSchema?: {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
        required?: string[];
    };
}

const TOOL_FILE_BY_NAME: Record<string, string> = {
    netezza_get_context: 'src/services/copilotTools/contextTool.ts',
    netezza_search_catalog: 'src/services/copilotTools/searchCatalogTool.ts',
    netezza_get_object: 'src/services/copilotTools/getObjectTool.ts',
    netezza_explain_query: 'src/services/copilotTools/explainQueryTool.ts',
    netezza_validate_sql: 'src/services/copilotTools/validateSqlTool.ts',
    netezza_get_reference: 'src/services/copilotTools/getReferenceTool.ts',
    netezza_inspect_import_file: 'src/services/copilotTools/inspectImportFileTool.ts',
    netezza_propose_import_mapping: 'src/services/copilotTools/proposeImportMappingTool.ts',
    netezza_execute_sql: 'src/services/copilotTools/executeSqlTool.ts',
    netezza_drop_object: 'src/services/copilotTools/dropObjectTool.ts',
    netezza_compile_procedure: 'src/services/copilotTools/compileProcedureTool.ts'
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

function copilotCatalog(): AssistantToolDefinition[] {
    return ASSISTANT_TOOL_CATALOG.filter(tool => tool.surfaces.includes('copilot'));
}

describe('JustyBase AI tool manifest', () => {
    it('declares exactly the catalog tools for the Copilot surface', () => {
        const manifestNames = getManifestTools().map(tool => tool.name).sort();
        const catalogNames = copilotCatalog().map(tool => copilotToolName(tool.id)).sort();

        expect(manifestNames).toEqual(catalogNames);
    });

    it('does not expose retired AI SQL execution tools or their settings', () => {
        const manifestTools = getManifestTools();
        const toolsByName = new Map(manifestTools.map(tool => [tool.name, tool]));
        const configurationProperties = getConfigurationProperties();

        for (const name of [
            'netezza_get_object_details', 'netezza_explain_sql', 'netezza_explain_plan',
            'netezza_validate_sql_on_database', 'netezza_get_dialect_reference',
            'netezza_repair_procedure', 'netezza_execute_query', 'netezza_get_sample_data',
            'netezza_execute_import', 'netezza_export_query_results',
            'netezza_execute_procedure', 'netezza_run_diagnostic_queries',
            'netezza_get_sql_schema', 'netezza_get_columns', 'netezza_get_tables',
            'netezza_get_databases', 'netezza_get_schemas', 'netezza_get_views',
            'netezza_get_procedures', 'netezza_get_ddl', 'netezza_get_table_stats',
            'netezza_search_schema', 'netezza_get_dependencies', 'netezza_get_external_tables',
            'netezza_find_table_locations', 'netezza_get_comments', 'netezza_get_favorites',
            'netezza_get_sql_diagnostics', 'netezza_get_tuning_advice'
        ]) {
            expect(toolsByName.has(name)).toBe(false);
        }

        expect(configurationProperties['justybase.copilot.tools.executeQueryEnabled']).toBeUndefined();
        expect(configurationProperties['justybase.copilot.tools.sampleDataEnabled']).toBeUndefined();
        expect(configurationProperties['justybase.copilot.prompts.fix']).toBeUndefined();
        expect(configurationProperties['justybase.copilot.requestTimeout']).toBeUndefined();
        expect(configurationProperties['justybase.copilot.skipPrivacyConfirmation']).toBeUndefined();
        expect(configurationProperties['justybase.ai.tools']).toBeDefined();
    });

    it('keeps every manifest entry in sync with the catalog schema', () => {
        const manifestByName = new Map(getManifestTools().map(tool => [tool.name, tool]));

        for (const definition of copilotCatalog()) {
            const manifest = manifestByName.get(copilotToolName(definition.id));
            expect(manifest).toBeDefined();

            const manifestProperties = manifest?.inputSchema?.properties ?? {};
            const catalogProperties = definition.inputSchema.properties;

            expect(Object.keys(manifestProperties).sort()).toEqual(Object.keys(catalogProperties).sort());
            expect([...(manifest?.inputSchema?.required ?? [])].sort())
                .toEqual([...(definition.inputSchema.required ?? [])].sort());

            for (const [property, catalogSchema] of Object.entries(catalogProperties)) {
                const manifestSchema = manifestProperties[property];
                expect(manifestSchema).toBeDefined();
                expect(manifestSchema.type).toBe(catalogSchema.type);
                if (Array.isArray(catalogSchema.enum)) {
                    expect(manifestSchema.enum).toEqual(catalogSchema.enum);
                }
                if (catalogSchema.type === 'array') {
                    expect(manifestSchema.items).toEqual(catalogSchema.items);
                }
            }
        }
    });

    it('ensures manifest input keys exist in runtime tool interfaces', () => {
        for (const tool of getManifestTools()) {
            const toolFile = TOOL_FILE_BY_NAME[tool.name];
            expect(toolFile).toBeDefined();

            const interfaceProps = getInterfacePropertyNames(toolFile);
            const manifestProps = Object.keys(tool.inputSchema?.properties || {});

            for (const prop of manifestProps) {
                expect(interfaceProps.has(prop)).toBe(true);
            }
        }
    });

    it('registers tools from the catalog and access policy instead of a static list', () => {
        const registrationPath = path.join(process.cwd(), 'src/activation/copilotRegistration.ts');
        const registrationSource = fs.readFileSync(registrationPath, 'utf8');

        expect(registrationSource).toContain('allowedToolsForSurface');
        expect(registrationSource).toContain('copilotToolName');
        expect(registrationSource).toContain("onDidChangeConfiguration");
        expect(registrationSource).not.toContain('netezza_repair_procedure');
        expect(registrationSource).not.toContain('netezza_get_object_details');
    });

    it('contributes skills and prompt files for agent workflows', () => {
        const packageJsonPath = path.join(process.cwd(), 'package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
            contributes?: {
                chatSkills?: Array<{ path: string }>;
                chatPromptFiles?: Array<{ path: string }>;
            };
        };

        expect(packageJson.contributes?.chatSkills?.length).toBe(4);
        expect(packageJson.contributes?.chatPromptFiles?.length).toBe(4);
    });
});
