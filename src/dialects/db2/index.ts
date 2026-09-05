/**
 * Core stub dialect for Db2 when the optional extension is not loaded.
 * Full runtime lives in extensions/db2; SQL parsing runtime is registered from
 * src/dialects/db2/sql via parsingRuntime.ts when authoring kind is db2.
 */
import { createStubDialect } from '../stubDialectFactory';

export const db2Dialect = createStubDialect('db2', 'Db2', 50000, {
	supportsRawTcpTunnel: true,
	connectionFormOptions: {
		databasePlaceholder: 'Db2 database name',
		userPlaceholder: 'Db2 user',
	},
	traitsOverrides: {
		identifiers: {
			generatedNameCase: 'upper',
		},
	},
});

export {
	createSqlParserInstance,
	getSqlParserInstance,
	Db2SqlParser,
	SqlParser,
} from './sql/parser';
export { SqlLexer as db2SqlLexer } from './sql/lexer';
