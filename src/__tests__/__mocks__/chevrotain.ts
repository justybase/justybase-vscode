// Mock for Chevrotain ESM module
// This mock provides working implementations for testing

export const createToken = jest.fn((config: { name: string; pattern: RegExp | string; group?: string; longer_alt?: any }) => ({
    name: config.name,
    pattern: config.pattern,
    tokenTypeIdx: 1,
    categoryMatches: [],
    categoryMatchesMap: {},
    GROUP: config.group,
    longer_alt: config.longer_alt
}));

export const VERSION = '11.0.0';

export class Lexer {
    static SKIPPED = 'SKIPPED';
    
    constructor(_tokens: any[]) {
        // tokens not used in mock
    }

    tokenize(input: string) {
        const tokens: any[] = [];
        const errors: any[] = [];
        
        const trimmed = input.trim();
        if (trimmed.length === 0) {
            return { tokens, groups: {}, errors, lexerConfig: {} };
        }
        
        // Identifier pattern - must be checked FIRST to handle INNER_COL correctly
        const identifierPattern = /[a-zA-Z_][a-zA-Z0-9_]*/;
        
        // Keyword patterns
        const keywordPatterns: Array<{ name: string; pattern: RegExp }> = [
            { name: 'Select', pattern: /SELECT/i },
            { name: 'From', pattern: /FROM/i },
            { name: 'Where', pattern: /WHERE/i },
            { name: 'Insert', pattern: /INSERT/i },
            { name: 'Into', pattern: /INTO/i },
            { name: 'Values', pattern: /VALUES/i },
            { name: 'Update', pattern: /UPDATE/i },
            { name: 'Set', pattern: /SET/i },
            { name: 'Delete', pattern: /DELETE/i },
            { name: 'Join', pattern: /JOIN/i },
            { name: 'Inner', pattern: /INNER/i },
            { name: 'Left', pattern: /LEFT/i },
            { name: 'Right', pattern: /RIGHT/i },
            { name: 'Full', pattern: /FULL/i },
            { name: 'Outer', pattern: /OUTER/i },
            { name: 'Cross', pattern: /CROSS/i },
            { name: 'On', pattern: /ON/i },
            { name: 'And', pattern: /AND/i },
            { name: 'Or', pattern: /OR/i },
            { name: 'Not', pattern: /NOT/i },
            { name: 'As', pattern: /AS/i },
            { name: 'Distinct', pattern: /DISTINCT/i },
            { name: 'All', pattern: /ALL/i },
            { name: 'GroupBy', pattern: /GROUP\s+BY/i },
            { name: 'OrderBy', pattern: /ORDER\s+BY/i },
            { name: 'Having', pattern: /HAVING/i },
            { name: 'Limit', pattern: /LIMIT/i },
            { name: 'Offset', pattern: /OFFSET/i },
            { name: 'Null', pattern: /NULL/i },
            { name: 'Is', pattern: /IS/i },
            { name: 'Like', pattern: /LIKE/i },
            { name: 'In', pattern: /IN/i },
            { name: 'Between', pattern: /BETWEEN/i },
            { name: 'Exists', pattern: /EXISTS/i },
            { name: 'Case', pattern: /CASE/i },
            { name: 'When', pattern: /WHEN/i },
            { name: 'Then', pattern: /THEN/i },
            { name: 'Else', pattern: /ELSE/i },
            { name: 'End', pattern: /END/i },
            { name: 'Create', pattern: /CREATE/i },
            { name: 'Table', pattern: /TABLE/i },
            { name: 'Temporary', pattern: /TEMPORARY/i },
            { name: 'Temp', pattern: /TEMP/i },
            { name: 'Drop', pattern: /DROP/i },
            { name: 'Alter', pattern: /ALTER/i },
            { name: 'With', pattern: /WITH/i },
            { name: 'Recursive', pattern: /RECURSIVE/i },
            { name: 'Distribute', pattern: /DISTRIBUTE/i },
            { name: 'Random', pattern: /RANDOM/i },
            { name: 'Organize', pattern: /ORGANIZE/i },
            { name: 'Asc', pattern: /ASC/i },
            { name: 'Desc', pattern: /DESC/i },
            { name: 'Union', pattern: /UNION/i },
            { name: 'Intersect', pattern: /INTERSECT/i },
            { name: 'Except', pattern: /EXCEPT/i }
        ];
        
        // Other token patterns
        const otherPatterns: Array<{ name: string; pattern: RegExp }> = [
            { name: 'NumberLiteral', pattern: /\d+(\.\d+)?([eE][+-]?\d+)?/ },
            { name: 'StringLiteral', pattern: /'([^']|'')*'/ },
            { name: 'QuotedIdentifier', pattern: /"[^"]*"/ },
            { name: 'NotEquals', pattern: /(!=|<>)/ },
            { name: 'LessThanEquals', pattern: /<=/ },
            { name: 'GreaterThanEquals', pattern: />=/ },
            { name: 'Concat', pattern: /\|\|/ },
            { name: 'Equals', pattern: /=/ },
            { name: 'LessThan', pattern: /</ },
            { name: 'GreaterThan', pattern: />/ },
            { name: 'Plus', pattern: /\+/ },
            { name: 'Minus', pattern: /-/ },
            { name: 'Multiply', pattern: /\*/ },
            { name: 'Divide', pattern: /\// },
            { name: 'Dot', pattern: /\./ },
            { name: 'Comma', pattern: /,/ },
            { name: 'Semicolon', pattern: /;/ },
            { name: 'LParen', pattern: /\(/ },
            { name: 'RParen', pattern: /\)/ },
            { name: 'LBracket', pattern: /\[/ },
            { name: 'RBracket', pattern: /\]/ },
            { name: 'Parameter', pattern: /\?/ }
        ];
        
        let remaining = trimmed;
        let offset = 0;
        
        while (remaining.length > 0) {
            // Skip whitespace
            const wsMatch = remaining.match(/^\s+/);
            if (wsMatch) {
                offset += wsMatch[0].length;
                remaining = remaining.slice(wsMatch[0].length);
                continue;
            }
            
            let matched = false;
            
            // First try to match as identifier (simulates longer_alt behavior)
            const idMatch = remaining.match(identifierPattern);
            if (idMatch && idMatch.index === 0) {
                const value = idMatch[0];
                
                // Check if this is EXACTLY a keyword (not longer like INNER_COL)
                let isExactKeyword = false;
                for (const kw of keywordPatterns) {
                    const kwMatch = remaining.match(kw.pattern);
                    if (kwMatch && kwMatch.index === 0 && kwMatch[0] === value) {
                        isExactKeyword = true;
                        break;
                    }
                }
                
                // If not exact keyword match, treat as identifier
                if (!isExactKeyword) {
                    tokens.push({
                        image: value,
                        tokenType: { name: 'Identifier' },
                        startOffset: offset,
                        startLine: 1,
                        startColumn: offset + 1,
                        endOffset: offset + value.length,
                        endLine: 1,
                        endColumn: offset + value.length + 1
                    });
                    offset += value.length;
                    remaining = remaining.slice(value.length);
                    matched = true;
                    continue;
                }
            }
            
            // Try keyword patterns
            for (const tokenDef of keywordPatterns) {
                const match = remaining.match(tokenDef.pattern);
                if (match && match.index === 0) {
                    const value = match[0];
                    tokens.push({
                        image: value,
                        tokenType: { name: tokenDef.name },
                        startOffset: offset,
                        startLine: 1,
                        startColumn: offset + 1,
                        endOffset: offset + value.length,
                        endLine: 1,
                        endColumn: offset + value.length + 1
                    });
                    offset += value.length;
                    remaining = remaining.slice(value.length);
                    matched = true;
                    break;
                }
            }
            
            if (matched) continue;
            
            // Try other patterns
            for (const tokenDef of otherPatterns) {
                const match = remaining.match(tokenDef.pattern);
                if (match && match.index === 0) {
                    const value = match[0];
                    tokens.push({
                        image: value,
                        tokenType: { name: tokenDef.name },
                        startOffset: offset,
                        startLine: 1,
                        startColumn: offset + 1,
                        endOffset: offset + value.length,
                        endLine: 1,
                        endColumn: offset + value.length + 1
                    });
                    offset += value.length;
                    remaining = remaining.slice(value.length);
                    matched = true;
                    break;
                }
            }
            
            if (!matched) {
                // Unknown character - skip it
                offset += 1;
                remaining = remaining.slice(1);
            }
        }
        
        return { tokens, groups: {}, errors, lexerConfig: {} };
    }
}

export class CstParser {
    static DEFER_DEFINITION_ERRORS_HANDLING = false;

    public errors: any[] = [];
    public input: any[] = [];
    
    private rules: Map<string, () => any> = new Map();
    private executingRules: Set<string> = new Set();

    constructor(public tokens: any[]) {}

    // Mock RULE method - creates a method on the parser instance
    RULE(name: string, impl: () => void) {
        this.rules.set(name, impl);
        const self = this;
        (this as any)[name] = jest.fn(() => {
            // Prevent infinite recursion by tracking executing rules
            if (self.executingRules.has(name)) {
                return { name, children: {}, location: { startOffset: 0, endOffset: 0 } };
            }
            self.executingRules.add(name);
            try {
                impl();
            } finally {
                self.executingRules.delete(name);
            }
            return {
                name,
                children: {},
                location: { startOffset: 0, endOffset: 0 }
            };
        });
        return (this as any)[name];
    }

    OVERRIDE_RULE(name: string, impl: () => void) {
        // Grammar inheritance uses OVERRIDE_RULE in real Chevrotain. The mock
        // can safely treat it the same as RULE because tests only need the
        // replacement rule implementation to be installed on the instance.
        return this.RULE(name, impl);
    }

    // Mock SUBRULE method - prevent infinite recursion
    SUBRULE(rule: any) {
        if (typeof rule === 'function') {
            const ruleName = this.getRuleNameFromFunction(rule);
            if (ruleName && this.executingRules.has(ruleName)) {
                return {};
            }
            return rule();
        }
        return {};
    }

    private getRuleNameFromFunction(fn: any): string | null {
        for (const [name, ruleFn] of this.rules.entries()) {
            if (ruleFn === fn || (fn as any).mock?.context?.api?.name === name) {
                return name;
            }
        }
        for (const [key, value] of Object.entries(this)) {
            if ((value as any) === fn) {
                return key;
            }
        }
        return null;
    }

    SUBRULE1(rule: any) {
        return this.SUBRULE(rule);
    }

    SUBRULE2(rule: any) {
        return this.SUBRULE(rule);
    }

    // Mock grammar methods
    MANY(_def: () => void) {
        // Mock - do nothing
    }

    MANY_SEP(config: { SEP: any; DEF: () => void }) {
        // Mock - execute definition once
        config.DEF();
    }

    AT_LEAST_ONE_SEP(config: { SEP: any; DEF: () => void }) {
        // Mock - execute definition once
        config.DEF();
    }

    AT_LEAST_ONE(def: () => void) {
        // Mock - execute definition once
        def();
    }

    OPTION(def: () => void) {
        // Mock - execute definition once
        def();
    }

    OPTION1(def: () => void) {
        return this.OPTION(def);
    }

    OPTION2(def: () => void) {
        return this.OPTION(def);
    }

    OPTION3(def: () => void) {
        return this.OPTION(def);
    }

    OPTION4(def: () => void) {
        return this.OPTION(def);
    }

    OPTION5(def: () => void) {
        return this.OPTION(def);
    }

    CONSUME(token: any) {
        // Mock - return a token-like object
        return { image: '', tokenType: token };
    }

    CONSUME1(token: any) {
        return this.CONSUME(token);
    }

    CONSUME2(token: any) {
        return this.CONSUME(token);
    }

    CONSUME3(token: any) {
        return this.CONSUME(token);
    }

    CONSUME4(token: any) {
        return this.CONSUME(token);
    }

    CONSUME5(token: any) {
        return this.CONSUME(token);
    }

    OR(alternatives: Array<{ ALT: () => void }>) {
        // Mock - execute first alternative
        if (alternatives.length > 0) {
            alternatives[0].ALT();
        }
    }

    OR1(alternatives: Array<{ ALT: () => void }>) {
        return this.OR(alternatives);
    }

    OR2(alternatives: Array<{ ALT: () => void }>) {
        return this.OR(alternatives);
    }

    performSelfAnalysis() {
        // Mock
    }

    getBaseCstVisitorConstructor() {
        return class BaseVisitor {
            visit(_node: any) {
                return {};
            }
            validateVisitor() {
                // Mock
            }
        };
    }
}
