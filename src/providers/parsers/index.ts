/**
 * Barrel exports for completion/parsers module
 * Allows importing multiple parsers from a single location
 */

export { stripComments } from './commentStripper';
export { parseVariables } from './variableParser';
export { 
    parseLocalDefinitions, 
    extractBalancedParenthesisContent, 
    extractColumnsFromQuery 
} from './sqlParser';
export {
    parseSemanticScopeWithParser,
    parseLocalDefinitionsWithParser,
    parseAliasBindingsWithParser,
    parseVisibleLocalDefinitionsWithParser
} from './parserSqlContext';
export {
    collectIdentifierOccurrences,
    type IdentifierOccurrence,
    type IdentifierSemanticRole,
} from './identifierRoleCollector';
