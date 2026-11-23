/**
 * Plans the DuckDB foreign keys that reproduce Microsoft Access enforced
 * relationships.
 *
 * Verified against DAO 16 (see `scripts/access-com-crosscheck.cjs`):
 *
 *   enforced, no cascade      rejects an orphan child row, blocks a parent
 *                             delete/update that is still referenced
 *   not enforced              Access itself does not check it
 *   ON DELETE/UPDATE CASCADE  Access updates/deletes the children
 *   composite key             every component NULL is allowed, a partial
 *                             NULL is rejected, and a mixed non-NULL match
 *                             must exist in the parent
 *
 * DuckDB can express the first case only, and only when the referenced key is
 * a real `PRIMARY KEY`/`UNIQUE` constraint (`ALTER TABLE ... ADD CONSTRAINT`
 * is not implemented, so the constraint must be inline).  It also compares key
 * columns binary, while Access ignores case and trailing spaces for text keys,
 * so a text key cannot back a DuckDB foreign key without rejecting rows Access
 * accepts.  Those relationships are therefore skipped with a warning instead
 * of being enforced with different semantics.
 */

import type {
    AccessColumnDefinition,
    AccessRelationshipDefinition,
    AccessTableDefinition,
} from '@justybase/access-file';
import type { AccessMirrorKeyPlan } from './accessMirrorKeys';
import { isAccessTextColumn } from './accessMirrorKeys';

export interface AccessMirrorReferencePlan {
    /** Constraint name inside the DuckDB mirror. */
    readonly name: string;
    /** Relationship name stored in the Access file. */
    readonly accessName: string;
    readonly childTable: string;
    readonly childColumns: readonly string[];
    readonly parentTable: string;
    readonly parentColumns: readonly string[];
    /** Parent key that makes the reference bindable (`PRIMARY KEY`/`UNIQUE`). */
    readonly parentKeyName: string;
    /** CHECK expressions that reproduce Access' all-or-nothing NULL rule. */
    readonly nullGuards: readonly string[];
}

export interface AccessMirrorReferencePlanResult {
    readonly references: readonly AccessMirrorReferencePlan[];
    readonly warnings: readonly string[];
    /** Child table -> parent tables it depends on. */
    readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>;
}

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

function hashedReferenceName(relationshipName: string): string {
    const source = relationshipName;
    let hash = 2166136261;
    for (const character of source) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619);
    }
    return `__access_fk_${(hash >>> 0).toString(16)}`;
}

function columnBy(
    definition: AccessTableDefinition,
    name: string,
): AccessColumnDefinition | undefined {
    const lower = name.toLowerCase();
    return definition.columns.find(column => column.name.toLowerCase() === lower);
}

/**
 * Access requires all-or-nothing NULL in a composite foreign key, while SQL
 * lets a partial NULL through unchecked.  One equality chain per column
 * reproduces the Access verdict.
 */
function buildNullGuards(columns: readonly string[]): string[] {
    if (columns.length < 2) {
        return [];
    }
    const [first, ...rest] = columns.map(quoteIdentifier);
    return rest.map(column => `((${first} IS NULL) = (${column} IS NULL))`);
}

export interface AccessMirrorReferencePlanInput {
    readonly definitions: readonly AccessTableDefinition[];
    readonly relationships: readonly AccessRelationshipDefinition[];
    readonly keysByTable: ReadonlyMap<string, readonly AccessMirrorKeyPlan[]>;
    /** DuckDB type of a column, so type mismatches are refused up front. */
    readonly typeOf: (column: AccessColumnDefinition) => string;
}

export function planAccessMirrorReferences(
    input: AccessMirrorReferencePlanInput,
): AccessMirrorReferencePlanResult {
    const references: AccessMirrorReferencePlan[] = [];
    const warnings: string[] = [];
    const cascadeNotes: string[] = [];
    const dependencies = new Map<string, Set<string>>();
    const byName = new Map(
        input.definitions.map(definition => [definition.name.toLowerCase(), definition]),
    );

    for (const relationship of input.relationships) {
        if (!relationship.enforced) {
            // Access stores "not enforced" as a flag and skips the check
            // itself, so the mirror must not add one either.
            continue;
        }
        if (relationship.updateCascade || relationship.deleteCascade) {
            // The staged writer changes one table at a time and has no cascade
            // engine, so reproducing the cascade is impossible.  Skipping the
            // key would let the mirror accept a parent delete that leaves
            // orphan children in the file, which Access would never produce;
            // enforcing the key without cascade refuses that operation
            // instead.  Failing closed keeps written files valid.
            cascadeNotes.push(
                `Relationship '${relationship.name}' is enforced without its cascade action: `
                + 'a parent delete or key update that Access would cascade to child rows is refused, '
                + 'because the staged writer changes one table at a time.',
            );
        }
        const child = byName.get(relationship.table.toLowerCase());
        const parent = byName.get(relationship.foreignTable.toLowerCase());
        if (!child || !parent) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'it references a table this file does not expose.',
            );
            continue;
        }
        if (child.name.toLowerCase() === parent.name.toLowerCase()) {
            // Rows load in file order, so a self-referencing child can appear
            // before its parent row; the same for cyclic graphs.
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'self-referencing keys would reject rows Access stores in file order.',
            );
            continue;
        }
        if (relationship.columns.length === 0
            || relationship.columns.length !== relationship.foreignColumns.length) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'the file pairs a different number of columns.',
            );
            continue;
        }

        const childColumns: AccessColumnDefinition[] = [];
        let missing = false;
        for (const name of relationship.columns) {
            const column = columnBy(child, name);
            if (!column) {
                missing = true;
                break;
            }
            childColumns.push(column);
        }
        if (missing) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'the child table does not expose every key column.',
            );
            continue;
        }
        const parentColumns: AccessColumnDefinition[] = [];
        for (const name of relationship.foreignColumns) {
            const column = columnBy(parent, name);
            if (!column) {
                missing = true;
                break;
            }
            parentColumns.push(column);
        }
        if (missing) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'the referenced table does not expose every key column.',
            );
            continue;
        }

        if (parentColumns.some(isAccessTextColumn)) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'Access matches text keys ignoring case and trailing spaces, and a DuckDB foreign key '
                + 'compares them binary, so it would reject values Access accepts.',
            );
            continue;
        }

        const parentTypes = parentColumns.map(input.typeOf);
        if (childColumns.some((column, position) => input.typeOf(column) !== parentTypes[position])) {
            // DAO rejects a relationship between different field types, but a
            // file can still carry it; DuckDB refuses to bind the key.
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'the paired columns have different DuckDB types, which a foreign key cannot match.',
            );
            continue;
        }

        const coveringKey = (input.keysByTable.get(parent.name.toLowerCase()) ?? []).find(key =>
            key.asConstraint
            && key.columns.length === relationship.foreignColumns.length
            && key.columns.every((name, position) =>
                name.toLowerCase() === relationship.foreignColumns[position]!.toLowerCase()));
        if (!coveringKey) {
            warnings.push(
                `Relationship '${relationship.name}' was mirrored without a foreign key: `
                + 'the referenced columns have no DuckDB primary key or unique constraint to point at.',
            );
            continue;
        }

        const childNames = childColumns.map(column => column.name);
        references.push({
            name: hashedReferenceName(relationship.name),
            accessName: relationship.name,
            childTable: child.name,
            childColumns: childNames,
            parentTable: parent.name,
            parentColumns: parentColumns.map(column => column.name),
            parentKeyName: coveringKey.accessIndex,
            nullGuards: buildNullGuards(childNames),
        });
        const parents = dependencies.get(child.name.toLowerCase()) ?? new Set<string>();
        parents.add(parent.name.toLowerCase());
        dependencies.set(child.name.toLowerCase(), parents);
    }

    return { references, warnings: [...warnings, ...cascadeNotes], dependencies };
}

/** Inline `FOREIGN KEY` clause for a `CREATE TABLE` statement. */
export function accessMirrorReferenceSql(reference: AccessMirrorReferencePlan): string {
    const columns = reference.childColumns.map(quoteIdentifier).join(', ');
    const parentColumns = reference.parentColumns.map(quoteIdentifier).join(', ');
    return `CONSTRAINT ${quoteIdentifier(reference.name)} FOREIGN KEY (${columns}) `
        + `REFERENCES ${quoteIdentifier(reference.parentTable)} (${parentColumns})`;
}

/**
 * Orders tables so every referenced table is created (and therefore holds its
 * rows) before the tables that point at it.  Tables involved in a cycle keep a
 * deterministic order; the caller drops the references that still point
 * forward.
 */
export function orderTablesForMirror(
    names: readonly string[],
    dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
    const canonical = new Map(names.map(name => [name.toLowerCase(), name]));
    const emitted = new Set<string>();
    const visiting = new Set<string>();
    const ordered: string[] = [];

    const visit = (lower: string): void => {
        if (emitted.has(lower) || visiting.has(lower)) {
            // A table already emitted is done; one still being visited closes
            // a cycle, so it is emitted by the caller's frame instead.
            return;
        }
        const name = canonical.get(lower);
        if (!name) {
            return;
        }
        visiting.add(lower);
        for (const parent of dependencies.get(lower) ?? []) {
            visit(parent.toLowerCase());
        }
        visiting.delete(lower);
        emitted.add(lower);
        ordered.push(name);
    };

    for (const name of names) {
        visit(name.toLowerCase());
    }

    return ordered;
}
