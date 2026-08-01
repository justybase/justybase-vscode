/**
 * Core stub dialect for MS SQL Server when the optional extension is not loaded.
 * Full runtime lives in extensions/mssql; SQL parsing runtime is registered from
 * src/dialects/mssql/sql via parsingRuntime.ts when authoring kind is mssql.
 */
import { createStubDialect } from '../stubDialectFactory';

export const mssqlDialect = createStubDialect('mssql', 'MS SQL Server', 1433, {
	extensionDisplayName: 'MSSQL Tools (justybase)',
	connectionFormOptions: {
		databasePlaceholder: 'Database name',
		userPlaceholder: 'SQL Server user',
	},
	traitsOverrides: {
		identifiers: {
			generatedNameCase: 'preserve',
		},
		qualification: {
			twoPartNameStyle: 'schema-object',
		},
	},
});

export {
	createSqlParserInstance,
	getSqlParserInstance,
	MsSqlSqlParser,
	SqlParser,
} from './sql/parser';
export { SqlLexer as mssqlSqlLexer } from './sql/lexer';
