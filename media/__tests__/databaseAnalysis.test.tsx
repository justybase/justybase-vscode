export {};
test('analysis webview protocol, keyboard navigation and bounded graph controls', async () => {
    document.body.innerHTML=`<button data-command="open" data-index="0">Open</button><button data-command="refresh">Refresh</button>
        <button data-command="plan" data-nodes="1,2">Plan</button><button id="empty-plan" data-command="plan">Empty</button>
        <select id="depth"><option value="2">2</option><option value="3">3</option></select>
        <details id="plan"><summary>Plan</summary><pre id="plan-1" class="highlight">Scan</pre><pre id="plan-2">Join</pre></details>
        <svg id="graph"><g data-command="open" data-index="1"><rect/></g></svg>`;
    const posted=jest.fn();Object.assign(globalThis,{acquireVsCodeApi:()=>({postMessage:posted})});
    const graph=document.getElementById('graph') as unknown as SVGSVGElement;
    const box={x:0,y:0,width:600,height:300};
    Object.defineProperty(graph,'viewBox',{value:{baseVal:box}});
    Object.defineProperty(graph,'setPointerCapture',{value:jest.fn()});
    let size=600;
    graph.getBoundingClientRect=()=>({x:0,y:0,width:size,height:300,top:0,right:size,bottom:300,left:0,toJSON:()=>({})});
    document.getElementById('plan-1')!.scrollIntoView=jest.fn();
    await import('../databaseAnalysis');
    document.querySelector<HTMLButtonElement>('[data-command="open"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-command="refresh"]')!.click();
    const select=document.getElementById('depth') as HTMLSelectElement;select.value='3';select.dispatchEvent(new Event('change'));
    document.querySelector('g')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    document.querySelector('g')!.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));
    document.querySelector('g')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    document.body.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    expect(posted.mock.calls.map(([message])=>message)).toEqual([{command:'open',index:0},{command:'refresh',index:undefined},{command:'depth',value:'3'},{command:'open',index:1},{command:'open',index:1}]);
    document.querySelector<HTMLButtonElement>('[data-command="plan"]')!.click();
    expect(document.querySelector<HTMLDetailsElement>('#plan')!.open).toBe(true);
    expect(document.getElementById('plan-2')!.classList.contains('highlight')).toBe(true);
    document.getElementById('empty-plan')!.click();expect(document.querySelectorAll('.highlight')).toHaveLength(0);
    graph.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));expect(box.width).toBeLessThan(600);
    graph.dispatchEvent(new WheelEvent('wheel',{deltaY:100}));expect(box.width).toBeCloseTo(600);
    const pointer=(type:string,x:number,y:number,target:Element=graph)=>target.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,bubbles:true}));
    pointer('pointermove',40,20);expect(box.x).toBeCloseTo(0);
    pointer('pointerdown',10,10,document.querySelector('g')!);pointer('pointermove',40,20);expect(box.x).toBeCloseTo(0);
    pointer('pointerdown',10,10);pointer('pointermove',50,20);expect(box.x).toBeLessThan(0);
    const previous=box.x;size=0;pointer('pointermove',80,20);expect(box.x).toBe(previous);
    pointer('pointerup',80,20);size=600;pointer('pointermove',100,40);expect(box.x).toBe(previous);
    pointer('pointercancel',0,0);pointer('lostpointercapture',0,0);
});
