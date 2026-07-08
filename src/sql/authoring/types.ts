import type { LintRule } from '../../providers/linterRules';

export interface DatabaseSqlFunctionSignature {
    name: string;
    parameters: readonly string[];
    description: string;
}

export interface DatabaseSqlTypeSpec {
    canonical: string;
    paramsMin: number;
    paramsMax: number;
    warnIfNoLength?: boolean;
}

export interface DatabaseSqlValidationProfile {
    builtinFunctions: ReadonlySet<string>;
    systemColumns: ReadonlySet<string>;
    specialBuiltinValues: ReadonlySet<string>;
    getTypeSpec(typeName: string): DatabaseSqlTypeSpec | undefined;
    supportsProcedureAnySizeArgument(typeName: string): boolean;
    syntaxValidationMode?: 'strict' | 'bestEffort';
}

export interface DatabaseSqlFormatterProfile {
    keywords: ReadonlySet<string>;
    clauseKeywords: ReadonlySet<string>;
    newlineBeforeKeywords: ReadonlySet<string>;
    joinModifiers: ReadonlySet<string>;
    commaNewlineClauses: ReadonlySet<string>;
    logicalBreakKeywords: ReadonlySet<string>;
}

export interface DatabaseSqlParsingProfile {
    lexerModulePath: string;
    parserModulePath: string;
}

export interface DatabaseSqlStaticAssetProfile {
    snippetsPath?: string;
    grammarPath?: string;
    grammarScopeName?: string;
}

export interface DatabaseSqlAuthoring {
    completionKeywords: readonly string[];
    signatures: ReadonlyMap<string, readonly DatabaseSqlFunctionSignature[]>;
    formatter: DatabaseSqlFormatterProfile;
    validation: DatabaseSqlValidationProfile;
    qualityRules: readonly LintRule[];
    parsing?: DatabaseSqlParsingProfile;
    staticAssets?: DatabaseSqlStaticAssetProfile;
}
