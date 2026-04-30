const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3001;
const SPICE_RESPAWN_SECONDS = 32;
const SPICE_NODE_COUNT = 8;
const SPICE_SMALL_YIELD_MIN = 6;
const SPICE_SMALL_YIELD_MAX = 9;
const SPICE_PLUME_YIELD_MIN = 16;
const SPICE_PLUME_YIELD_MAX = 20;
const SPICE_INITIAL_PLUME_CHANCE = 1;
const SPICE_PLUME_SPAWN_INTERVAL = 60;   // seconds between plume spawn checks
const SPICE_PLUME_SPAWN_CHANCE = 0.35;   // probability per check
const SPICE_PLUME_COOLDOWN = 35;         // seconds after a plume is depleted
const SPICE_DECAY_SECONDS = 45;          // seconds after first harvest before node auto-depletes
const SPICE_MAX_CARRY = 10;
const SPICE_TUTORIAL_NODE_ID = 0;
const SPICE_TUTORIAL_YIELD_MIN = 1;
const SPICE_TUTORIAL_YIELD_MAX = 3;
const MAX_PLAYERS = 20;
const WORM_TICK_MS = 100;
const WORLD_SIZE = 1500;
const WORLD_HALF = WORLD_SIZE * 0.5;
const PLAYER_SPEED = 16.5;
const PLAYER_RUN_MULTIPLIER = 1.65;
const PLAYER_MAX_RUN_SPEED = PLAYER_SPEED * PLAYER_RUN_MULTIPLIER;
const POISON_DPS = 4;
const POISON_DURATION = 6;
const HOLTZMAN_LETHAL_RADIUS = 35;
const HOLTZMAN_DAMAGE_RADIUS = 70;
const HOLTZMAN_DAMAGE = 80;
const HOLTZMAN_EVENT_COOLDOWN_MS = 250;
const SPAWN_PROTECTION_SECONDS = 1.0;
const PLAYER_SPAWN_CENTER_X = -380;
const PLAYER_SPAWN_CENTER_Z = -380;
const PLAYER_SPAWN_RADIUS = 18;
const PLAYER_SPAWN_MIN_SEPARATION = 6;
const START_MESA_SAFE_RADIUS = 41;
const SPICE_DEPOT_X = PLAYER_SPAWN_CENTER_X;
const SPICE_DEPOT_Z = PLAYER_SPAWN_CENTER_Z - 10;
const SPICE_DEPOSIT_RADIUS = 7.5;
const SPICE_DEPOSIT_SERVER_PADDING = 2.5;
const NPC_SPICE_DROP_AMOUNT = 1;
const NPC_SPICE_DROP_MAX_DISTANCE = 240;
const DEFAULT_MAP_SEED = Math.floor(Math.random() * 0x1000000) >>> 0;
const SERVER_START_MS = Date.now();

function mulberry32(seed) {
  return function next() {
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRange(min, max, rand = Math.random) {
  return min + ((max - min) * rand());
}

function parseMapSeed(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let parsed = NaN;
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    parsed = Number.parseInt(raw, 16);
  } else if (/^[0-9a-f]{6,8}$/i.test(raw) && /[a-f]/i.test(raw)) {
    parsed = Number.parseInt(raw, 16);
  } else if (/^\d+$/.test(raw)) {
    parsed = Number.parseInt(raw, 10);
  }

  if (!Number.isFinite(parsed)) return null;
  return (parsed >>> 0) & 0xFFFFFF;
}

const MAP_SEED = parseMapSeed(process.env.MAP_SEED) ?? DEFAULT_MAP_SEED;

function rollSpiceYield(type, nodeId, cycle = 0) {
  const seed = (
    (MAP_SEED ^ 0x53a9b1df)
    + ((nodeId + 1) * 0x9e3779b9)
    + (cycle * 0x85ebca6b)
  ) >>> 0;
  const rand = mulberry32(seed);
  const min = type === "plume" ? SPICE_PLUME_YIELD_MIN : SPICE_SMALL_YIELD_MIN;
  const max = type === "plume" ? SPICE_PLUME_YIELD_MAX : SPICE_SMALL_YIELD_MAX;
  return Math.floor(randomRange(min, max + 1, rand));
}

function rollTutorialSpiceYield(cycle = 0) {
  const seed = ((MAP_SEED ^ 0x2b7e6a11) + (cycle * 0x85ebca6b)) >>> 0;
  const rand = mulberry32(seed);
  return Math.floor(randomRange(SPICE_TUTORIAL_YIELD_MIN, SPICE_TUTORIAL_YIELD_MAX + 1, rand));
}

const hasInitialSpicePlume = mulberry32((MAP_SEED ^ 0x1f4e2c73) >>> 0)() < SPICE_INITIAL_PLUME_CHANCE;

const WORM_CFG = {
  noisePressureSpawnThreshold: 0.68,
  noisePressureRise: 0.38,
  noisePressureDecay: 0.14,
  hotspotMinIntensity: 0.18,
  spawnMinDistance: 300,
  spawnMaxDistance: 500,
  inboundSpeed: 48,
  huntingSpeed: 58,
  retreatSpeed: 38,
  steering: 3.4,
  retreatSteering: 2.2,
  attackTriggerDistance: 36,
  offMapTravelDistance: 1900,
  inboundDuration: 2.2,
  warningDuration: 2.8,
  breachDuration: 4.0,
  strikeDelay: 0.35,
  strikeWindow: 0.65,
  devourDuration: 3.2,
  recoverDuration: 2.0,
  cooldownDuration: 14,
  killRadius: 28,
  attackMinSign: 0.32,
  warningSignFloor: 0.72,
  warningRadius: 42,
  leadDistance: 18,
  targetTrackSharpness: 4.6,
  targetLockProgress: 0.72,
  pullRadius: 18.5,
  pullWarningStrength: 10,
  pullBreachStrength: 22,
  shieldHotspotBonus: 0.34,
  maxNoiseHotspots: 32,
};

// ── Game state ────────────────────────────────────────────────────────────────

const players = new Map(); // socketId → playerState
const playerSessions = new Map(); // playerToken -> { name, team, socketId, lastSeen }
const socketSessionTokens = new Map(); // socketId -> playerToken

// Spice nodes: server owns active state, remaining yield, type, and respawn timers.
// Positions are still determined client-side from MAP_SEED for now.
const spiceNodes = Array.from({ length: SPICE_NODE_COUNT }, (_, i) => {
  const tutorial = i === SPICE_TUTORIAL_NODE_ID;
  const type = tutorial
    ? "small"
    : (hasInitialSpicePlume && i === (SPICE_NODE_COUNT - 1) ? "plume" : "small");
  const totalYield = tutorial ? rollTutorialSpiceYield(0) : rollSpiceYield(type, i, 0);
  return {
    id: i,
    tutorial,
    active: true,
    respawnTimer: 0,
    decayTimer: -1,
    type,
    totalYield,
    remaining: totalYield,
    respawnCount: 0,
  };
});

let spicePlumeCooldown = 0;
let spicePlumeSpawnTimer = 0;

const spiceDrops = new Map(); // dropId → { x, z, amount, timer }
let nextDropId = 1;
const SPICE_DROP_LIFETIME = 15; // seconds before drop sinks and disappears

const scores = { fremen: 0, harkonnen: 0 };
const noiseHotspots = [];
const worm = {
  position: { x: 0, z: 0 },
  velocity: { x: 0, z: 0 },
  state: "off_map",
  phase: "idle",
  timer: 0,
  cooldown: 0,
  noisePressure: 0,
  target: { x: 0, z: 0 },
	  targetHotspot: null,
	  targetSource: null,
	  targetOwnerId: null,
	  lastSpawnTime: -Infinity,
	  strikeEventSent: false,
	  strikeId: 0,
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

function getWorldTimeSeconds() {
  return (Date.now() - SERVER_START_MS) / 1000;
}

function isInsideStartMesaSafeZone(x, z) {
  const dx = x - PLAYER_SPAWN_CENTER_X;
  const dz = z - PLAYER_SPAWN_CENTER_Z;
  return (dx * dx) + (dz * dz) <= (START_MESA_SAFE_RADIUS * START_MESA_SAFE_RADIUS);
}

function sanitizePlayerName(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .replace(/[^\w .'-]/g, "")
    .trim()
    .slice(0, 24);
}

function sanitizePlayerToken(raw) {
  if (typeof raw !== "string") return "";
  const token = raw.trim().slice(0, 64);
  if (!/^[a-z0-9_-]{12,64}$/i.test(token)) return "";
  return token;
}

function fallbackPlayerName(socketId, playerToken = "") {
  const stableSuffix = playerToken
    ? playerToken.slice(-4).toUpperCase()
    : String(socketId).slice(-4).toUpperCase();
  return `Pilgrim-${stableSuffix}`;
}

function pickPlayerSpawnPoint(excludeId = null) {
  const others = [];
  for (const p of players.values()) {
    if (!p || p.id === excludeId || p.health <= 0) continue;
    others.push(p);
  }

  const minSeparationSq = PLAYER_SPAWN_MIN_SEPARATION * PLAYER_SPAWN_MIN_SEPARATION;
  let best = null;
  let bestScore = -Infinity;
  const attempts = 24;

  for (let i = 0; i < attempts; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * PLAYER_SPAWN_RADIUS;
    const x = clampToPlayableBounds(PLAYER_SPAWN_CENTER_X + (Math.cos(angle) * dist));
    const z = clampToPlayableBounds(PLAYER_SPAWN_CENTER_Z + (Math.sin(angle) * dist));

    let nearestSq = Infinity;
    for (const p of others) {
      const d2 = dist2(x, z, p.x, p.z);
      if (d2 < nearestSq) nearestSq = d2;
    }
    if (!Number.isFinite(nearestSq)) nearestSq = minSeparationSq;

    const score = nearestSq + (Math.random() * 0.0001);
    if (score > bestScore) {
      bestScore = score;
      best = { x, z };
    }
    if (nearestSq >= minSeparationSq) break;
  }

  return best || { x: PLAYER_SPAWN_CENTER_X, z: PLAYER_SPAWN_CENTER_Z };
}

function getWorldSnapshot() {
  return {
    players: [...players.values()],
    spiceNodes,
    spiceDrops: [...spiceDrops.values()],
    scores,
    seed: MAP_SEED,
    worm: {
      position: { ...worm.position },
      velocity: { ...worm.velocity },
      state: worm.state,
      phase: worm.phase,
      timer: worm.timer,
      cooldown: worm.cooldown,
      noisePressure: worm.noisePressure,
      target: { ...worm.target },
      targetHotspot: worm.targetHotspot ? { ...worm.targetHotspot } : null,
      worldTime: getWorldTimeSeconds(),
    },
  };
}

function emitDeathEvent(victimId, killerId, cause = "combat", respawnSeconds = 3) {
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
    respawnSeconds,
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

function getPlayerSpiceCarry(player) {
  if (!player) return 0;
  return clamp(Math.floor(Number(player.spiceCarry) || 0), 0, SPICE_MAX_CARRY);
}

function setPlayerSpiceCarry(player, amount) {
  if (!player) return 0;
  player.spiceCarry = clamp(Math.floor(Number(amount) || 0), 0, SPICE_MAX_CARRY);
  return player.spiceCarry;
}

function emitPlayerCarry(player, targetSocket = null) {
  if (!player) return;
  const payload = { id: player.id, spiceCarry: getPlayerSpiceCarry(player) };
  if (targetSocket) {
    targetSocket.emit("playerCarryUpdated", payload);
  } else {
    io.emit("playerCarryUpdated", payload);
    io.emit("playerMoved", {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      rotY: player.rotY,
      spiceCarry: payload.spiceCarry,
      equipped: player.equipped,
      shieldActive: player.shieldActive,
    });
  }
}

function isPlayerNearSpiceDepot(player) {
  if (!player) return false;
  const radius = SPICE_DEPOSIT_RADIUS + SPICE_DEPOSIT_SERVER_PADDING;
  return dist2(player.x, player.z, SPICE_DEPOT_X, SPICE_DEPOT_Z) <= radius * radius;
}

function isInsideWorldBounds(x, z, padding = 0) {
  const halfWorld = WORLD_HALF - padding;
  return x >= -halfWorld && x <= halfWorld && z >= -halfWorld && z <= halfWorld;
}

function clampToPlayableBounds(value) {
  return clamp(value, -WORLD_HALF + 10, WORLD_HALF - 10);
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

function getNearestTrackedPlayerDistance(x, z) {
  let best = Infinity;
  for (const p of players.values()) {
    if (p.health <= 0) continue;
    const distance = Math.sqrt(dist2(x, z, p.x, p.z));
    if (distance < best) best = distance;
  }
  return best;
}

function setWormTargetHotspot(target) {
  if (!target) {
    worm.targetHotspot = null;
    worm.targetSource = null;
    worm.targetOwnerId = null;
    return;
  }
  worm.targetHotspot = {
    x: Number(target.x) || 0,
    z: Number(target.z) || 0,
  };
  worm.targetSource = target.source || null;
  worm.targetOwnerId = target.ownerId || null;
}

function trackWormTargetHotspot(target, dt) {
  if (!target) return;
  if (!worm.targetHotspot) {
    setWormTargetHotspot(target);
    return;
  }
  worm.targetHotspot.x = damp(worm.targetHotspot.x, target.x, WORM_CFG.targetTrackSharpness, dt);
  worm.targetHotspot.z = damp(worm.targetHotspot.z, target.z, WORM_CFG.targetTrackSharpness, dt);
  worm.targetSource = target.source || worm.targetSource || null;
  worm.targetOwnerId = target.ownerId || worm.targetOwnerId || null;
}

function getLockedThumperHotspot() {
  if (worm.targetSource !== "thumper" || !worm.targetOwnerId) return null;
  const owner = players.get(worm.targetOwnerId);
  if (!owner?.thumperActive) return null;
  const thStrength = clamp(0.52 + (0.48 * (owner.thumperSignal || 0)), 0, 1);
  return {
    x: owner.thumperX ?? owner.x,
    z: owner.thumperZ ?? owner.z,
    strength: clamp(thStrength * getNoiseKindWeight("thumper"), 0, 1),
    signLevel: thStrength,
    source: "thumper",
    ownerId: owner.id,
  };
}

function getLockedAtomicHotspot() {
  if (worm.targetSource !== "atomic_holtzman" || !worm.targetHotspot) return null;
  if (worm.state === "retreat" || worm.state === "off_map") return null;
  return {
    x: worm.targetHotspot.x,
    z: worm.targetHotspot.z,
    strength: 1,
    signLevel: 1,
    source: "atomic_holtzman",
  };
}

function pickWormTargetForPlayer(p) {
  const speed = Math.hypot(p.vx || 0, p.vz || 0);
  let dirX = 0;
  let dirZ = 0;
  if (speed > 0.5) {
    dirX = (p.vx || 0) / speed;
    dirZ = (p.vz || 0) / speed;
  }
  const leadDistance = WORM_CFG.leadDistance
    * clamp(speed / Math.max(0.001, PLAYER_MAX_RUN_SPEED), 0, 1);
  return {
    x: clampToPlayableBounds((p.x || 0) + (dirX * leadDistance)),
    z: clampToPlayableBounds((p.z || 0) + (dirZ * leadDistance)),
  };
}

function spawnWormOutsideCluster(target, worldTime) {
  if (!target) return false;
  const originX = Number.isFinite(target.x) ? target.x : 0;
  const originZ = Number.isFinite(target.z) ? target.z : 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const distance = WORM_CFG.spawnMinDistance
      + (Math.random() * (WORM_CFG.spawnMaxDistance - WORM_CFG.spawnMinDistance));
    const x = originX + (Math.cos(angle) * distance);
    const z = originZ + (Math.sin(angle) * distance);
    worm.position.x = x;
    worm.position.z = z;
    worm.velocity.x = 0;
    worm.velocity.z = 0;
    worm.state = "inbound";
    worm.lastSpawnTime = worldTime;
    setWormTargetHotspot(target);
    return true;
  }
  return false;
}

function steerWormTowards(target, speed, steering, dt) {
  if (!target) return Infinity;
  const desiredX = target.x - worm.position.x;
  const desiredZ = target.z - worm.position.z;
  const distance = Math.hypot(desiredX, desiredZ);
  if (distance > 0.001) {
    const scale = speed / distance;
    const vx = desiredX * scale;
    const vz = desiredZ * scale;
    const alpha = 1 - Math.exp(-steering * dt);
    worm.velocity.x += (vx - worm.velocity.x) * alpha;
    worm.velocity.z += (vz - worm.velocity.z) * alpha;
  } else {
    const decay = Math.exp(-steering * dt);
    worm.velocity.x *= decay;
    worm.velocity.z *= decay;
  }
  worm.position.x += worm.velocity.x * dt;
  worm.position.z += worm.velocity.z * dt;
  return distance;
}

function startWormRetreat() {
  const clusterCenter = getPlayerClusterCenter();
  let dirX = worm.position.x - clusterCenter.x;
  let dirZ = worm.position.z - clusterCenter.z;
  if ((dirX * dirX) + (dirZ * dirZ) < 0.001) {
    const angle = Math.random() * Math.PI * 2;
    dirX = Math.cos(angle);
    dirZ = Math.sin(angle);
  }
  const length = Math.hypot(dirX, dirZ) || 1;
  dirX = (dirX / length) * WORM_CFG.offMapTravelDistance;
  dirZ = (dirZ / length) * WORM_CFG.offMapTravelDistance;
  setWormTargetHotspot({
    x: worm.position.x + dirX,
    z: worm.position.z + dirZ,
  });
  worm.state = "retreat";
  worm.noisePressure = Math.min(worm.noisePressure, 0.32);
}

function beginWormWarning() {
  worm.target.x = worm.position.x;
  worm.target.z = worm.position.z;
  worm.velocity.x = 0;
  worm.velocity.z = 0;
  worm.phase = "warning";
  worm.timer = WORM_CFG.warningDuration;
  worm.strikeEventSent = false;
  worm.noisePressure *= 0.72;
}

function emitWormStrikeEvent() {
  if (worm.strikeEventSent) return;
  worm.strikeEventSent = true;
  worm.strikeId += 1;
  io.emit("wormStrike", {
    id: worm.strikeId,
    x: worm.target.x,
    z: worm.target.z,
    radius: WORM_CFG.killRadius,
    deathKind: "worm",
    worldTime: getWorldTimeSeconds(),
  });
}

function anchorWormAtStrikeTarget() {
  worm.position.x = worm.target.x;
  worm.position.z = worm.target.z;
  worm.velocity.x = 0;
  worm.velocity.z = 0;
}

function schedulePlayerRespawn(targetId, delayMs = 3000) {
  setTimeout(() => {
    const target = players.get(targetId);
    if (!target) return;
	    const spawn = pickPlayerSpawnPoint(targetId);
	    target.health = 100;
	    target.x = spawn.x;
	    target.z = spawn.z;
	    target.y = 0;
	    clearPlayerTransientState(target, { clearCarry: true });
	    grantSpawnProtection(target);
	    emitPlayerCarry(target);
	    io.emit("playerRespawned", {
	      id: targetId,
	      spawn,
	      protectedUntil: target.spawnProtectedUntil,
	      spiceCarry: getPlayerSpiceCarry(target),
	      worldTime: getWorldTimeSeconds(),
	    });
  }, delayMs);
}

function emitWormDevourStart(target) {
  io.emit("wormDevourStart", {
    victimId: target.id,
    target: { x: worm.target.x, z: worm.target.z },
    devourDuration: WORM_CFG.devourDuration,
    recoverDuration: WORM_CFG.recoverDuration,
    worldTime: getWorldTimeSeconds(),
  });
}

function consumePlayerThumper(player) {
  if (!player?.thumperActive) return false;
  player.thumperActive = false;
  player.thumperSignal = 0;
  io.to(player.id).emit("wormConsumedThumper");
  io.emit("deathEvent", {
    victimId: null,
    killerId: "worm",
    cause: "thumper",
    victimName: "Thumper",
    killerName: "Worm",
    message: "Worm consumed the thumper",
    respawnSeconds: 0,
  });
  return true;
}

function spawnSpiceDrop(x, z, amount) {
  amount = clamp(Math.floor(Number(amount) || 0), 0, SPICE_MAX_CARRY);
  if (amount <= 0) return;
  const id = nextDropId++;
  spiceDrops.set(id, { id, x, z, amount, timer: SPICE_DROP_LIFETIME });
  io.emit("spiceDrop", { id, x, z, amount });
}

function dropPlayerCarriedSpice(player) {
  const amount = getPlayerSpiceCarry(player);
  if (amount <= 0) return false;
  spawnSpiceDrop(player.x, player.z, amount);
  return true;
}

function clearPlayerTransientState(player, { clearCarry = true } = {}) {
  if (!player) return;
  player.poisonTimer = 0;
  player.poisonAttackerId = null;
  player.shieldActive = false;
  player.harvestActive = false;
  player.noiseLevel = 0;
  player.signLevel = 0;
  player.vx = 0;
  player.vz = 0;
  player.moveTime = 0;
  if (clearCarry) {
    player.spiceCarry = 0;
  }
}

function grantSpawnProtection(player, seconds = SPAWN_PROTECTION_SECONDS) {
  if (!player) return;
  player.spawnProtectedUntil = getWorldTimeSeconds() + Math.max(0, Number(seconds) || 0);
}

function isSpawnProtected(player, now = getWorldTimeSeconds()) {
  if (!player) return false;
  return Number(player.spawnProtectedUntil) > now;
}

function sampleStrongestWormHotspot() {
  if (worm.phase === "devour" || worm.phase === "recover") return null;
  let strongest = null;

  const consider = (x, z, rawStrength, signLevel, source, radius = Infinity, ownerId = null) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    let falloff = 1;
    if (Number.isFinite(radius)) {
      const nearestPlayerDistance = getNearestTrackedPlayerDistance(x, z);
      if (!Number.isFinite(nearestPlayerDistance)) return;
      falloff = clamp(1 - (nearestPlayerDistance / Math.max(1, radius)), 0, 1);
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
      ownerId,
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
      260,
      p.id
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
    if (p.health <= 0) continue;
    if (p.surfaceType !== "sand") continue;
    const target = pickWormTargetForPlayer(p);
    const shieldStrength = p.shieldActive
      ? clamp(Math.max(p.signLevel, (p.noiseLevel * 0.65) + WORM_CFG.shieldHotspotBonus), 0, 1)
      : 0;
    const strength = clamp(
      Math.max(
        p.signLevel,
        (p.noiseLevel * 0.65)
	          + (getPlayerSpiceCarry(p) > 0 ? 0.08 : 0)
          + (p.harvestActive ? 0.12 : 0),
        shieldStrength
      ),
      0,
      1
    );
    consider(target.x, target.z, strength, p.signLevel, "actor");
  }

  return strongest;
}

function killPlayerByWorm(target) {
  if (!target || target.health <= 0 || isSpawnProtected(target)) return;
	  target.health = 0;
	  dropPlayerCarriedSpice(target);
	  clearPlayerTransientState(target, { clearCarry: true });
	  emitPlayerCarry(target);
	  io.emit("playerDamaged", { id: target.id, health: target.health, attackerId: "worm" });
  io.emit("playerKilled", { id: target.id, killerId: "worm" });
  emitDeathEvent(
    target.id,
    "worm",
    "worm",
    (WORM_CFG.devourDuration + WORM_CFG.recoverDuration)
  );
  emitWormDevourStart(target);
  schedulePlayerRespawn(
    target.id,
    Math.round((WORM_CFG.devourDuration + WORM_CFG.recoverDuration) * 1000)
  );
}

function tickWorm(dt) {
  for (let i = noiseHotspots.length - 1; i >= 0; i -= 1) {
    noiseHotspots[i].ttl -= dt;
    if (noiseHotspots[i].ttl <= 0) noiseHotspots.splice(i, 1);
  }

  worm.cooldown = Math.max(0, worm.cooldown - dt);
  const strongestHotspot = sampleStrongestWormHotspot();
  const lockedHotspot = getLockedThumperHotspot() || getLockedAtomicHotspot();
  const hotspot = lockedHotspot || strongestHotspot;
  const hotspotStrength = strongestHotspot ? strongestHotspot.strength : 0;
  const response = hotspotStrength > worm.noisePressure
    ? WORM_CFG.noisePressureRise
    : WORM_CFG.noisePressureDecay;
  worm.noisePressure = damp(worm.noisePressure, hotspotStrength, response, dt);

  if (worm.phase === "idle") {
    const worldTime = getWorldTimeSeconds();
    if (worm.state === "off_map") {
      setWormTargetHotspot(null);
      worm.velocity.x = 0;
      worm.velocity.z = 0;
      if (
        worm.cooldown <= 0 &&
        hotspot &&
        hotspot.signLevel >= WORM_CFG.attackMinSign &&
        (worldTime - worm.lastSpawnTime) >= WORM_CFG.cooldownDuration &&
        worm.noisePressure >= WORM_CFG.noisePressureSpawnThreshold
      ) {
        spawnWormOutsideCluster(hotspot, worldTime);
      }
      return;
    }

    if (worm.state === "inbound") {
      if (hotspot) {
        trackWormTargetHotspot(hotspot, dt);
      }
      if (!worm.targetHotspot) {
        startWormRetreat();
        return;
      }
      const distance = steerWormTowards(
        worm.targetHotspot,
        WORM_CFG.inboundSpeed,
        WORM_CFG.steering * 0.8,
        dt
      );
      if (distance <= WORM_CFG.warningRadius * 1.35) {
        worm.state = "hunting";
      }
      return;
    }

    if (worm.state === "hunting") {
      if (hotspot) {
        trackWormTargetHotspot(hotspot, dt);
      } else {
        startWormRetreat();
        return;
      }
      if (!worm.targetHotspot) {
        startWormRetreat();
        return;
      }
      const distance = steerWormTowards(
        worm.targetHotspot,
        WORM_CFG.huntingSpeed,
        WORM_CFG.steering,
        dt
      );
      if (
        worm.cooldown <= 0 &&
        hotspot.signLevel >= WORM_CFG.attackMinSign &&
        distance <= WORM_CFG.attackTriggerDistance
      ) {
        beginWormWarning();
      }
      return;
    }

    if (worm.state === "retreat") {
      if (!worm.targetHotspot) {
        startWormRetreat();
      }
      steerWormTowards(
        worm.targetHotspot,
        WORM_CFG.retreatSpeed,
        WORM_CFG.retreatSteering,
        dt
      );
      if (!isInsideWorldBounds(worm.position.x, worm.position.z, -40)) {
        worm.state = "off_map";
        worm.velocity.x = 0;
        worm.velocity.z = 0;
        setWormTargetHotspot(null);
      }
    }
    return;
  }

  if (worm.phase === "warning") {
    const warningProgress = 1 - (worm.timer / WORM_CFG.warningDuration);
    if (hotspot && warningProgress < WORM_CFG.targetLockProgress) {
      trackWormTargetHotspot(hotspot, dt);
      if (worm.targetHotspot) {
        worm.target.x = damp(worm.target.x, worm.targetHotspot.x, WORM_CFG.targetTrackSharpness, dt);
        worm.target.z = damp(worm.target.z, worm.targetHotspot.z, WORM_CFG.targetTrackSharpness, dt);
      }
    }
  }

  if (worm.phase === "breach") {
    const breachElapsed = WORM_CFG.breachDuration - worm.timer;
	    const strikeActive = breachElapsed >= WORM_CFG.strikeDelay
	      && breachElapsed <= (WORM_CFG.strikeDelay + WORM_CFG.strikeWindow);
	    if (strikeActive) {
	      emitWormStrikeEvent();
	      const victims = [];
      const killR2 = WORM_CFG.killRadius * WORM_CFG.killRadius;
      for (const p of players.values()) {
        if (p.thumperActive && dist2(p.thumperX ?? p.x, p.thumperZ ?? p.z, worm.target.x, worm.target.z) <= killR2) {
          consumePlayerThumper(p);
        }
        if (p.health <= 0 || p.surfaceType !== "sand") continue;
        if (isSpawnProtected(p)) continue;
        if (dist2(p.x, p.z, worm.target.x, worm.target.z) <= killR2) {
          victims.push(p);
        }
      }
      if (victims.length > 0) {
        anchorWormAtStrikeTarget();
        for (const victim of victims) killPlayerByWorm(victim);
        worm.phase = "devour";
        worm.timer = WORM_CFG.devourDuration;
        return;
      }
    }
  }

  if (worm.phase === "devour" || worm.phase === "recover") {
    anchorWormAtStrikeTarget();
  }

  worm.timer = Math.max(0, worm.timer - dt);
  if (worm.timer > 0) return;

  if (worm.phase === "warning") {
    worm.phase = "breach";
    worm.timer = WORM_CFG.breachDuration;
    return;
  }
  if (worm.phase === "breach") {
    anchorWormAtStrikeTarget();
    worm.phase = "idle";
    worm.cooldown = WORM_CFG.cooldownDuration;
    startWormRetreat();
    return;
  }
  if (worm.phase === "devour") {
    anchorWormAtStrikeTarget();
    worm.phase = "recover";
    worm.timer = WORM_CFG.recoverDuration;
    return;
  }
  if (worm.phase === "recover") {
    anchorWormAtStrikeTarget();
    worm.phase = "idle";
    worm.cooldown = WORM_CFG.cooldownDuration;
    startWormRetreat();
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
        node.decayTimer = -1;
        node.type = "small";
        node.respawnCount += 1;
        node.totalYield = node.tutorial
          ? rollTutorialSpiceYield(node.respawnCount)
          : rollSpiceYield(node.type, node.id, node.respawnCount);
        node.remaining = node.totalYield;
        changed = true;
      }
    } else if (node.decayTimer > 0) {
      // Partially-harvested nodes decay after timeout
      node.decayTimer -= TICK_MS / 1000;
      if (node.decayTimer <= 0) {
        node.active = false;
        node.decayTimer = -1;
        node.respawnTimer = SPICE_RESPAWN_SECONDS;
        if (node.type === "plume") {
          spicePlumeCooldown = SPICE_PLUME_COOLDOWN;
        }
        io.emit("nodeHarvested", node.id);
        changed = true;
      }
    }
  }

  // Plume spawn check (mirrors single-player logic on server)
  if (spicePlumeCooldown > 0) spicePlumeCooldown -= TICK_MS / 1000;
  spicePlumeSpawnTimer += TICK_MS / 1000;
  if (spicePlumeSpawnTimer >= SPICE_PLUME_SPAWN_INTERVAL) {
    spicePlumeSpawnTimer -= SPICE_PLUME_SPAWN_INTERVAL;
    const hasActivePlume = spiceNodes.some(n => n.type === "plume" && n.active);
    if (!hasActivePlume && spicePlumeCooldown <= 0) {
      if (Math.random() < SPICE_PLUME_SPAWN_CHANCE) {
        const slot = spiceNodes.find(n => !n.active);
        if (slot) {
          slot.type = "plume";
          slot.respawnCount += 1;
          slot.totalYield = rollSpiceYield("plume", slot.id, slot.respawnCount);
          slot.remaining = slot.totalYield;
          slot.active = true;
          slot.respawnTimer = 0;
          changed = true;
        }
      }
    }
  }

  if (changed) io.emit("spiceSync", spiceNodes);

  // Expire spice drops
  for (const [id, drop] of spiceDrops) {
    drop.timer -= TICK_MS / 1000;
    if (drop.timer <= 0) {
      spiceDrops.delete(id);
      io.emit("spiceDropExpired", id);
    }
  }
}, TICK_MS);

setInterval(() => {
  tickWorm(WORM_TICK_MS / 1000);
  io.emit("wormSync", {
    position: { x: worm.position.x, z: worm.position.z },
    velocity: { x: worm.velocity.x, z: worm.velocity.z },
    state: worm.state,
    phase: worm.phase,
    timer: worm.timer,
    cooldown: worm.cooldown,
    noisePressure: worm.noisePressure,
    target: { x: worm.target.x, z: worm.target.z },
    targetHotspot: worm.targetHotspot ? { ...worm.targetHotspot } : null,
    worldTime: getWorldTimeSeconds(),
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
    if (isSpawnProtected(p)) continue;
    const dmg = POISON_DPS * dt;
    p.health = Math.max(0, p.health - dmg);
    io.emit("playerDamaged", { id: p.id, health: p.health, attackerId: p.poisonAttackerId });
	    if (p.health <= 0) {
			      dropPlayerCarriedSpice(p);
	      clearPlayerTransientState(p, { clearCarry: true });
	      emitPlayerCarry(p);
	      io.emit("playerKilled", { id: p.id, killerId: p.poisonAttackerId });
      emitDeathEvent(p.id, p.poisonAttackerId, "poison");
      schedulePlayerRespawn(p.id, 3000);
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

  const clientSeed = parseMapSeed(socket.handshake.auth?.seed);
  if (clientSeed !== null && clientSeed !== MAP_SEED) {
    socket.emit("seedMismatch", { seed: MAP_SEED });
    socket.disconnect(true);
    return;
  }

  const sessionToken = sanitizePlayerToken(String(socket.handshake.auth?.playerToken || ""));
  const session = sessionToken ? (playerSessions.get(sessionToken) || null) : null;
  if (session?.socketId && session.socketId !== socket.id) {
    const prevSocket = io.sockets.sockets.get(session.socketId);
    if (prevSocket) prevSocket.disconnect(true);
  }

  const team = session?.team || assignTeam();
  const spawn = pickPlayerSpawnPoint(socket.id);
  const rawName = sanitizePlayerName(String(socket.handshake.auth?.name || ""));
  const name = rawName || session?.name || fallbackPlayerName(socket.id, sessionToken);
  const player = {
    id: socket.id,
    name,
    team,
    x: spawn.x, y: 0, z: spawn.z,
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
    harvestActive: false,
    thumperActive: false,
    thumperX: 0,
    thumperZ: 0,
    thumperSignal: 0,
    spawnProtectedUntil: getWorldTimeSeconds() + SPAWN_PROTECTION_SECONDS,
    vx: 0,
    vz: 0,
    moveTime: 0,
  };
  players.set(socket.id, player);
  if (sessionToken) {
    playerSessions.set(sessionToken, {
      name,
      team,
      socketId: socket.id,
      lastSeen: Date.now(),
    });
    socketSessionTokens.set(socket.id, sessionToken);
  }

  console.log(`[+] ${socket.id} "${name}" joined as ${team} (${players.size} players)`);

  // Send new player the full world state
  socket.emit("welcome", { id: socket.id, team, spawn, snapshot: getWorldSnapshot() });

  // Tell everyone else about the new player
  socket.broadcast.emit("playerJoined", player);

  function isShieldBlockedAttack(attackType) {
    return attackType === "knife" || attackType === "maula";
  }

  function applyPlayerDamage(targetId, damage, attackerId = socket.id, attackType = "generic") {
    const target = players.get(targetId);
    if (!target || target.health <= 0) return false;
    if (isSpawnProtected(target)) return false;
    if (target.shieldActive && isShieldBlockedAttack(attackType)) {
      socket.emit("shieldBlocked", { targetId, attackType });
      return false;
    }
    const clampedDamage = Math.max(0, Math.min(Number(damage) || 0, 100));
    target.health = Math.max(0, target.health - clampedDamage);
    io.emit("playerDamaged", { id: targetId, health: target.health, attackerId });
	    if (target.health <= 0) {
			      dropPlayerCarriedSpice(target);
	      clearPlayerTransientState(target, { clearCarry: true });
	      emitPlayerCarry(target);
	      io.emit("playerKilled", { id: targetId, killerId: attackerId });
      emitDeathEvent(targetId, attackerId, attackType);
      schedulePlayerRespawn(targetId, 3000);
    }
    return true;
  }

  // ── Position updates (high frequency) ──
  socket.on("move", (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    const x = Number(data.x) || 0;
    const z = Number(data.z) || 0;
    const nowSec = getWorldTimeSeconds();
    const dt = p.moveTime > 0 ? Math.min(0.25, Math.max(0.016, nowSec - p.moveTime)) : 0;
    if (dt > 0) {
      p.vx = (x - p.x) / dt;
      p.vz = (z - p.z) / dt;
    } else {
      p.vx = 0;
      p.vz = 0;
    }
    p.moveTime = nowSec;
	    p.x = x;
	    p.y = data.y;
	    p.z = z;
	    p.rotY = data.rotY;
	    p.equipped = data.equipped;
    p.surfaceType = data.surfaceType === "rock" ? "rock" : "sand";
    p.noiseLevel = clamp(Number(data.noiseLevel) || 0, 0, 1);
    p.signLevel = clamp(Number(data.signLevel) || 0, 0, 1);
    p.shieldActive = Boolean(data.shieldActive);
    p.harvestActive = Boolean(data.harvestActive);
    p.thumperActive = Boolean(data.thumperActive);
    const thumperX = Number(data.thumperX);
    const thumperZ = Number(data.thumperZ);
    p.thumperX = Number.isFinite(thumperX) ? thumperX : p.x;
    p.thumperZ = Number.isFinite(thumperZ) ? thumperZ : p.z;
    p.thumperSignal = clamp(Number(data.thumperSignal) || 0, 0, 1);
    // Relay to everyone else — don't echo back to sender
    socket.broadcast.emit("playerMoved", {
	      id: socket.id,
	      x: p.x, y: p.y, z: p.z,
	      rotY: p.rotY,
	      spiceCarry: getPlayerSpiceCarry(p),
	      equipped: p.equipped,
	      shieldActive: p.shieldActive,
	    });
  });

  socket.on("noiseHotspot", (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    const kind = String(data.kind || "generic");
    if (kind === "atomic_holtzman") return;
    const x = Number(data.x);
    const z = Number(data.z);
    const strength = clamp(Number(data.strength) || 0, 0, 1);
    if (kind === "thumper" && p) {
      p.thumperActive = true;
      p.thumperX = Number.isFinite(x) ? x : p.x;
      p.thumperZ = Number.isFinite(z) ? z : p.z;
      p.thumperSignal = Math.max(p.thumperSignal || 0, strength);
    }
    pushNoiseHotspot(
      kind,
      x,
      z,
      strength,
      {
        radius: data.radius,
        ttl: data.ttl,
        signLevel: data.signLevel,
      }
    );
    if (kind === "thumper" && Number.isFinite(x) && Number.isFinite(z)) {
      const thumperTarget = {
        x,
        z,
        source: "thumper",
        ownerId: socket.id,
      };
      if (worm.phase === "idle" && worm.state === "off_map" && worm.cooldown <= 0) {
        worm.noisePressure = Math.max(worm.noisePressure, WORM_CFG.noisePressureSpawnThreshold);
        spawnWormOutsideCluster(thumperTarget, getWorldTimeSeconds());
      } else if (worm.phase === "idle" && (worm.state === "inbound" || worm.state === "hunting")) {
        trackWormTargetHotspot(thumperTarget, WORM_TICK_MS / 1000);
      }
    }
  });

  socket.on("holtzmanDetonation", (data) => {
    if (!data) return;
    const p = players.get(socket.id);
    const now = Date.now();
    if (now - lastHoltzmanDetonationMs < HOLTZMAN_EVENT_COOLDOWN_MS) return;
    lastHoltzmanDetonationMs = now;
    const x = Number(data.x);
    const y = Number(data.y);
    const z = Number(data.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const reportedSurface = data.surfaceType === "rock"
      ? "rock"
      : (data.surfaceType === "sand" ? "sand" : null);
    const detonationSurface = reportedSurface || (p?.surfaceType === "sand" ? "sand" : "rock");
    const wormEligible = detonationSurface === "sand";

    // Server-side atomic hotspot fallback so worm reaction does not depend on
    // client hotspot emit timing/connectivity.
    if (wormEligible) {
      pushNoiseHotspot("atomic_holtzman", x, z, 1.0, {
        radius: 540,
        ttl: 30,
        signLevel: 1.0,
      });
      if (worm.phase === "idle" && worm.state === "off_map") {
        worm.cooldown = 0;
        worm.noisePressure = Math.max(worm.noisePressure, WORM_CFG.noisePressureSpawnThreshold);
        spawnWormOutsideCluster({ x, z, source: "atomic_holtzman" }, getWorldTimeSeconds());
      } else if (
        worm.phase === "idle"
        && (worm.state === "inbound" || worm.state === "hunting")
        && worm.targetSource !== "atomic_holtzman"
      ) {
        trackWormTargetHotspot({ x, z, source: "atomic_holtzman" }, WORM_TICK_MS / 1000);
      }
    }

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
	  socket.on("harvestNode", (data) => {
	    const p = players.get(socket.id);
	    if (!p || p.health <= 0) return;
	    const nodeId = typeof data === "object" && data !== null ? data.id : data;
	    const node = spiceNodes[nodeId];
	    if (!node || !node.active) {
	      emitPlayerCarry(p, socket);
	      return;
	    }
	    const requestedAmount = Math.max(0, Math.floor(Number(data?.takenAmount) || 0));
	    const carry = getPlayerSpiceCarry(p);
	    const bagSpace = Math.max(0, SPICE_MAX_CARRY - carry);
	    const takenAmount = Math.min(
	      node.remaining,
	      bagSpace,
	      requestedAmount > 0 ? requestedAmount : node.remaining
	    );
	    if (takenAmount <= 0) {
	      emitPlayerCarry(p, socket);
	      io.emit("spiceNodeSync", node);
	      return;
	    }

	    setPlayerSpiceCarry(p, carry + takenAmount);
	    node.remaining = Math.max(0, node.remaining - takenAmount);

	    if (node.remaining <= 0) {
	      node.active = false;
      node.decayTimer = -1;
      node.respawnTimer = SPICE_RESPAWN_SECONDS;
      if (node.type === "plume") {
        spicePlumeCooldown = SPICE_PLUME_COOLDOWN;
      }
      io.emit("nodeHarvested", nodeId);
    } else {
      node.active = true;
      node.respawnTimer = 0;
      // Start decay timer on first partial harvest
      if (node.decayTimer < 0) {
        node.decayTimer = SPICE_DECAY_SECONDS;
      }
	    }
	    io.emit("spiceNodeSync", node);
	    emitPlayerCarry(p);
	  });

	  // ── Spice deposited ──
	  socket.on("spiceDeposited", () => {
	    const p = players.get(socket.id);
	    if (!p || p.health <= 0) return;
	    if (!isPlayerNearSpiceDepot(p)) {
	      emitPlayerCarry(p, socket);
	      socket.emit("spiceDepositRejected", {
	        reason: "not_at_depot",
	        spiceCarry: getPlayerSpiceCarry(p),
	      });
	      return;
	    }
	    const depositedAmount = getPlayerSpiceCarry(p);
	    if (depositedAmount <= 0) {
	      emitPlayerCarry(p, socket);
	      socket.emit("spiceDepositRejected", {
	        reason: "no_spice",
	        spiceCarry: getPlayerSpiceCarry(p),
	      });
	      return;
	    }
	    scores[p.team] += depositedAmount;
	    setPlayerSpiceCarry(p, 0);
	    p.health = 100;
	    io.emit("scoreUpdate", scores);
	    emitPlayerCarry(p);
	    socket.emit("spiceDepositAccepted", {
	      amount: depositedAmount,
	      spiceCarry: getPlayerSpiceCarry(p),
	      scores,
	      health: p.health,
	    });
	    io.emit("playerDamaged", { id: socket.id, health: p.health, attackerId: "bank" });
	  });

  // ── Spice drop pickup ──
  socket.on("pickupSpiceDrop", (dropId) => {
	    const p = players.get(socket.id);
	    if (!p || p.health <= 0) return;
	    const drop = spiceDrops.get(dropId);
	    if (!drop) return;
	    const take = Math.min(drop.amount, SPICE_MAX_CARRY - getPlayerSpiceCarry(p));
	    if (take <= 0) return;
	    setPlayerSpiceCarry(p, getPlayerSpiceCarry(p) + take);
	    drop.amount -= take;
	    if (drop.amount <= 0) {
	      spiceDrops.delete(dropId);
	    }
	    io.emit("spiceDropPickedUp", {
	      dropId,
	      playerId: socket.id,
	      taken: take,
	      remaining: drop.amount || 0,
	      spiceCarry: getPlayerSpiceCarry(p),
	    });
		    emitPlayerCarry(p);
		  });

  socket.on("npcSpiceDrop", (data) => {
    const p = players.get(socket.id);
    if (!p || p.health <= 0) return;
    const x = Number(data?.x);
    const z = Number(data?.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (dist2(p.x, p.z, x, z) > NPC_SPICE_DROP_MAX_DISTANCE * NPC_SPICE_DROP_MAX_DISTANCE) return;
    spawnSpiceDrop(x, z, NPC_SPICE_DROP_AMOUNT);
  });

  // ── Poison applied (maula dart) ──
  socket.on("poisonPlayer", ({ targetId, attackType = "maula" }) => {
    const target = players.get(targetId);
    if (!target || target.health <= 0) return;
    if (isSpawnProtected(target)) return;
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
  socket.on("disconnect", (reason) => {
    const sessionTokenOnDisconnect = socketSessionTokens.get(socket.id);
    socketSessionTokens.delete(socket.id);
    const leftPlayer = players.get(socket.id);
    if (sessionTokenOnDisconnect) {
      const sessionState = playerSessions.get(sessionTokenOnDisconnect);
      if (sessionState && sessionState.socketId === socket.id) {
        sessionState.socketId = null;
        sessionState.lastSeen = Date.now();
        if (leftPlayer?.name) sessionState.name = leftPlayer.name;
        if (leftPlayer?.team) sessionState.team = leftPlayer.team;
      }
    }
    players.delete(socket.id);
    io.emit("playerLeft", socket.id);
    console.log(`[-] ${socket.id} left (${players.size} players) reason=${reason || "unknown"}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(
    `Spice Jam server listening on :${PORT} (seed=${MAP_SEED.toString(16).toUpperCase().padStart(6, "0")})`
  );
});
