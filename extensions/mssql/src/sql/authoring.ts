import type {
	DatabaseSqlAuthoring,
	DatabaseSqlFunctionSignature,
	DatabaseSqlTypeSpec,
	DatabaseSqlValidationProfile,
} from '../../../../src/sql/authoring/types';
import {
	BASE_SQL_BUILTIN_FUNCTIONS,
	BASE_SQL_COMPLETION_KEYWORDS,
	BASE_SQL_FORMATTER_PROFILE,
	BASE_SQL_FUNCTION_SIGNATURES,
	BASE_SQL_SPECIAL_BUILTIN_VALUES,
	extendFormatterProfile,
	mergeFunctionSignatures,
	mergeStringSets,
	mergeUniqueStrings,
} from '../../../../src/sql/authoring/baseProfiles';
import { mssqlSqlQualityRules } from './qualityRules';

const MSSQL_COMPLETION_KEYWORD_OVERLAYS = [
	'OUTPUT',
	'INDEX',
	'FUNCTION',
	'TRIGGER',
	'HAVING',
	'TOP',
	'FETCH NEXT',
	'CROSS APPLY',
	'OUTER APPLY',
	'BEGIN TRY',
	'BEGIN CATCH',
	'GO',
	'ORDER BY',
	'GROUP BY',
] as const;

const MSSQL_COMPLETION_KEYWORDS = mergeUniqueStrings(
	BASE_SQL_COMPLETION_KEYWORDS,
	MSSQL_COMPLETION_KEYWORD_OVERLAYS,
);

const MSSQL_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
	'CAST',
	'CHARINDEX',
	'CHOOSE',
	'CONVERT',
	'DATALENGTH',
	'DATEADD',
	'DATEDIFF',
	'FORMAT',
	'GETDATE',
	'IIF',
	'ISNULL',
	'LEN',
	'NEWID',
	'STRING_AGG',
	'STUFF',
	'SYSDATETIME',
]);

const MSSQL_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>(['NULL']);

const MSSQL_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
	TINYINT: { canonical: 'TINYINT', paramsMin: 0, paramsMax: 0 },
	SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
	INT: { canonical: 'INT', paramsMin: 0, paramsMax: 0 },
	BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
	NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
	DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
	REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 0 },
	FLOAT: { canonical: 'FLOAT', paramsMin: 0, paramsMax: 1 },
	BIT: { canonical: 'BIT', paramsMin: 0, paramsMax: 0 },
	CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	NCHAR: { canonical: 'NCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	NVARCHAR: { canonical: 'NVARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	TEXT: { canonical: 'TEXT', paramsMin: 0, paramsMax: 0 },
	NTEXT: { canonical: 'NTEXT', paramsMin: 0, paramsMax: 0 },
	DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
	TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 1 },
	DATETIME: { canonical: 'DATETIME', paramsMin: 0, paramsMax: 0 },
	SMALLDATETIME: { canonical: 'SMALLDATETIME', paramsMin: 0, paramsMax: 0 },
	DATETIME2: { canonical: 'DATETIME2', paramsMin: 0, paramsMax: 1 },
	DATETIMEOFFSET: { canonical: 'DATETIMEOFFSET', paramsMin: 0, paramsMax: 1 },
	MONEY: { canonical: 'MONEY', paramsMin: 0, paramsMax: 0 },
	SMALLMONEY: { canonical: 'SMALLMONEY', paramsMin: 0, paramsMax: 0 },
	BINARY: { canonical: 'BINARY', paramsMin: 1, paramsMax: 1 },
	VARBINARY: { canonical: 'VARBINARY', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	IMAGE: { canonical: 'IMAGE', paramsMin: 0, paramsMax: 0 },
	XML: { canonical: 'XML', paramsMin: 0, paramsMax: 0 },
	UNIQUEIDENTIFIER: { canonical: 'UNIQUEIDENTIFIER', paramsMin: 0, paramsMax: 0 },
	SQL_VARIANT: { canonical: 'SQL_VARIANT', paramsMin: 0, paramsMax: 0 },
};

const MSSQL_SIGNATURE_OVERLAYS = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
	[
		'COUNT',
		[{
			name: 'COUNT',
			parameters: ['expression'],
			description: 'Returns the number of items found in a group.',
		}],
	],
	[
		'ISNULL',
		[{
			name: 'ISNULL',
			parameters: ['check_expression', 'replacement_value'],
			description: 'Replaces NULL with the specified replacement value.',
		}],
	],
	[
		'GETDATE',
		[{
			name: 'GETDATE',
			parameters: [],
			description: 'Returns the current database system timestamp.',
		}],
	],
	[
		'STRING_AGG',
		[{
			name: 'STRING_AGG',
			parameters: ['expression', 'separator'],
			description: 'Concatenates string expressions and places separator values between them.',
		}],
	],
	[
		'SYSDATETIME',
		[{
			name: 'SYSDATETIME',
			parameters: [],
			description: 'Returns the current database system timestamp as datetime2.',
		}],
	],
]);

const mssqlFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
	keywords: MSSQL_COMPLETION_KEYWORD_OVERLAYS,
	clauseKeywords: ['GROUP BY', 'ORDER BY', 'OFFSET', 'FETCH NEXT', 'OUTPUT'],
	newlineBeforeKeywords: ['GROUP BY', 'ORDER BY', 'OFFSET', 'FETCH NEXT', 'OUTPUT'],
	joinModifiers: ['APPLY'],
});

const mssqlValidationProfile: DatabaseSqlValidationProfile = {
	builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, MSSQL_BUILTIN_FUNCTION_OVERLAYS),
	systemColumns: new Set([]),
	specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, MSSQL_SPECIAL_BUILTIN_VALUE_OVERLAYS),
	getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
		if (!typeName) return undefined;
		return MSSQL_TYPE_SPECS[typeName.trim().toUpperCase()];
	},
	supportsProcedureAnySizeArgument(): boolean {
		return false;
	},
	syntaxValidationMode: 'strict',
};

export const mssqlSqlAuthoring: DatabaseSqlAuthoring = {
	completionKeywords: MSSQL_COMPLETION_KEYWORDS,
	signatures: mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, MSSQL_SIGNATURE_OVERLAYS),
	formatter: mssqlFormatterProfile,
	validation: mssqlValidationProfile,
	qualityRules: mssqlSqlQualityRules,
	parsing: {
		lexerModulePath: 'src/dialects/mssql/sql/lexer.ts',
		parserModulePath: 'src/dialects/mssql/sql/parser.ts',
	},
	staticAssets: {
		snippetsPath: 'dialects/mssql/snippets/mssql.code-snippets',
		grammarPath: 'dialects/mssql/syntaxes/mssql.tmLanguage.json',
		grammarScopeName: 'mssql.injection',
	},
};
