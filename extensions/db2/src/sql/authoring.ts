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
import { db2SqlQualityRules } from './qualityRules';

const DB2_COMPLETION_KEYWORD_OVERLAYS = [
	'FUNCTION',
	'TRIGGER',
	'ALIAS',
	'INDEX',
	'IDENTITY',
	'GENERATED',
	'ALWAYS',
	'BY DEFAULT',
	'FETCH FIRST',
	'OPTIMIZE FOR',
	'FOR READ ONLY',
	'FOR UPDATE',
	'WITH UR',
	'WITH CS',
	'WITH RS',
	'WITH RR',
	'FINAL TABLE',
	'DECLARE GLOBAL TEMPORARY',
	'ORGANIZE BY',
	'DATA CAPTURE',
	'LANGUAGE SQL',
	'HAVING',
	'CURRENT SCHEMA',
	'CURRENT SERVER',
	'CURRENT DATE',
	'CURRENT TIME',
	'CURRENT TIMESTAMP',
	'CURRENT USER',
	'ORDER BY',
	'GROUP BY',
] as const;

const DB2_COMPLETION_KEYWORDS = mergeUniqueStrings(
	BASE_SQL_COMPLETION_KEYWORDS,
	DB2_COMPLETION_KEYWORD_OVERLAYS,
);

const DB2_BUILTIN_FUNCTION_OVERLAYS = new Set<string>([
	'CAST',
	'CHAR',
	'CURRENT DATE',
	'CURRENT TIME',
	'CURRENT TIMESTAMP',
	'CURRENT USER',
	'DECIMAL',
	'HEX',
	'INTEGER',
	'LOCATE',
	'POSSTR',
	'VARCHAR',
	'VALUE',
	'XMLSERIALIZE',
]);

const DB2_SPECIAL_BUILTIN_VALUE_OVERLAYS = new Set<string>([
	'NULL',
	'CURRENT DATE',
	'CURRENT TIME',
	'CURRENT TIMESTAMP',
	'CURRENT USER',
	'CURRENT SCHEMA',
	'CURRENT SERVER',
]);

const DB2_TYPE_SPECS: Readonly<Record<string, DatabaseSqlTypeSpec>> = {
	SMALLINT: { canonical: 'SMALLINT', paramsMin: 0, paramsMax: 0 },
	INTEGER: { canonical: 'INTEGER', paramsMin: 0, paramsMax: 0 },
	BIGINT: { canonical: 'BIGINT', paramsMin: 0, paramsMax: 0 },
	DECIMAL: { canonical: 'DECIMAL', paramsMin: 1, paramsMax: 2 },
	NUMERIC: { canonical: 'NUMERIC', paramsMin: 1, paramsMax: 2 },
	DECFLOAT: { canonical: 'DECFLOAT', paramsMin: 0, paramsMax: 1 },
	REAL: { canonical: 'REAL', paramsMin: 0, paramsMax: 0 },
	DOUBLE: { canonical: 'DOUBLE', paramsMin: 0, paramsMax: 0 },
	CHAR: { canonical: 'CHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	VARCHAR: { canonical: 'VARCHAR', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	GRAPHIC: { canonical: 'GRAPHIC', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	VARGRAPHIC: { canonical: 'VARGRAPHIC', paramsMin: 1, paramsMax: 1, warnIfNoLength: true },
	CLOB: { canonical: 'CLOB', paramsMin: 0, paramsMax: 1 },
	BLOB: { canonical: 'BLOB', paramsMin: 0, paramsMax: 1 },
	XML: { canonical: 'XML', paramsMin: 0, paramsMax: 0 },
	DATE: { canonical: 'DATE', paramsMin: 0, paramsMax: 0 },
	TIME: { canonical: 'TIME', paramsMin: 0, paramsMax: 0 },
	TIMESTAMP: { canonical: 'TIMESTAMP', paramsMin: 0, paramsMax: 1 },
};

const DB2_SIGNATURE_OVERLAYS = new Map<string, readonly DatabaseSqlFunctionSignature[]>([
	[
		'COUNT',
		[
			{
				name: 'COUNT',
				parameters: ['expression'],
				description: 'Returns the number of non-null values for the expression.',
			},
		],
	],
	[
		'COALESCE',
		[
			{
				name: 'COALESCE',
				parameters: ['value1', 'value2', '...'],
				description: 'Returns the first non-null argument.',
			},
		],
	],
	[
		'CONCAT',
		[
			{
				name: 'CONCAT',
				parameters: ['left', 'right'],
				description: 'Concatenates two string expressions.',
			},
		],
	],
	[
		'VARCHAR',
		[
			{
				name: 'VARCHAR',
				parameters: ['expression', 'length?'],
				description: 'Casts or truncates an expression to VARCHAR.',
			},
		],
	],
]);

const db2FormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
	keywords: DB2_COMPLETION_KEYWORD_OVERLAYS,
	clauseKeywords: ['GROUP BY', 'ORDER BY', 'FETCH FIRST', 'WITH UR', 'WITH CS', 'OPTIMIZE FOR'],
	newlineBeforeKeywords: ['GROUP BY', 'ORDER BY', 'FETCH FIRST', 'WITH UR', 'WITH CS', 'OPTIMIZE FOR'],
});

const db2ValidationProfile: DatabaseSqlValidationProfile = {
	builtinFunctions: mergeStringSets(BASE_SQL_BUILTIN_FUNCTIONS, DB2_BUILTIN_FUNCTION_OVERLAYS),
	systemColumns: new Set(),
	specialBuiltinValues: mergeStringSets(BASE_SQL_SPECIAL_BUILTIN_VALUES, DB2_SPECIAL_BUILTIN_VALUE_OVERLAYS),
	getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined {
		if (!typeName) {
			return undefined;
		}
		const normalized = typeName.trim().toUpperCase();
		if (DB2_TYPE_SPECS[normalized]) {
			return DB2_TYPE_SPECS[normalized];
		}
		// Catalog / FORMAT_TYPE style names (e.g. "INTEGER", "CHARACTER VARYING(100)").
		const base = normalized.replace(/\s*\(.*\)$/, '').trim();
		if (base === 'CHARACTER VARYING' || base === 'CHARACTER') {
			return DB2_TYPE_SPECS.VARCHAR;
		}
		if (base === 'INT') {
			return DB2_TYPE_SPECS.INTEGER;
		}
		return DB2_TYPE_SPECS[base];
	},
	supportsProcedureAnySizeArgument(): boolean {
		return false;
	},
	syntaxValidationMode: 'strict',
};

export const db2SqlAuthoring: DatabaseSqlAuthoring = {
	completionKeywords: DB2_COMPLETION_KEYWORDS,
	signatures: mergeFunctionSignatures(BASE_SQL_FUNCTION_SIGNATURES, DB2_SIGNATURE_OVERLAYS),
	formatter: db2FormatterProfile,
	validation: db2ValidationProfile,
	qualityRules: db2SqlQualityRules,
	parsing: {
		lexerModulePath: 'src/dialects/db2/sql/lexer.ts',
		parserModulePath: 'src/dialects/db2/sql/parser.ts',
	},
	staticAssets: {
		snippetsPath: 'dialects/db2/snippets/db2.code-snippets',
		grammarPath: 'dialects/db2/syntaxes/db2.tmLanguage.json',
		grammarScopeName: 'db2.injection',
	},
};
