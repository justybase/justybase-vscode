import { test, expect } from '@playwright/test';
import path from 'path';

test('analysis bundle supports navigation, graph pan/zoom, depth and explain highlights', async ({ page }) => {
    await page.setContent(`<button data-command="open" data-index="0">Object</button><button data-command="plan" data-nodes="1,2">Steps</button>
        <select id="depth"><option value="2">2</option><option value="3">3</option></select>
        <svg id="graph" width="600" height="300" viewBox="0 0 600 300"><g data-command="open" data-index="1" tabindex="0" role="button"><rect width="100" height="50" fill="blue"/></g></svg>
        <details id="plan"><summary>Plan</summary><pre id="plan-1">Scan</pre><pre id="plan-2">Join</pre></details>`);
    await page.evaluate(() => {
        const target = window as unknown as { acquireVsCodeApi: () => {postMessage:(message:unknown)=>void}; messages:unknown[] };
        target.messages=[];target.acquireVsCodeApi=()=>({postMessage:message=>target.messages.push(message)});
    });
    await page.addScriptTag({ path:path.resolve(__dirname,'../../dist/media/databaseAnalysis.js') });
    await page.getByRole('button',{name:'Object',exact:true}).click();
    await page.locator('#depth').selectOption('3');
    await expect.poll(()=>page.evaluate(()=> (window as unknown as {messages:unknown[]}).messages)).toEqual([{command:'open',index:0},{command:'depth',value:'3'}]);
    const graph=page.locator('#graph');const box=await graph.boundingBox();expect(box).not.toBeNull();
    const initial=await graph.getAttribute('viewBox');
    await graph.hover();await page.mouse.wheel(0,-100);
    await expect.poll(()=>graph.getAttribute('viewBox')).not.toBe(initial);
    const zoomed=await graph.getAttribute('viewBox');
    await page.mouse.move(box!.x+300,box!.y+150);await page.mouse.down();await page.mouse.move(box!.x+400,box!.y+200);await page.mouse.up();
    await expect.poll(()=>graph.getAttribute('viewBox')).not.toBe(zoomed);
    await page.getByRole('button',{name:'Steps'}).click();
    await expect(page.locator('#plan')).toHaveAttribute('open','');
    await expect(page.locator('#plan-1')).toHaveClass('highlight');await expect(page.locator('#plan-2')).toHaveClass('highlight');
});
