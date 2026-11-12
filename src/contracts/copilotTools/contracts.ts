/**
 * Central contract definitions for JustyBase AI tools.
 *
 * The contract layer is the single source of truth for tool input validation.
 * Runtime tool classes mirror the input interfaces in
 * `src/services/copilotTools/*Tool.ts`, and package.json mirrors the contract
 * names/tags through `languageModelTools`.
 */

import {
    ToolContract,
    ToolOutput,
    CommonErrorCodes,
    ValidationError,
    ValidationResult
} from './types';
import {
    requiredString,
    optionalString,
    optionalBoolean,
    optionalNumber,
    optionalStringArray,
    enumValidator,
    sqlString
} from './validators';
import type {
    ProcedureCallArgument,
    ProcedureRepairInput
} from './types';

const OBJECT_DETAIL_SECTIONS = ['ddl', 'columns', 'comments', 'stats', 'dependencies', 'favorites'] as const;
const OBJECT_DETAIL_TYPES = ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'] as const;
const CATALOG_OBJECT_TYPES = ['databases', 'schemas', 'tables', 'views', 'procedures', 'external tables', 'columns', 'all', 'locations'] as const;

/** GetContextTool input */
export interface IGetContextToolInput {
    sql?: string;
    includeSchema?: boolean;
    includeDiagnostics?: boolean;
}

/** SearchCatalogTool input */
export interface ISearchCatalogToolInput {
    objectType?: typeof CATALOG_OBJECT_TYPES[number];
    pattern?: string;
    database?: string;
    schema?: string;
}

/** GetObjectDetailsTool input */
export interface IGetObjectDetailsToolInput {
    objectName?: string;
    objectType?: typeof OBJECT_DETAIL_TYPES[number];
    database?: string;
    schema?: string;
    sections?: typeof OBJECT_DETAIL_SECTIONS[number][];
}

/** ExplainSqlTool input */
export interface IExplainSqlToolInput {
    sql: string;
    database?: string;
    verbose?: boolean;
}

/** ValidateSqlTool input */
export interface IValidateSqlToolInput {
    sql?: string;
}

/** ValidateSqlOnDatabaseTool input */
export interface IValidateSqlOnDatabaseToolInput {
    sql?: string;
    database?: string;
}

/** ProcedureRepairTool input */
export type IProcedureRepairToolInput = ProcedureRepairInput;

/** InspectImportFileTool input */
export interface IInspectImportFileToolInput {
    filePath: string;
    sampleRows?: number;
}

/** ProposeImportMappingTool input */
export interface IProposeImportMappingToolInput {
    filePath: string;
    targetTable: string;
}

/** NetezzaReferenceTool input */
export interface INetezzaReferenceToolInput {
    topic?: 'optimization' | 'nzplsql' | 'all';
}

function invalidInput(): ValidationResult<never> {
    return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
}

function validateGetContextToolInput(input: unknown): ValidationResult<IGetContextToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = optionalString(obj.sql, 'sql');
    const includeSchemaResult = optionalBoolean(obj.includeSchema, 'includeSchema');
    const includeDiagnosticsResult = optionalBoolean(obj.includeDiagnostics, 'includeDiagnostics');

    if (!sqlResult.success || !includeSchemaResult.success || !includeDiagnosticsResult.success) {
        return {
            success: false,
            errors: [
                ...(sqlResult.success ? [] : sqlResult.errors),
                ...(includeSchemaResult.success ? [] : includeSchemaResult.errors),
                ...(includeDiagnosticsResult.success ? [] : includeDiagnosticsResult.errors)
            ]
        };
    }

    return {
        success: true,
        data: {
            sql: sqlResult.data,
            includeSchema: includeSchemaResult.data,
            includeDiagnostics: includeDiagnosticsResult.data
        }
    };
}

function validateSearchCatalogToolInput(input: unknown): ValidationResult<ISearchCatalogToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const objectTypeResult = obj.objectType === undefined
        ? { success: true as const, data: 'tables' as const }
        : enumValidator(CATALOG_OBJECT_TYPES, obj.objectType, 'objectType');
    const patternResult = optionalString(obj.pattern, 'pattern');
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');

    if (!objectTypeResult.success || !patternResult.success || !databaseResult.success || !schemaResult.success) {
        return {
            success: false,
            errors: [
                ...(objectTypeResult.success ? [] : objectTypeResult.errors),
                ...(patternResult.success ? [] : patternResult.errors),
                ...(databaseResult.success ? [] : databaseResult.errors),
                ...(schemaResult.success ? [] : schemaResult.errors)
            ]
        };
    }

    return {
        success: true,
        data: {
            objectType: objectTypeResult.data,
            pattern: patternResult.data,
            database: databaseResult.data,
            schema: schemaResult.data
        }
    };
}

function validateGetObjectDetailsToolInput(input: unknown): ValidationResult<IGetObjectDetailsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const objectNameResult = optionalString(obj.objectName, 'objectName');
    const objectTypeResult = obj.objectType === undefined
        ? { success: true as const, data: 'table' as const }
        : enumValidator(OBJECT_DETAIL_TYPES, obj.objectType, 'objectType');
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');
    const sectionsResult = optionalStringArray(obj.sections, 'sections');

    const errors: ValidationError[] = [
        ...(objectNameResult.success ? [] : objectNameResult.errors),
        ...(objectTypeResult.success ? [] : objectTypeResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors),
        ...(schemaResult.success ? [] : schemaResult.errors),
        ...(sectionsResult.success ? [] : sectionsResult.errors)
    ];

    let sections: typeof OBJECT_DETAIL_SECTIONS[number][] = ['ddl', 'columns'];
    if (sectionsResult.success && sectionsResult.data !== undefined) {
        sections = [];
        for (const section of sectionsResult.data) {
            if (!(OBJECT_DETAIL_SECTIONS as readonly string[]).includes(section)) {
                errors.push({
                    field: 'sections',
                    message: `Unsupported section "${section}". Allowed: ${OBJECT_DETAIL_SECTIONS.join(', ')}`,
                    code: 'INVALID_VALUE'
                });
            } else {
                sections.push(section as typeof OBJECT_DETAIL_SECTIONS[number]);
            }
        }
    }

    if (errors.length > 0 || !objectNameResult.success || !objectTypeResult.success) {
        return { success: false, errors };
    }

    if (!objectNameResult.data && !sections.every(section => section === 'favorites')) {
        errors.push({
            field: 'objectName',
            message: 'objectName is required unless the only requested section is "favorites"',
            code: 'REQUIRED'
        });
    }

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            objectName: objectNameResult.data,
            objectType: objectTypeResult.data,
            database: databaseResult.success ? databaseResult.data : undefined,
            schema: schemaResult.success ? schemaResult.data : undefined,
            sections
        }
    };
}

function validateExplainSqlToolInput(input: unknown): ValidationResult<IExplainSqlToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = sqlString(obj.sql, 'sql');
    const databaseResult = optionalString(obj.database, 'database');
    const verboseResult = optionalBoolean(obj.verbose, 'verbose');

    if (!sqlResult.success || !databaseResult.success || !verboseResult.success) {
        return {
            success: false,
            errors: [
                ...(sqlResult.success ? [] : sqlResult.errors),
                ...(databaseResult.success ? [] : databaseResult.errors),
                ...(verboseResult.success ? [] : verboseResult.errors)
            ]
        };
    }

    return {
        success: true,
        data: {
            sql: sqlResult.data,
            database: databaseResult.data,
            verbose: verboseResult.data
        }
    };
}

function validateValidateSqlToolInput(input: unknown): ValidationResult<IValidateSqlToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = optionalString(obj.sql, 'sql');
    if (!sqlResult.success) {
        return { success: false, errors: sqlResult.errors };
    }

    const sql = sqlResult.data;
    if (sql && sql.trim().length > 0) {
        const sqlValidationResult = sqlString(sql, 'sql');
        if (!sqlValidationResult.success) {
            return { success: false, errors: sqlValidationResult.errors };
        }
    }

    return { success: true, data: { sql } };
}

function validateValidateSqlOnDatabaseToolInput(input: unknown): ValidationResult<IValidateSqlOnDatabaseToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlValidationResult = validateValidateSqlToolInput(input);
    const databaseResult = optionalString(obj.database, 'database');

    if (!sqlValidationResult.success) {
        return { success: false, errors: sqlValidationResult.errors };
    }
    if (!databaseResult.success) {
        return { success: false, errors: databaseResult.errors };
    }

    return {
        success: true,
        data: {
            sql: sqlValidationResult.data.sql,
            database: databaseResult.data
        }
    };
}

function validateInspectImportFileToolInput(input: unknown): ValidationResult<IInspectImportFileToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const filePathResult = requiredString(obj.filePath, 'filePath');
    const sampleRowsResult = optionalNumber(obj.sampleRows, 'sampleRows');

    if (!filePathResult.success || !sampleRowsResult.success) {
        return {
            success: false,
            errors: [
                ...(filePathResult.success ? [] : filePathResult.errors),
                ...(sampleRowsResult.success ? [] : sampleRowsResult.errors)
            ]
        };
    }

    return {
        success: true,
        data: {
            filePath: filePathResult.data,
            sampleRows: sampleRowsResult.data
        }
    };
}

function validateProposeImportMappingToolInput(input: unknown): ValidationResult<IProposeImportMappingToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const filePathResult = requiredString(obj.filePath, 'filePath');
    const targetTableResult = requiredString(obj.targetTable, 'targetTable');

    if (!filePathResult.success || !targetTableResult.success) {
        return {
            success: false,
            errors: [
                ...(filePathResult.success ? [] : filePathResult.errors),
                ...(targetTableResult.success ? [] : targetTableResult.errors)
            ]
        };
    }

    return {
        success: true,
        data: {
            filePath: filePathResult.data,
            targetTable: targetTableResult.data
        }
    };
}

function validateNetezzaReferenceToolInput(input: unknown): ValidationResult<INetezzaReferenceToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const topicResult = obj.topic === undefined
        ? { success: true as const, data: 'all' as const }
        : enumValidator(['optimization', 'nzplsql', 'all'] as const, obj.topic, 'topic');

    if (!topicResult.success) {
        return { success: false, errors: topicResult.errors };
    }

    return { success: true, data: { topic: topicResult.data } };
}

function validateProcedureRepairToolInput(input: unknown): ValidationResult<IProcedureRepairToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }

    const obj = input as Record<string, unknown>;
    const modeResult = enumValidator(['compile_only', 'compile_and_call'] as const, obj.mode, 'mode');
    const sqlResult = optionalString(obj.sql, 'sql');
    const errors: ValidationError[] = [
        ...(modeResult.success ? [] : modeResult.errors),
        ...(sqlResult.success ? [] : sqlResult.errors)
    ];

    const rawArguments = obj.callArguments;
    let callArguments: ProcedureCallArgument[] | undefined;
    if (rawArguments !== undefined) {
        if (!Array.isArray(rawArguments)) {
            errors.push({ field: 'callArguments', message: 'Field \'callArguments\' must be an array', code: 'INVALID_TYPE' });
        } else {
            callArguments = [];
            rawArguments.forEach((rawArgument, index) => {
                const argumentResult = validateProcedureCallArgument(rawArgument, `callArguments[${index}]`);
                if (!argumentResult.success) {
                    errors.push(...argumentResult.errors);
                } else {
                    callArguments!.push(argumentResult.data);
                }
            });
        }
    }

    const mode = modeResult.success ? modeResult.data : undefined;
    if (mode === 'compile_and_call' && rawArguments === undefined) {
        errors.push({
            field: 'callArguments',
            message: 'Field \'callArguments\' is required for compile_and_call (use [] for a no-argument procedure)',
            code: 'REQUIRED'
        });
    }

    if (errors.length > 0 || !modeResult.success || !sqlResult.success) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            mode: modeResult.data,
            sql: sqlResult.data,
            ...(callArguments === undefined ? {} : { callArguments })
        }
    };
}

function validateProcedureCallArgument(value: unknown, field: string): ValidationResult<ProcedureCallArgument> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { success: false, errors: [{ field, message: `${field} must be an object`, code: 'INVALID_TYPE' }] };
    }

    const argument = value as Record<string, unknown>;
    const typeResult = enumValidator(
        ['string', 'number', 'boolean', 'null', 'date', 'timestamp'] as const,
        argument.type,
        `${field}.type`
    );
    if (!typeResult.success) {
        return { success: false, errors: typeResult.errors };
    }

    const argumentType = typeResult.data;
    const argumentValue = argument.value;
    const validValue = argumentType === 'string' || argumentType === 'date' || argumentType === 'timestamp'
        ? typeof argumentValue === 'string'
        : argumentType === 'number'
            ? typeof argumentValue === 'number' && Number.isFinite(argumentValue)
            : argumentType === 'boolean'
                ? typeof argumentValue === 'boolean'
                : argumentValue === null;

    if (!validValue) {
        return {
            success: false,
            errors: [{ field: `${field}.value`, message: `${field}.value does not match type '${argumentType}'`, code: 'INVALID_TYPE' }]
        };
    }

    if (argumentType === 'date' && !/^\d{4}-\d{2}-\d{2}$/u.test(argumentValue as string)) {
        return {
            success: false,
            errors: [{ field: `${field}.value`, message: `${field}.value must use YYYY-MM-DD`, code: 'INVALID_FORMAT' }]
        };
    }

    return {
        success: true,
        data: { type: argumentType, value: argumentValue as ProcedureCallArgument['value'] }
    };
}

/** Validates the standard ToolOutput shape. */
function validateToolOutput<T>(output: unknown): ValidationResult<ToolOutput<T>> {
    if (typeof output !== 'object' || output === null) {
        return { success: false, errors: [{ field: 'output', message: 'Output must be an object', code: 'INVALID_TYPE' }] };
    }

    const obj = output as Record<string, unknown>;

    if (typeof obj.summary !== 'string') {
        return { success: false, errors: [{ field: 'summary', message: 'summary must be a string', code: 'INVALID_TYPE' }] };
    }

    if (!Array.isArray(obj.errors)) {
        return { success: false, errors: [{ field: 'errors', message: 'errors must be an array', code: 'INVALID_TYPE' }] };
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'data')) {
        return { success: false, errors: [{ field: 'data', message: 'data field is required', code: 'REQUIRED' }] };
    }

    for (let i = 0; i < obj.errors.length; i++) {
        const error = obj.errors[i];
        if (typeof error !== 'object' || error === null) {
            return { success: false, errors: [{ field: `errors[${i}]`, message: 'Each error must be an object', code: 'INVALID_TYPE' }] };
        }
        const err = error as Record<string, unknown>;
        if (typeof err.code !== 'string') {
            return { success: false, errors: [{ field: `errors[${i}].code`, message: 'Error code must be a string', code: 'INVALID_TYPE' }] };
        }
        if (typeof err.message !== 'string') {
            return { success: false, errors: [{ field: `errors[${i}].message`, message: 'Error message must be a string', code: 'INVALID_TYPE' }] };
        }
        if (
            typeof err.type !== 'string' ||
            !['validation', 'execution', 'connection', 'timeout', 'cancelled', 'not_found'].includes(err.type)
        ) {
            return {
                success: false,
                errors: [{ field: `errors[${i}].type`, message: 'Error type is invalid', code: 'INVALID_TYPE' }]
            };
        }
    }

    return { success: true, data: output as ToolOutput<T> };
}

const commonErrorCodes = {
    [CommonErrorCodes.INVALID_INPUT]: { message: 'Invalid input parameters', type: 'validation' as const },
    [CommonErrorCodes.MISSING_REQUIRED_FIELD]: { message: 'Required field is missing', type: 'validation' as const },
    [CommonErrorCodes.INVALID_TYPE]: { message: 'Invalid type for field', type: 'validation' as const },
    [CommonErrorCodes.NO_CONNECTION]: { message: 'No active database connection', type: 'connection' as const },
    [CommonErrorCodes.EXECUTION_FAILED]: { message: 'Operation execution failed', type: 'execution' as const }
};

export const GetContextToolContract: ToolContract<IGetContextToolInput, string> = {
    name: 'netezza_get_context',
    displayName: 'Get SQL Context',
    description: 'Collects active SQL, dialect, connection, referenced table DDL, and parser/linter diagnostics',
    toolReferenceName: 'getSqlContext',
    validateInput: validateGetContextToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['context', 'diagnostics', 'netezza', 'sql']
};

export const SearchCatalogToolContract: ToolContract<ISearchCatalogToolInput, string> = {
    name: 'netezza_search_catalog',
    displayName: 'Search Catalog',
    description: 'Searches databases, schemas, tables, views, procedures, external tables, columns, or table locations',
    toolReferenceName: 'searchCatalog',
    validateInput: validateSearchCatalogToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['catalog', 'database', 'metadata', 'netezza', 'search']
};

export const GetObjectDetailsToolContract: ToolContract<IGetObjectDetailsToolInput, string> = {
    name: 'netezza_get_object_details',
    displayName: 'Get Object Details',
    description: 'Returns DDL, columns, comments, statistics, dependencies, or workspace favorites for a database object',
    toolReferenceName: 'getObjectDetails',
    validateInput: validateGetObjectDetailsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['columns', 'comments', 'database', 'ddl', 'dependencies', 'metadata', 'netezza', 'statistics']
};

export const ExplainSqlToolContract: ToolContract<IExplainSqlToolInput, string> = {
    name: 'netezza_explain_sql',
    displayName: 'Explain SQL',
    description: 'Runs a read-only EXPLAIN and returns plan structure, hotspots, risk, and raw plan',
    toolReferenceName: 'explainSql',
    validateInput: validateExplainSqlToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['database', 'explain', 'netezza', 'performance', 'sql']
};

export const ValidateSqlToolContract: ToolContract<IValidateSqlToolInput, string> = {
    name: 'netezza_validate_sql',
    displayName: 'Validate SQL (Parser)',
    description: 'Validates SQL syntax using the parser without executing it',
    toolReferenceName: 'validateSqlParser',
    validateInput: validateValidateSqlToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['netezza', 'parser', 'sql', 'syntax', 'validation']
};

export const ValidateSqlOnDatabaseToolContract: ToolContract<IValidateSqlOnDatabaseToolInput, string> = {
    name: 'netezza_validate_sql_on_database',
    displayName: 'Validate SQL on Database',
    description: 'Validates SQL on the database using a read-only EXPLAIN',
    toolReferenceName: 'validateSqlOnDatabase',
    validateInput: validateValidateSqlOnDatabaseToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['database', 'explain', 'netezza', 'runtime', 'sql', 'validation']
};

export const ProcedureRepairToolContract: ToolContract<IProcedureRepairToolInput, string> = {
    name: 'netezza_repair_procedure',
    displayName: 'Repair Netezza Procedure',
    description: 'Compiles a procedure and optionally runs a user-confirmed typed test CALL with a bounded repair loop',
    toolReferenceName: 'repairProcedure',
    validateInput: validateProcedureRepairToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['compile', 'database', 'nzplsql', 'procedure', 'repair', 'sql', 'write']
};

export const InspectImportFileToolContract: ToolContract<IInspectImportFileToolInput, string> = {
    name: 'netezza_inspect_import_file',
    displayName: 'Inspect Import File',
    description: 'Inspects a file and infers delimiter, column types, and sample rows',
    toolReferenceName: 'inspectImportFile',
    validateInput: validateInspectImportFileToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['file', 'import', 'netezza', 'preview', 'schema']
};

export const ProposeImportMappingToolContract: ToolContract<IProposeImportMappingToolInput, string> = {
    name: 'netezza_propose_import_mapping',
    displayName: 'Propose Import Mapping',
    description: 'Proposes a source-to-target column mapping and CREATE SQL for import',
    toolReferenceName: 'proposeImportMapping',
    validateInput: validateProposeImportMappingToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['ddl', 'import', 'mapping', 'netezza', 'schema']
};

export const NetezzaReferenceToolContract: ToolContract<INetezzaReferenceToolInput, string> = {
    name: 'netezza_get_dialect_reference',
    displayName: 'Get Dialect Reference',
    description: 'Returns JustyBase Netezza SQL, optimization, or NZPLSQL reference guidance',
    toolReferenceName: 'getDialectReference',
    validateInput: validateNetezzaReferenceToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['netezza', 'nzplsql', 'optimization', 'reference', 'sql']
};

/** Registry of all tool contracts. */
export const ToolContractRegistry: Map<string, ToolContract<unknown, unknown>> = new Map([
    [GetContextToolContract.name, GetContextToolContract as ToolContract<unknown, unknown>],
    [SearchCatalogToolContract.name, SearchCatalogToolContract as ToolContract<unknown, unknown>],
    [GetObjectDetailsToolContract.name, GetObjectDetailsToolContract as ToolContract<unknown, unknown>],
    [ExplainSqlToolContract.name, ExplainSqlToolContract as ToolContract<unknown, unknown>],
    [ValidateSqlToolContract.name, ValidateSqlToolContract as ToolContract<unknown, unknown>],
    [ValidateSqlOnDatabaseToolContract.name, ValidateSqlOnDatabaseToolContract as ToolContract<unknown, unknown>],
    [ProcedureRepairToolContract.name, ProcedureRepairToolContract as ToolContract<unknown, unknown>],
    [InspectImportFileToolContract.name, InspectImportFileToolContract as ToolContract<unknown, unknown>],
    [ProposeImportMappingToolContract.name, ProposeImportMappingToolContract as ToolContract<unknown, unknown>],
    [NetezzaReferenceToolContract.name, NetezzaReferenceToolContract as ToolContract<unknown, unknown>]
]);

export function getToolContract(name: string): ToolContract<unknown, unknown> | undefined {
    return ToolContractRegistry.get(name);
}

export function getAllToolContracts(): ToolContract<unknown, unknown>[] {
    return Array.from(ToolContractRegistry.values());
}

export function hasToolContract(name: string): boolean {
    return ToolContractRegistry.has(name);
}
