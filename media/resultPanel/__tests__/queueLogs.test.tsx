import { updateSqlQueueLogs, renderSqlQueueLogs } from '../sqlQueueLogs';
import { appendRunLogRows } from '../logRunGroups';
import { getResultPanelWindow } from '../types';

const posted = jest.fn();
jest.mock('../protocol', () => ({ postHostMessage: (message: unknown) => posted(message) }));

describe('SQL queue and grouped Logs', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div class="console-wrapper"><div class="console-view"></div></div>';
        getResultPanelWindow().activeSource = 'file:///a.sql';
        posted.mockClear();
        updateSqlQueueLogs('[]');
    });
    const lane = () => ({ sourceUri:'file:///a.sql',sourceKey:'lane',maxConcurrency:20,paused:false,
        running:[{id:'a',status:'running',sql:'SELECT <unsafe>',executionUri:'file:///a.sql#query-a',database:'DB'}],
        queued:[{id:'b',status:'queued',sql:'SELECT 2'}, {id:'c',status:'preparing',sql:'SELECT 3'}] });
    test('counts, disclosures, escaping and distinct control semantics', () => {
        updateSqlQueueLogs(JSON.stringify([lane()]));
        expect(document.querySelector('strong')?.textContent).toBe('1 running / 20 · 2 queued');
        expect(document.querySelector('unsafe')).toBeNull();
        const buttons=[...document.querySelectorAll('button')];
        for (const button of buttons) button.click();
        expect(posted.mock.calls.map(([message])=>message.action)).toEqual(['pause','clear','cancel','remove','remove']);
        expect(posted.mock.calls[2][0].jobId).toBe('a');
        const job=document.querySelector<HTMLDetailsElement>('details')!;
        job.open=true;job.dispatchEvent(new Event('toggle'));
        updateSqlQueueLogs(JSON.stringify([lane()]));
        expect(document.querySelector<HTMLDetailsElement>('details')!.open).toBe(true);
        expect(document.querySelector('.sql-queue-job-detail')?.textContent).toContain('Database: DB');
    });
    test('pause, cancellation, standalone mode, no lane, malformed JSON, and completed archives', () => {
        updateSqlQueueLogs('invalid JSON');
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        const state={...lane(),maxConcurrency:1,paused:true,queued:[],running:[{id:'a',status:'cancelling',sql:'SELECT 1'}]};
        updateSqlQueueLogs(JSON.stringify([state]));
        expect(document.querySelector('strong')?.textContent).toBe('1 running · 0 queued · Paused');
        document.querySelector('button')!.click();expect(posted.mock.calls[0][0].action).toBe('resume');
        expect(document.querySelector<HTMLButtonElement>('.sql-queue-job button')!.disabled).toBe(true);
        getResultPanelWindow().activeSource='file:///other.sql';updateSqlQueueLogs();
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        getResultPanelWindow().activeSource='file:///a.sql#query-finished';
        const archive={sourceUri:'file:///a.sql#query-old',rows:[['now','✓ SUCCESS: SELECT 4',{executionId:'old',event:'end',status:'success'}]]};
        updateSqlQueueLogs(JSON.stringify([{...lane(),running:[],queued:[],sources:['file:///a.sql#query-finished'],archive:[archive]}]));
        expect(document.querySelector('.log-run-summary')?.textContent).toContain('SUCCESS');
        expect(document.querySelector('.sql-queue-overview')).toBeNull();
        getResultPanelWindow().activeSource='file:///a.sql#query-a';
        updateSqlQueueLogs(JSON.stringify([lane()]));expect(document.querySelector('.sql-queue-overview')).not.toBeNull();
        getResultPanelWindow().activeSource='file:///a.sql#query-last';
        updateSqlQueueLogs(JSON.stringify([{...lane(),lastExecutionUri:'file:///a.sql#query-last'}]));
        expect(document.querySelector('.sql-queue-overview')).not.toBeNull();
        renderSqlQueueLogs(document.createElement('div'));
    });
    test('execution metadata groups only its own messages and survives append and rebuild', () => {
        const container=document.querySelector<HTMLElement>('.console-view')!;
        const line=(row: unknown[])=>{const element=document.createElement('div');element.textContent=String(row[1]);return element;};
        appendRunLogRows(container,[['now','Legacy message'],['now','RUNNING',{executionId:'run',event:'start',status:'running',sql:'SELECT <unsafe>'}]],line);
        expect(container.querySelectorAll('details')).toHaveLength(1);
        const run=container.querySelector('details')!;run.open=true;run.dispatchEvent(new Event('toggle'));
        appendRunLogRows(container,[['now','Progress',{executionId:'run',event:'message'}],['later','SUCCESS',{executionId:'run',event:'end',status:'success'}]],line);
        expect(run.open).toBe(true);expect(run.dataset.status).toBe('success');expect(run.querySelector('.log-run-body')?.textContent).toContain('Progress');
        expect(run.querySelector('summary')?.textContent).toContain('SUCCESS');expect(run.querySelector('unsafe')).toBeNull();
        container.innerHTML='';appendRunLogRows(container,[['now','RUNNING',{executionId:'run',event:'start',status:'running'}]],line);
        expect(container.querySelector('details')!.open).toBe(true);
        for(let i=0;i<501;i++){
            const target=document.createElement('div');appendRunLogRows(target,[['','',{executionId:'r'+i,event:'start'}]],line);
            target.querySelector('details')!.dispatchEvent(new Event('toggle'));
        }
    });
});
