/**
 * AI-01: Contract Tests dla Copilot Tools
 * Walidacja zgodności package.json z runtime contracts
 */

import {
    ToolContractRegistry,
    getToolContract,
    getAllToolContracts,
    hasToolContract,
    SchemaToolContract,
    ColumnsToolContract,
    TablesToolContract,
    ExecuteQueryToolContract,
    SearchSchemaToolContract,
    ExportQueryResultsToolContract,
    FavoritesToolContract,
    ValidateSqlToolContract,
    ValidateSqlOnDatabaseToolContract,
    TuningAdviceToolContract
} from '../../contracts/copilotTools/contracts';

// Import package.json to access languageModelTools
const packageJson = require('../../../package.json');

describe('AI-01: Copilot Tool Contracts', () => {
    const manifestTools = packageJson.contributes?.languageModelTools || [];

    describe('Manifest → Runtime Contract Coverage', () => {
        it('should have contracts for all tools defined in package.json', () => {
            const manifestToolNames = manifestTools.map((t: { name: string }) => t.name);

            const missingContracts = manifestToolNames.filter(
                (name: string) => !hasToolContract(name)
            );

            if (missingContracts.length > 0) {
                console.error('Missing contracts for tools:', missingContracts);
            }

            expect(missingContracts).toEqual([]);
        });

        it('should have all registry tools defined in package.json', () => {
            const manifestToolNames = new Set(
                manifestTools.map((t: { name: string }) => t.name)
            );
            const registryToolNames = Array.from(ToolContractRegistry.keys());

            const missingInManifest = registryToolNames.filter(
                (name) => !manifestToolNames.has(name)
            );

            if (missingInManifest.length > 0) {
                console.error('Tools in registry but not in package.json:', missingInManifest);
            }

            expect(missingInManifest).toEqual([]);
        });

        it('should have exactly 29 tools registered', () => {
            expect(ToolContractRegistry.size).toBe(29);
        });
    });

    describe('Contract Property Validation', () => {
        it('should match tool names between manifest and contracts', () => {
            for (const manifestTool of manifestTools) {
                const contract = getToolContract(manifestTool.name);
                expect(contract).toBeDefined();
                expect(contract!.name).toBe(manifestTool.name);
            }
        });

        it('should match display names between manifest and contracts', () => {
            for (const manifestTool of manifestTools) {
                const contract = getToolContract(manifestTool.name);
                expect(contract).toBeDefined();
                expect(contract!.displayName).toBe(manifestTool.displayName);
            }
        });

        it('should match tool reference names between manifest and contracts', () => {
            for (const manifestTool of manifestTools) {
                const contract = getToolContract(manifestTool.name);
                expect(contract).toBeDefined();
                expect(contract!.toolReferenceName).toBe(manifestTool.toolReferenceName);
            }
        });

        it('should have matching tags between manifest and contracts', () => {
            const mismatches: Array<{name: string, manifest: string[], contract: string[]}> = [];
            
            for (const manifestTool of manifestTools) {
                const contract = getToolContract(manifestTool.name);
                expect(contract).toBeDefined();

                const manifestTags = new Set(manifestTool.tags || []);
                const contractTags = new Set(contract!.tags);

                // Check for mismatch and collect info
                const mArr = (Array.from(manifestTags) as string[]).sort();
                const cArr = (Array.from(contractTags) as string[]).sort();
                if (JSON.stringify(mArr) !== JSON.stringify(cArr)) {
                    mismatches.push({
                        name: manifestTool.name,
                        manifest: mArr,
                        contract: cArr
                    });
                }
            }
            
            // Log all mismatches before asserting
            if (mismatches.length > 0) {
                console.log('Tag mismatches found:');
                for (const m of mismatches) {
                    console.log(`  ${m.name}:`);
                    console.log(`    manifest: [${m.manifest.join(', ')}]`);
                    console.log(`    contract: [${m.contract.join(', ')}]`);
                }
            }
            
            // Now assert
            expect(mismatches).toEqual([]);
        });
    });

    describe('Input Schema Validation', () => {
        it('should validate SchemaTool input correctly', () => {
            const contract = SchemaToolContract;

            // Valid input with SQL
            const validInput = { sql: 'SELECT * FROM users' };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);
            if (validResult.success) {
                expect(validResult.data.sql).toBe('SELECT * FROM users');
            }

            // Valid empty input
            const emptyInput = {};
            const emptyResult = contract.validateInput(emptyInput);
            expect(emptyResult.success).toBe(true);

            // Invalid input type
            const invalidInput = { sql: 123 };
            const invalidResult = contract.validateInput(invalidInput);
            expect(invalidResult.success).toBe(false);
        });

        it('should validate ColumnsTool input correctly', () => {
            const contract = ColumnsToolContract;

            // Valid input
            const validInput = { tables: ['users', 'orders'], database: 'production' };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);
            if (validResult.success) {
                expect(validResult.data.tables).toEqual(['users', 'orders']);
                expect(validResult.data.database).toBe('production');
            }

            // Missing required field
            const invalidInput = { database: 'production' };
            const invalidResult = contract.validateInput(invalidInput);
            expect(invalidResult.success).toBe(false);
        });

        it('should validate TablesTool input correctly', () => {
            const contract = TablesToolContract;

            // Valid input with all fields
            const validInput = { database: 'test', schema: 'public' };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);

            // Valid empty input
            const emptyInput = {};
            const emptyResult = contract.validateInput(emptyInput);
            expect(emptyResult.success).toBe(true);
        });

        it('should validate ExecuteQueryTool input correctly', () => {
            const contract = ExecuteQueryToolContract;

            // Valid input
            const validInput = { sql: 'SELECT 1', database: 'test', maxRows: 100 };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);

            // Missing required SQL
            const invalidInput = { database: 'test' };
            const invalidResult = contract.validateInput(invalidInput);
            expect(invalidResult.success).toBe(false);

            // Invalid SQL (no keywords)
            const badSqlInput = { sql: 'not valid sql' };
            const badSqlResult = contract.validateInput(badSqlInput);
            expect(badSqlResult.success).toBe(false);
        });

        it('should validate SearchSchemaTool input using manifest keys', () => {
            const contract = SearchSchemaToolContract;

            const validInput = { searchTerm: 'CUSTOMER', objectType: 'TABLE', database: 'TESTDB' };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);
            if (validResult.success) {
                expect(validResult.data.searchTerm).toBe('CUSTOMER');
                expect(validResult.data.objectType).toBe('TABLE');
                expect(validResult.data.database).toBe('TESTDB');
            }

            const invalidInput = { objectType: 'TABLE' };
            const invalidResult = contract.validateInput(invalidInput);
            expect(invalidResult.success).toBe(false);
        });

        it('should validate ExportQueryResultsTool optional format and timeoutSeconds', () => {
            const contract = ExportQueryResultsToolContract;

            const validInput = { source: 'sql', timeoutSeconds: 120 };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);
            if (validResult.success) {
                expect(validResult.data.format).toBe('csv');
                expect(validResult.data.timeoutSeconds).toBe(120);
            }
        });

        it('should validate FavoritesTool supported modes and profileNames', () => {
            const contract = FavoritesToolContract;

            const validInput = { mode: 'summary', profileNames: ['My Query'] };
            const validResult = contract.validateInput(validInput);
            expect(validResult.success).toBe(true);

            const legacyModeInput = { mode: 'list' };
            const legacyModeResult = contract.validateInput(legacyModeInput);
            expect(legacyModeResult.success).toBe(true);
            if (legacyModeResult.success) {
                expect(legacyModeResult.data.mode).toBe('summary');
            }
        });

        it('should allow Validate SQL tools without sql input', () => {
            const parserContract = ValidateSqlToolContract;
            const parserResult = parserContract.validateInput({});
            expect(parserResult.success).toBe(true);

            const dbContract = ValidateSqlOnDatabaseToolContract;
            const dbResult = dbContract.validateInput({ database: 'TESTDB' });
            expect(dbResult.success).toBe(true);
        });

        it('should allow TuningAdviceTool input without sql', () => {
            const contract = TuningAdviceToolContract;
            const result = contract.validateInput({ database: 'TESTDB' });
            expect(result.success).toBe(true);
        });
    });

    describe('Output Schema Validation (AI-02 Compliance)', () => {
        it('should validate correct ToolOutput structure', () => {
            const contract = SchemaToolContract;

            const validOutput = {
                summary: 'Successfully retrieved schema',
                data: 'CREATE TABLE users (id INT)',
                errors: []
            };

            const result = contract.validateOutput(validOutput);
            expect(result.success).toBe(true);
        });

        it('should reject output without summary', () => {
            const contract = SchemaToolContract;

            const invalidOutput = {
                data: 'some data',
                errors: []
            };

            const result = contract.validateOutput(invalidOutput);
            expect(result.success).toBe(false);
        });

        it('should reject output without errors array', () => {
            const contract = SchemaToolContract;

            const invalidOutput = {
                summary: 'Test',
                data: 'some data'
            };

            const result = contract.validateOutput(invalidOutput);
            expect(result.success).toBe(false);
        });

        it('should reject output without data field', () => {
            const contract = SchemaToolContract;
            const invalidOutput = {
                summary: 'Test',
                errors: []
            };

            const result = contract.validateOutput(invalidOutput);
            expect(result.success).toBe(false);
        });

        it('should accept output with errors', () => {
            const contract = SchemaToolContract;

            const outputWithErrors = {
                summary: 'Operation failed',
                data: null,
                errors: [
                    {
                        code: 'TOOL-CONN-001',
                        type: 'connection',
                        message: 'No active connection'
                    }
                ]
            };

            const result = contract.validateOutput(outputWithErrors);
            expect(result.success).toBe(true);
        });
    });

    describe('Contract Registry Functions', () => {
        it('getToolContract should return contract for existing tool', () => {
            const contract = getToolContract('netezza_get_sql_schema');
            expect(contract).toBeDefined();
            expect(contract!.name).toBe('netezza_get_sql_schema');
        });

        it('getToolContract should return undefined for non-existing tool', () => {
            const contract = getToolContract('non_existent_tool');
            expect(contract).toBeUndefined();
        });

        it('hasToolContract should return true for existing tool', () => {
            expect(hasToolContract('netezza_get_columns')).toBe(true);
        });

        it('hasToolContract should return false for non-existing tool', () => {
            expect(hasToolContract('non_existent_tool')).toBe(false);
        });

        it('getAllToolContracts should return all 26 contracts', () => {
            const contracts = getAllToolContracts();
            expect(contracts).toHaveLength(29);
        });
    });

    describe('Contract Metadata Validation', () => {
        it('every contract should have required metadata fields', () => {
            const contracts = getAllToolContracts();

            for (const contract of contracts) {
                expect(contract.name).toBeTruthy();
                expect(contract.displayName).toBeTruthy();
                expect(contract.description).toBeTruthy();
                expect(contract.toolReferenceName).toBeTruthy();
                expect(contract.tags).toBeInstanceOf(Array);
                expect(contract.tags.length).toBeGreaterThan(0);
                expect(typeof contract.requiresConnection).toBe('boolean');
                expect(contract.errorCodes).toBeDefined();
            }
        });

        it('every contract should have validateInput function', () => {
            const contracts = getAllToolContracts();

            for (const contract of contracts) {
                expect(typeof contract.validateInput).toBe('function');
            }
        });

        it('every contract should have validateOutput function', () => {
            const contracts = getAllToolContracts();

            for (const contract of contracts) {
                expect(typeof contract.validateOutput).toBe('function');
            }
        });
    });

    describe('Connection Requirements Validation', () => {
        it('should correctly identify tools requiring connection', () => {
            const connectionTools = [
                'netezza_get_sql_schema',
                'netezza_get_columns',
                'netezza_execute_query',
                'netezza_explain_plan'
            ];

            for (const toolName of connectionTools) {
                const contract = getToolContract(toolName);
                expect(contract).toBeDefined();
                expect(contract!.requiresConnection).toBe(true);
            }
        });

        it('should correctly identify tools not requiring connection', () => {
            const noConnectionTools = [
                'netezza_validate_sql',
                'netezza_get_sql_diagnostics',
                'netezza_inspect_import_file',
                'netezza_get_favorites'
            ];

            for (const toolName of noConnectionTools) {
                const contract = getToolContract(toolName);
                expect(contract).toBeDefined();
                expect(contract!.requiresConnection).toBe(false);
            }
        });
    });
});
