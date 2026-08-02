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

const statementEnd = createStatementEndScanner();
const identifier = createIdentifierPattern();

/** Prefer an explicit projection over SELECT * in production Db2 SQL. */
export const ruleDB2001: LintRule = createSelectStarRule({
	id: 'DB2001',
	name: 'Select Star',
	description:
		'Avoid SELECT * in production Db2 queries when a stable projection is possible.',
	defaultSeverity: LintSeverity.Warning,
	selectStarPattern: /\bSELECT\s+\*/gi,
});

/** DELETE without WHERE removes every row. */
export const ruleDB2002: LintRule = createDeleteWithoutWhereRule({
	id: 'DB2002',
	name: 'Delete Without Where',
	description: 'DELETE without WHERE removes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	statementEnd,
	targetPattern: createDeleteFromPattern(identifier),
});

/** UPDATE without WHERE updates every row. */
export const ruleDB2003: LintRule = createUpdateWithoutWhereRule({
	id: 'DB2003',
	name: 'Update Without Where',
	description: 'UPDATE without WHERE changes every row in the target table.',
	defaultSeverity: LintSeverity.Error,
	statementEnd,
	targetPattern: createUpdateSetPattern(identifier),
});

/** Netezza-only GROOM is not valid Db2 SQL. */
export const ruleDB2004: LintRule = createKeywordRule({
	id: 'DB2004',
	name: 'Netezza Groom',
	description: 'GROOM is Netezza-only; use RUNSTATS / REORG on Db2 LUW instead.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bGROOM\b/gi,
});

/** Netezza DISTRIBUTE ON is not valid Db2 table DDL. */
export const ruleDB2005: LintRule = createKeywordRule({
	id: 'DB2005',
	name: 'Netezza Distribute On',
	description:
		'DISTRIBUTE ON is Netezza-only; use DISTRIBUTE BY HASH / ORGANIZE BY on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bDISTRIBUTE\s+ON\b/gi,
});

/** FETCH FIRST / OPTIMIZE FOR without ORDER BY yields non-deterministic top-N. */
export const ruleDB2006: LintRule = createTopNWithoutOrderByRule({
	id: 'DB2006',
	name: 'Top-N Without Order By',
	description:
		'FETCH FIRST / OPTIMIZE FOR without ORDER BY in the same SELECT can return non-deterministic rows; add ORDER BY for stable top-N.',
	defaultSeverity: LintSeverity.Warning,
	statementEnd,
	topNPattern: /\b(?:FETCH\s+(?:FIRST|NEXT)|OPTIMIZE\s+FOR)\b/gi,
});

/** Netezza LIMIT is not valid Db2 SQL — use FETCH FIRST. */
export const ruleDB2007: LintRule = createKeywordRule({
	id: 'DB2007',
	name: 'Netezza Limit',
	description: 'LIMIT is Netezza-only; use FETCH FIRST n ROWS ONLY on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
	keywordPattern: /\bLIMIT\s+\d+/gi,
});

/** Netezza DB..TABLE notation is not valid on Db2 LUW. */
export const ruleDB2008: LintRule = createDoubleDotTableRule({
	id: 'DB2008',
	name: 'Netezza Double-Dot Table',
	description:
		'DB..TABLE is Netezza-only; use SCHEMA.TABLE or CURRENT SCHEMA on Db2 LUW.',
	defaultSeverity: LintSeverity.Error,
});

export const db2SqlQualityRules: readonly LintRule[] = [
	ruleDB2001,
	ruleDB2002,
	ruleDB2003,
	ruleDB2004,
	ruleDB2005,
	ruleDB2006,
	ruleDB2007,
	ruleDB2008,
];
