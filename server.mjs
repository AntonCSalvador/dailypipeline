import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { launchBrowser, contextOptions, viewport } from './browser.mjs';
import { games, readResultInPage, validateResult } from './scores.mjs';

const port = Number(process.env.PORT || 3067);
const host = '127.0.0.1';
const allowedHosts = new Set([`localhost:${port}`, `${host}:${port}`]);
const sessions = new Map();
const dataDir = process.env.POC_DATA_DIR ? pathToFileURL(resolve(process.env.POC_DATA_DIR) + '/') : new URL('./.poc/', import.meta.url);
await mkdir(dataDir, { recursive: true });
const resultsPath = new URL('results.json', dataDir);
let saved = {};
try { saved = JSON.parse(await readFile(resultsPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .poc/results.json; preserve the file and repair it before restarting.', { cause: error }); }
let writes = Promise.resolve();
let browserPromise;
const browser = () => browserPromise ||= launchBrowser().catch(error => { browserPromise = null; throw error; });
const sessionId = req => /(?:^|;\s*)dp67=([a-f0-9-]{36})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
const getResults = id => Object.values(saved[id] || {});
const send = (session, message) => {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(message));
};

function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, {
    id, pages: new Map(), socket: null, active: null, cdp: null, context: null,
    lastSeen: Date.now(), createdAt: Date.now(), frames: 0, bytes: 0, chain: Promise.resolve(), viewport,
  });
  return sessions.get(id);
}

async function capture(session) {
  if (session.capturing) return;
  session.capturing = true;
  try {
    for (const [gameId, page] of session.pages) {
      if (page.url() !== games.find(game => game.id === gameId).url) continue;
      const raw = await page.evaluate(readResultInPage, gameId).catch(() => null);
      const result = validateResult(raw, gameId);
      if (!result) continue;
      const key = `${gameId}:${result.puzzleId}:${result.puzzleDate}`;
      if (saved[session.id]?.[key]) continue;
      const entry = { ...result, capturedAt: new Date().toISOString(), source: 'live-game' };
      // Serialize writes and replace atomically. Publish "saved" only after disk succeeds.
      writes = writes.catch(() => {}).then(async () => {
        const next = { ...saved, [session.id]: { ...saved[session.id], [key]: entry } };
        const temporary = new URL('results.tmp', dataDir);
        await writeFile(temporary, JSON.stringify(next, null, 2));
        await rename(temporary, resultsPath);
        saved = next;
      });
      try {
        await writes;
        send(session, { type: 'results', results: getResults(session.id), captured: entry });
        console.log(`Saved ${gameId} #${result.puzzleId}: ${result.score}`);
      } catch {
        send(session, { type: 'error', message: 'Result detected, but saving failed. Keep this page open and check server disk access.' });
      }
    }
  } finally { session.capturing = false; }
}

async function stopStream(session) {
  if (!session.cdp) return;
  const cdp = session.cdp;
  session.cdp = null;
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
}

async function openGame(session, gameId, reload = false, requestedViewport) {
  const game = games.find(item => item.id === gameId);
  if (!game) throw new Error('Choose Krillion or Maptap.');
  send(session, { type: 'status', state: 'loading', gameId, message: `Opening ${game.name}…` });
  if (!session.context) session.context = await (await browser()).newContext(contextOptions);
  await stopStream(session);
  if (Number.isInteger(requestedViewport?.width) && Number.isInteger(requestedViewport?.height)) {
    session.viewport = {
      width: Math.max(360, Math.min(1100, requestedViewport.width)),
      height: Math.max(600, Math.min(900, requestedViewport.height)),
    };
  }
  let page = session.pages.get(gameId);
  if (!page || page.isClosed()) {
    page = await session.context.newPage();
    session.pages.set(gameId, page);
    page.on('popup', popup => popup.close().catch(() => {}));
    await page.route('**/*', route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()
        && new URL(request.url()).origin !== new URL(game.url).origin) {
        send(session, { type: 'notice', message: 'External navigation is disabled in this guest-game proof of concept.' });
        return route.abort();
      }
      return route.continue();
    });
    reload = true;
  }
  session.active = gameId;
  await page.setViewportSize(session.viewport);
  await page.bringToFront();
  const cdp = await session.context.newCDPSession(page);
  session.cdp = cdp;
  await cdp.send('Page.enable');
  cdp.on('Page.screencastFrame', event => {
    cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    if (session.cdp !== cdp || session.socket?.readyState !== WebSocket.OPEN || session.socket.bufferedAmount > 1_000_000) return;
    const frame = Buffer.from(event.data, 'base64');
    session.frames += 1;
    session.bytes += frame.length;
    session.socket.send(frame, { binary: true });
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 65, maxWidth: session.viewport.width, maxHeight: session.viewport.height, everyNthFrame: 2 });
  if (reload) await page.goto(game.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  send(session, { type: 'status', state: 'live', gameId, message: `${game.name} is live`, viewport: session.viewport });
  await capture(session);
}

const keyAllowed = key => typeof key === 'string' && (key.length === 1 || [
  'Enter', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Shift', 'Escape',
].includes(key));

async function handleMessage(session, message) {
  session.lastSeen = Date.now();
  if (message.type === 'open') return openGame(session, message.gameId, message.reload === true, message.viewport);
  if (message.type === 'ping') return send(session, { type: 'pong', time: message.time });
  const page = session.pages.get(session.active);
  if (!page || !session.cdp) return;
  if (message.type === 'pointer') {
    const { x, y, action } = message;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > session.viewport.width || y > session.viewport.height) return;
    if (!['down', 'up', 'move'].includes(action)) return;
    await page.mouse.move(x, y);
    if (action === 'down') await page.mouse.down();
    if (action === 'up') await page.mouse.up();
  } else if (message.type === 'wheel') {
    if (!Number.isFinite(message.deltaY)) return;
    await page.mouse.wheel(0, Math.max(-500, Math.min(500, message.deltaY)));
  } else if (message.type === 'key' && keyAllowed(message.key)) {
    if (message.action === 'down') await page.keyboard.down(message.key);
    if (message.action === 'up') await page.keyboard.up(message.key);
  } else if (message.type === 'text' && typeof message.text === 'string' && message.text.length <= 200) {
    await page.keyboard.insertText(message.text);
    if (message.submit === true) await page.keyboard.press('Enter');
  }
}

const files = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
]);
const server = http.createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host)) { res.writeHead(403); return res.end('Local access only'); }
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (pathname === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ok: true, sessions: sessions.size })); }
  const file = files.get(pathname);
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  if (pathname === '/' && !sessionId(req)) res.setHeader('Set-Cookie', `dp67=${randomUUID()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    res.setHeader('Content-Type', file[1]);
    res.end(body);
  } catch { res.writeHead(500); res.end('Could not load the POC. Check server output.'); }
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const id = sessionId(req);
  if (!allowedHosts.has(req.headers.host) || req.url !== '/stream' || !id
    || req.headers.origin !== `http://${req.headers.host}`) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  websocketServer.handleUpgrade(req, socket, head, ws => websocketServer.emit('connection', ws, req));
});

websocketServer.on('connection', (socket, req) => {
  const session = getSession(sessionId(req));
  session.socket?.close(4000, 'Opened in another tab');
  session.socket = socket;
  session.lastSeen = Date.now();
  send(session, { type: 'hello', games, results: getResults(session.id), viewport, active: session.active });
  let pending = 0;
  socket.on('message', data => {
    if (pending > 120 || session.socket !== socket) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message || typeof message !== 'object') return;
    pending += 1;
    session.chain = session.chain.then(() => handleMessage(session, message)).catch(error => {
      console.error(error.message);
      send(session, { type: 'error', message: `Game connection failed: ${error.message.slice(0, 180)}. Try reopening the game.` });
    }).finally(() => { pending -= 1; });
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (session.socket !== socket) return;
    session.socket = null;
    stopStream(session).catch(() => {});
  });
});

const monitor = setInterval(() => {
  for (const session of sessions.values()) {
    if (Date.now() - session.lastSeen > 15 * 60_000 && !session.socket) {
      session.context?.close().catch(() => {});
      sessions.delete(session.id);
      continue;
    }
    if (!session.socket) continue;
    capture(session).catch(error => console.error('Capture failed:', error.message));
    const seconds = Math.max(1, (Date.now() - session.createdAt) / 1000);
    send(session, { type: 'metrics', frames: session.frames, megabytes: session.bytes / 1_000_000, seconds });
  }
}, 1000);

server.listen(port, host, () => console.log(`dailypipeline67 POC: http://localhost:${port}\nLocal guest sessions only. Ctrl+C stops the server.`));
async function shutdown() {
  clearInterval(monitor);
  for (const session of sessions.values()) session.socket?.close();
  await writes.catch(() => {});
  if (browserPromise) await (await browserPromise.catch(() => null))?.close();
  websocketServer.close();
  server.close();
}
process.on('SIGINT', () => shutdown().then(() => process.exit()));
process.on('SIGTERM', () => shutdown().then(() => process.exit()));

export { server, sessions, shutdown };
