import { createLogConsole, appendLogRows, replaceLogRows } from '../grid/alternateViews';
import { getResultPanelWindow, type ResultSet, type LogRow } from '../types';
import { updateSqlQueueLogs } from '../sqlQueueLogs';
import { getActiveGridIndex } from '../state';

jest.mock('../state', () => ({ getActiveGridIndex: jest.fn(()=>0),addGrid:jest.fn(),getGlobalFilterState:jest.fn() }));
jest.mock('../grid/persistence', () => ({resolveScrollStateForResultSet:jest.fn(),applyScrollStateToTarget:jest.fn()}));
jest.mock('../protocol', () => ({postHostMessage:jest.fn()}));

test('console renders, appends and recovers grouped runs without duplicating initial rows', () => {
    document.body.innerHTML='<div id="gridContainer"></div>';
    const panel=getResultPanelWindow();panel.activeSource='file:///a.sql';panel.executingSources=new Set([panel.activeSource]);
    const rows: LogRow[]=[['now','RUNNING',{executionId:'a',event:'start',status:'running',sql:'SELECT 1'}]];
    const logs={isLog:true,columns:[],data:rows,executionTimestamp:1} as ResultSet;
    panel.resultSets=[logs];updateSqlQueueLogs('[]');
    createLogConsole(logs,0,document.getElementById('gridContainer')!);
    appendLogRows(0,[['later','Progress',{executionId:'a',event:'message'}]]);
    expect(document.querySelectorAll('.log-run')).toHaveLength(1);
    expect(document.querySelector('.log-run-body')?.textContent).toContain('Progress');
    replaceLogRows(0,[...rows,['later','SUCCESS',{executionId:'a',event:'end',status:'success'}]]);
    expect(document.querySelectorAll('.log-run')).toHaveLength(1);
    expect(document.querySelector('.log-run-summary')?.textContent).toContain('SUCCESS');
    document.querySelector('.console-wrapper')!.remove();
    appendLogRows(0,rows);
    expect(document.querySelectorAll('.log-run')).toHaveLength(1);
    document.querySelector('.console-view')!.remove();appendLogRows(0,rows);
    appendLogRows(99,rows);replaceLogRows(99,rows);
    (getActiveGridIndex as jest.Mock).mockReturnValue(1);
    createLogConsole(logs,0,document.createElement('div'));
});
