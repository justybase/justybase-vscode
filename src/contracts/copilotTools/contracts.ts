/**
 * CQ-03: Central contract definitions dla Copilot Tools
 * Single Source of Truth dla wszystkich narzędzi
 */

import {
    ToolContract,
    ToolOutput,
    CommonErrorCodes,
    ValidationResult,
    ValidationError
} from './types';

import {
    requiredString,
    optionalString,
    requiredStringArray,
    optionalStringArray,
    optionalBoolean,
    optionalNumber,
    enumValidator,
    sqlString,
    netezzaObjectName
} from './validators';

/**
 * ============================================
 * INPUT INTERFACES (migracja z istniejących tools)
 * ============================================
 */

/** SchemaTool input */
export interface ISchemaToolInput {
    sql?: string;
}

/** ColumnsTool input */
export interface IColumnsToolInput {
    tables: string[];
    database?: string;
}

/** TablesTool input */
export interface ITablesToolInput {
    database?: string;
    schema?: string;
}

/** ExplainPlanTool input */
export interface IExplainPlanToolInput {
    sql: string;
    database?: string;
    verbose?: boolean;
}

/** TuningAdviceTool input */
export interface ITuningAdviceToolInput {
    sql?: string;
    database?: string;
}

/** SearchSchemaTool input */
export interface ISearchSchemaToolInput {
    searchTerm?: string;
    pattern?: string;
    objectType?:
    | 'TABLE'
    | 'TABLES'
    | 'VIEW'
    | 'PROCEDURE'
    | 'FUNCTION'
    | 'AGGREGATE'
    | 'SYNONYM'
    | 'EXTERNAL TABLE'
    | 'COLUMN'
    | 'COLUMNS'
    | 'ALL';
    searchType?: 'table' | 'tables' | 'column' | 'columns' | 'all';
    database?: string;
}

/** TableStatsTool input */
export interface ITableStatsToolInput {
    tableName: string;
    database?: string;
}

/** DependenciesTool input */
export interface IDependenciesToolInput {
    objectName?: string;
    object?: string;
    objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE';
    database?: string;
}

/** GetDDLTool input */
export interface IGetDDLToolInput {
    objectName: string;
    objectType: 'table' | 'view' | 'procedure' | 'external table' | 'synonym' | 'nickname' | 'alias';
    database?: string;
    schema?: string;
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

/** GetSqlDiagnosticsTool input */
export interface IGetSqlDiagnosticsToolInput {
    includeWarnings?: boolean;
}

/** DatabasesTool input */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IDatabasesToolInput {
    // No parameters required
}

/** SchemasTool input */
export interface ISchemasToolInput {
    database?: string;
}

/** ViewsTool input */
export interface IViewsToolInput {
    database?: string;
    schema?: string;
}

/** ProceduresTool input */
export interface IProceduresToolInput {
    database?: string;
    schema?: string;
}

/** ExternalTablesTool input */
export interface IExternalTablesToolInput {
    database?: string;
    schema?: string;
}

/** FindTableLocationsTool input */
export interface IFindTableLocationsToolInput {
    tableName: string;
    sql?: string;
}

/** GetCommentsTool input */
export interface IGetCommentsToolInput {
    tableName: string;
    database?: string;
    schema?: string;
    includeColumns?: boolean;
}

/** FavoritesTool input */
export interface IFavoritesToolInput {
    mode?: 'full' | 'summary' | 'content' | 'list' | 'include_now';
    includeNowProfileId?: string;
    profileNames?: string[];
}

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

/**
 * ============================================
 * VALIDATION FUNCTIONS
 * ============================================
 */

/** Validates SchemaTool input */
function validateSchemaToolInput(input: unknown): ValidationResult<ISchemaToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = optionalString(obj.sql, 'sql');

    if (!sqlResult.success) {
        return sqlResult as ValidationResult<ISchemaToolInput>;
    }

    return { success: true, data: { sql: sqlResult.data } };
}

/** Validates ColumnsTool input */
function validateColumnsToolInput(input: unknown): ValidationResult<IColumnsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const tablesResult = requiredStringArray(obj.tables, 'tables');
    const databaseResult = optionalString(obj.database, 'database');

    const errors: ValidationError[] = [];
    if (!tablesResult.success) errors.push(...tablesResult.errors);
    if (!databaseResult.success) errors.push(...databaseResult.errors);

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            tables: (tablesResult as { success: true; data: string[] }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates TablesTool input */
function validateTablesToolInput(input: unknown): ValidationResult<ITablesToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');

    const errors = [...(databaseResult.success ? [] : databaseResult.errors), ...(schemaResult.success ? [] : schemaResult.errors)];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            database: (databaseResult as { success: true; data: string | undefined }).data,
            schema: (schemaResult as { success: true; data: string | undefined }).data
        }
    };
}



/** Validates ExplainPlanTool input */
function validateExplainPlanToolInput(input: unknown): ValidationResult<IExplainPlanToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = sqlString(obj.sql, 'sql');
    const databaseResult = optionalString(obj.database, 'database');
    const verboseResult = optionalBoolean(obj.verbose, 'verbose');

    const errors = [
        ...(sqlResult.success ? [] : sqlResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors),
        ...(verboseResult.success ? [] : verboseResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            sql: (sqlResult as { success: true; data: string }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data,
            verbose: (verboseResult as { success: true; data: boolean | undefined }).data
        }
    };
}

/** Validates TuningAdviceTool input */
function validateTuningAdviceToolInput(input: unknown): ValidationResult<ITuningAdviceToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = optionalString(obj.sql, 'sql');
    const databaseResult = optionalString(obj.database, 'database');

    const errors = [
        ...(sqlResult.success ? [] : sqlResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    const sql = (sqlResult as { success: true; data: string | undefined }).data;
    if (sql && sql.trim().length > 0) {
        const sqlValidationResult = sqlString(sql, 'sql');
        if (!sqlValidationResult.success) {
            return sqlValidationResult as ValidationResult<ITuningAdviceToolInput>;
        }
    }

    return {
        success: true,
        data: {
            sql,
            database: (databaseResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates SearchSchemaTool input */
function validateSearchSchemaToolInput(input: unknown): ValidationResult<ISearchSchemaToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const searchTermRaw = obj.searchTerm ?? obj.pattern;
    const searchTermResult = requiredString(searchTermRaw, 'searchTerm');
    const searchTypeAlias =
        typeof obj.searchType === 'string'
            ? obj.searchType.toUpperCase() === 'TABLE'
                ? 'TABLES'
                : obj.searchType.toUpperCase() === 'COLUMN'
                    ? 'COLUMNS'
                    : obj.searchType.toUpperCase()
            : undefined;
    const objectTypeRaw = obj.objectType ?? searchTypeAlias;
    const normalizedObjectType =
        typeof objectTypeRaw === 'string'
            ? objectTypeRaw.toUpperCase() === 'COLUMN'
                ? 'COLUMNS'
                : objectTypeRaw.toUpperCase()
            : objectTypeRaw;
    const objectTypeResult = normalizedObjectType !== undefined
        ? enumValidator(
            ['TABLE', 'TABLES', 'VIEW', 'PROCEDURE', 'FUNCTION', 'AGGREGATE', 'SYNONYM', 'EXTERNAL TABLE', 'COLUMNS', 'ALL'] as const,
            normalizedObjectType,
            'objectType'
        )
        : { success: true as const, data: 'ALL' as const };
    const databaseResult = optionalString(obj.database, 'database');

    const errors = [
        ...(searchTermResult.success ? [] : searchTermResult.errors),
        ...(objectTypeResult.success ? [] : objectTypeResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            searchTerm: (searchTermResult as { success: true; data: string }).data,
            objectType: (objectTypeResult as { success: true; data: 'TABLE' | 'TABLES' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'AGGREGATE' | 'SYNONYM' | 'EXTERNAL TABLE' | 'COLUMNS' | 'ALL' }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates TableStatsTool input */
function validateTableStatsToolInput(input: unknown): ValidationResult<ITableStatsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const tableNameResult = netezzaObjectName(obj.tableName, 'tableName');
    const databaseResult = optionalString(obj.database, 'database');

    const errors = [
        ...(tableNameResult.success ? [] : tableNameResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            tableName: (tableNameResult as { success: true; data: string }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates GetDDLTool input */
function validateGetDDLToolInput(input: unknown): ValidationResult<IGetDDLToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const objectNameResult = netezzaObjectName(obj.objectName, 'objectName');
    const objectTypeResult = enumValidator(
        ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'] as const,
        obj.objectType,
        'objectType'
    );
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');

    const errors = [
        ...(objectNameResult.success ? [] : objectNameResult.errors),
        ...(objectTypeResult.success ? [] : objectTypeResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors),
        ...(schemaResult.success ? [] : schemaResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            objectName: (objectNameResult as { success: true; data: string }).data,
            objectType: (objectTypeResult as {
                success: true;
                data: 'table' | 'view' | 'procedure' | 'external table' | 'synonym' | 'nickname' | 'alias';
            }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data,
            schema: (schemaResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates ValidateSqlTool input */
function validateValidateSqlToolInput(input: unknown): ValidationResult<IValidateSqlToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const sqlResult = optionalString(obj.sql, 'sql');
    if (!sqlResult.success) {
        return sqlResult as ValidationResult<IValidateSqlToolInput>;
    }

    const sql = sqlResult.data;
    if (sql && sql.trim().length > 0) {
        const sqlValidationResult = sqlString(sql, 'sql');
        if (!sqlValidationResult.success) {
            return sqlValidationResult as ValidationResult<IValidateSqlToolInput>;
        }
    }

    return { success: true, data: { sql } };
}

/** Validates ValidateSqlOnDatabaseTool input */
function validateValidateSqlOnDatabaseToolInput(input: unknown): ValidationResult<IValidateSqlOnDatabaseToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }

    const obj = input as Record<string, unknown>;
    const sqlValidationResult = validateValidateSqlToolInput(input);
    const databaseResult = optionalString(obj.database, 'database');

    if (!sqlValidationResult.success) {
        return sqlValidationResult as ValidationResult<IValidateSqlOnDatabaseToolInput>;
    }
    if (!databaseResult.success) {
        return databaseResult as ValidationResult<IValidateSqlOnDatabaseToolInput>;
    }

    return {
        success: true,
        data: {
            sql: sqlValidationResult.data.sql,
            database: databaseResult.data
        }
    };
}

/** Validates GetSqlDiagnosticsTool input */
function validateGetSqlDiagnosticsToolInput(input: unknown): ValidationResult<IGetSqlDiagnosticsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const includeWarningsResult = optionalBoolean(obj.includeWarnings, 'includeWarnings');

    if (!includeWarningsResult.success) {
        return includeWarningsResult as ValidationResult<IGetSqlDiagnosticsToolInput>;
    }

    return { success: true, data: { includeWarnings: includeWarningsResult.data } };
}

/** Validates DatabasesTool input (always valid) */
function validateDatabasesToolInput(_input: unknown): ValidationResult<IDatabasesToolInput> {
    return { success: true, data: {} };
}

/** Validates SchemasTool input */
function validateSchemasToolInput(input: unknown): ValidationResult<ISchemasToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const databaseResult = optionalString(obj.database, 'database');

    if (!databaseResult.success) {
        return databaseResult as ValidationResult<ISchemasToolInput>;
    }

    return { success: true, data: { database: databaseResult.data } };
}

/** Validates ViewsTool input */
function validateViewsToolInput(input: unknown): ValidationResult<IViewsToolInput> {
    return validateTablesToolInput(input) as ValidationResult<IViewsToolInput>;
}

/** Validates ProceduresTool input */
function validateProceduresToolInput(input: unknown): ValidationResult<IProceduresToolInput> {
    return validateTablesToolInput(input) as ValidationResult<IProceduresToolInput>;
}

/** Validates ExternalTablesTool input */
function validateExternalTablesToolInput(input: unknown): ValidationResult<IExternalTablesToolInput> {
    return validateTablesToolInput(input) as ValidationResult<IExternalTablesToolInput>;
}

/** Validates FindTableLocationsTool input */
function validateFindTableLocationsToolInput(input: unknown): ValidationResult<IFindTableLocationsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const tableNameResult = netezzaObjectName(obj.tableName, 'tableName');
    const sqlResult = optionalString(obj.sql, 'sql');

    const errors = [
        ...(tableNameResult.success ? [] : tableNameResult.errors),
        ...(sqlResult.success ? [] : sqlResult.errors)
    ];
    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            tableName: (tableNameResult as { success: true; data: string }).data,
            sql: (sqlResult as { success: true; data: string | undefined }).data
        }
    };
}

/** Validates GetCommentsTool input */
function validateGetCommentsToolInput(input: unknown): ValidationResult<IGetCommentsToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const tableNameResult = netezzaObjectName(obj.tableName, 'tableName');
    const databaseResult = optionalString(obj.database, 'database');
    const schemaResult = optionalString(obj.schema, 'schema');
    const includeColumnsResult = optionalBoolean(obj.includeColumns, 'includeColumns');

    const errors = [
        ...(tableNameResult.success ? [] : tableNameResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors),
        ...(schemaResult.success ? [] : schemaResult.errors),
        ...(includeColumnsResult.success ? [] : includeColumnsResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            tableName: (tableNameResult as { success: true; data: string }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data,
            schema: (schemaResult as { success: true; data: string | undefined }).data,
            includeColumns: (includeColumnsResult as { success: true; data: boolean | undefined }).data
        }
    };
}

/** Validates FavoritesTool input */
function validateFavoritesToolInput(input: unknown): ValidationResult<IFavoritesToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const normalizedMode =
        obj.mode === 'list' || obj.mode === 'include_now'
            ? 'summary'
            : obj.mode;
    const modeResult = normalizedMode !== undefined
        ? enumValidator(['full', 'summary', 'content'] as const, normalizedMode, 'mode')
        : { success: true as const, data: 'summary' as const };
    const includeNowProfileIdResult = optionalString(obj.includeNowProfileId, 'includeNowProfileId');
    const profileNamesResult = optionalStringArray(obj.profileNames, 'profileNames');

    const errors = [
        ...(modeResult.success ? [] : modeResult.errors),
        ...(includeNowProfileIdResult.success ? [] : includeNowProfileIdResult.errors),
        ...(profileNamesResult.success ? [] : profileNamesResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            mode: (modeResult as { success: true; data: 'full' | 'summary' | 'content' }).data,
            includeNowProfileId: (includeNowProfileIdResult as { success: true; data: string | undefined }).data,
            profileNames: (profileNamesResult as { success: true; data: string[] | undefined }).data
        }
    };
}

/** Validates InspectImportFileTool input */
function validateInspectImportFileToolInput(input: unknown): ValidationResult<IInspectImportFileToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const filePathResult = requiredString(obj.filePath, 'filePath');
    const sampleRowsResult = optionalNumber(obj.sampleRows, 'sampleRows');

    const errors = [
        ...(filePathResult.success ? [] : filePathResult.errors),
        ...(sampleRowsResult.success ? [] : sampleRowsResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            filePath: (filePathResult as { success: true; data: string }).data,
            sampleRows: (sampleRowsResult as { success: true; data: number | undefined }).data
        }
    };
}

/** Validates ProposeImportMappingTool input */
function validateProposeImportMappingToolInput(input: unknown): ValidationResult<IProposeImportMappingToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const filePathResult = requiredString(obj.filePath, 'filePath');
    const targetTableResult = requiredString(obj.targetTable, 'targetTable');

    const errors = [
        ...(filePathResult.success ? [] : filePathResult.errors),
        ...(targetTableResult.success ? [] : targetTableResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            filePath: (filePathResult as { success: true; data: string }).data,
            targetTable: (targetTableResult as { success: true; data: string }).data
        }
    };
}



/** Validates DependenciesTool input */
function validateDependenciesToolInput(input: unknown): ValidationResult<IDependenciesToolInput> {
    if (typeof input !== 'object' || input === null) {
        return { success: false, errors: [{ field: 'input', message: 'Input must be an object', code: 'INVALID_TYPE' }] };
    }
    const obj = input as Record<string, unknown>;
    const objectNameRaw = obj.objectName ?? obj.object;
    const objectNameResult = netezzaObjectName(objectNameRaw, 'objectName');
    const objectTypeResult = enumValidator(['TABLE', 'VIEW', 'PROCEDURE'] as const, obj.objectType, 'objectType');
    const databaseResult = optionalString(obj.database, 'database');

    const errors = [
        ...(objectNameResult.success ? [] : objectNameResult.errors),
        ...(objectTypeResult.success ? [] : objectTypeResult.errors),
        ...(databaseResult.success ? [] : databaseResult.errors)
    ];

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: {
            objectName: (objectNameResult as { success: true; data: string }).data,
            objectType: (objectTypeResult as { success: true; data: 'TABLE' | 'VIEW' | 'PROCEDURE' }).data,
            database: (databaseResult as { success: true; data: string | undefined }).data
        }
    };
}




/** Validates ToolOutput structure */
function validateToolOutput<T>(output: unknown): ValidationResult<ToolOutput<T>> {
    if (typeof output !== 'object' || output === null) {
        return { success: false, errors: [{ field: 'output', message: 'Output must be an object', code: 'INVALID_TYPE' }] };
    }

    const obj = output as Record<string, unknown>;

    // Sprawdź wymagane pola
    if (typeof obj.summary !== 'string') {
        return { success: false, errors: [{ field: 'summary', message: 'summary must be a string', code: 'INVALID_TYPE' }] };
    }

    if (!Array.isArray(obj.errors)) {
        return { success: false, errors: [{ field: 'errors', message: 'errors must be an array', code: 'INVALID_TYPE' }] };
    }
    if (!Object.prototype.hasOwnProperty.call(obj, 'data')) {
        return { success: false, errors: [{ field: 'data', message: 'data field is required', code: 'REQUIRED' }] };
    }

    // Sprawdź czy errors są poprawne
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

/**
 * ============================================
 * CONTRACT DEFINITIONS
 * ============================================
 */

const commonErrorCodes = {
    [CommonErrorCodes.INVALID_INPUT]: { message: 'Invalid input parameters', type: 'validation' as const },
    [CommonErrorCodes.MISSING_REQUIRED_FIELD]: { message: 'Required field is missing', type: 'validation' as const },
    [CommonErrorCodes.INVALID_TYPE]: { message: 'Invalid type for field', type: 'validation' as const },
    [CommonErrorCodes.NO_CONNECTION]: { message: 'No active database connection', type: 'connection' as const },
    [CommonErrorCodes.EXECUTION_FAILED]: { message: 'Operation execution failed', type: 'execution' as const }
};

/** SchemaTool Contract */
export const SchemaToolContract: ToolContract<ISchemaToolInput, string> = {
    name: 'netezza_get_sql_schema',
    displayName: 'Get SQL Schema',
    description: 'Gets table schema (DDL) for tables referenced in the current SQL file',
    toolReferenceName: 'schema',
    validateInput: validateSchemaToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'schema', 'netezza', 'ddl']
};

/** ColumnsTool Contract */
export const ColumnsToolContract: ToolContract<IColumnsToolInput, string> = {
    name: 'netezza_get_columns',
    displayName: 'Get Table Columns',
    description: 'Gets column definitions for specified tables from the connected Netezza database',
    toolReferenceName: 'getColumns',
    validateInput: validateColumnsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'columns', 'netezza', 'metadata']
};

/** TablesTool Contract */
export const TablesToolContract: ToolContract<ITablesToolInput, string> = {
    name: 'netezza_get_tables',
    displayName: 'Get Tables List',
    description: 'Gets list of tables from a database or all databases in connected Netezza server',
    toolReferenceName: 'getTables',
    validateInput: validateTablesToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'tables', 'netezza', 'metadata']
};



/** ExplainPlanTool Contract */
export const ExplainPlanToolContract: ToolContract<IExplainPlanToolInput, string> = {
    name: 'netezza_explain_plan',
    displayName: 'Get Explain Plan',
    description: 'Gets query execution plan with cost analysis and optimization hints',
    toolReferenceName: 'explainPlan',
    validateInput: validateExplainPlanToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'performance', 'netezza', 'explain']
};

/** TuningAdviceTool Contract */
export const TuningAdviceToolContract: ToolContract<ITuningAdviceToolInput, string> = {
    name: 'netezza_get_tuning_advice',
    displayName: 'Get Tuning Advice',
    description: 'Analyzes SQL and provides Netezza-specific performance recommendations',
    toolReferenceName: 'getTuningAdvice',
    validateInput: validateTuningAdviceToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'performance', 'netezza', 'tuning']
};

/** SearchSchemaTool Contract */
export const SearchSchemaToolContract: ToolContract<ISearchSchemaToolInput, string> = {
    name: 'netezza_search_schema',
    displayName: 'Search Schema Objects',
    description: 'Finds tables/columns by pattern in the database',
    toolReferenceName: 'searchSchema',
    validateInput: validateSearchSchemaToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'search', 'netezza', 'metadata']
};

/** TableStatsTool Contract */
export const TableStatsToolContract: ToolContract<ITableStatsToolInput, string> = {
    name: 'netezza_get_table_stats',
    displayName: 'Get Table Statistics',
    description: 'Gets row count, skew, distribution info for a table',
    toolReferenceName: 'getTableStats',
    validateInput: validateTableStatsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'statistics', 'netezza', 'table']
};

/** DependenciesTool Contract */
export const DependenciesToolContract: ToolContract<IDependenciesToolInput, string> = {
    name: 'netezza_get_dependencies',
    displayName: 'Get Object Dependencies',
    description: 'Performs best-effort dependency lookup for database objects',
    toolReferenceName: 'getDependencies',
    validateInput: validateDependenciesToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'dependencies', 'netezza', 'metadata']
};

/** GetDDLTool Contract */
export const GetDDLToolContract: ToolContract<IGetDDLToolInput, string> = {
    name: 'netezza_get_ddl',
    displayName: 'Get DDL',
    description: 'Gets the DDL (CREATE statement) for a table, view, procedure, nickname, or alias',
    toolReferenceName: 'getDDL',
    validateInput: validateGetDDLToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'ddl', 'netezza', 'definition', 'create', 'table', 'view', 'procedure', 'nickname', 'alias']
};

/** ValidateSqlTool Contract */
export const ValidateSqlToolContract: ToolContract<IValidateSqlToolInput, string> = {
    name: 'netezza_validate_sql',
    displayName: 'Validate SQL (Parser)',
    description: 'Validates SQL syntax using the parser without executing',
    toolReferenceName: 'validateSqlParser',
    validateInput: validateValidateSqlToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['netezza', 'parser', 'sql', 'syntax', 'validation']
};

/** ValidateSqlOnDatabaseTool Contract */
export const ValidateSqlOnDatabaseToolContract: ToolContract<IValidateSqlOnDatabaseToolInput, string> = {
    name: 'netezza_validate_sql_on_database',
    displayName: 'Validate SQL on Database',
    description: 'Validates SQL on the database using EXPLAIN',
    toolReferenceName: 'validateSqlOnDatabase',
    validateInput: validateValidateSqlOnDatabaseToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['database', 'explain', 'netezza', 'runtime', 'sql', 'validation']
};

/** GetSqlDiagnosticsTool Contract */
export const GetSqlDiagnosticsToolContract: ToolContract<IGetSqlDiagnosticsToolInput, string> = {
    name: 'netezza_get_sql_diagnostics',
    displayName: 'Get SQL Diagnostics',
    description: 'Reads current SQL diagnostics with issue codes',
    toolReferenceName: 'getSqlDiagnostics',
    validateInput: validateGetSqlDiagnosticsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['diagnostics', 'linter', 'netezza', 'sql', 'validation']
};

/** DatabasesTool Contract */
export const DatabasesToolContract: ToolContract<IDatabasesToolInput, string> = {
    name: 'netezza_get_databases',
    displayName: 'Get Databases List',
    description: 'Gets list of databases from the connected Netezza server',
    toolReferenceName: 'getDatabases',
    validateInput: validateDatabasesToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'netezza', 'metadata']
};

/** SchemasTool Contract */
export const SchemasToolContract: ToolContract<ISchemasToolInput, string> = {
    name: 'netezza_get_schemas',
    displayName: 'Get Schemas List',
    description: 'Gets list of schemas from a database',
    toolReferenceName: 'getSchemas',
    validateInput: validateSchemasToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'schemas', 'netezza', 'metadata']
};

/** ViewsTool Contract */
export const ViewsToolContract: ToolContract<IViewsToolInput, string> = {
    name: 'netezza_get_views',
    displayName: 'Get Views List',
    description: 'Gets list of views from a database',
    toolReferenceName: 'getViews',
    validateInput: validateViewsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'views', 'netezza', 'metadata']
};

/** ProceduresTool Contract */
export const ProceduresToolContract: ToolContract<IProceduresToolInput, string> = {
    name: 'netezza_get_procedures',
    displayName: 'Get Procedures List',
    description: 'Gets list of stored procedures from a database',
    toolReferenceName: 'getProcedures',
    validateInput: validateProceduresToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'procedures', 'netezza', 'metadata']
};

/** ExternalTablesTool Contract */
export const ExternalTablesToolContract: ToolContract<IExternalTablesToolInput, string> = {
    name: 'netezza_get_external_tables',
    displayName: 'Get External Tables List',
    description: 'Gets list of external tables from a database',
    toolReferenceName: 'getExternalTables',
    validateInput: validateExternalTablesToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'external-tables', 'netezza', 'metadata']
};

/** FindTableLocationsTool Contract */
export const FindTableLocationsToolContract: ToolContract<IFindTableLocationsToolInput, string> = {
    name: 'netezza_find_table_locations',
    displayName: 'Find Table Locations in SQL',
    description: 'Finds which database/schema contains a table',
    toolReferenceName: 'findTableLocations',
    validateInput: validateFindTableLocationsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['analysis', 'database', 'netezza', 'sql']
};

/** GetCommentsTool Contract */
export const GetCommentsToolContract: ToolContract<IGetCommentsToolInput, string> = {
    name: 'netezza_get_comments',
    displayName: 'Get Table/Column Comments',
    description: 'Gets comments for tables and columns',
    toolReferenceName: 'getComments',
    validateInput: validateGetCommentsToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['sql', 'database', 'comments', 'netezza', 'metadata']
};

/** FavoritesTool Contract */
export const FavoritesToolContract: ToolContract<IFavoritesToolInput, string> = {
    name: 'netezza_get_favorites',
    displayName: 'Get Favorites',
    description: 'Lists workspace-curated table profiles and favorites',
    toolReferenceName: 'favorites',
    validateInput: validateFavoritesToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['context', 'copilot', 'favorites', 'snippets', 'sql', 'tables', 'ulubione']
};

/** InspectImportFileTool Contract */
export const InspectImportFileToolContract: ToolContract<IInspectImportFileToolInput, string> = {
    name: 'netezza_inspect_import_file',
    displayName: 'Inspect Import File',
    description: 'Inspects file and infers delimiter, types, sample rows',
    toolReferenceName: 'inspectImportFile',
    validateInput: validateInspectImportFileToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: false,
    tags: ['file', 'import', 'netezza', 'preview', 'schema']
};

/** ProposeImportMappingTool Contract */
export const ProposeImportMappingToolContract: ToolContract<IProposeImportMappingToolInput, string> = {
    name: 'netezza_propose_import_mapping',
    displayName: 'Propose Import Mapping',
    description: 'Proposes source→target mapping and CREATE SQL for import',
    toolReferenceName: 'proposeImportMapping',
    validateInput: validateProposeImportMappingToolInput,
    validateOutput: validateToolOutput,
    errorCodes: commonErrorCodes,
    requiresConnection: true,
    tags: ['ddl', 'import', 'mapping', 'netezza', 'schema']
};






/** Registry wszystkich kontraktów */
export const ToolContractRegistry: Map<string, ToolContract<unknown, unknown>> = new Map([
    [SchemaToolContract.name, SchemaToolContract],
    [ColumnsToolContract.name, ColumnsToolContract],
    [TablesToolContract.name, TablesToolContract],
    [ExplainPlanToolContract.name, ExplainPlanToolContract],
    [TuningAdviceToolContract.name, TuningAdviceToolContract],
    [SearchSchemaToolContract.name, SearchSchemaToolContract],
    [TableStatsToolContract.name, TableStatsToolContract],
    [DependenciesToolContract.name, DependenciesToolContract],
    [GetDDLToolContract.name, GetDDLToolContract],
    [ValidateSqlToolContract.name, ValidateSqlToolContract],
    [ValidateSqlOnDatabaseToolContract.name, ValidateSqlOnDatabaseToolContract],
    [GetSqlDiagnosticsToolContract.name, GetSqlDiagnosticsToolContract],
    [DatabasesToolContract.name, DatabasesToolContract],
    [SchemasToolContract.name, SchemasToolContract],
    [ViewsToolContract.name, ViewsToolContract],
    [ProceduresToolContract.name, ProceduresToolContract],
    [ExternalTablesToolContract.name, ExternalTablesToolContract],
    [FindTableLocationsToolContract.name, FindTableLocationsToolContract],
    [GetCommentsToolContract.name, GetCommentsToolContract],
    [FavoritesToolContract.name, FavoritesToolContract],
    [InspectImportFileToolContract.name, InspectImportFileToolContract],
    [ProposeImportMappingToolContract.name, ProposeImportMappingToolContract],
]);

/** Pobiera kontrakt po nazwie */
export function getToolContract(name: string): ToolContract<unknown, unknown> | undefined {
    return ToolContractRegistry.get(name);
}

/** Lista wszystkich zarejestrowanych tools */
export function getAllToolContracts(): ToolContract<unknown, unknown>[] {
    return Array.from(ToolContractRegistry.values());
}

/** Sprawdza czy tool o danej nazwie istnieje */
export function hasToolContract(name: string): boolean {
    return ToolContractRegistry.has(name);
}
