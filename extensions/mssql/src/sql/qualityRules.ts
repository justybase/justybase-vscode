import { LintSeverity, type LintRule } from '../../../../src/providers/linterRules';
import {
	createDeleteFromPattern,
	createDeleteWithoutWhereRule,
	createDoubleDotTableRule,
	createIdentifierPattern,
	createKeywordRule,
	createSelectStarRule,
	createStatementEndScanner,
	createTopNWithoutOrderByRule,
	createUpdateSetPattern,
	createUpdateWithoutWhereRule,
} from '../../../../src/providers/qualityRuleFactory';

const statementEnd = createStatementEndScanner({ brackets: true });
const identifier = createIdentifierPattern({ brackets: true });

/** Prefer an explicit projection over SELECT * in production T-SQL. */
export const ruleMSS001: LintRule = createSelectStarRule({
	id: 'MSS001',
	name: 'Select Star',
	description:
		'Avoid SELECT * in production T-SQL when a stable projection is possible.',
	defaultSeverity: LintSeverity.Warning,
	selectStarPattern: /\bSELECT\s+(?:TOP\s*\([^)]*\)\s+|TOP\s+\d+\s+)?\*/gi,
});

/** DELETE without WHERE removes every row. */
export const ruleMSS002: LintRule = createDeleteWithoutWhereRule({
	id: 'MSS002',
	name: 'Delete Without Where',
	description: 'DELETE without WHERE removes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	statementEnd,
	targetPattern: createDeleteFromPattern(identifier),
});

/** UPDATE without WHERE updates every row. */
export const ruleMSS003: LintRule = createUpdateWithoutWhereRule({
	id: 'MSS003',
	name: 'Update Without Where',
	description: 'UPDATE without WHERE changes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	statementEnd,
	targetPattern: createUpdateSetPattern(identifier),
});

/** Netezza-only GROOM is not valid T-SQL. */
export const ruleMSS004: LintRule = createKeywordRule({
	id: 'MSS004',
	name: 'Netezza Groom',
	description:
		'GROOM is Netezza-only; use ALTER INDEX / maintenance plans on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bGROOM\b/gi,
});

/** Netezza DISTRIBUTE ON is not valid MSSQL DDL. */
export const ruleMSS005: LintRule = createKeywordRule({
	id: 'MSS005',
	name: 'Netezza Distribute On',
	description:
		'DISTRIBUTE ON is Netezza-only; use partitioned tables / indexes on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bDISTRIBUTE\s+ON\b/gi,
});

/** TOP / OFFSET FETCH without ORDER BY yields non-deterministic top-N. */
export const ruleMSS006: LintRule = createTopNWithoutOrderByRule({
	id: 'MSS006',
	name: 'Top-N Without Order By',
	description:
		'TOP / OFFSET FETCH without ORDER BY in the same SELECT can return non-deterministic rows; add ORDER BY for stable top-N.',
	defaultSeverity: LintSeverity.Warning,
	statementEnd,
	topNPattern: /\b(?:TOP\s*\(|TOP\s+\d+|OFFSET\s+\d+)/gi,
});

/** Netezza LIMIT is not valid T-SQL — use TOP or OFFSET/FETCH. */
export const ruleMSS007: LintRule = createKeywordRule({
	id: 'MSS007',
	name: 'Netezza Limit',
	description:
		'LIMIT is Netezza-only; use TOP or OFFSET/FETCH NEXT on SQL Server.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bLIMIT\s+\d+/gi,
});

/** Netezza DB..TABLE notation is not valid on SQL Server. */
export const ruleMSS008: LintRule = createDoubleDotTableRule({
	id: 'MSS008',
	name: 'Netezza Double-Dot Table',
	description:
		'DB..TABLE is Netezza-only; use SCHEMA.TABLE or database.schema.table on SQL Server.',
	defaultSeverity: LintSeverity.Error,
});

export const mssqlSqlQualityRules: readonly LintRule[] = [
	ruleMSS001,
	ruleMSS002,
	ruleMSS003,
	ruleMSS004,
	ruleMSS005,
	ruleMSS006,
	ruleMSS007,
	ruleMSS008,
];
