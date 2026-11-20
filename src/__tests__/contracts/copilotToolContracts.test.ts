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
    GetObjectToolContract,
    ExplainQueryToolContract,
    ValidateSqlToolContract,
    ExecuteSqlToolContract,
    DropObjectToolContract,
    CompileProcedureToolContract,
    InspectImportFileToolContract,
    ProposeImportMappingToolContract,
    GetReferenceToolContract
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

    describe('Manifest → contract coverage', () => {
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

        it('registers exactly eleven tools', () => {
            expect(ToolContractRegistry.size).toBe(11);
            expect(manifestTools).toHaveLength(11);
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

        it('defaults search_catalog to tables and validates kind', () => {
            const defaultResult = SearchCatalogToolContract.validateInput({});
            expect(defaultResult.success).toBe(true);
            if (defaultResult.success) {
                expect(defaultResult.data.kind).toBe('tables');
            }

            expect(SearchCatalogToolContract.validateInput({ kind: 'columns', query: 'NAME' }).success).toBe(true);
            expect(SearchCatalogToolContract.validateInput({ kind: 'invalid' }).success).toBe(false);
            expect(SearchCatalogToolContract.validateInput({ kind: 'columns' }).success).toBe(false);
        });

        it('requires the object name and validates sections', () => {
            expect(GetObjectToolContract.validateInput({ object: 'ADMIN.T', sections: ['ddl'] }).success).toBe(true);
            expect(GetObjectToolContract.validateInput({ object: 'ADMIN.T' }).success).toBe(true);
            expect(GetObjectToolContract.validateInput({ sections: ['ddl'] }).success).toBe(false);
            expect(GetObjectToolContract.validateInput({ object: 'T', sections: ['unknown'] }).success).toBe(false);
            expect(GetObjectToolContract.validateInput({ object: 'T', sections: ['favorites'] }).success).toBe(false);
        });

        it('validates explain_query and validate_sql input', () => {
            expect(ExplainQueryToolContract.validateInput({ sql: 'SELECT 1' }).success).toBe(true);
            expect(ExplainQueryToolContract.validateInput({}).success).toBe(false);
            expect(ValidateSqlToolContract.validateInput({ sql: 'SELECT 1' }).success).toBe(true);
            expect(ValidateSqlToolContract.validateInput({}).success).toBe(false);
            expect(ValidateSqlToolContract.validateInput({ sql: 'SELECT 1', mode: 'database' }).success).toBe(true);
            expect(ValidateSqlToolContract.validateInput({ sql: 'SELECT 1', mode: 'invalid' }).success).toBe(false);
        });

        it('validates execute_sql input', () => {
            expect(ExecuteSqlToolContract.validateInput({ sql: 'SELECT 1' }).success).toBe(true);
            expect(ExecuteSqlToolContract.validateInput({ sql: 'DROP TABLE T', confirm: 'T' }).success).toBe(true);
            expect(ExecuteSqlToolContract.validateInput({}).success).toBe(false);
        });

        it('validates drop_object input', () => {
            expect(DropObjectToolContract.validateInput({
                object: 'ADMIN.T',
                objectType: 'table',
                confirm: 'T'
            }).success).toBe(true);
            expect(DropObjectToolContract.validateInput({ object: 'ADMIN.T', confirm: 'T' }).success).toBe(false);
            expect(DropObjectToolContract.validateInput({ object: 'ADMIN.T', objectType: 'table' }).success).toBe(false);
            expect(DropObjectToolContract.validateInput({
                object: 'ADMIN.T',
                objectType: 'invalid',
                confirm: 'T'
            }).success).toBe(false);
        });

        it('validates procedure compile mode, call arguments and confirmation', () => {
            expect(CompileProcedureToolContract.validateInput({ mode: 'compile_only' }).success).toBe(true);
            expect(CompileProcedureToolContract.validateInput({
                mode: 'compile_and_call',
                callArguments: [],
                confirm: 'P'
            }).success).toBe(true);
            expect(CompileProcedureToolContract.validateInput({ mode: 'compile_and_call', callArguments: [] }).success).toBe(false);
            expect(CompileProcedureToolContract.validateInput({
                mode: 'compile_and_call',
                callArguments: [],
                confirm: ''
            }).success).toBe(false);
            expect(CompileProcedureToolContract.validateInput({ mode: 'compile_and_call' }).success).toBe(false);
            expect(CompileProcedureToolContract.validateInput({ mode: 'invalid' }).success).toBe(false);
        });

        it('validates import tools', () => {
            expect(InspectImportFileToolContract.validateInput({ filePath: 'C:/tmp/data.csv' }).success).toBe(true);
            expect(InspectImportFileToolContract.validateInput({}).success).toBe(false);
            expect(ProposeImportMappingToolContract.validateInput({ filePath: 'C:/tmp/data.csv', targetTable: 'ADMIN.T' }).success).toBe(true);
            expect(ProposeImportMappingToolContract.validateInput({ filePath: 'C:/tmp/data.csv' }).success).toBe(false);
        });

        it('validates dialect reference topic', () => {
            const defaultResult = GetReferenceToolContract.validateInput({});
            expect(defaultResult.success).toBe(true);
            if (defaultResult.success) {
                expect(defaultResult.data.topic).toBe('all');
            }
            expect(GetReferenceToolContract.validateInput({ topic: 'nzplsql' }).success).toBe(true);
            expect(GetReferenceToolContract.validateInput({ topic: 'invalid' }).success).toBe(false);
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
