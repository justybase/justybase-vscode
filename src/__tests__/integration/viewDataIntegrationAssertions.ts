import { expect } from '@jest/globals';
import type { DatabaseConnection, DatabaseKind } from '../../contracts/database';
import { buildEditDataQueryPlan } from '../../views/editDataQuery';

export interface ReadOnlyViewDataTarget {
    database: string;
    schema: string;
    table: string;
    kind: DatabaseKind;
}

/**
 * Executes the production read-only View Data plan against a live connection.
 * This guards dialect qualification and native row-limit syntax (LIMIT vs
 * TOP vs FETCH FIRST) in addition to the absence of Netezza's ROWID.
 */
export async function expectReadOnlyViewDataQuery(
    connection: DatabaseConnection,
    target: ReadOnlyViewDataTarget,
    expectedRowCount?: number,
): Promise<void> {
    const plan = buildEditDataQueryPlan({
        database: target.database,
        schema: target.schema,
        table: target.table,
        databaseKind: target.kind,
        editable: false,
        rowLimit: 100,
    });

    const reader = await connection.createCommand(plan.sql).executeReader();
    try {
        expect(reader.fieldCount).toBeGreaterThan(0);
        let rowCount = 0;
        while (await reader.read()) {
            rowCount++;
        }
        if (expectedRowCount !== undefined) {
            expect(rowCount).toBe(expectedRowCount);
        }
    } finally {
        await reader.close();
    }
}
