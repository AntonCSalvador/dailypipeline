export const games = [
  { id: 'krillion', name: 'Krillion', url: 'https://krillion.io/', rounds: 7, maxScore: 700 },
  { id: 'maptap', name: 'Maptap', url: 'https://maptap.gg/', rounds: 5, maxScore: 1000 },
];

// Read only this guest browser's completed result. Never call the games' private APIs.
// ponytail: two site-specific readers; update when either game's result UI changes.
export function readResultInPage(gameId) {
  const text = document.body.innerText;
  const visible = selector => {
    const node = document.querySelector(selector);
    return node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  if (gameId === 'krillion') {
    const match = text.match(/Dive\s*#(\d+)\s*complete/i);
    if (!match || !visible('.ds-done-krill')) return null;
    const owner = localStorage.getItem('krillion:account-owner:v1');
    // The POC uses fresh guest sessions. Do not inspect account credentials or unrelated storage.
    if (owner) return null;
    const history = JSON.parse(localStorage.getItem('krillion:stats:v1') || '{}').history || {};
    const entry = Object.entries(history).find(([, result]) => result.dayNumber === Number(match[1]));
    if (!entry || !Array.isArray(entry[1].results) || entry[1].results.length !== 7) return null;
    return { gameId, puzzleId: match[1], puzzleDate: entry[0], score: entry[1].score, rounds: 7 };
  }
  if (gameId === 'maptap') {
    const match = text.match(/MapTap\s*#\s*(\d+)/i);
    if (!match || !visible('#share-button')) return null;
    // These are read-only values from the running game, not a network integration.
    if (typeof gameState === 'undefined' || gameState.roundData?.length !== 5) return null;
    const date = typeof getTodayKey === 'function' ? getTodayKey() : null;
    return { gameId, puzzleId: match[1], puzzleDate: date, score: gameState.finalScore, rounds: 5 };
  }
  return null;
}

export function validateResult(result, expectedGame) {
  const game = games.find(item => item.id === expectedGame);
  if (!game || !result || result.gameId !== game.id || result.rounds !== game.rounds) return null;
  if (!/^\d+$/.test(result.puzzleId) || !/^\d{4}-\d{2}-\d{2}$/.test(result.puzzleDate)) return null;
  // Maptap has an intentional negative-score mode, including -1000.
  const minimum = game.id === 'maptap' ? -1000 : 0;
  if (!Number.isInteger(result.score) || result.score < minimum || result.score > game.maxScore) return null;
  return { ...result, maxScore: game.maxScore };
}
