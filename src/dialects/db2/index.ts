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
	additionalConnectionFields: [
		{
			key: 'security_mechanism',
			label: 'Preferred security mechanism',
			type: 'select',
			storage: 'options',
			defaultValue: '',
			options: [
				{ value: '', label: 'Default' },
				{ value: '3', label: '3 — User ID and password' },
				{ value: '7', label: '7 — User ID and encrypted password' },
				{ value: '9', label: '9 — Encrypted user ID and password' },
			],
			description: 'Optional preference forwarded to the Db2 driver. Leave blank to use its default; the selected mechanism must be supported by the installed driver and server.',
			layout: 'half',
		},
	],
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
