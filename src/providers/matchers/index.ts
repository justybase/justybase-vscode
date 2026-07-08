/**
 * Barrel exports for completion/matchers module
 */

export {
    matchJoinOn,
    matchFromJoinPartial,
    isMultiLineFromJoin,
    matchDatabase,
    matchSchema,
    matchDoubleDot,
    matchColumnQualifier,
    matchColumnExpansion,
    matchVariable,
    getVariableInsertionMode
} from './patternMatchers';

export {
    findAlias,
    getTableAndAliasBeforeCursor,
    //extractCurrentStatement,
    getCurrentSqlStatementRange
} from './aliasResolver';
