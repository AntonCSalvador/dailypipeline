// Opt-in check: plays one fresh guest daily run with intentionally empty / arbitrary guesses.
// It never changes game scores, timers, or storage and never signs into a game account.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { launchBrowser, contextOptions } from '../browser.mjs';
import { readResultInPage } from '../scores.mjs';

process.env.PORT = '3069';
process.env.POC_DATA_DIR = '.poc/live-check';
const { server, sessions, shutdown } = await import('../server.mjs');
if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
await mkdir('.poc', { recursive: true });
const browser = await launchBrowser();
const context = await browser.newContext({ ...contextOptions, viewport: { width: 1440, height: 1100 } });
const resumeMaptap = process.argv.includes('--resume-maptap');
let krillionResult;
if (resumeMaptap) {
  const previous = JSON.parse(await readFile('.poc/live-check/results.json', 'utf8'));
  const priorSession = Object.entries(previous).find(([, scores]) => Object.values(scores).some(result => result.gameId === 'krillion'));
  assert(priorSession, 'A prior real Krillion result is required to resume the Maptap check');
  krillionResult = Object.values(priorSession[1]).find(result => result.gameId === 'krillion');
  await context.addCookies([{ name: 'dp67', value: priorSession[0], domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Strict' }]);
}
const viewer = await context.newPage();
let session;
async function clickRemote(locator) {
  await locator.waitFor({ state: 'visible', timeout: 45000 });
  const target = await locator.boundingBox();
  const screen = await viewer.locator('#screen').boundingBox();
  await viewer.mouse.click(screen.x + (target.x + target.width / 2) * screen.width / session.viewport.width, screen.y + (target.y + target.height / 2) * screen.height / session.viewport.height);
}
async function tapGlobe(x = .35, y = .65) {
  const screen = await viewer.locator('#screen').boundingBox();
  await viewer.mouse.click(screen.x + screen.width * x, screen.y + screen.height * y);
}
try {
  await viewer.goto('http://localhost:3069');
  if (!resumeMaptap) await viewer.getByRole('button', { name: 'Start your pipeline' }).click();
  const id = (await context.cookies()).find(cookie => cookie.name === 'dp67').value;
  await viewer.waitForFunction(() => document.querySelector('#status').textContent !== 'Connecting…');
  session = sessions.get(id);
  if (!resumeMaptap) {
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === 'Krillion is live');
  const krillion = session.pages.get('krillion');
  await clickRemote(krillion.getByRole('button', { name: /BEGIN DESCENT/ }));
  for (let round = 1; round <= 7; round++) {
    await krillion.waitForFunction(count => {
      const game = JSON.parse(localStorage.getItem('krillion:game:v1') || '{}');
      return game.phase === 'feedback' && game.results?.length === count;
    }, round, { timeout: 45000 });
    console.log(`Krillion round ${round}: real timer expired`);
    for (let attempt = 0; attempt < 15; attempt++) {
      await viewer.locator('#screen').focus();
      await viewer.keyboard.press('Enter');
      await viewer.waitForTimeout(500);
      const phase = await krillion.evaluate(() => JSON.parse(localStorage.getItem('krillion:game:v1') || '{}').phase);
      if (phase !== 'feedback') break;
    }
  }
  await viewer.waitForFunction(() => document.querySelector('#krillion-score').textContent !== '—', { timeout: 20000 });
  krillionResult = await krillion.evaluate(readResultInPage, 'krillion');
  assert.equal(krillionResult.score, 0);
  await viewer.screenshot({ path: '.poc/krillion-result.png', fullPage: true });
  console.log('PASS real Krillion completion captured:', JSON.stringify(krillionResult));
  await viewer.getByRole('button', { name: 'Next game' }).click();
  } else {
    await viewer.waitForFunction(() => document.querySelector('#krillion-score').textContent !== '—');
    console.log('PASS prior real Krillion result recovered after server restart');
    await viewer.getByRole('button', { name: /02 Maptap/ }).click();
  }
  await viewer.waitForFunction(() => document.querySelector('#status').textContent === 'Maptap is live');
  const maptap = session.pages.get('maptap');
  await maptap.locator('.tutorial-prompt').waitFor({ state: 'visible', timeout: 30000 });
  await tapGlobe();
  await clickRemote(maptap.getByRole('button', { name: "Let's Go!", exact: true }));
  for (let round = 1; round <= 5; round++) {
    await maptap.waitForFunction(count => gameState.round === count && runtime.currentlyScoring !== 1 && !!runtime.activeRoundCity, round, { timeout: 45000 });
    await tapGlobe();
    await maptap.waitForFunction(count => gameState.roundData.length >= count, round, { timeout: 30000 });
    console.log(`Maptap round ${round}: real guess scored`);
  }
  await viewer.waitForFunction(() => document.querySelector('#maptap-score').textContent !== '—', { timeout: 30000 });
  const maptapResult = await maptap.evaluate(readResultInPage, 'maptap');
  assert(Number.isInteger(maptapResult.score));
  const saved = JSON.parse(await readFile('.poc/live-check/results.json', 'utf8'))[id];
  assert.equal(Object.keys(saved).length, 2);
  await viewer.reload();
  await viewer.waitForFunction(() => document.querySelector('#completed').textContent === '2 / 2');
  const afterReload = JSON.parse(await readFile('.poc/live-check/results.json', 'utf8'))[id];
  assert.equal(Object.keys(afterReload).length, 2, 'Reopening must not duplicate results');
  await viewer.screenshot({ path: '.poc/both-results.png', fullPage: true });
  const report = { checkedAt: new Date().toISOString(), krillionFromPriorVerifiedRun: resumeMaptap, krillion: krillionResult, maptap: maptapResult,
    persistedAndDeduplicated: true, frames: session.frames, megabytes: session.bytes / 1e6,
    seconds: (Date.now() - session.createdAt) / 1000 };
  await writeFile('.poc/live-check-report.json', JSON.stringify(report, null, 2));
  console.log('PASS both real games, result capture, persistence and deduplication:', JSON.stringify(report));
} catch (error) {
  console.error('LIVE CHECK FAILED:', error.message);
  if (session) for (const [id, page] of session.pages) {
    console.error(id, (await page.locator('body').innerText().catch(() => '')).slice(-4500));
    await page.screenshot({ path: `.poc/${id}-failure.png` }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  await shutdown();
}
