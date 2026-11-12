/**
 * Contract tests for JustyBase AI tools.
 *
 * Validates that package.json, runtime contracts, input validators, and the
 * active tool policy stay aligned.
 */

import {
    ToolContractRegistry,
    getToolContract,
    getAllToolContracts,
    hasToolContract,
    GetContextToolContract,
    SearchCatalogToolContract,
    GetObjectDetailsToolContract,
    ExplainSqlToolContract,
    ValidateSqlToolContract,
    ValidateSqlOnDatabaseToolContract,
    ProcedureRepairToolContract,
    InspectImportFileToolContract,
    ProposeImportMappingToolContract,
    NetezzaReferenceToolContract
} from '../../contracts/copilotTools/contracts';
import { ALLOWED_AI_TOOL_NAMES } from '../../services/copilotTools/aiToolPolicy';

const packageJson = require('../../../package.json');

describe('JustyBase AI tool contracts', () => {
    const manifestTools = (packageJson.contributes?.languageModelTools || []) as Array<{
        name: string;
        displayName: string;
        toolReferenceName?: string;
        tags?: string[];
    }>;

    describe('Manifest ↔ contract coverage', () => {
        it('has a contract for every manifest tool', () => {
            const missing = manifestTools
                .map(tool => tool.name)
                .filter(name => !hasToolContract(name));
            expect(missing).toEqual([]);
        });

        it('has every contract in the manifest', () => {
            const manifestNames = new Set(manifestTools.map(tool => tool.name));
            const missing = Array.from(ToolContractRegistry.keys())
                .filter(name => !manifestNames.has(name));
            expect(missing).toEqual([]);
        });

        it('keeps the AI tool policy aligned with the contract registry', () => {
            expect([...ALLOWED_AI_TOOL_NAMES].sort()).toEqual([...ToolContractRegistry.keys()].sort());
        });

        it('registers exactly ten tools', () => {
            expect(ToolContractRegistry.size).toBe(10);
            expect(manifestTools).toHaveLength(10);
        });

        it('matches names, display names, reference names, and tags', () => {
            for (const manifestTool of manifestTools) {
                const contract = getToolContract(manifestTool.name);
                expect(contract).toBeDefined();
                expect(contract!.name).toBe(manifestTool.name);
                expect(contract!.displayName).toBe(manifestTool.displayName);
                expect(contract!.toolReferenceName).toBe(manifestTool.toolReferenceName);
                expect([...contract!.tags].sort()).toEqual([...(manifestTool.tags || [])].sort());
            }
        });
    });

    describe('Input validation', () => {
        it('validates get_context input', () => {
            expect(GetContextToolContract.validateInput({}).success).toBe(true);
            expect(GetContextToolContract.validateInput({ sql: 'SELECT 1', includeSchema: false }).success).toBe(true);
            expect(GetContextToolContract.validateInput({ includeSchema: 'yes' }).success).toBe(false);
        });

        it('defaults search_catalog to tables and validates objectType', () => {
            const defaultResult = SearchCatalogToolContract.validateInput({});
            expect(defaultResult.success).toBe(true);
            if (defaultResult.success) {
                expect(defaultResult.data.objectType).toBe('tables');
            }

            expect(SearchCatalogToolContract.validateInput({ objectType: 'columns', pattern: 'NAME' }).success).toBe(true);
            expect(SearchCatalogToolContract.validateInput({ objectType: 'invalid' }).success).toBe(false);
        });

        it('requires objectName unless only favorites are requested', () => {
            expect(GetObjectDetailsToolContract.validateInput({ objectName: 'ADMIN.T', sections: ['ddl'] }).success).toBe(true);
            expect(GetObjectDetailsToolContract.validateInput({ sections: ['favorites'] }).success).toBe(true);
            expect(GetObjectDetailsToolContract.validateInput({ sections: ['ddl'] }).success).toBe(false);
            expect(GetObjectDetailsToolContract.validateInput({ objectName: 'T', sections: ['unknown'] }).success).toBe(false);
        });

        it('validates explain_sql and validate_sql input', () => {
            expect(ExplainSqlToolContract.validateInput({ sql: 'SELECT 1' }).success).toBe(true);
            expect(ExplainSqlToolContract.validateInput({}).success).toBe(false);
            expect(ValidateSqlToolContract.validateInput({}).success).toBe(true);
            expect(ValidateSqlToolContract.validateInput({ sql: 'SELECT 1' }).success).toBe(true);
        });

        it('validates validate_sql_on_database input', () => {
            expect(ValidateSqlOnDatabaseToolContract.validateInput({ database: 'TESTDB' }).success).toBe(true);
            expect(ValidateSqlOnDatabaseToolContract.validateInput({ sql: 'SELECT 1', database: 'TESTDB' }).success).toBe(true);
        });

        it('validates procedure repair mode and call arguments', () => {
            expect(ProcedureRepairToolContract.validateInput({ mode: 'compile_only' }).success).toBe(true);
            expect(ProcedureRepairToolContract.validateInput({ mode: 'compile_and_call', callArguments: [] }).success).toBe(true);
            expect(ProcedureRepairToolContract.validateInput({ mode: 'compile_and_call' }).success).toBe(false);
            expect(ProcedureRepairToolContract.validateInput({ mode: 'invalid' }).success).toBe(false);
        });

        it('validates import tools', () => {
            expect(InspectImportFileToolContract.validateInput({ filePath: 'C:/tmp/data.csv' }).success).toBe(true);
            expect(InspectImportFileToolContract.validateInput({}).success).toBe(false);
            expect(ProposeImportMappingToolContract.validateInput({ filePath: 'C:/tmp/data.csv', targetTable: 'ADMIN.T' }).success).toBe(true);
            expect(ProposeImportMappingToolContract.validateInput({ filePath: 'C:/tmp/data.csv' }).success).toBe(false);
        });

        it('validates dialect reference topic', () => {
            const defaultResult = NetezzaReferenceToolContract.validateInput({});
            expect(defaultResult.success).toBe(true);
            if (defaultResult.success) {
                expect(defaultResult.data.topic).toBe('all');
            }
            expect(NetezzaReferenceToolContract.validateInput({ topic: 'nzplsql' }).success).toBe(true);
            expect(NetezzaReferenceToolContract.validateInput({ topic: 'invalid' }).success).toBe(false);
        });
    });

    describe('Output validation and metadata', () => {
        it('accepts a valid ToolOutput', () => {
            const result = GetContextToolContract.validateOutput({
                summary: 'ok',
                data: 'context',
                errors: []
            });
            expect(result.success).toBe(true);
        });

        it('rejects an invalid ToolOutput', () => {
            expect(GetContextToolContract.validateOutput({ data: 'x', errors: [] }).success).toBe(false);
            expect(GetContextToolContract.validateOutput({ summary: 'x', data: 'x' }).success).toBe(false);
        });

        it('provides required metadata for every contract', () => {
            for (const contract of getAllToolContracts()) {
                expect(contract.name).toBeTruthy();
                expect(contract.displayName).toBeTruthy();
                expect(contract.description).toBeTruthy();
                expect(contract.toolReferenceName).toBeTruthy();
                expect(contract.tags.length).toBeGreaterThan(0);
                expect(typeof contract.requiresConnection).toBe('boolean');
                expect(typeof contract.validateInput).toBe('function');
                expect(typeof contract.validateOutput).toBe('function');
            }
        });
    });
});
