const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;
const SPICE_RESPAWN_SECONDS = 32;
const SPICE_NODE_COUNT = 8;
const MAX_PLAYERS = 20;
const WORM_TICK_MS = 100;
const POISON_DPS = 4;
const POISON_DURATION = 6;
const HOLTZMAN_LETHAL_RADIUS = 35;
const HOLTZMAN_DAMAGE_RADIUS = 70;
const HOLTZMAN_DAMAGE = 80;
const HOLTZMAN_EVENT_COOLDOWN_MS = 250;

const WORM_CFG = {
  noisePressureSpawnThreshold: 0.68,
  noisePressureRise: 0.38,
  noisePressureDecay: 0.14,
  hotspotMinIntensity: 0.18,
  inboundDuration: 8,
  warningDuration: 2.8,
  breachDuration: 4.0,
  strikeDelay: 0.35,
  strikeWindow: 0.65,
  recoverDuration: 2.0,
  cooldownDuration: 14,
  killRadius: 28,
  targetTrackSharpness: 4.6,
  targetLockProgress: 0.72,
  shieldHotspotBonus: 0.34,
  maxNoiseHotspots: 32,
};

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
const SERVER_START_MS = Date.now();
const noiseHotspots = [];
const worm = {
  state: "off_map",
  phase: "idle",
  timer: 0,
  cooldown: 0,
  noisePressure: 0,
  target: { x: 0, z: 0 },
};
let lastHoltzmanDetonationMs = 0;

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
    worm: {
      state: worm.state,
      phase: worm.phase,
      timer: worm.timer,
      cooldown: worm.cooldown,
      noisePressure: worm.noisePressure,
      target: { ...worm.target },
      worldTime: (Date.now() - SERVER_START_MS) / 1000,
    },
  };
}

function emitDeathEvent(victimId, killerId, cause = "combat") {
  const victim = players.get(victimId);
  const killer = players.get(killerId);
  const victimName = victim?.name || `Player-${String(victimId).slice(-4)}`;
  const killerName = killerId === "worm"
    ? "Worm"
    : (killer?.name || `Player-${String(killerId).slice(-4)}`);
  const message = killerId === "worm"
    ? `${victimName} was devoured by the worm`
    : `${victimName} was killed by ${killerName}`;
  console.log(`[death] ${message} (${cause})`);
  io.emit("deathEvent", {
    victimId,
    killerId,
    cause,
    victimName,
    killerName,
    message,
    respawnSeconds: 3,
  });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function damp(current, target, sharpness, dt) {
  return current + ((target - current) * (1 - Math.exp(-sharpness * dt)));
}

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return (dx * dx) + (dz * dz);
}

function pushNoiseHotspot(kind, x, z, strength = 1, opts = {}) {
  const ttl = Math.max(0.05, Number(opts.ttl ?? 4));
  const hotspot = {
    kind: String(kind || "generic"),
    x: Number(x) || 0,
    z: Number(z) || 0,
    baseStrength: clamp(Number(strength) || 0, 0, 1),
    signLevel: clamp(Number(opts.signLevel) || 0.5, 0, 1),
    radius: Math.max(1, Number(opts.radius) || 120),
    ttl,
    maxTtl: ttl,
  };
  noiseHotspots.push(hotspot);
  if (noiseHotspots.length > WORM_CFG.maxNoiseHotspots) {
    noiseHotspots.splice(0, noiseHotspots.length - WORM_CFG.maxNoiseHotspots);
  }
}

function getNoiseKindWeight(kind) {
  switch (kind) {
    case "atomic_holtzman": return 1.15;
    case "thumper": return 1.05;
    case "spice_blow": return 0.92;
    case "battle": return 0.86;
    default: return 1.0;
  }
}

function getPlayerClusterCenter() {
  if (players.size === 0) return { x: 0, z: 0 };
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const p of players.values()) {
    sx += p.x;
    sz += p.z;
    n += 1;
  }
  return n > 0 ? { x: sx / n, z: sz / n } : { x: 0, z: 0 };
}

function sampleStrongestWormHotspot() {
  const cluster = getPlayerClusterCenter();
  let strongest = null;

  const consider = (x, z, rawStrength, signLevel, source, radius = Infinity) => {
    let falloff = 1;
    if (Number.isFinite(radius)) {
      const d = Math.sqrt(dist2(x, z, cluster.x, cluster.z));
      falloff = clamp(1 - (d / Math.max(1, radius)), 0, 1);
      if (falloff <= 0) return;
    }
    const strength = clamp(rawStrength * falloff, 0, 1);
    if (strength < WORM_CFG.hotspotMinIntensity) return;
    if (strongest && strongest.strength >= strength) return;
    strongest = {
      x, z,
      strength,
      signLevel: clamp(signLevel * falloff, 0, 1),
      source,
    };
  };

  // Thumpers from all players (highest priority engineered lure)
  for (const p of players.values()) {
    if (!p.thumperActive) continue;
    const thStrength = clamp(0.52 + (0.48 * (p.thumperSignal || 0)), 0, 1);
    consider(
      p.thumperX ?? p.x,
      p.thumperZ ?? p.z,
      thStrength * getNoiseKindWeight("thumper"),
      thStrength,
      "thumper",
      260
    );
  }

  // Event hotspots (plume/atomic/etc)
  for (const hs of noiseHotspots) {
    const life = clamp(hs.ttl / Math.max(0.001, hs.maxTtl), 0, 1);
    const lifeScale = 0.28 + (life * 0.72);
    consider(
      hs.x,
      hs.z,
      hs.baseStrength * getNoiseKindWeight(hs.kind) * lifeScale,
      hs.signLevel * lifeScale,
      hs.kind,
      hs.radius
    );
  }

  // Player actor noise/shield on sand
  for (const p of players.values()) {
    if (p.surfaceType !== "sand") continue;
    const shieldStrength = p.shieldActive
      ? clamp(Math.max(p.signLevel, (p.noiseLevel * 0.65) + WORM_CFG.shieldHotspotBonus), 0, 1)
      : 0;
    const strength = clamp(
      Math.max(
        p.signLevel,
        (p.noiseLevel * 0.65) + (p.spiceCarry > 0 ? 0.08 : 0),
        shieldStrength
      ),
      0,
      1
    );
    consider(p.x, p.z, strength, p.signLevel, "actor");
  }

  return strongest;
}

function killPlayerByWorm(target) {
  if (!target || target.health <= 0) return;
  target.health = 0;
  io.emit("playerDamaged", { id: target.id, health: target.health, attackerId: "worm" });
  io.emit("playerKilled", { id: target.id, killerId: "worm" });
  emitDeathEvent(target.id, "worm", "worm");
  setTimeout(() => {
    const p = players.get(target.id);
    if (!p) return;
    p.health = 100;
    io.emit("playerRespawned", { id: target.id });
  }, 3000);
}

function tickWorm(dt) {
  for (let i = noiseHotspots.length - 1; i >= 0; i -= 1) {
    noiseHotspots[i].ttl -= dt;
    if (noiseHotspots[i].ttl <= 0) noiseHotspots.splice(i, 1);
  }

  worm.cooldown = Math.max(0, worm.cooldown - dt);
  const hotspot = sampleStrongestWormHotspot();
  const hotspotStrength = hotspot ? hotspot.strength : 0;
  const response = hotspotStrength > worm.noisePressure
    ? WORM_CFG.noisePressureRise
    : WORM_CFG.noisePressureDecay;
  worm.noisePressure = damp(worm.noisePressure, hotspotStrength, response, dt);

  if (worm.phase === "idle") {
    if (
      worm.state === "off_map" &&
      worm.cooldown <= 0 &&
      hotspot &&
      worm.noisePressure >= WORM_CFG.noisePressureSpawnThreshold
    ) {
      worm.state = "hunting";
      worm.phase = "warning";
      worm.timer = WORM_CFG.warningDuration;
      worm.target.x = hotspot.x;
      worm.target.z = hotspot.z;
    }
    return;
  }

  if (hotspot) {
    worm.target.x = damp(worm.target.x, hotspot.x, WORM_CFG.targetTrackSharpness, dt);
    worm.target.z = damp(worm.target.z, hotspot.z, WORM_CFG.targetTrackSharpness, dt);
  }

  if (worm.phase === "breach") {
    const killR2 = WORM_CFG.killRadius * WORM_CFG.killRadius;
    for (const p of players.values()) {
      if (p.health <= 0) continue;
      if (p.surfaceType !== "sand") continue;
      if (dist2(p.x, p.z, worm.target.x, worm.target.z) <= killR2) {
        killPlayerByWorm(p);
      }
    }
  }

  worm.timer = Math.max(0, worm.timer - dt);
  if (worm.timer > 0) return;

  if (worm.phase === "warning") {
    worm.phase = "breach";
    worm.timer = WORM_CFG.breachDuration;
    return;
  }
  if (worm.phase === "breach") {
    worm.phase = "recover";
    worm.timer = WORM_CFG.recoverDuration;
    return;
  }
  if (worm.phase === "recover") {
    worm.phase = "idle";
    worm.state = "off_map";
    worm.cooldown = WORM_CFG.cooldownDuration;
  }
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

setInterval(() => {
  tickWorm(WORM_TICK_MS / 1000);
  io.emit("wormSync", {
    state: worm.state,
    phase: worm.phase,
    timer: worm.timer,
    cooldown: worm.cooldown,
    noisePressure: worm.noisePressure,
    target: { x: worm.target.x, z: worm.target.z },
    worldTime: (Date.now() - SERVER_START_MS) / 1000,
  });
}, WORM_TICK_MS);

// ── Poison tick ──────────────────────────────────────────────────────────────

const POISON_TICK_MS = 200;
setInterval(() => {
  const dt = POISON_TICK_MS / 1000;
  for (const p of players.values()) {
    if (p.poisonTimer <= 0) continue;
    p.poisonTimer = Math.max(0, p.poisonTimer - dt);
    if (p.health <= 0) { p.poisonTimer = 0; continue; }
    const dmg = POISON_DPS * dt;
    p.health = Math.max(0, p.health - dmg);
    io.emit("playerDamaged", { id: p.id, health: p.health, attackerId: p.poisonAttackerId });
    if (p.health <= 0) {
      io.emit("playerKilled", { id: p.id, killerId: p.poisonAttackerId });
      emitDeathEvent(p.id, p.poisonAttackerId, "poison");
      p.poisonTimer = 0;
      setTimeout(() => {
        if (!players.has(p.id)) return;
        p.health = 100;
        io.emit("playerRespawned", { id: p.id });
      }, 3000);
    }
  }
}, POISON_TICK_MS);

// ── Socket.io ─────────────────────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  // Serve static files for local dev
  const url = req.url.split("?")[0];
  const filePath = url === "/" ? "/index.html" : url;
  const fullPath = path.join(__dirname, filePath);
  const ext = path.extname(fullPath).toLowerCase();
  const mimeTypes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".svg": "image/svg+xml" };
  try {
    const data = fs.readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(200);
    res.end("Spice Jam server running");
  }
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
  const rawName = String(socket.handshake.auth?.name || "").trim().slice(0, 24);
  const name = rawName || ("Pilgrim-" + socket.id.slice(-4).toUpperCase());
  const player = {
    id: socket.id,
    name,
    team,
    x: 0, y: 0, z: 0,
    rotY: 0,
    spiceCarry: 0,
    health: 100,
    equipped: "knife",
    surfaceType: "sand",
    noiseLevel: 0,
    signLevel: 0,
    shieldActive: false,
    poisonTimer: 0,
    poisonAttackerId: null,
    thumperActive: false,
    thumperX: 0,
    thumperZ: 0,
    thumperSignal: 0,
  };
  players.set(socket.id, player);

  console.log(`[+] ${socket.id} "${name}" joined as ${team} (${players.size} players)`);

  // Send new player the full world state
  socket.emit("welcome", { id: socket.id, team, snapshot: getWorldSnapshot() });

  // Tell everyone else about the new player
  socket.broadcast.emit("playerJoined", player);

  function isShieldBlockedAttack(attackType) {
    return attackType === "knife" || attackType === "maula";
  }

  function applyPlayerDamage(targetId, damage, attackerId = socket.id, attackType = "generic") {
    const target = players.get(targetId);
    if (!target || target.health <= 0) return false;
    if (target.shieldActive && isShieldBlockedAttack(attackType)) {
      socket.emit("shieldBlocked", { targetId, attackType });
      return false;
    }
    const clampedDamage = Math.max(0, Math.min(Number(damage) || 0, 100));
    target.health = Math.max(0, target.health - clampedDamage);
    io.emit("playerDamaged", { id: targetId, health: target.health, attackerId });
    if (target.health <= 0) {
      io.emit("playerKilled", { id: targetId, killerId: attackerId });
      emitDeathEvent(targetId, attackerId, attackType);
      setTimeout(() => {
        if (!players.has(targetId)) return;
        target.health = 100;
        target.poisonTimer = 0;
        target.poisonAttackerId = null;
        io.emit("playerRespawned", { id: targetId });
      }, 3000);
    }
    return true;
  }

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
    p.surfaceType = data.surfaceType === "rock" ? "rock" : "sand";
    p.noiseLevel = clamp(Number(data.noiseLevel) || 0, 0, 1);
    p.signLevel = clamp(Number(data.signLevel) || 0, 0, 1);
    p.shieldActive = Boolean(data.shieldActive);
    p.thumperActive = Boolean(data.thumperActive);
    p.thumperX = Number(data.thumperX) || p.x;
    p.thumperZ = Number(data.thumperZ) || p.z;
    p.thumperSignal = clamp(Number(data.thumperSignal) || 0, 0, 1);
    // Relay to everyone else — don't echo back to sender
    socket.broadcast.emit("playerMoved", {
      id: socket.id,
      x: p.x, y: p.y, z: p.z,
      rotY: p.rotY,
      spiceCarry: p.spiceCarry,
      equipped: p.equipped,
      shieldActive: p.shieldActive,
    });
  });

  socket.on("noiseHotspot", (data) => {
    if (!data) return;
    pushNoiseHotspot(
      data.kind,
      data.x,
      data.z,
      data.strength,
      {
        radius: data.radius,
        ttl: data.ttl,
        signLevel: data.signLevel,
      }
    );
  });

  socket.on("holtzmanDetonation", (data) => {
    if (!data) return;
    const now = Date.now();
    if (now - lastHoltzmanDetonationMs < HOLTZMAN_EVENT_COOLDOWN_MS) return;
    lastHoltzmanDetonationMs = now;
    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;

    for (const p of players.values()) {
      if (!p || p.health <= 0) continue;
      const dx = p.x - x;
      const dz = p.z - z;
      const dist = Math.hypot(dx, dz);
      let damage = 0;
      if (dist < HOLTZMAN_LETHAL_RADIUS) {
        damage = 999;
      } else if (dist < HOLTZMAN_DAMAGE_RADIUS) {
        const f = 1 - ((dist - HOLTZMAN_LETHAL_RADIUS)
          / Math.max(0.001, HOLTZMAN_DAMAGE_RADIUS - HOLTZMAN_LETHAL_RADIUS));
        damage = HOLTZMAN_DAMAGE * f;
      }
      if (damage > 0) {
        applyPlayerDamage(p.id, damage, socket.id, "atomic_holtzman");
      }
    }

    io.emit("holtzmanDetonation", {
      x,
      y: Number.isFinite(y) ? y : 0,
      z,
      from: socket.id,
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

  // ── Poison applied (maula dart) ──
  socket.on("poisonPlayer", ({ targetId, attackType = "maula" }) => {
    const target = players.get(targetId);
    if (!target || target.health <= 0) return;
    if (target.shieldActive && isShieldBlockedAttack(attackType)) {
      socket.emit("shieldBlocked", { targetId, attackType });
      return;
    }
    target.poisonTimer = POISON_DURATION;
    target.poisonAttackerId = socket.id;
    io.emit("playerPoisoned", { id: targetId, duration: POISON_DURATION });
  });

  // ── Combined maula PvP hit (damage + poison) ──
  socket.on("maulaHitPlayer", ({ targetId, damage, applyPoison = true }) => {
    const applied = applyPlayerDamage(targetId, damage, socket.id, "maula");
    if (!applied || !applyPoison) return;
    const target = players.get(targetId);
    if (!target || target.health <= 0) return;
    if (target.shieldActive) return;
    target.poisonTimer = POISON_DURATION;
    target.poisonAttackerId = socket.id;
    io.emit("playerPoisoned", { id: targetId, duration: POISON_DURATION });
  });

  // ── Hit / damage ──
  socket.on("hitPlayer", ({ targetId, damage, attackType = "generic" }) => {
    applyPlayerDamage(targetId, damage, socket.id, attackType);
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
