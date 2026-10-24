import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readResultInPage, validateResult } from '../scores.mjs';

const krillion = { gameId: 'krillion', puzzleId: '100', puzzleDate: '2026-10-23', score: 0, rounds: 7 };
const maptap = { gameId: 'maptap', puzzleId: '854', puzzleDate: '2026-10-23', score: -1000, rounds: 5 };

test('completed scores preserve zero and negative scores; reject incomplete or invalid results', () => {
  assert.equal(validateResult(krillion, 'krillion').score, 0);
  assert.equal(validateResult(maptap, 'maptap').score, -1000);
  for (const bad of [null, { ...krillion, rounds: 6 }, { ...krillion, score: NaN },
    { ...krillion, score: 701 }, { ...krillion, score: '100' }, { ...krillion, puzzleDate: 'today' },
    { ...maptap, score: -1001 }]) {
    assert.equal(validateResult(bad, bad?.gameId || 'krillion'), null);
  }
  assert.equal(validateResult(krillion, 'maptap'), null);
});

test('readers require a completed result screen, not a mid-game running score', () => {
  const visibleNode = { getClientRects: () => [1] };
  function read(gameId, { text, storage = {}, state, visible = true, shareText }) {
    return vm.runInNewContext(`(${readResultInPage.toString()})('${gameId}')`, {
      document: { body: { innerText: text }, querySelector: () => visible ? visibleNode : null },
      getComputedStyle: () => ({ visibility: 'visible' }),
      localStorage: { getItem: key => storage[key] || null },
      gameState: state, getTodayKey: () => '2026-10-23',
      getScoreText: shareText === undefined ? undefined : () => shareText,
    });
  }
  const history = JSON.stringify({ history: { '2026-10-23': { dayNumber: 100, score: 0, results: Array(7).fill({ score: 0 }) } } });
  const store = { 'krillion:stats:v1': history };
  assert.equal(read('krillion', { text: 'Dive #100 complete', storage: store }).score, 0);
  assert.equal(read('krillion', { text: 'PROMPT 6 OF 7 SCORE 200', storage: store }), null);
  assert.equal(read('krillion', { text: 'Dive #99 complete', storage: store }), null);
  assert.equal(read('krillion', { text: 'Dive #100 complete', storage: store, visible: false }), null);
  assert.equal(read('krillion', { text: 'Dive #100 complete', storage: { ...store, 'krillion:account-owner:v1': 'fixture-account' } }), null);
  const state = { roundData: Array(5).fill({ score: 0 }), finalScore: -1000 };
  assert.equal(read('maptap', { text: 'MapTap #854 SCORE -1000 Share your score', state }).score, -1000);
  assert.equal(read('maptap', { text: 'MapTap #854 SCORE 400', state, visible: false }), null);
  assert.equal(read('maptap', { text: 'MapTap #854 Final Score:', state: { ...state, roundData: [] } }), null);
  const tiers = ['plankton', 'tooclever', 'schooler', 'rare', 'deepcut', 'krillion', 'miss'];
  const detailed = JSON.stringify({ history: { '2026-10-23': { dayNumber: 100, score: 300, tiers, results: Array(7).fill({}) } } });
  const shared = read('krillion', { text: 'Dive #100 complete', storage: { 'krillion:stats:v1': detailed } });
  assert.equal(shared.shareText, 'Krillion #100 🦐\n300\n\n🫧🤡🐟🦑🏮🌟⬛');
  const missingTiers = JSON.stringify({ history: { '2026-10-23': { dayNumber: 100, score: 300, results: Array(7).fill({ score: 40 }) } } });
  assert.equal(read('krillion', { text: 'Dive #100 complete', storage: { 'krillion:stats:v1': missingTiers } }).shareText, 'Krillion #100 🦐\n300', 'Never invent tier emojis from missing details');
  const originalShare = 'www.maptap.gg October 23\n0💀 10😱 20🧊 30😔 40😁\nFinal score: -1000 Antipode!';
  assert.equal(read('maptap', { text: 'MapTap #854', state, shareText: originalShare }).shareText, originalShare);
  assert.equal(read('maptap', { text: 'MapTap #854', state }).score, -1000, 'Missing share formatter must not lose a score');
});
