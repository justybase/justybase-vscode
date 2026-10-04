import type { CstNode, IToken } from 'chevrotain';
import { parseSqlStatements } from '../../sqlParser/parsingRuntime';
import { buildSemanticScopeFromParseResult } from '../../providers/parsers/parserSqlContext';
import { getChildNodesFlat, getNodeRange } from '../../providers/parsers/scope/cstNodeUtils';
import { getOrderedCstTokens, getOrderedReferenceTokens } from '../../providers/parsers/scope/referenceTokenCollector';
import { decodeSqlStringLiteral, wrapProcedureStringBody } from '../../sqlParser/procedure/procedureStringBody';

export type AnalysisObjectType = 'TABLE' | 'VIEW' | 'PROCEDURE' | 'EXTERNAL TABLE' | 'SEQUENCE' | 'UNKNOWN';
export interface ObjectReference { database: string; schema: string; name: string; type: AnalysisObjectType }
export interface SqlLocation { start: number; end: number }
export interface SqlReference { target: ObjectReference; column?: string; kind: 'object' | 'column' | 'call' | 'wildcard'; confidence: 'exact' | 'probable'; location: SqlLocation }
export interface SqlJoin { left: SqlReference; right: SqlReference }
export interface SqlAnalysis {
    references: SqlReference[];
    joins: SqlJoin[];
    issues: string[];
    patterns: { kind: 'conversion' | 'cartesian' | 'distinct' | 'group' | 'sort' | 'union' | 'star'; location: SqlLocation }[];
}
export function objectId(object: ObjectReference): string {
    return JSON.stringify([object.database, object.schema, object.name]);
}
export function objectLabel(object: ObjectReference): string {
    return [object.database, object.schema, object.name].filter(Boolean).join('.');
}
function identifier(token: IToken): string {
    return token.image.startsWith('"') ? token.image.slice(1, -1).replace(/""/g, '"') : token.image.toUpperCase();
}
export function qualifiedReference(tokens: IToken[], context: ObjectReference): ObjectReference {
    const names = tokens.filter(t => t.image !== '.').map(identifier);
    const dots = tokens.filter(t => t.image === '.').length;
    return { database: names.length === 3 || dots === 2 ? names[0] : context.database,
        schema: names.length === 3 ? names[1] : dots === 2 ? '' : names.length === 2 ? names[0] : context.schema,
        name: names[names.length - 1], type: 'UNKNOWN' };
}
/** Single existing Chevrotain parse; scope resolution remains owned by parserSqlContext. */
export function analyzeSql(sql: string, context: ObjectReference, recursion = 0): SqlAnalysis {
    const report: SqlAnalysis = { references: [], joins: [], issues: [], patterns: [] };
    if (sql.length > 2_000_000 || recursion > 4) {
        report.issues.push('Definition exceeds the bounded static analysis budget.');
        return report;
    }
    const parsed = parseSqlStatements({ sql, databaseKind: 'netezza' });
    if (!parsed.cst || parsed.lexResult.errors.length || parsed.actionableParserErrors.length) {
        report.issues.push('SQL could not be parsed reliably; references are unavailable.');
        return report;
    }
    const containsProcedure = (node: CstNode): boolean => node.name === 'createProcedureStatement' || getChildNodesFlat(node).some(containsProcedure);
    const inProcedure = containsProcedure(parsed.cst);
    if (inProcedure) { report.issues.push('Unqualified procedure columns are not inferred because names may denote variables.'); }
    const rangeCache = new WeakMap();
    const scopes = new Map<number, ReturnType<typeof buildSemanticScopeFromParseResult>>();
    const scopeAt = (offset: number) => {
        let scope = scopes.get(offset);
        if (!scope) { scope = buildSemanticScopeFromParseResult(parsed, sql, offset, 'netezza'); scopes.set(offset, scope); }
        return scope;
    };
    const localAt = (name: string, offset: number) => scopeAt(offset).visibleLocalDefinitions.some(d => d.name.toUpperCase() === name.toUpperCase());
    const column = (node: CstNode): SqlReference | undefined => {
        const tokens = getOrderedReferenceTokens(node);
        if (!tokens.length) { return undefined; }
        const parts = tokens.map(identifier);
        const scope = scopeAt(tokens[0].startOffset);
        let target: ObjectReference | undefined;
        const qualifier = parts.slice(0, -1);
        if (qualifier.length === 1) {
            const alias = [...scope.preferredAliasBindings.entries()].find(([key]) => tokens[0].image.startsWith('"') ? key === qualifier[0] : key.toUpperCase() === qualifier[0])?.[1];
            if (alias && !localAt(alias.table, tokens[0].startOffset)) {
                target = { database: alias.db ?? context.database, schema: alias.schema ?? (alias.db ? '' : context.schema), name: alias.table, type: 'UNKNOWN' };
            }
        } else if (qualifier.length >= 2) {
            target = { database: qualifier.length === 3 ? qualifier[0] : context.database,
                schema: qualifier.length === 3 ? qualifier[1] : qualifier[0], name: qualifier[qualifier.length - 1], type: 'UNKNOWN' };
        } else {
            if (inProcedure) { return undefined; }
            const candidates = new Map<string, ObjectReference>();
            for (const alias of scope.preferredAliasBindings.values()) {
                if (!localAt(alias.table, tokens[0].startOffset)) {
                    const ref: ObjectReference = { database: alias.db ?? context.database, schema: alias.schema ?? (alias.db ? '' : context.schema), name: alias.table, type: 'UNKNOWN' };
                    candidates.set(objectId(ref), ref);
                }
            }
            if (candidates.size === 1) { target = [...candidates.values()][0]; }
        }
        if (!target) {
            const issue = 'Some column references are ambiguous or unresolved; object-level dependencies remain available.';
            if (!report.issues.includes(issue)) report.issues.push(issue);
            return undefined;
        }
        return { target, column: parts[parts.length - 1], kind: 'column', confidence: 'exact', location: { start: tokens[0].startOffset, end: (tokens[tokens.length - 1].endOffset ?? tokens[0].startOffset) + 1 } };
    };
    const visit = (node: CstNode, ancestors: string[]) => {
        const range = getNodeRange(node, rangeCache);
        const location = { start: range?.start ?? 0, end: (range?.end ?? 0) + 1 };
        const tokens = ['tableName', 'callStatement', 'comparisonExpression', 'joinClause', 'castExpression', 'functionCall', 'selectClause', 'selectItem'].includes(node.name) || /execute.*Statement/i.test(node.name) ? getOrderedCstTokens(node) : [];
        if (node.name === 'tableName' || node.name === 'callStatement') {
            const qualified = node.name === 'callStatement' ? getChildNodesFlat(node).find(n => n.name === 'qualifiedName' || n.name === 'tableName') : node;
            if (qualified) {
                const nameTokens = getOrderedCstTokens(qualified);
                const target = qualifiedReference(nameTokens, context);
                if (!target.schema) { report.issues.push(`${target.name}: implicit target schema cannot be resolved statically.`); }
                const unqualified = nameTokens.every(t => t.image !== '.');
                const ddlTarget = ancestors.some(n => /create.*Statement|alterTableStatement|dropTarget/.test(n)) && !ancestors.some(n => n === 'selectStatement' || n === 'beginProcBody');
                if (target.name && !ddlTarget && !(unqualified && localAt(target.name, location.start))) {
                    report.references.push({ target: { ...target, type: node.name === 'callStatement' ? 'PROCEDURE' : 'UNKNOWN' }, kind: node.name === 'callStatement' ? 'call' : 'object', confidence: 'exact', location });
                }
            }
        }
        if (node.name === 'columnReference') {
            const reference = column(node);
            if (reference) { report.references.push(reference); }
        }
        if (node.name === 'comparisonExpression' && tokens.some(t => t.image === '=')) {
            const columns: SqlReference[] = [];
            const collect = (n: CstNode) => { if (n.name === 'columnReference') { const ref = column(n); if (ref) { columns.push(ref); } } else { getChildNodesFlat(n).forEach(collect); } };
            collect(node);
            if (columns.length === 2 && objectId(columns[0].target) !== objectId(columns[1].target)) {
                report.joins.push({ left: columns[0], right: columns[1] });
            }
        }
        const upper = tokens.map(t => t.image.toUpperCase());
        if (node.name === 'joinClause' && !upper.includes('ON') && !upper.includes('USING') && !upper.includes('NATURAL')) {
            report.patterns.push({ kind: 'cartesian', location });
        }
        const hasColumn = (child: CstNode): boolean => child.name === 'columnReference' || getChildNodesFlat(child).some(hasColumn);
        if (((node.name === 'castExpression' && (upper.includes('CAST') || upper.includes('::'))) || (node.name === 'functionCall' && upper.includes('('))) && hasColumn(node) && ancestors.some(n => n === 'whereClause' || n === 'joinClause')) {
            report.patterns.push({ kind: 'conversion', location });
        }
        const pattern = node.name === 'groupByClause' ? 'group' : node.name === 'orderByClause' ? 'sort' : node.name === 'selectClause' && upper.includes('DISTINCT') ? 'distinct' : undefined;
        if (pattern) { report.patterns.push({ kind: pattern, location }); }
        if (node.name === 'selectItem' && tokens.length <= 3 && upper.includes('*')) { report.patterns.push({ kind: 'star', location }); }
        if (node.name === 'setOperation' && node.children.Union?.length && !node.children.All?.length) { report.patterns.push({ kind: 'union', location }); }
        if (/execute.*Statement/i.test(node.name) && upper.includes('EXECUTE')) {
            const strings = tokens.filter(t => t.tokenType.name === 'StringLiteral');
            if (strings.length === 1 && !upper.includes('||') && tokens.filter(t => t.startOffset > strings[0].startOffset && t.image !== ';').length === 0) {
                const nested = analyzeSql(decodeSqlStringLiteral(strings[0].image), context, recursion + 1);
                report.references.push(...nested.references.map(ref => ({ ...ref, confidence: 'probable' as const, location })));
                report.issues.push(...nested.issues);
            } else { report.issues.push('Dynamic SQL detected; constructed object names cannot be resolved statically.'); }
        }
        if (node.name === 'createProcedureStatement') {
            const body = (node.children.StringLiteral ?? []).find(t => 'image' in t);
            if (body && 'image' in body) {
                const nested = analyzeSql(wrapProcedureStringBody(decodeSqlStringLiteral(body.image)), context, recursion + 1);
                report.references.push(...nested.references.map(ref => ({ ...ref, confidence: 'probable' as const, location })));
                report.issues.push(...nested.issues);
            }
        }
        getChildNodesFlat(node).forEach(child => visit(child, [...ancestors, node.name]));
    };
    visit(parsed.cst, []);
    if (report.patterns.some(p => p.kind === 'star')) {
        const seen = new Set<string>();
        for (const reference of report.references.filter(r => r.kind === 'object')) {
            if (!seen.has(objectId(reference.target))) {
                seen.add(objectId(reference.target));
                report.references.push({ ...reference, kind: 'wildcard', confidence: 'probable' });
            }
        }
    }
    report.issues = [...new Set(report.issues)];
    return report;
}
