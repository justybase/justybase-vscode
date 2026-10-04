import { createHash } from 'crypto';
import { analyzeSql, objectId, type ObjectReference, type SqlReference } from './sqlAnalysis';

export interface ObjectDefinition { object: ObjectReference; sql: string }
export interface DependencyEdge extends SqlReference { source: ObjectReference }
export interface DependencyReport {
    root: ObjectReference;
    direction: 'outgoing' | 'incoming';
    edges: DependencyEdge[];
    affected: { object: ObjectReference; depth: number; severity: 'high' | 'medium' | 'low'; reason: string }[];
    issues: string[];
    truncated: boolean;
    proposedChange?: string;
}
interface IndexedDefinition { hash: string; edges: DependencyEdge[]; issues: string[]; object: ObjectReference }
/** Derived, ephemeral index. Definitions and ASTs remain with their existing owners. */
export class DependencyIndex {
    private entries = new Map<string, IndexedDefinition>();
    private outgoing = new Map<string, DependencyEdge[]>();
    private incoming = new Map<string, DependencyEdge[]>();
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
                entry = { hash, object, edges: analysis.references.map(ref => ({ ...ref, source: object })), issues: analysis.issues };
            }
            next.set(id, entry);
            if (i % 20 === 19) { await new Promise<void>(resolve => setImmediate(resolve)); }
        }
        if (cancelled() || generation !== this.generation) { return false; }
        this.entries = next;
        this.knownObjects = known;
        this.outgoing.clear();
        this.incoming.clear();
        for (const entry of next.values()) {
            const edges = entry.edges.map(edge => ({ ...edge, target: known.get(objectId(edge.target)) ?? edge.target }));
            this.outgoing.set(objectId(entry.object), edges);
            for (const edge of edges) {
                const id = objectId(edge.target);
                const reverse = this.incoming.get(id) ?? [];
                reverse.push(edge);
                this.incoming.set(id, reverse);
            }
        }
        for (const edge of catalogEdges) {
            const from = objectId(edge.source), to = objectId(edge.target);
            const outgoing = this.outgoing.get(from) ?? []; outgoing.push(edge); this.outgoing.set(from, outgoing);
            const incoming = this.incoming.get(to) ?? []; incoming.push(edge); this.incoming.set(to, incoming);
        }
        return true;
    }
    getReport(root: ObjectReference, direction: 'outgoing' | 'incoming', maxDepth = 2, column?: string, maxNodes = 300): DependencyReport {
        const report: DependencyReport = { root, direction, edges: [], affected: [], issues: [], truncated: false };
        const visited = new Set([objectId(root)]);
        const pending = [{ object: root, depth: 0 }];
        const depthLimit = Math.min(Math.max(maxDepth, 1), 100);
        while (pending.length) {
            const current = pending.shift()!;
            if (current.depth >= depthLimit) { continue; }
            const map = direction === 'outgoing' ? this.outgoing : this.incoming;
            const edges = map.get(objectId(current.object)) ?? [];
            for (const edge of edges) {
                if (column && current.depth === 0 && direction === 'incoming' && edge.column !== column && edge.kind !== 'wildcard') { continue; }
                const object = direction === 'outgoing' ? edge.target : edge.source;
                if (report.edges.length >= 3000) { report.truncated = true; break; }
                report.edges.push(edge);
                if (visited.has(objectId(object))) { continue; }
                if (visited.size >= maxNodes) { report.truncated = true; continue; }
                visited.add(objectId(object));
                const depth = current.depth + 1;
                report.affected.push({ object, depth, severity: edge.confidence !== 'exact' || edge.kind === 'wildcard' ? 'low' : depth === 1 ? 'high' : 'medium',
                    reason: depth === 1 ? column ? `References ${column}; review the proposed change.` : 'Direct dependency; review the proposed change.' : 'Indirect dependency; potentially affected.' });
                pending.push({ object, depth });
            }
        }
        for (const entry of this.entries.values()) {
            for (const issue of entry.issues) { report.issues.push(`${entry.object.name}: ${issue}`); }
        }
        if (column) { report.issues.push('Column coverage is partial: ambiguous columns and complex derived-column lineage are not inferred.'); }
        if (!this.knownObjects.has(objectId(root))) { report.issues.push('Object is not present in the loaded catalog snapshot.'); }
        return report;
    }
}
