import { updateSqlQueueLogs, renderSqlQueueLogs } from '../sqlQueueLogs';
import { appendRunLogRows } from '../logRunGroups';

const posted = jest.fn();
jest.mock('../protocol', () => ({ postHostMessage: (message: unknown) => posted(message) }));

describe('SQL queue and grouped Logs', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="console-wrapper"><div class="console-view"></div></div>';
        posted.mockClear();
        updateSqlQueueLogs('[]', 'file:///a.sql');
    });
    const lane = () => ({ sourceUri:'file:///a.sql',sourceKey:'lane',maxConcurrency:20,paused:false,
        running:[{id:'a',status:'running',sql:'SELECT <unsafe>',executionUri:'file:///a.sql#query-a',database:'DB'}],
        queued:[{id:'b',status:'queued',sql:'SELECT 2'}, {id:'c',status:'preparing',sql:'SELECT 3'}] });
    test('counts, disclosures, escaping and distinct control semantics', () => {
        updateSqlQueueLogs(JSON.stringify([lane()]), 'file:///a.sql');
        expect(document.querySelector('strong')?.textContent).toBe('1 running / 20 · 2 queued');
        expect(document.querySelector('unsafe')).toBeNull();
        const buttons=[...document.querySelectorAll('button')];
        // Queue controls sit inside <summary>: they must not submit forms or
        // toggle the disclosure when clicked.
        for (const button of buttons) expect(button.type).toBe('button');
        for (const button of buttons) button.click();
        expect(posted.mock.calls.map(([message])=>message.action)).toEqual(['pause','clear','cancel','remove','remove']);
        expect(posted.mock.calls[2][0].jobId).toBe('a');
        const job=document.querySelector<HTMLDetailsElement>('details')!;
        job.open=true;job.dispatchEvent(new Event('toggle'));
        updateSqlQueueLogs(JSON.stringify([lane()]), 'file:///a.sql');
        expect(document.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
        expect(document.querySelector('.sql-queue-job-detail')?.textContent).toContain('Database: DB');
    });
    test('pause, cancellation, standalone mode, no lane, malformed JSON, and completed archives', () => {
        updateSqlQueueLogs('invalid JSON', 'file:///a.sql');
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        const state={...lane(),maxConcurrency:1,paused:true,queued:[],running:[{id:'a',status:'cancelling',sql:'SELECT 1'}]};
        updateSqlQueueLogs(JSON.stringify([state]), 'file:///a.sql');
        expect(document.querySelector('strong')?.textContent).toBe('1 running · 0 queued · Paused');
        // Queue rows are static: only the Logs tab header animates progress.
        expect(document.querySelectorAll('.sql-queue-job-status .log-status-icon-spinner')).toHaveLength(0);
        document.querySelector('button')!.click();expect(posted.mock.calls[0][0].action).toBe('resume');
        expect(document.querySelector<HTMLButtonElement>('.sql-queue-job button')!.disabled).toBe(true);
        updateSqlQueueLogs(JSON.stringify([lane()]), 'file:///a.sql');
        expect(document.querySelectorAll('.sql-queue-job-status .log-status-icon-spinner')).toHaveLength(0);
        expect(document.querySelector('.sql-queue-job[data-status="running"] .sql-queue-job-status')?.textContent).toBe('RUNNING');
        updateSqlQueueLogs(undefined, 'file:///other.sql');
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        const archive={sourceUri:'file:///a.sql#query-old',rows:[['now','✓ SUCCESS: SELECT 4',{executionId:'old',event:'end',status:'success'}]]};
        updateSqlQueueLogs(JSON.stringify([{...lane(),running:[],queued:[],sources:['file:///a.sql#query-finished'],archive:[archive]}]), 'file:///a.sql#query-finished');
        expect(document.querySelector('.log-run-summary')?.textContent).toContain('SUCCESS');
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        updateSqlQueueLogs(JSON.stringify([lane()]), 'file:///a.sql#query-a');expect(document.querySelector('.sql-queue-overview')).not.toBeNull();
        updateSqlQueueLogs(JSON.stringify([{...lane(),lastExecutionUri:'file:///a.sql#query-last'}]), 'file:///a.sql#query-last');
        expect(document.querySelector('.sql-queue-overview')).not.toBeNull();
        renderSqlQueueLogs(document.createElement('div'));
    });
    test('execution metadata groups only its own messages and survives append and rebuild', () => {
        const container=document.querySelector<HTMLElement>('.console-view')!;
        const line=(row: unknown[])=>{const element=document.createElement('div');element.textContent=String(row[1]);return element;};
        appendRunLogRows(container,[['now','Legacy message'],['now','RUNNING',{executionId:'run',event:'start',status:'running',sql:'SELECT <unsafe>'}]],line);
        expect(container.querySelectorAll('details')).toHaveLength(1);
        // Transcript badges stay static; the animated ring lives in the tab
        // header, so one query does not paint several indicators.
        expect(container.querySelector('.log-status--running .log-status-icon-spinner')).toBeNull();
        expect(container.querySelector('.log-status--running .log-status-icon')?.textContent).toBe('▶');
        const run=container.querySelector('details')!;run.open=true;run.dispatchEvent(new Event('toggle'));
        appendRunLogRows(container,[['now','Progress',{executionId:'run',event:'message'}],['later','SUCCESS',{executionId:'run',event:'end',status:'success'}]],line);
        expect(run.open).toBe(true);expect(run.dataset.status).toBe('success');expect(run.querySelector('.log-run-body')?.textContent).toContain('Progress');
        expect(run.querySelector('summary')?.textContent).toContain('SUCCESS');
        expect(run.querySelector('.log-status--success .log-status-icon-spinner')).toBeNull();
        expect(run.querySelector('unsafe')).toBeNull();
        container.innerHTML='';appendRunLogRows(container,[['now','RUNNING',{executionId:'run',event:'start',status:'running'}]],line);
        expect(container.querySelector('details')!.open).toBe(true);
        for(let i=0;i<501;i++){
            const target=document.createElement('div');appendRunLogRows(target,[['','',{executionId:'r'+i,event:'start'}]],line);
            target.querySelector('details')!.dispatchEvent(new Event('toggle'));
        }
    });
    test('compacts long echoed SQL in grouped error summaries and lines', () => {
        const container=document.querySelector<HTMLElement>('.console-view')!;
        const line=(row: unknown[])=>{const element=document.createElement('div');element.textContent=String(row[1]);return element;};
        const longSql = `SELECT ${Array.from({ length: 80 }, (_value, index) => `COL_${index}`).join(', ')} FROM T`;
        const message = `✗ ERROR: SELECT 1 | CONN | 10 ms | 1 row | ERROR:  '${longSql}'\nerror ^ found "," (at char 10) expecting an identifier`;
        appendRunLogRows(container,[
            ['now','RUNNING',{executionId:'err',event:'start',status:'running'}],
            ['later', message, {executionId:'err',event:'end',status:'error'}]
        ],line);
        const hint=container.querySelector('.log-error-hint')?.textContent ?? '';
        expect(hint).toContain('found "," (at char 10)');
        expect(hint).not.toContain('COL_40');
        expect(container.querySelector('.log-run-summary')?.textContent).not.toContain('COL_40');
    });
});
