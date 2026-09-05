/**
 * Core stub dialect for MS SQL Server when the optional extension is not loaded.
 * Full runtime lives in extensions/mssql; SQL parsing runtime is registered from
 * src/dialects/mssql/sql via parsingRuntime.ts when authoring kind is mssql.
 */
import { createStubDialect } from '../stubDialectFactory';
import { MSSQL_UNQUOTED_IDENTIFIER_PATTERN } from '../../shared/dialect-traits/mssql';

export const mssqlDialect = createStubDialect('mssql', 'MS SQL Server', 1433, {
	supportsRawTcpTunnel: true,
	connectionFormOptions: {
		databasePlaceholder: 'Database name',
		userPlaceholder: 'SQL Server user',
	},
	traitsOverrides: {
		identifiers: {
			unquotedIdentifierPattern: MSSQL_UNQUOTED_IDENTIFIER_PATTERN,
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
