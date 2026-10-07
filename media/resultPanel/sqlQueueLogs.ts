import { appendRunLogRows } from './logRunGroups.js';
import type { LogRow } from './types.js';
import { postHostMessage } from './protocol.js';
import { getActiveSourceUri } from './types.js';

interface QueueJob { id: string; sql: string; status: string; executionUri?: string; database?: string }
interface QueueLane { sourceKey: string; sourceUri: string; lastExecutionUri?: string; paused: boolean; recoveryRequired?: boolean; workspace?: boolean; maxConcurrency: number; running: QueueJob[]; queued: QueueJob[]; sources?: string[]; archive?: {sourceUri: string; rows: LogRow[]}[] }
let lanes: QueueLane[] = [];
const disclosures = new Map<string, boolean>();

/** A presentation of coordinator state; this module never owns scheduling. */
export function updateSqlQueueLogs(json?: string): void {
    if (json !== undefined) {
        try { lanes = JSON.parse(json) as QueueLane[];
            const live = new Set(lanes.flatMap(lane => [...lane.running, ...lane.queued].map(job => job.id)));
            for (const id of disclosures.keys()) if (!live.has(id)) disclosures.delete(id);
        } catch { return; }
    }
    document.querySelectorAll<HTMLElement>('.console-wrapper').forEach(renderSqlQueueLogs);
}

export function renderSqlQueueLogs(wrapper: HTMLElement): void {
    wrapper.querySelector('.sql-queue-overview')?.remove();
    const source = getActiveSourceUri();
    const lane = lanes.find(item => item.sourceUri === source || item.running.some(job => job.executionUri === source)
        || (source !== undefined && (item.lastExecutionUri === source || item.sources?.includes(source))));
    const transcript = wrapper.querySelector<HTMLElement>('.console-view');
    transcript?.querySelector('.log-run-archive')?.remove();
    if (lane && transcript && !lane.workspace) {
        const archive = document.createElement('div');
        archive.className = 'log-run-archive';
        const rows = (lane.archive ?? []).filter(item => item.sourceUri !== source).flatMap(item => item.rows);
        appendRunLogRows(archive, rows, row => { const line = document.createElement('div'); line.className = 'console-line'; line.textContent = `[${String(row[0] ?? '')}] ${String(row[1] ?? '')}`; return line; });
        transcript.prepend(archive);
    }
    if (!lane || (!lane.running.length && !lane.queued.length && !lane.paused && !lane.recoveryRequired)) return;
    const overview = document.createElement('section');
    overview.className = 'sql-queue-overview';
    overview.setAttribute('aria-label', 'SQL execution queue');
    const title = document.createElement('strong');
    title.textContent = `${lane.running.length} running${lane.maxConcurrency > 1 ? ` / ${lane.maxConcurrency}` : ''} · ${lane.queued.length} queued${lane.recoveryRequired ? ' · Recovery required' : lane.paused ? ' · Paused' : ''}`;
    overview.append(title);
    const action = (label: string, command: string, job?: QueueJob) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', event => {
            // Job controls live inside <summary>: without these the click also
            // toggles the <details> disclosure (and a submit default in forms).
            event.preventDefault();
            event.stopPropagation();
            postHostMessage({ command: 'sqlQueueAction', sourceKey: lane.sourceKey, action: command, jobId: job?.id });
        });
        return button;
    };
    const controls = document.createElement('div');
    controls.className = 'sql-queue-controls';
    controls.append(action(lane.paused ? 'Resume queue' : 'Pause queue', lane.paused ? 'resume' : 'pause'));
    if (lane.recoveryRequired) controls.append(action('Recover connection…', 'recover'));
    if (lane.queued.length) controls.append(action('Clear queued', 'clear'));
    overview.append(controls);
    const list = document.createElement('div');
    list.className = 'sql-queue-jobs';
    [...lane.running, ...lane.queued].forEach((job, index) => {
        const row = document.createElement('details');
        row.open = disclosures.get(job.id) ?? false;
        row.addEventListener('toggle', () => disclosures.set(job.id, row.open));
        const summary = document.createElement('summary');
        summary.className = 'sql-queue-job-summary';
        row.className = 'sql-queue-job';
        row.dataset.status = job.status;
        const status = document.createElement('span');
        status.className = 'sql-queue-job-status';
        status.textContent = job.status === 'queued' ? `QUEUED #${index - lane.running.length + 1}` : job.status.toUpperCase();
        const sql = document.createElement('code');
        sql.textContent = job.sql.replace(/\s+/g, ' ').slice(0, 180);
        sql.title = `${job.database ?? ''}\n${job.sql}`;
        const control = action(index < lane.running.length ? 'Cancel' : 'Remove', index < lane.running.length ? 'cancel' : 'remove', job);
        control.disabled = job.status === 'cancelling';
        summary.append(status, sql, control);
        const detail = document.createElement('pre');
        detail.className = 'sql-queue-job-detail';
        detail.textContent = `${job.database ? 'Database: ' + job.database + '\n\n' : ''}${job.sql}`;
        row.append(summary, detail);
        list.append(row);
    });
    overview.append(list);
    wrapper.prepend(overview);
}
