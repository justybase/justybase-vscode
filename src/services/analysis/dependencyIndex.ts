import { createHash } from 'crypto';
import { analyzeSql, objectId, resolveKnownObject, type ObjectReference, type SqlLocation, type SqlReference } from './sqlAnalysis';

export interface ObjectDefinition { object: ObjectReference; sql: string }
/** A proposed change behind impact analysis; severity is derived from this instead of display text. */
export type ProposedChange =
    | { kind: 'dropObject' }
    | { kind: 'dropColumn'; column: string }
    | { kind: 'renameColumn'; from: string; to: string }
    | { kind: 'changeColumnType'; column: string; fromType?: string; toType?: string }
    | { kind: 'renameObject'; to: string };
export interface ColumnEvidence { column?: string; kind: SqlReference['kind']; confidence: SqlReference['confidence']; location: SqlLocation }
export interface DependencyEdge extends SqlReference { source: ObjectReference; columns?: string[]; evidence: ColumnEvidence[] }
export interface DependencyReport {
    root: ObjectReference;
    direction: 'outgoing' | 'incoming';
    edges: DependencyEdge[];
    affected: { object: ObjectReference; depth: number; severity: 'high' | 'medium' | 'low'; reason: string }[];
    issues: string[];
    truncated: boolean;
    proposedChange?: string;
    change?: ProposedChange;
}
interface IndexedDefinition { hash: string; references: SqlReference[]; issues: string[]; object: ObjectReference }
interface PairEdge { source: ObjectReference; target: ObjectReference; evidence: ColumnEvidence[] }

const MAX_EDGES = 3000;
const MAX_ISSUES_PER_OBJECT = 50;

/** Free-text impact descriptions are classified into the discriminated model; unknown text stays conservative. */
export function parseProposedChange(text: string, column?: string): ProposedChange {
    const input = text.trim();
    const renameColumn = /^rename\s+column\s+(\S+)\s+to\s+(\S+)$/i.exec(input);
    if (renameColumn) { return { kind: 'renameColumn', from: renameColumn[1], to: renameColumn[2] }; }
    const dropColumn = /^drop\s+column\s+(\S+)$/i.exec(input);
    if (dropColumn) { return { kind: 'dropColumn', column: dropColumn[1] }; }
    const explicitType = /^change\s+column\s+(\S+)\s+(.+)$/i.exec(input);
    if (explicitType) {
        const rest = explicitType[2].trim().replace(/^type\s+/i, '');
        const split = /^(?:(\S.*?)\s+)?(?:->|→|\bto\b)\s*(.+)$/i.exec(rest);
        if (split) { return { kind: 'changeColumnType', column: explicitType[1], fromType: split[1]?.trim() || undefined, toType: split[2].trim() || undefined }; }
    }
    const changeType = /^change\s+(.+?)\s*(?:->|→|\bto\b)\s*(.+)$/i.exec(input);
    if (changeType) {
        const left = changeType[1].trim();
        const identifierOnly = /^[A-Za-z_][\w$]*$/.test(left);
        return { kind: 'changeColumnType', column: column ?? (identifierOnly ? left : ''), fromType: column ? left : (identifierOnly ? undefined : left), toType: changeType[2].trim() || undefined };
    }
    if (/^rename\s/i.test(input)) {
        const to = /^rename\s+(?:table|view|object|procedure)\s+to\s+(\S+)$/i.exec(input);
        if (to) { return { kind: 'renameObject', to: to[1] }; }
    }
    if (/^drop\s/i.test(input)) { return { kind: 'dropObject' }; }
    return column ? { kind: 'dropColumn', column } : { kind: 'dropObject' };
}

export function describeProposedChange(change: ProposedChange, root: ObjectReference): string {
    switch (change.kind) {
        case 'dropObject': return `Drop ${root.name}`;
        case 'dropColumn': return `Drop column ${root.name}.${change.column}`;
        case 'renameColumn': return `Rename column ${root.name}.${change.from} to ${change.to}`;
        case 'changeColumnType': return `Change column ${root.name}.${change.column}${change.fromType || change.toType ? ` (${change.fromType ?? '?'} → ${change.toType ?? '?'})` : ''}`;
        case 'renameObject': return `Rename ${root.name} to ${change.to}`;
    }
}

const changeColumn = (change: ProposedChange): string | undefined =>
    change.kind === 'dropColumn' ? change.column : change.kind === 'renameColumn' ? change.from : change.kind === 'changeColumnType' ? change.column : undefined;

const isExact = (pair: PairEdge): boolean => pair.evidence.some(e => e.confidence === 'exact');
const hasWildcard = (pair: PairEdge): boolean => pair.evidence.some(e => e.kind === 'wildcard');
const matchesColumn = (pair: PairEdge, name: string | undefined): boolean =>
    Boolean(name) && pair.evidence.some(e => e.column?.toUpperCase() === name!.toUpperCase());

function severityFor(change: ProposedChange | undefined, pair: PairEdge, depth: number): 'high' | 'medium' | 'low' {
    if (!change) { return !isExact(pair) ? 'low' : depth === 1 ? 'high' : 'medium'; }
    switch (change.kind) {
        case 'dropObject': case 'renameObject':
            return !isExact(pair) ? 'medium' : depth === 1 ? 'high' : 'medium';
        case 'dropColumn': case 'renameColumn':
            if (matchesColumn(pair, changeColumn(change))) { return depth === 1 ? 'high' : 'medium'; }
            if (hasWildcard(pair)) { return depth === 1 ? 'medium' : 'low'; }
            return 'low';
        case 'changeColumnType':
            if (matchesColumn(pair, change.column) && isExact(pair)) { return depth === 1 ? 'medium' : 'low'; }
            if (hasWildcard(pair)) { return depth === 1 ? 'medium' : 'low'; }
            return 'low';
    }
}

function reasonFor(change: ProposedChange | undefined, pair: PairEdge, depth: number, column?: string): string {
    const direct = depth === 1;
    if (!change) {
        return direct ? column ? `References ${column}; review the proposed change.` : 'Direct dependency; review the proposed change.' : 'Indirect dependency; potentially affected.';
    }
    switch (change.kind) {
        case 'dropObject': return direct ? 'References this object; the proposed drop breaks it.' : 'Indirect dependency; downstream objects may break.';
        case 'renameObject': return direct ? 'References this object by name; the proposed rename breaks it.' : 'Indirect dependency; downstream objects may break.';
        case 'dropColumn': case 'renameColumn': {
            const name = changeColumn(change);
            if (matchesColumn(pair, name)) { return direct ? `References column ${name}; the proposed change breaks it.` : `Indirect dependency on column ${name}.`; }
            if (hasWildcard(pair)) { return direct ? 'Uses a wildcard projection; column-level exposure is unverified.' : 'Indirect dependency with wildcard exposure.'; }
            return direct ? 'References the object without the changed column; verify usage.' : 'Indirect dependency; likely unaffected.';
        }
        case 'changeColumnType':
            return direct
                ? (matchesColumn(pair, change.column) ? `Compares or projects column ${change.column}; verify type compatibility.` : hasWildcard(pair) ? 'Uses a wildcard projection; verify type compatibility.' : 'References the object; verify type compatibility.')
                : 'Indirect dependency; verify type compatibility.';
    }
}

const toDependencyEdge = (pair: PairEdge): DependencyEdge => {
    const first = pair.evidence[0];
    const columns = [...new Set(pair.evidence.map(e => e.column).filter(c => c !== undefined))];
    return { source: pair.source, target: pair.target, kind: first.kind, confidence: isExact(pair) ? 'exact' : 'probable',
        location: first.location, column: first.column, columns: columns.length ? columns : undefined, evidence: pair.evidence };
};

/** Derived, ephemeral index with unique object-to-object pairs; columns are evidence, not edges. */
export class DependencyIndex {
    private entries = new Map<string, IndexedDefinition>();
    private outgoing = new Map<string, Map<string, PairEdge>>();
    private incoming = new Map<string, Map<string, PairEdge>>();
    private knownObjects = new Map<string, ObjectReference>();
    private generation = 0;

    invalidate(): void {
        this.generation++;
        this.entries.clear();
        this.outgoing.clear();
        this.incoming.clear();
        this.knownObjects.clear();
    }
    async update(definitions: readonly ObjectDefinition[], objects: readonly ObjectReference[] = [], cancelled: () => boolean = () => false, catalogEdges: readonly DependencyEdge[] = []): Promise<boolean> {
        const generation = ++this.generation;
        const known = new Map([...objects, ...definitions.map(d => d.object)].map(o => [objectId(o), o]));
        const next = new Map<string, IndexedDefinition>();
        for (let i = 0; i < definitions.length; i++) {
            if (cancelled() || generation !== this.generation) { return false; }
            const { object, sql } = definitions[i];
            const id = objectId(object);
            const hash = createHash('sha256').update(sql).digest('hex');
            let entry = this.entries.get(id);
            if (!entry || entry.hash !== hash) {
                const analysis = analyzeSql(sql, object);
                entry = { hash, object, references: analysis.references, issues: analysis.issues };
            }
            next.set(id, entry);
            if (i % 20 === 19) { await new Promise<void>(resolve => setImmediate(resolve)); }
        }
        if (cancelled() || generation !== this.generation) { return false; }
        const outgoing = new Map<string, Map<string, PairEdge>>();
        const incoming = new Map<string, Map<string, PairEdge>>();
        for (const entry of next.values()) {
            for (const reference of entry.references) {
                this.link(outgoing, incoming, entry.object, resolveKnownObject(reference.target, known),
                    { column: reference.column, kind: reference.kind, confidence: reference.confidence, location: reference.location });
            }
        }
        for (const edge of catalogEdges) {
            for (const evidence of edge.evidence ?? [{ column: edge.column, kind: edge.kind, confidence: edge.confidence, location: edge.location }]) {
                this.link(outgoing, incoming, edge.source, resolveKnownObject(edge.target, known), evidence);
            }
        }
        this.entries = next;
        this.knownObjects = known;
        this.outgoing = outgoing;
        this.incoming = incoming;
        return true;
    }
    private link(outgoing: Map<string, Map<string, PairEdge>>, incoming: Map<string, Map<string, PairEdge>>, source: ObjectReference, target: ObjectReference, evidence: ColumnEvidence): void {
        const sourceId = objectId(source), targetId = objectId(target);
        const outMap = outgoing.get(sourceId) ?? new Map<string, PairEdge>();
        outgoing.set(sourceId, outMap);
        const existing = outMap.get(targetId);
        if (existing) { existing.evidence.push(evidence); return; }
        const pair: PairEdge = { source, target, evidence: [evidence] };
        outMap.set(targetId, pair);
        const inMap = incoming.get(targetId) ?? new Map<string, PairEdge>();
        incoming.set(targetId, inMap);
        inMap.set(sourceId, pair);
    }
    getReport(root: ObjectReference, direction: 'outgoing' | 'incoming', maxDepth = 2, column?: string, maxNodes = 300, change?: ProposedChange): DependencyReport {
        const traversalRoot = root.type === 'UNKNOWN' ? resolveKnownObject(root, this.knownObjects) : root;
        const report: DependencyReport = { root: traversalRoot, direction, edges: [], affected: [], issues: [], truncated: false, change };
        const visited = new Set([objectId(traversalRoot)]);
        const pending = [{ object: traversalRoot, depth: 0 }];
        const depthLimit = Math.min(Math.max(maxDepth, 1), 100);
        /** Pairs referencing the root name stay unique: prefer the typed identity over UNKNOWN. */
        const sameTriple = (a: ObjectReference, b: ObjectReference): boolean =>
            a.database === b.database && a.schema === b.schema && a.name === b.name;
        const normalizeIdentity = (object: ObjectReference): ObjectReference =>
            sameTriple(object, traversalRoot) && object.type !== traversalRoot.type && (object.type === 'UNKNOWN' || traversalRoot.type === 'UNKNOWN')
                ? (traversalRoot.type === 'UNKNOWN' ? object : traversalRoot)
                : object;
        const pairsFor = (object: ObjectReference): PairEdge[] => {
            const map = direction === 'outgoing' ? this.outgoing : this.incoming;
            const pairs = [...(map.get(objectId(object))?.values() ?? [])];
            if (object.type !== 'UNKNOWN') {
                const unknownId = objectId({ ...object, type: 'UNKNOWN' });
                for (const pair of map.get(unknownId)?.values() ?? []) {
                    if (!pairs.includes(pair)) { pairs.push(pair); }
                }
            }
            return pairs;
        };
        while (pending.length) {
            const current = pending.shift()!;
            if (current.depth >= depthLimit) { continue; }
            for (const pair of pairsFor(current.object)) {
                if (column && current.depth === 0 && direction === 'incoming' && !pair.evidence.some(e => e.column === column || e.kind === 'wildcard')) { continue; }
                const object = normalizeIdentity(direction === 'outgoing' ? pair.target : pair.source);
                if (report.edges.length >= MAX_EDGES) { report.truncated = true; break; }
                report.edges.push(toDependencyEdge(pair));
                if (visited.has(objectId(object))) { continue; }
                if (visited.size >= maxNodes) { report.truncated = true; continue; }
                visited.add(objectId(object));
                const depth = current.depth + 1;
                report.affected.push({ object, depth, severity: severityFor(change, pair, depth), reason: reasonFor(change, pair, depth, column) });
                pending.push({ object, depth });
            }
        }
        // Only reachable objects contribute issues; catalog-wide problems are reported by the service.
        for (const id of visited) {
            const entry = this.entries.get(id);
            if (!entry) { continue; }
            for (const issue of entry.issues.slice(0, MAX_ISSUES_PER_OBJECT)) { report.issues.push(`${entry.object.name}: ${issue}`); }
        }
        if (column) { report.issues.push('Column coverage is partial: ambiguous columns and complex derived-column lineage are not inferred.'); }
        if (!this.knownObjects.has(objectId(traversalRoot))) { report.issues.push('Object is not present in the loaded catalog snapshot.'); }
        return report;
    }
}
