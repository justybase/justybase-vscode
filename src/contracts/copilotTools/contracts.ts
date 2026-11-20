/**
 * Central contract definitions for JustyBase AI tools.
 *
 * The contract layer is the single source of truth for tool input validation.
 * Runtime tool classes mirror the input interfaces in
 * `src/services/copilotTools/*Tool.ts`, and package.json mirrors the catalog
 * through `contributes.languageModelTools`.
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

const OBJECT_SECTIONS = ['ddl', 'columns', 'comments', 'stats', 'constraints', 'dependencies'] as const;
const OBJECT_TYPES = ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'] as const;
const CATALOG_KINDS = ['databases', 'schemas', 'tables', 'views', 'procedures', 'external_tables', 'columns', 'all'] as const;
const VALIDATION_MODES = ['parser', 'database'] as const;

/** GetContextTool input */
export interface IGetContextToolInput {
    sql?: string;
    includeSchema?: boolean;
    includeDiagnostics?: boolean;
}

/** SearchCatalogTool input */
export interface ISearchCatalogToolInput {
    kind: typeof CATALOG_KINDS[number];
    query?: string;
    database?: string;
    schema?: string;
}

/** GetObjectTool input */
export interface IGetObjectToolInput {
    object: string;
    objectType?: typeof OBJECT_TYPES[number];
    database?: string;
    schema?: string;
    sections?: typeof OBJECT_SECTIONS[number][];
}

/** ExplainQueryTool input */
export interface IExplainQueryToolInput {
    sql: string;
    database?: string;
    verbose?: boolean;
    analyze?: boolean;
}

/** ValidateSqlTool input */
export interface IValidateSqlToolInput {
    sql: string;
    mode?: typeof VALIDATION_MODES[number];
    database?: string;
}

/** ExecuteSqlTool input */
export interface IExecuteSqlToolInput {
    sql: string;
    maxRows?: number;
    timeoutMs?: number;
    database?: string;
    confirm?: string;
}

/** DropObjectTool input */
export interface IDropObjectToolInput {
    object: string;
    objectType: typeof OBJECT_TYPES[number];
    cascade?: boolean;
    database?: string;
    confirm: string;
}

/** CompileProcedureTool input */
export type ICompileProcedureToolInput = ProcedureRepairInput;

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

/** GetReferenceTool input */
export interface IGetReferenceToolInput {
    topic?: 'optimization' | 'nzplsql' | 'all';
}

function invalidInput(): ValidationResult<never> {
    return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
}

function collectErrors(...results: ValidationResult<unknown>[]): ValidationError[] {
    return results.flatMap(result => result.success ? [] : result.errors);
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
        return { success: false, errors: collectErrors(sqlResult, includeSchemaResult, includeDiagnosticsResult) };
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
    const kindResult = obj.kind === undefined
        ? { success: true as const, data: 'tables' as const }
        : enumValidator(CATALOG_KINDS, obj.kind, 'kind');
    const queryResult = optionalString(obj.query, 'query');
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');

    if (!kindResult.success || !queryResult.success || !databaseResult.success || !schemaResult.success) {
        return {
            success: false,
            errors: collectErrors(kindResult, queryResult, databaseResult, schemaResult)
        };
    }

    const errors: ValidationError[] = [];
    if ((kindResult.data === 'columns' || kindResult.data === 'all')
        && (!queryResult.data || queryResult.data.trim().length === 0)) {
        errors.push({ field: 'query', message: `query is required when kind is "${kindResult.data}"`, code: 'REQUIRED' });
    }
    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            kind: kindResult.data,
            query: queryResult.data,
            database: databaseResult.data,
            schema: schemaResult.data
        }
    };
}

function validateGetObjectToolInput(input: unknown): ValidationResult<IGetObjectToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const objectResult = requiredString(obj.object, 'object');
    const objectTypeResult = obj.objectType === undefined
        ? { success: true as const, data: 'table' as const }
        : enumValidator(OBJECT_TYPES, obj.objectType, 'objectType');
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');
    const sectionsResult = optionalStringArray(obj.sections, 'sections');

    const errors: ValidationError[] = collectErrors(
        objectResult,
        objectTypeResult,
        databaseResult,
        schemaResult,
        sectionsResult
    );

    let sections: typeof OBJECT_SECTIONS[number][] = ['ddl', 'columns'];
    if (sectionsResult.success && sectionsResult.data !== undefined) {
        sections = [];
        for (const section of sectionsResult.data) {
            if (!(OBJECT_SECTIONS as readonly string[]).includes(section)) {
                errors.push({
                    field: 'sections',
                    message: `Unsupported section "${section}". Allowed: ${OBJECT_SECTIONS.join(', ')}`,
                    code: 'INVALID_VALUE'
                });
            } else {
                sections.push(section as typeof OBJECT_SECTIONS[number]);
            }
        }
    }

    if (errors.length > 0 || !objectResult.success || !objectTypeResult.success) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            object: objectResult.data,
            objectType: objectTypeResult.data,
            database: databaseResult.success ? databaseResult.data : undefined,
            schema: schemaResult.success ? schemaResult.data : undefined,
            sections
        }
    };
}

function validateExplainQueryToolInput(input: unknown): ValidationResult<IExplainQueryToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = sqlString(obj.sql, 'sql');
    const databaseResult = optionalString(obj.database, 'database');
    const verboseResult = optionalBoolean(obj.verbose, 'verbose');
    const analyzeResult = optionalBoolean(obj.analyze, 'analyze');

    if (!sqlResult.success || !databaseResult.success || !verboseResult.success || !analyzeResult.success) {
        return { success: false, errors: collectErrors(sqlResult, databaseResult, verboseResult, analyzeResult) };
    }

    return {
        success: true,
        data: {
            sql: sqlResult.data,
            database: databaseResult.data,
            verbose: verboseResult.data,
            analyze: analyzeResult.data
        }
    };
}

function validateValidateSqlToolInput(input: unknown): ValidationResult<IValidateSqlToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = sqlString(obj.sql, 'sql');
    const modeResult = obj.mode === undefined
        ? { success: true as const, data: 'parser' as const }
        : enumValidator(VALIDATION_MODES, obj.mode, 'mode');
    const databaseResult = optionalString(obj.database, 'database');

    if (!sqlResult.success || !modeResult.success || !databaseResult.success) {
        return { success: false, errors: collectErrors(sqlResult, modeResult, databaseResult) };
    }

    return {
        success: true,
        data: {
            sql: sqlResult.data,
            mode: modeResult.data,
            database: databaseResult.data
        }
    };
}

function validateExecuteSqlToolInput(input: unknown): ValidationResult<IExecuteSqlToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = sqlString(obj.sql, 'sql');
    const maxRowsResult = optionalNumber(obj.maxRows, 'maxRows');
    const timeoutResult = optionalNumber(obj.timeoutMs, 'timeoutMs');
    const databaseResult = optionalString(obj.database, 'database');
    const confirmResult = optionalString(obj.confirm, 'confirm');

    if (!sqlResult.success || !maxRowsResult.success || !timeoutResult.success
        || !databaseResult.success || !confirmResult.success) {
        return {
            success: false,
            errors: collectErrors(sqlResult, maxRowsResult, timeoutResult, databaseResult, confirmResult)
        };
    }

    return {
        success: true,
        data: {
            sql: sqlResult.data,
            maxRows: maxRowsResult.data,
            timeoutMs: timeoutResult.data,
            database: databaseResult.data,
            confirm: confirmResult.data
        }
    };
}

function validateDropObjectToolInput(input: unknown): ValidationResult<IDropObjectToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }
    const obj = input as Record<string, unknown>;
    const objectResult = requiredString(obj.object, 'object');
    const objectTypeResult = enumValidator(OBJECT_TYPES, obj.objectType, 'objectType');
    const cascadeResult = optionalBoolean(obj.cascade, 'cascade');
    const databaseResult = optionalString(obj.database, 'database');
    const confirmResult = requiredString(obj.confirm, 'confirm');

    if (!objectResult.success || !objectTypeResult.success || !cascadeResult.success
        || !databaseResult.success || !confirmResult.success) {
        return {
            success: false,
            errors: collectErrors(objectResult, objectTypeResult, cascadeResult, databaseResult, confirmResult)
        };
    }

    return {
        success: true,
        data: {
            object: objectResult.data,
            objectType: objectTypeResult.data,
            cascade: cascadeResult.data,
            database: databaseResult.data,
            confirm: confirmResult.data
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
        return { success: false, errors: collectErrors(filePathResult, sampleRowsResult) };
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
        return { success: false, errors: collectErrors(filePathResult, targetTableResult) };
    }

    return {
        success: true,
        data: {
            filePath: filePathResult.data,
            targetTable: targetTableResult.data
        }
    };
}

function validateGetReferenceToolInput(input: unknown): ValidationResult<IGetReferenceToolInput> {
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

function validateCompileProcedureToolInput(input: unknown): ValidationResult<ICompileProcedureToolInput> {
    if (typeof input !== 'object' || input === null) {
        return invalidInput();
    }

    const obj = input as Record<string, unknown>;
    const modeResult = enumValidator(['compile_only', 'compile_and_call'] as const, obj.mode, 'mode');
    const sqlResult = optionalString(obj.sql, 'sql');
    const errors: ValidationError[] = collectErrors(modeResult, sqlResult);

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
    description: 'Searches databases, schemas, tables, views, procedures, external tables, columns, or all objects',
    toolReferenceName: 'searchCatalog',
    validateInput: validateSearchCatalogToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['catalog', 'database', 'metadata', 'netezza', 'search']
};

export const GetObjectToolContract: ToolContract<IGetObjectToolInput, string> = {
    name: 'netezza_get_object',
    displayName: 'Get Object Details',
    description: 'Returns DDL, columns, comments, statistics, constraints, or dependencies for a database object',
    toolReferenceName: 'getObject',
    validateInput: validateGetObjectToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['catalog', 'ddl', 'metadata', 'netezza', 'object']
};

export const ExplainQueryToolContract: ToolContract<IExplainQueryToolInput, string> = {
    name: 'netezza_explain_query',
    displayName: 'Explain Query',
    description: 'Runs a read-only EXPLAIN and returns plan structure, hotspots, risk, and raw plan',
    toolReferenceName: 'explainQuery',
    validateInput: validateExplainQueryToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['explain', 'netezza', 'performance', 'sql']
};

export const ValidateSqlToolContract: ToolContract<IValidateSqlToolInput, string> = {
    name: 'netezza_validate_sql',
    displayName: 'Validate SQL',
    description: 'Validates SQL with the offline parser or a read-only database EXPLAIN',
    toolReferenceName: 'validateSql',
    validateInput: validateValidateSqlToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['diagnostics', 'netezza', 'sql', 'validation']
};

export const ExecuteSqlToolContract: ToolContract<IExecuteSqlToolInput, string> = {
    name: 'netezza_execute_sql',
    displayName: 'Execute SQL',
    description: 'Executes one SQL statement; write and destructive access is policy-gated',
    toolReferenceName: 'executeSql',
    validateInput: validateExecuteSqlToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['database', 'netezza', 'sql', 'write']
};

export const DropObjectToolContract: ToolContract<IDropObjectToolInput, string> = {
    name: 'netezza_drop_object',
    displayName: 'Drop Object',
    description: 'Drops one database object after an explicit confirmation value',
    toolReferenceName: 'dropObject',
    validateInput: validateDropObjectToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['database', 'destructive', 'netezza']
};

export const CompileProcedureToolContract: ToolContract<ICompileProcedureToolInput, string> = {
    name: 'netezza_compile_procedure',
    displayName: 'Compile Procedure',
    description: 'Compiles a procedure and optionally runs a user-confirmed typed test CALL with a bounded repair loop',
    toolReferenceName: 'compileProcedure',
    validateInput: validateCompileProcedureToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['ddl', 'netezza', 'nzplsql', 'procedure']
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
    tags: ['file', 'import', 'netezza']
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
    tags: ['ddl', 'import', 'mapping', 'netezza']
};

export const GetReferenceToolContract: ToolContract<IGetReferenceToolInput, string> = {
    name: 'netezza_get_reference',
    displayName: 'Get Dialect Reference',
    description: 'Returns JustyBase Netezza SQL, optimization, or NZPLSQL reference guidance',
    toolReferenceName: 'getDialectReference',
    validateInput: validateGetReferenceToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['documentation', 'netezza', 'reference']
};

/** Registry of all tool contracts. */
export const ToolContractRegistry: Map<string, ToolContract<unknown, unknown>> = new Map();
ToolContractRegistry.set(GetContextToolContract.name, GetContextToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(SearchCatalogToolContract.name, SearchCatalogToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(GetObjectToolContract.name, GetObjectToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(ExplainQueryToolContract.name, ExplainQueryToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(ValidateSqlToolContract.name, ValidateSqlToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(ExecuteSqlToolContract.name, ExecuteSqlToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(DropObjectToolContract.name, DropObjectToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(CompileProcedureToolContract.name, CompileProcedureToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(InspectImportFileToolContract.name, InspectImportFileToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(ProposeImportMappingToolContract.name, ProposeImportMappingToolContract as ToolContract<unknown, unknown>);
ToolContractRegistry.set(GetReferenceToolContract.name, GetReferenceToolContract as ToolContract<unknown, unknown>);

export function getToolContract(name: string): ToolContract<unknown, unknown> | undefined {
    return ToolContractRegistry.get(name);
}

export function hasToolContract(name: string): boolean {
    return ToolContractRegistry.has(name);
}

export function getAllToolContracts(): ToolContract<unknown, unknown>[] {
    return Array.from(ToolContractRegistry.values());
}
