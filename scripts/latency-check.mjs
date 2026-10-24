// Local fixture only: measures the real websocket/input/paint path without playing a daily game.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launchBrowser, contextOptions } from '../browser.mjs';

process.env.PORT = '3070';
process.env.POC_DATA_DIR = '.poc/latency';
const { server, sessions, shutdown } = await import('../server.mjs');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
const browser = await launchBrowser();
const gameBrowser = await launchBrowser();
const context = await browser.newContext({ ...contextOptions, viewport: { width: 1440, height: 1100 } });
const viewer = await context.newPage();
await viewer.addInitScript(() => {
  const Original = WebSocket;
  window.WebSocket = class extends Original { constructor(...args) { super(...args); window.testSocket = this; } };
});
try {
  await viewer.goto('http://localhost:3070');
  await viewer.waitForFunction(() => window.testSocket?.readyState === 1);
  const id = (await context.cookies()).find(cookie => cookie.name === 'dp67').value;
  const session = sessions.get(id);
  session.context = await gameBrowser.newContext(contextOptions);
  const fixture = await session.context.newPage();
  session.pages.set('krillion', fixture);
  await fixture.setContent(`
    <body style="margin:0;background:rgb(0,0,200)"><div id="tick" style="position:absolute;width:2px;height:2px;background:white"></div><script>
      function tick(t) { document.querySelector('#tick').style.left = (t % 100) + 'px'; requestAnimationFrame(tick); } requestAnimationFrame(tick);
      window.clicks = 0;
      addEventListener('mousedown', () => { window.clicks++; document.body.style.background = 'rgb(200,0,0)'; });
      addEventListener('mouseup', () => window.released = true);
      addEventListener('mousemove', e => window.lastX = e.clientX);
    </script></body>`);
  await viewer.getByRole('button', { name: 'Start your pipeline' }).click();
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === 'Krillion is live');
  await viewer.waitForFunction(() => document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data[2] > 150);
  const game = session.pages.get('krillion');
  const samples = [];
  for (let run = 0; run < 3; run++) {
    await game.evaluate(() => { window.released = false; document.body.style.background = 'rgb(0,0,200)'; });
    await viewer.waitForFunction(() => document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data[2] > 150);
    const duration = await viewer.evaluate(async () => {
      for (let i=0; i<60; i++) {
        testSocket.send(JSON.stringify({ type: 'pointer', action: 'move', x: 100+i*2, y: 100 }));
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const start = performance.now();
      testSocket.send(JSON.stringify({ type: 'pointer', action: 'down', x: 250, y: 100 }));
      testSocket.send(JSON.stringify({ type: 'pointer', action: 'up', x: 250, y: 100 }));
      while (document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data[0] < 150) {
        if (performance.now() - start > 10000) throw new Error('Stream did not show click within 10 seconds');
        await new Promise(requestAnimationFrame);
      }
      return performance.now() - start;
    });
    await game.waitForFunction(() => window.released === true);
    samples.push(Math.round(duration));
  }
  const report = { clickToPaintAfterMotionMs: samples, megabytes: session.bytes / 1e6 };
  await game.evaluate(() => { document.body.style.background = 'rgb(0,0,200)'; });
  await viewer.waitForFunction(() => document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data[2] > 150);
  report.clickAfterBurstMs = Math.round(await viewer.evaluate(async () => {
    for (let i=0;i<60;i++) testSocket.send(JSON.stringify({ type: 'pointer', action: 'move', x: 100+i*2, y: 100 }));
    const start = performance.now();
    testSocket.send(JSON.stringify({ type: 'pointer', action: 'down', x: 250, y: 100 }));
    testSocket.send(JSON.stringify({ type: 'pointer', action: 'up', x: 250, y: 100 }));
    while (document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data[0] < 150) {
      if (performance.now() - start > 10000) throw new Error('Click stuck behind mouse movement');
      await new Promise(requestAnimationFrame);
    }
    return performance.now() - start;
  }));
  console.log(JSON.stringify(report));
  await writeFile(`.poc/latency-${process.argv[2] || 'latest'}.json`, JSON.stringify(report, null, 2));
  if (process.argv.includes('--assert-fast')) assert(Math.max(...samples, report.clickAfterBurstMs) < 250, 'Motion must not leave clicks queued behind stale input');
} catch (error) {
  for (const session of sessions.values()) for (const page of session.pages.values()) console.log('GAME', await page.evaluate(() => ({ clicks: window.clicks, released: window.released, lastX: window.lastX, background: document.body.style.background, viewport: [innerWidth,innerHeight] })), 'FRAMES', session.frames);
  console.log('VIEWER', await viewer.evaluate(() => ({ pixel: [...document.querySelector('#screen').getContext('2d').getImageData(50,50,1,1).data], status: document.querySelector('#status').textContent, notice: document.querySelector('#notice').textContent })));
  throw error;
} finally { await browser.close(); await gameBrowser.close(); await shutdown(); }
