# dailypipeline67 — streaming proof of concept

Two original daily games, played through one local website. An isolated Chrome session runs on the Node server; its video frames stream to the player, whose mouse and keyboard events travel back. Completed results are read from that session and saved automatically.

**Throwaway technical experiment.** This is not the production application and has no shared friend leaderboard yet.

## Run

Requires Node.js 22+ and Google Chrome or Microsoft Edge.

```sh
npm install
npm start
```

Open **http://localhost:3067**. Click **Start your pipeline**, play Krillion, then choose Maptap. Scores appear after the original game shows its completed result. Each visitor browser receives a separate guest session.

- Click inside the game to focus keyboard input. Drag and scroll work on Maptap.
- On a phone-sized screen, the remote game uses a narrow viewport. The **Touch keyboard** field sends an answer to Krillion's currently focused input.
- Escape returns keyboard focus to the surrounding page.
- Switching games keeps both pages open. Reloading the facilitator reconnects to the same running session.
- Results persist in `.poc/results.json`. Game login cookies are not persisted. Restarting the server loses in-progress game sessions; completed facilitator results remain.
- The server binds to loopback only. This URL is not accessible from friends' devices or another phone. It is deliberately not a public remote-browser service.

If Chrome is installed elsewhere, set `BROWSER_PATH` to its executable. Set `PORT` to change 3067. `POC_DATA_DIR` changes the local result directory; live checks use their own directory so they cannot overwrite normal POC results.

## What this proves

1. The real games can render in a server-side browser and be streamed into our page.
2. Mouse, keyboard and globe controls can pass through the stream.
3. A completed daily score, game ID and puzzle date can be captured without manual entry.
4. Scores can be persisted once per game/puzzle/date and restored on page reload.

The readers are intentionally specific to today's Krillion and Maptap UI. They require completion markers and validate scores. They do not call private game APIs, inspect unrelated browser storage, answer questions, or modify game results. They are not an anti-cheating system.

### Observed results — October 23, 2026

- Live Krillion #100: seven real timer expirations, score **0** captured and persisted automatically.
- Live Maptap #854: five real guest guesses, score **130** captured and persisted automatically.
- The Krillion result survived a server restart; both results survived page reload without duplicate records.
- Streamed clicking and keyboard input worked. Maptap dragging changed its actual globe longitude, not just the streamed image.
- Desktop and narrow mobile layouts were visually inspected. Actual phone hardware and mobile browsers have not been tested.
- The isolated Maptap check streamed **71.5 MB in 57.7 seconds**, about **74 MB/minute (9.9 Mbps)**. That includes onboarding and gameplay on this computer, not a cloud benchmark. Streaming cost is a real concern at scale.
- Both native Node test cases passed, covering completion gates, zero/negative scores, invalid values and the alternate Maptap result view that originally exposed a capture bug.

Raw verification output: `.poc/live-check-report.json`. Test results are isolated from the normal player session.

## Checks

```sh
npm test
node scripts/smoke.mjs
```

Unit checks use isolated synthetic fixtures, never production game data or displayed demo scores. The smoke check opens live guest games, checks streamed input and actual globe rotation, and captures desktop/mobile screenshots in `.poc/`.

An optional full live check takes about four to six minutes. It lets Krillion's real timers expire and makes arbitrary Maptap guesses through the streamed UI. It completes fresh guest games, so run it intentionally:

```sh
node scripts/live-check.mjs
```

Its results and screenshots stay in `.poc/live-check/` and `.poc/`. It never signs into existing game accounts or manipulates game clocks, storage or scores.

## Limits and next decision

- **Local streaming is not a cloud performance test.** The displayed link time is a WebSocket round trip, not end-to-end input-to-frame latency. Actual cloud latency, GPU availability, concurrency and dollar cost still require a hosted trial.
- Every active user needs an isolated browser session and streaming bandwidth. The UI reports bytes sent. Estimate transfer from `MB streamed / session minutes`; multiply by expected usage and the chosen host's current prices. No hosting bill has been incurred by this POC.
- The stream currently contains video only, with a fixed JPEG quality and frame sampling. Audio, clipboard integration, screen-reader access inside the remote game, full mobile touch gestures, and cross-device accounts are not implemented. Basic pointer-based touch controls and a text-entry helper exist.
- The server closes disconnected sessions after 15 minutes. Results remain on disk. Daily comparisons follow each game's puzzle ID/date; the visitor session uses America/New_York for this initial test.
- The existing game's own cookies/progress in a user's normal browser do not transfer to this guest session. Use guest mode for the POC.
- Public hosting needs authentication, per-user session ownership, resource limits, durable storage and abuse controls. Do not expose this local development server with a tunnel.
- Technical access does not resolve creator terms. [Maptap's terms](https://maptap.gg/terms) require permission for scraping/API access. Confirm an acceptable integration before public rollout.

## Files

- `server.mjs` — HTTP/WebSocket service, isolated browser sessions, streaming and persistence.
- `browser.mjs` — browser discovery and launch.
- `scores.mjs` — the two completed-result readers and validation.
- `public/` — buildless player UI.
- `test/scores.test.mjs` — score reader guard checks.
- `scripts/` — opt-in live verification tools.

Source repository: [AntonCSalvador/dailypipeline](https://github.com/AntonCSalvador/dailypipeline). This POC runs locally; pushing the source does not deploy a hosted application.
