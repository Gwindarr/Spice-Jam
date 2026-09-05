# Spice Jam

`Spice Jam` is a Dune-inspired desert survival prototype where players harvest spice, manage worm sign, and evade a massive sandworm.

## Run

Install dependencies, start the local game server, and open the served page:

```bash
npm install
npm start
```

Then visit `http://localhost:3001`.

For auto-restart during development:

```bash
npm run dev
```

The server serves both the static game files and the local Socket.IO multiplayer endpoint. To use a different port, run `PORT=4000 npm start` and open `http://localhost:4000`.

The default bind address is `127.0.0.1`. For LAN testing, explicitly set `HOST=0.0.0.0`.

## Checks

```bash
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

The browser check starts a disposable local server and verifies harvesting, banking,
movement after reconnection, and mobile startup. On macOS it uses installed Google
Chrome; elsewhere it uses Playwright Chromium. Set `CHROME_PATH` to override the browser
executable. Set `REVIEW_OUTPUT` to save screenshots and a JSON result.

## Multiplayer rules

The server owns spice positions/yields, harvest timing, movement limits, damage,
projectile ammunition, and weapon cooldowns. Clients submit actions and render the
result. The deterministic terrain/placement model lives in `world.js`.

Local training NPCs have no shared authoritative health state: their kills award spice
in offline play only. Multiplayer atomic damage requires a validated hit on a shielded
player; local training explosions remain visual. PvP drops, patch harvesting, banking,
and worm interactions remain shared.

See [Vultr deployment](deploy/README.md) for the service layout and rollback procedure.
