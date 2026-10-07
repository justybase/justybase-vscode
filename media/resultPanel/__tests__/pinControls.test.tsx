import { createResultSetTab } from '../tabs';
import { getResultPanelWindow, type ResultSet } from '../types';
const posted=jest.fn();
jest.mock('../protocol',()=>({postHostMessage:(message:unknown)=>posted(message)}));
jest.mock('../state',()=>({getActiveGridIndex:()=>0}));
jest.mock('../grid',()=>({updateControlsVisibility:jest.fn(),syncGlobalFilterInput:jest.fn()}));
jest.mock('../analysis',()=>({syncAnalysisView:jest.fn()}));
jest.mock('../filter',()=>({renderRowCountInfo:jest.fn()}));

test('manual pins show distinct SVG states and keyboard/click controls remain accessible',()=>{
    const panel=getResultPanelWindow();Object.assign(panel,{activeSource:'file:///a.sql',pinnedResults:[],executingSources:new Set()});
    const result={columns:[],data:[[1]],name:'Result 1'} as ResultSet;
    panel.resultSets=[{columns:[],data:[],isLog:true} as ResultSet,result];
    const tab=createResultSetTab(result,1);document.body.append(tab);
    const button=tab.querySelector<HTMLElement>('.pin-icon')!;
    expect(button.getAttribute('aria-pressed')).toBe('false');expect(button.querySelector('svg')?.getAttribute('fill')).toBe('none');
    button.click();
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    button.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));
    button.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    // jsdom does not synthesize native button clicks from keyboard events.
    expect(button.tagName).toBe('BUTTON');
    expect(posted).toHaveBeenCalledTimes(1);
    expect(posted).toHaveBeenCalledWith({command:'toggleResultPin',sourceUri:'file:///a.sql',resultSetIndex:1,resultSetId:undefined});
    Object.assign(panel,{pinnedResults:[{sourceUri:'file:///a.sql',resultSetIndex:1}]});
    const pinned=createResultSetTab({...result,name:undefined},1);
    expect(pinned.classList.contains('is-pinned')).toBe(true);
    expect(pinned.querySelector('.pin-icon')?.getAttribute('aria-pressed')).toBe('true');
    expect(pinned.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
});
