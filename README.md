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
