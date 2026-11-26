import { createToken, Lexer } from 'chevrotain';
import * as baseLexer from '../../netezza/sql/lexer';

/**
 * Db2 LUW lexical additions. Shared tokens are reused for SELECT/DML CST shape.
 * Multi-word phrases are listed first so they win over Identifier / WITH / FOR.
 */
export const Db2OptimizeFor = createToken({
	name: 'Db2OptimizeFor',
	pattern: /OPTIMIZE\s+FOR\b/i,
});

export const Db2WithUr = createToken({
	name: 'Db2WithUr',
	pattern: /WITH\s+UR\b/i,
});

export const Db2WithCs = createToken({
	name: 'Db2WithCs',
	pattern: /WITH\s+CS\b/i,
});

export const Db2WithRs = createToken({
	name: 'Db2WithRs',
	pattern: /WITH\s+RS\b/i,
});

export const Db2WithRr = createToken({
	name: 'Db2WithRr',
	pattern: /WITH\s+RR\b/i,
});

export const Db2ForReadOnly = createToken({
	name: 'Db2ForReadOnly',
	pattern: /FOR\s+READ\s+ONLY\b/i,
});

export const Db2ForUpdate = createToken({
	name: 'Db2ForUpdate',
	pattern: /FOR\s+UPDATE\b/i,
});

export const Db2FinalTable = createToken({
	name: 'Db2FinalTable',
	pattern: /FINAL\s+TABLE\b/i,
});

export const Db2OldTable = createToken({
	name: 'Db2OldTable',
	pattern: /OLD\s+TABLE\b/i,
});

export const Db2NewTable = createToken({
	name: 'Db2NewTable',
	pattern: /NEW\s+TABLE\b/i,
});

export const Db2ModifiedBy = createToken({
	name: 'Db2ModifiedBy',
	pattern: /MODIFIED\s+BY\b/i,
});

export const Db2DeclareGlobalTemporary = createToken({
	name: 'Db2DeclareGlobalTemporary',
	pattern: /DECLARE\s+GLOBAL\s+TEMPORARY\b/i,
});

export const Db2GeneratedAlways = createToken({
	name: 'Db2GeneratedAlways',
	pattern: /GENERATED\s+ALWAYS\b/i,
});

export const Db2GeneratedByDefault = createToken({
	name: 'Db2GeneratedByDefault',
	pattern: /GENERATED\s+BY\s+DEFAULT\b/i,
});

export const Db2Identity = createToken({
	name: 'Db2Identity',
	pattern: /IDENTITY\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2OrganizeBy = createToken({
	name: 'Db2OrganizeBy',
	pattern: /ORGANIZE\s+BY\b/i,
});

export const Db2DataCapture = createToken({
	name: 'Db2DataCapture',
	pattern: /DATA\s+CAPTURE\b/i,
});

export const Db2CurrentSchema = createToken({
	name: 'Db2CurrentSchema',
	pattern: /CURRENT\s+SCHEMA\b/i,
});

export const Db2CurrentServer = createToken({
	name: 'Db2CurrentServer',
	pattern: /CURRENT\s+SERVER\b/i,
});

export const Db2CurrentDate = createToken({
	name: 'Db2CurrentDate',
	pattern: /CURRENT\s+DATE\b/i,
});

export const Db2CurrentTime = createToken({
	name: 'Db2CurrentTime',
	pattern: /CURRENT\s+TIME\b/i,
});

export const Db2CurrentTimestamp = createToken({
	name: 'Db2CurrentTimestamp',
	pattern: /CURRENT\s+TIMESTAMP\b/i,
});

export const Db2CurrentUser = createToken({
	name: 'Db2CurrentUser',
	pattern: /CURRENT\s+USER\b/i,
});

/**
 * Settable Db2 special registers. Each register is a single token so
 * `SET CURRENT …` statements expose the register in the CST instead of
 * leaving it as an opaque command tail. The value after the register stays
 * a command tail: registers accept identifiers, string/number literals and
 * comma lists, and referencing another register (`SET CURRENT PATH = CURRENT
 * PATH, …`) must keep working.
 */
export const Db2CurrentSqlid = createToken({
	name: 'Db2CurrentSqlid',
	pattern: /CURRENT\s+SQLID\b/i,
});

export const Db2CurrentDegree = createToken({
	name: 'Db2CurrentDegree',
	pattern: /CURRENT\s+DEGREE\b/i,
});

export const Db2CurrentExplainMode = createToken({
	name: 'Db2CurrentExplainMode',
	pattern: /CURRENT\s+EXPLAIN\s+MODE\b/i,
});

export const Db2CurrentExplainSnapshot = createToken({
	name: 'Db2CurrentExplainSnapshot',
	pattern: /CURRENT\s+EXPLAIN\s+SNAPSHOT\b/i,
});

export const Db2CurrentSnapshot = createToken({
	name: 'Db2CurrentSnapshot',
	pattern: /CURRENT\s+SNAPSHOT\b/i,
});

export const Db2CurrentLockTimeout = createToken({
	name: 'Db2CurrentLockTimeout',
	pattern: /CURRENT\s+LOCK\s+TIMEOUT\b/i,
});

export const Db2CurrentRefreshAge = createToken({
	name: 'Db2CurrentRefreshAge',
	pattern: /CURRENT\s+REFRESH\s+AGE\b/i,
});

export const Db2CurrentQueryOptimization = createToken({
	name: 'Db2CurrentQueryOptimization',
	pattern: /CURRENT\s+QUERY\s+OPTIMIZATION\b/i,
});

export const Db2CurrentQueryAcceleration = createToken({
	name: 'Db2CurrentQueryAcceleration',
	pattern: /CURRENT\s+QUERY\s+ACCELERATION\b/i,
});

export const Db2CurrentPath = createToken({
	name: 'Db2CurrentPath',
	pattern: /CURRENT\s+PATH\b/i,
});

export const Db2CurrentIsolation = createToken({
	name: 'Db2CurrentIsolation',
	pattern: /CURRENT\s+ISOLATION\b/i,
});

export const Db2CurrentMaintainedTableTypes = createToken({
	name: 'Db2CurrentMaintainedTableTypes',
	pattern: /CURRENT\s+MAINTAINED\s+TABLE\s+TYPES\s+FOR\s+OPTIMIZATION\b/i,
});

export const Db2CurrentDecfloatRoundingMode = createToken({
	name: 'Db2CurrentDecfloatRoundingMode',
	pattern: /CURRENT\s+DECFLOAT\s+ROUNDING\s+MODE\b/i,
});

export const Db2CurrentApplicationCompatibility = createToken({
	name: 'Db2CurrentApplicationCompatibility',
	pattern: /CURRENT\s+APPLICATION\s+COMPATIBILITY\b/i,
});

export const Db2CurrentPackagePath = createToken({
	name: 'Db2CurrentPackagePath',
	pattern: /CURRENT\s+PACKAGE\s+PATH\b/i,
});

export const Db2CurrentDefaultTransformGroup = createToken({
	name: 'Db2CurrentDefaultTransformGroup',
	pattern: /CURRENT\s+DEFAULT\s+TRANSFORM\s+GROUP\b/i,
});

export const Db2CurrentOptimizationProfile = createToken({
	name: 'Db2CurrentOptimizationProfile',
	pattern: /CURRENT\s+OPTIMIZATION\s+PROFILE\b/i,
});

export const Db2CurrentFederatedAsynchrony = createToken({
	name: 'Db2CurrentFederatedAsynchrony',
	pattern: /CURRENT\s+FEDERATED\s+ASYNCHRONY\b/i,
});

export const Db2CurrentImplicitXmlparseOption = createToken({
	name: 'Db2CurrentImplicitXmlparseOption',
	pattern: /CURRENT\s+IMPLICIT\s+XMLPARSE\s+OPTION\b/i,
});

export const Db2CurrentTemporalSystemTime = createToken({
	name: 'Db2CurrentTemporalSystemTime',
	pattern: /CURRENT\s+TEMPORAL\s+SYSTEM_TIME\b/i,
});

export const Db2CurrentTemporalBusinessTime = createToken({
	name: 'Db2CurrentTemporalBusinessTime',
	pattern: /CURRENT\s+TEMPORAL\s+BUSINESS_TIME\b/i,
});

export const Db2LanguageSql = createToken({
	name: 'Db2LanguageSql',
	pattern: /LANGUAGE\s+SQL\b/i,
});

export const Db2Nickname = createToken({
	name: 'Db2Nickname',
	pattern: /NICKNAME\b/i,
	longer_alt: baseLexer.Identifier,
});

/**
 * Command-leading Db2 words that must not be `Identifier` in the statement
 * FIRST set. `identifier` accepts most Db2 keywords, so a statement
 * alternative that starts with `Identifier` gives Chevrotain a huge
 * first-set overlap and parser self-analysis becomes quadratic.
 */
export const Db2RenameTable = createToken({
	name: 'Db2RenameTable',
	pattern: /RENAME\s+TABLE\b/i,
});

export const Db2LabelOn = createToken({
	name: 'Db2LabelOn',
	pattern: /LABEL\s+ON\b/i,
});

export const Db2Reorg = createToken({
	name: 'Db2Reorg',
	pattern: /REORG\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2Runstats = createToken({
	name: 'Db2Runstats',
	pattern: /RUNSTATS\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2Export = createToken({
	name: 'Db2Export',
	pattern: /EXPORT\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2Import = createToken({
	name: 'Db2Import',
	pattern: /IMPORT\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2Index = createToken({
	name: 'Db2Index',
	pattern: /INDEX\b/i,
	longer_alt: baseLexer.Identifier,
});

export const Db2Trigger = createToken({
	name: 'Db2Trigger',
	pattern: /TRIGGER\b/i,
	longer_alt: baseLexer.Identifier,
});

const db2OnlyTokens = [
	Db2OptimizeFor,
	Db2WithUr,
	Db2WithCs,
	Db2WithRs,
	Db2WithRr,
	Db2ForReadOnly,
	Db2ForUpdate,
	Db2FinalTable,
	Db2OldTable,
	Db2NewTable,
	Db2ModifiedBy,
	Db2DeclareGlobalTemporary,
	Db2GeneratedAlways,
	Db2GeneratedByDefault,
	Db2OrganizeBy,
	Db2DataCapture,
	Db2CurrentSchema,
	Db2CurrentServer,
	Db2CurrentDate,
	Db2CurrentTime,
	Db2CurrentTimestamp,
	Db2CurrentUser,
	Db2CurrentSqlid,
	Db2CurrentDegree,
	Db2CurrentExplainMode,
	Db2CurrentExplainSnapshot,
	Db2CurrentSnapshot,
	Db2CurrentLockTimeout,
	Db2CurrentRefreshAge,
	Db2CurrentQueryOptimization,
	Db2CurrentQueryAcceleration,
	Db2CurrentPath,
	Db2CurrentIsolation,
	Db2CurrentMaintainedTableTypes,
	Db2CurrentDecfloatRoundingMode,
	Db2CurrentApplicationCompatibility,
	Db2CurrentPackagePath,
	Db2CurrentDefaultTransformGroup,
	Db2CurrentOptimizationProfile,
	Db2CurrentFederatedAsynchrony,
	Db2CurrentImplicitXmlparseOption,
	Db2CurrentTemporalSystemTime,
	Db2CurrentTemporalBusinessTime,
	Db2LanguageSql,
	Db2Nickname,
	Db2Identity,
	Db2RenameTable,
	Db2LabelOn,
	Db2Reorg,
	Db2Runstats,
	Db2Export,
	Db2Import,
	Db2Index,
	Db2Trigger,
];

const db2AllTokens = [...db2OnlyTokens, ...baseLexer.allTokens];

export const SqlLexer = new Lexer(db2AllTokens);

export * from '../../netezza/sql/lexer';
