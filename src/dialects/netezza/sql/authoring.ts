import {
    NETEZZA_BUILTIN_FUNCTIONS,
    NETEZZA_SPECIAL_BUILTIN_VALUES,
    NETEZZA_SYSTEM_COLUMNS
} from './builtins';
import { getNetezzaTypeSpec, supportsProcedureAnySizeArgument } from './dataTypes';
import { NETEZZA_COMPLETION_KEYWORDS, netezzaFormatterProfile } from './keywords';
import { netezzaSqlQualityRules } from './qualityRules';
import { NETEZZA_FUNCTION_SIGNATURES } from './signatures';
import type { DatabaseSqlAuthoring } from '../../../sql/authoring/types';

export const netezzaSqlAuthoring: DatabaseSqlAuthoring = {
    completionKeywords: NETEZZA_COMPLETION_KEYWORDS,
    signatures: NETEZZA_FUNCTION_SIGNATURES,
    formatter: netezzaFormatterProfile,
    validation: {
        builtinFunctions: NETEZZA_BUILTIN_FUNCTIONS,
        systemColumns: NETEZZA_SYSTEM_COLUMNS,
        specialBuiltinValues: NETEZZA_SPECIAL_BUILTIN_VALUES,
        getTypeSpec: getNetezzaTypeSpec,
        supportsProcedureAnySizeArgument
    },
    qualityRules: netezzaSqlQualityRules,
    parsing: {
        lexerModulePath: 'src/dialects/netezza/sql/lexer.ts',
        parserModulePath: 'src/dialects/netezza/sql/parser.ts'
    },
    staticAssets: {
        snippetsPath: 'dialects/netezza/snippets/netezza.code-snippets',
        grammarPath: 'dialects/netezza/syntaxes/netezza.tmLanguage.json',
        grammarScopeName: 'netezza.injection'
    }
};
