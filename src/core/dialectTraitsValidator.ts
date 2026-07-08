import { DatabaseDialectTraits } from '../contracts/database';

const REPRESENTATIVE_IDENTIFIER_SAMPLES = ['TABLE_NAME', 'table_name', 'TableName'] as const;

function testPattern(pattern: RegExp, value: string): boolean {
    const safePattern = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
    return safePattern.test(value);
}

export function validateDialectTraits(traits: DatabaseDialectTraits): string[] {
    const errors: string[] = [];

    if (!traits.identifiers) {
        errors.push('Missing identifiers traits.');
    }
    if (!traits.qualification) {
        errors.push('Missing qualification traits.');
    }
    if (!traits.completion) {
        errors.push('Missing completion traits.');
    }
    if (!traits.objects) {
        errors.push('Missing object support traits.');
    }
    if (errors.length > 0) {
        return errors;
    }

    const { identifiers, qualification, completion } = traits;
    const pattern = identifiers.unquotedIdentifierPattern;

    if (!(pattern instanceof RegExp)) {
        errors.push('identifiers.unquotedIdentifierPattern must be a RegExp instance.');
    } else {
        if (!REPRESENTATIVE_IDENTIFIER_SAMPLES.some(sample => testPattern(pattern, sample))) {
            errors.push('identifiers.unquotedIdentifierPattern should match at least one representative unquoted identifier.');
        }
        if (testPattern(pattern, '')) {
            errors.push('identifiers.unquotedIdentifierPattern must not match an empty string.');
        }
        if (testPattern(pattern, '123invalid')) {
            errors.push('identifiers.unquotedIdentifierPattern must reject identifiers that start with digits.');
        }
        if (identifiers.quoteStyle === 'backtick' && !testPattern(pattern, 'table_name')) {
            errors.push('Backtick-quoted dialects should allow lowercase unquoted identifiers like table_name.');
        }
    }

    if (qualification.twoPartNameStyle === 'database-object' && qualification.supportsThreePartName) {
        errors.push('qualification.twoPartNameStyle="database-object" requires supportsThreePartName=false.');
    }

    if (qualification.twoPartNameStyle === 'database-object' && completion.singleDotPathNamespace !== 'database') {
        errors.push('Database-object dialects require completion.singleDotPathNamespace="database".');
    }

    if (completion.singleDotPathNamespace === 'schema-or-database' && !completion.supportsDoubleDotPath) {
        errors.push('completion.singleDotPathNamespace="schema-or-database" requires supportsDoubleDotPath=true.');
    }

    if (completion.singleDotPathNamespace === 'schema-or-database' && qualification.twoPartNameStyle !== 'schema-object') {
        errors.push('completion.singleDotPathNamespace="schema-or-database" is only valid for schema-object dialects.');
    }

    return errors;
}
