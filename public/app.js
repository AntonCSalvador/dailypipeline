const $ = selector => document.querySelector(selector);
const screen = $('#screen');
const paint = screen.getContext('2d');
const gameButtons = [...document.querySelectorAll('[data-game]')];
let socket, active = null, state = 'connecting', results = [], gameList = [], frames = 0, latency = null;
let pressed = false, movePending = false, lastPointer, decoding = false;
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
function notice(message) { $('#notice').textContent = message; $('#notice').hidden = !message; }
function renderScores() {
  let complete = 0, krillionComplete = false;
  for (const game of gameList) {
    const result = results.filter(item => item.gameId === game.id).sort((a, b) => b.puzzleDate.localeCompare(a.puzzleDate))[0];
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const current = result?.puzzleDate === today ? result : null;
    if (current) complete += 1;
    if (current && game.id === 'krillion') krillionComplete = true;
    $(`#${game.id}-score`).textContent = current ? `${current.score} / ${current.maxScore}` : '—';
    $(`#${game.id}-status`).textContent = current ? `Saved · #${current.puzzleId}` : active === game.id ? 'In progress' : 'Ready to play';
    $(`[data-game="${game.id}"]`).classList.toggle('done', !!current);
  }
  $('#completed').textContent = `${complete} / 2`;
  $('#score-note').textContent = complete === 2 ? 'Run complete. Both results saved automatically.' : complete ? 'Result saved. Your next game is ready.' : 'Finish a game and your result appears here.';
  $('#next').hidden = !(active === 'krillion' && krillionComplete && complete < 2);
}
function setStatus(next, message) {
  state = next;
  $('#status').textContent = message;
  $('#connection-dot').className = `dot ${next === 'live' ? 'live' : next === 'error' ? 'error' : ''}`;
  $('#loading').hidden = next !== 'loading';
  for (const button of gameButtons) button.disabled = !['ready', 'live', 'error'].includes(next) || socket?.readyState !== WebSocket.OPEN;
  $('#start').disabled = next !== 'ready';
  $('#reload').disabled = next !== 'live';
}
function openGame(gameId, reload = false) {
  if (socket?.readyState !== WebSocket.OPEN) { connect(); return; }
  active = gameId;
  notice('');
  $('#empty').hidden = true;
  $('#screen').hidden = false;
  $('#controls').hidden = false;
  $('#answer-form').hidden = gameId !== 'krillion';
  setStatus('loading', `Opening ${gameId === 'krillion' ? 'Krillion' : 'Maptap'}…`);
  for (const button of gameButtons) {
    button.classList.toggle('selected', button.dataset.game === gameId);
    button.setAttribute('aria-pressed', String(button.dataset.game === gameId));
  }
  $('#source').textContent = `Live original game · ${gameId === 'krillion' ? 'krillion.io' : 'maptap.gg'}`;
  renderScores();
  const width = Math.max(360, Math.min(1100, Math.round($('.stage').clientWidth)));
  const height = width < 650 ? 700 : 760;
  screen.width = width; screen.height = height;
  $('.stage').style.aspectRatio = `${width} / ${height}`;
  send({ type: 'open', gameId, reload, viewport: { width, height } });
}
function connect() {
  setStatus('connecting', 'Connecting…');
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream`);
  socket.binaryType = 'blob';
  socket.addEventListener('message', async event => {
    if (event.data instanceof Blob) {
      if (decoding) return;
      decoding = true;
      try {
        const image = await createImageBitmap(event.data);
        paint.drawImage(image, 0, 0, screen.width, screen.height);
        image.close(); frames += 1;
      } finally { decoding = false; }
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === 'hello') {
      gameList = message.games; results = message.results;
      setStatus('ready', 'Ready when you are'); renderScores();
      if (message.active) openGame(message.active);
    } else if (message.type === 'status') {
      setStatus(message.state, message.message);
    } else if (message.type === 'results') {
      results = message.results; renderScores();
      if (message.captured) $('#status').textContent = `${message.captured.gameId === 'krillion' ? 'Krillion' : 'Maptap'} score saved automatically`;
    } else if (message.type === 'error') {
      setStatus('error', 'Connection needs attention'); notice(message.message);
    } else if (message.type === 'notice') notice(message.message);
    else if (message.type === 'metrics') {
      $('#metrics').textContent = `${message.megabytes.toFixed(1)} MB streamed${latency === null ? '' : ` · ${latency} ms link`}`;
      screen.dataset.frames = String(frames);
    } else if (message.type === 'pong') latency = Math.round(performance.now() - message.time);
  });
  socket.addEventListener('close', event => {
    setStatus('error', event.code === 4000 ? 'Session opened in another tab' : 'Disconnected');
    notice('Connection closed. Reload this page to reconnect. Saved scores are kept.');
  });
  socket.addEventListener('error', () => notice('Cannot reach the local streaming server. Check that npm start is running.'));
}
for (const button of gameButtons) button.addEventListener('click', () => openGame(button.dataset.game));
$('#start').addEventListener('click', () => openGame('krillion'));
$('#next').addEventListener('click', () => openGame('maptap'));
$('#reload').addEventListener('click', () => openGame(active, true));
function coordinates(event) {
  const bounds = screen.getBoundingClientRect();
  return { x: Math.max(0, Math.min(screen.width, (event.clientX - bounds.left) * screen.width / bounds.width)), y: Math.max(0, Math.min(screen.height, (event.clientY - bounds.top) * screen.height / bounds.height)) };
}
screen.addEventListener('pointerdown', event => {
  if (state !== 'live' || event.button !== 0) return;
  event.preventDefault(); screen.focus(); screen.setPointerCapture(event.pointerId);
  pressed = true; send({ type: 'pointer', action: 'down', ...coordinates(event) });
});
screen.addEventListener('pointermove', event => {
  if (state !== 'live') return;
  lastPointer = coordinates(event);
  if (movePending) return;
  movePending = true;
  requestAnimationFrame(() => { send({ type: 'pointer', action: 'move', ...lastPointer }); movePending = false; });
});
for (const eventName of ['pointerup', 'pointercancel']) screen.addEventListener(eventName, event => {
  if (!pressed) return;
  pressed = false; send({ type: 'pointer', action: 'up', ...coordinates(event) });
  if (screen.hasPointerCapture(event.pointerId)) screen.releasePointerCapture(event.pointerId);
});
screen.addEventListener('wheel', event => { if (state === 'live') { event.preventDefault(); send({ type: 'wheel', deltaY: event.deltaY }); } }, { passive: false });
for (const eventName of ['keydown', 'keyup']) screen.addEventListener(eventName, event => {
  if (event.key === 'Escape') { if (eventName === 'keydown') $('#reload').focus(); return; }
  if (event.key === 'Tab' || event.ctrlKey || event.metaKey || event.altKey || state !== 'live') return;
  event.preventDefault(); send({ type: 'key', key: event.key, action: eventName === 'keydown' ? 'down' : 'up' });
});
$('#answer-form').addEventListener('submit', event => {
  event.preventDefault();
  if (state !== 'live' || !$('#answer').value.trim()) return;
  send({ type: 'text', text: $('#answer').value, submit: true });
  $('#answer').value = '';
});
setInterval(() => { if (state === 'live') send({ type: 'ping', time: performance.now() }); }, 3000);
connect();
