export type DatabaseIdentifierQuoteStyle = 'double' | 'backtick';
export type DatabaseGeneratedIdentifierCase = 'upper' | 'lower' | 'preserve';
export type DatabaseTwoPartNameStyle = 'schema-object' | 'database-object';
export type DatabaseTwoPartContainerPreference = 'database-over-schema' | 'schema-over-database';
export type DatabaseDatabaseOnlyReferenceStyle = 'double-dot' | 'single-dot' | 'omit';
export type DatabaseSingleDotPathNamespace = 'database' | 'schema' | 'schema-or-database';

export interface DatabaseIdentifierTraits {
    quoteStyle: DatabaseIdentifierQuoteStyle;
    unquotedIdentifierPattern: RegExp;
    generatedNameCase: DatabaseGeneratedIdentifierCase;
}

export interface DatabaseQualificationTraits {
    twoPartNameStyle: DatabaseTwoPartNameStyle;
    twoPartContainerPreference: DatabaseTwoPartContainerPreference;
    supportsThreePartName: boolean;
    databaseOnlyReferenceStyle: DatabaseDatabaseOnlyReferenceStyle;
}

export interface DatabaseCompletionTraits {
    singleDotPathNamespace: DatabaseSingleDotPathNamespace;
    supportsDoubleDotPath: boolean;
}

export interface DatabaseObjectSupportTraits {
    supportsIndexes: boolean;
}

export interface DatabaseDialectTraits {
    identifiers: DatabaseIdentifierTraits;
    qualification: DatabaseQualificationTraits;
    completion: DatabaseCompletionTraits;
    objects: DatabaseObjectSupportTraits;
}

export interface DatabaseDialectTraitsOverrides {
    identifiers?: Partial<DatabaseIdentifierTraits>;
    qualification?: Partial<DatabaseQualificationTraits>;
    completion?: Partial<DatabaseCompletionTraits>;
    objects?: Partial<DatabaseObjectSupportTraits>;
}

export function createDatabaseDialectTraits(overrides: DatabaseDialectTraitsOverrides = {}): DatabaseDialectTraits {
    return {
        identifiers: {
            quoteStyle: 'double',
            unquotedIdentifierPattern: /^[A-Z_][A-Z0-9_]*$/,
            generatedNameCase: 'upper',
            ...overrides.identifiers,
        },
        qualification: {
            twoPartNameStyle: 'schema-object',
            twoPartContainerPreference: 'database-over-schema',
            supportsThreePartName: true,
            databaseOnlyReferenceStyle: 'double-dot',
            ...overrides.qualification,
        },
        completion: {
            singleDotPathNamespace: 'database',
            supportsDoubleDotPath: false,
            ...overrides.completion,
        },
        objects: {
            supportsIndexes: true,
            ...overrides.objects,
        },
    };
}
