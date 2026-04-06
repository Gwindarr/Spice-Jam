const { createServer } = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;
const SPICE_RESPAWN_SECONDS = 32;
const SPICE_NODE_COUNT = 8;
const MAX_PLAYERS = 20;

// ── Game state ────────────────────────────────────────────────────────────────

const players = new Map(); // socketId → playerState

// Spice nodes: server owns active/inactive state and respawn timers.
// Positions are determined client-side from MAP_SEED — server just tracks
// node index + active state so all clients stay in sync.
const spiceNodes = Array.from({ length: SPICE_NODE_COUNT }, (_, i) => ({
  id: i,
  active: true,
  respawnTimer: 0,
}));

const scores = { fremen: 0, harkonnen: 0 };
// Canonical map seed — all clients must match this
const MAP_SEED = Math.floor(Math.random() * 0xFFFFFF);

// ── Helpers ───────────────────────────────────────────────────────────────────

function countTeam(team) {
  let n = 0;
  for (const p of players.values()) if (p.team === team) n++;
  return n;
}

function assignTeam() {
  return countTeam("fremen") <= countTeam("harkonnen") ? "fremen" : "harkonnen";
}

function getWorldSnapshot() {
  return {
    players: [...players.values()],
    spiceNodes,
    scores,
    seed: MAP_SEED,
  };
}

// ── Server tick: respawn spice nodes ─────────────────────────────────────────

const TICK_MS = 1000;
setInterval(() => {
  let changed = false;
  for (const node of spiceNodes) {
    if (!node.active) {
      node.respawnTimer -= TICK_MS / 1000;
      if (node.respawnTimer <= 0) {
        node.active = true;
        node.respawnTimer = 0;
        changed = true;
      }
    }
  }
  if (changed) io.emit("spiceSync", spiceNodes);
}, TICK_MS);

// ── Socket.io ─────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.writeHead(200);
  res.end("Spice Jam server running");
});

const io = new Server(httpServer, {
  cors: { origin: "*" },
  // Prefer WebSocket, fall back to polling
  transports: ["websocket", "polling"],
});

io.on("connection", (socket) => {
  if (players.size >= MAX_PLAYERS) {
    socket.emit("serverFull");
    socket.disconnect(true);
    return;
  }

  const team = assignTeam();
  const player = {
    id: socket.id,
    team,
    x: 0, y: 0, z: 0,
    rotY: 0,
    spiceCarry: 0,
    health: 100,
    equipped: "knife",
  };
  players.set(socket.id, player);

  console.log(`[+] ${socket.id} joined as ${team} (${players.size} players)`);

  // Send new player the full world state
  socket.emit("welcome", { id: socket.id, team, snapshot: getWorldSnapshot() });

  // Tell everyone else about the new player
  socket.broadcast.emit("playerJoined", player);

  // ── Position updates (high frequency) ──
  socket.on("move", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = data.x;
    p.y = data.y;
    p.z = data.z;
    p.rotY = data.rotY;
    p.spiceCarry = data.spiceCarry;
    p.equipped = data.equipped;
    // Relay to everyone else — don't echo back to sender
    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      x: p.x, y: p.y, z: p.z,
      rotY: p.rotY,
      spiceCarry: p.spiceCarry,
      equipped: p.equipped,
    });
  });

  // ── Spice harvested ──
  socket.on("harvestNode", (nodeId) => {
    const node = spiceNodes[nodeId];
    if (!node || !node.active) return;
    node.active = false;
    node.respawnTimer = SPICE_RESPAWN_SECONDS;
    io.emit("nodeHarvested", nodeId);
  });

  // ── Spice deposited ──
  socket.on("spiceDeposited", () => {
    const p = players.get(socket.id);
    if (!p) return;
    scores[p.team] += 1;
    io.emit("scoreUpdate", scores);
  });

  // ── Hit / damage ──
  socket.on("hitPlayer", ({ targetId, damage }) => {
    const target = players.get(targetId);
    if (!target || target.health <= 0) return;
    damage = Math.max(0, Math.min(damage, 100)); // sanity clamp
    target.health = Math.max(0, target.health - damage);
    io.emit("playerDamaged", { id: targetId, health: target.health, attackerId: socket.id });
    if (target.health <= 0) {
      io.emit("playerKilled", { id: targetId, killerId: socket.id });
      // Respawn after 3 s
      setTimeout(() => {
        if (!players.has(targetId)) return; // left before respawn
        target.health = 100;
        io.emit("playerRespawned", { id: targetId });
      }, 3000);
    }
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    players.delete(socket.id);
    io.emit("playerLeft", socket.id);
    console.log(`[-] ${socket.id} left (${players.size} players)`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Spice Jam server listening on :${PORT}`);
});
