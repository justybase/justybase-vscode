import type { ExecutionLogDetails } from '../../src/contracts/webviews/executionLogContracts';
import type { LogRow } from './types.js';

const disclosures = new Map<string, boolean>();
/** Groups by execution identity, including incremental messages and terminal updates. */
export function appendRunLogRows(container: HTMLElement, rows: LogRow[], createLine: (row: LogRow) => HTMLElement): void {
    for (const row of rows) {
        const metadata = row[2] as ExecutionLogDetails | undefined;
        if (!metadata?.executionId) { container.append(createLine(row)); continue; }
        let run = [...container.querySelectorAll<HTMLDetailsElement>('details.log-run')].find(item => item.dataset.executionId === metadata.executionId);
        if (!run) {
            run = document.createElement('details');
            run.className = 'log-run';
            run.dataset.executionId = metadata.executionId;
            run.open = disclosures.get(metadata.executionId) ?? false;
            const summary = document.createElement('summary');
            summary.className = 'log-run-summary';
            const body = document.createElement('div');
            body.className = 'log-run-body';
            run.append(summary, body);
            run.addEventListener('toggle', () => {
                disclosures.set(metadata.executionId, run!.open);
                if (disclosures.size > 500) disclosures.delete(disclosures.keys().next().value!);
            });
            container.append(run);
        }
        if (metadata.event === 'start' || metadata.event === 'end') {
            run.querySelector('summary')!.textContent = `[${String(row[0] ?? '')}] ${String(row[1] ?? '')}`;
            run.dataset.status = metadata.status;
        }
        const body = run.querySelector<HTMLElement>('.log-run-body')!;
        if (metadata.sql) {
            const sql = document.createElement('pre');
            sql.className = 'log-run-sql';
            sql.textContent = metadata.sql;
            body.append(sql);
        }
        body.append(createLine(row));
    }
}
