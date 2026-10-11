const World = require('./world');
const WEAPONS = new Set(['knife', 'maula', 'lasgun']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function reset(player, now = Date.now()) {
  player.moveBudget = 3;
  player.lastMoveAt = now;
  player.harvest = null;
  player.lastKnifeAt = -Infinity;
  player.lastDartAt = -Infinity;
  player.lastLaserAt = now;
  player.laserCharge = 1;
  player.laserUpdatedAt = now;
  player.darts = 4;
  player.shot = null;
  player.thumperUntil = 0;
  player.shieldCharge = 1;
  player.shieldUpdatedAt = now;
  player.serverSign = 0;
}

// Server-side shield battery. Drain is slightly under the client's and recharge uses the client's
// best (full daylight) rate, so an honest client is never cut off but a shield can't stay up forever.
const SHIELD_DRAIN = 0.16 * 0.85, SHIELD_RECHARGE = 0.055, SHIELD_MIN_ACTIVATE = 0.08;
function shield(player, wantOn, now = Date.now()) {
  const dt = Math.max(0, (now - player.shieldUpdatedAt) / 1000);
  player.shieldUpdatedAt = now;
  if (player.shieldActive) player.shieldCharge = Math.max(0, player.shieldCharge - dt * SHIELD_DRAIN);
  else player.shieldCharge = Math.min(1, player.shieldCharge + dt * SHIELD_RECHARGE);
  if (!wantOn) player.shieldActive = false;
  else if (player.shieldActive) player.shieldActive = player.shieldCharge > 0;
  else player.shieldActive = player.shieldCharge >= SHIELD_MIN_ACTIVATE;
  return player.shieldActive;
}

// Lower bound on worm noise/sign from what the server observes itself (mirrors the client's
// updateNoiseSystem with the quietest assumptions), so reporting zero doesn't hide a player.
function noiseFloor(player, dt) {
  const sand = player.surfaceType === 'sand';
  const speed = Math.hypot(player.vx || 0, player.vz || 0);
  const running = speed > 16.5 * 1.08;
  const movement = running ? Math.min(1, speed / 16.5) * 0.6 : 0;
  const noise = Math.min(1, (sand ? 1 : 0.32) * movement
    + ((player.spiceCarry || 0) > 0 ? 0.1 : 0)
    + (player.harvest ? 0.72 : 0)
    + (player.shieldActive ? (sand ? 0.62 : 0.18) : 0)) * 0.9;
  const exposure = Math.min(1, Math.max(0, (noise - 0.28) / 0.72));
  const damp = (from, to, rate) => from + (to - from) * (1 - Math.exp(-rate * dt));
  if (!sand) player.serverSign = damp(player.serverSign, 0, 0.28);
  else {
    const target = Math.max(Math.pow(exposure, 2.1), player.shieldActive ? 0.58 * 0.9 : 0);
    player.serverSign = damp(player.serverSign, target, target > player.serverSign ? 0.28 : 0.09);
  }
  return { noise, sign: player.serverSign };
}

function move(player, data, terrain, now = Date.now(), pullSpeed = 0) {
  if (!record(data) || !['x', 'y', 'z', 'rotY'].every(k => finite(data[k]))
      || !WEAPONS.has(data.equipped) || player.health <= 0
      || Math.abs(data.x) > 740 || Math.abs(data.z) > 740) return false;
  const ground = World.groundHeight(terrain, data.x, data.z);
  if (data.y < ground - 5 || data.y > ground + 28) return false;
  const dt = Math.max(0, (now - player.lastMoveAt) / 1000);
  const speed = 16.5 * 1.65 + pullSpeed;
  const available = Math.min(3 + speed * 0.35, player.moveBudget + dt * speed);
  const travelled = distance(player, data);
  player.lastMoveAt = now;
  player.moveBudget = available;
  if (travelled > available) return false;
  player.moveBudget -= travelled;
  if (player.harvest && (distance(player.harvest, data) > 1.2 || !data.harvestActive)) player.harvest = null;
  return true;
}

// Terrain occlusion and a small allowance for interpolation/muzzle offsets.
function visible(terrain, a, b) {
  const length = distance(a, b);
  const steps = Math.ceil(length / 3);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    const y = a.y + 3.3 + (b.y - a.y) * t;
    if (World.groundHeight(terrain, x, z) > y + 1) return false;
  }
  return true;
}

function fireDart(player, data, now = Date.now()) {
  if (player.health <= 0 || player.equipped !== 'maula' || !record(data.direction)
      || !['x', 'y', 'z'].every(k => finite(data.direction[k]))
      || player.darts <= 0 || now - player.lastDartAt < 2000) return false;
  const magnitude = Math.hypot(data.direction.x, data.direction.y, data.direction.z);
  if (magnitude < .99 || magnitude > 1.01) return false;
  player.darts--;
  player.lastDartAt = now;
  player.shot = { x: player.x, y: player.y, z: player.z, direction: data.direction, at: now };
  return true;
}

function hit(player, target, type, terrain, now = Date.now()) {
  if (!player || !target || player.id === target.id || player.health <= 0 || target.health <= 0) return 0;
  if (type === 'maula') {
    const shot = player.shot;
    if (!shot || now - shot.at > 2000) return 0;
    const dx = target.x - shot.x, dz = target.z - shot.z;
    const dy = target.y + 2.56 - (shot.y + 3.3);
    const along = dx * shot.direction.x + dy * shot.direction.y + dz * shot.direction.z;
    const flight = Math.max(0, along / 55);
    const miss = Math.hypot(dx - along * shot.direction.x,
      dy - along * shot.direction.y + 1.75 * flight * flight, dz - along * shot.direction.z);
    if (along < -2 || along > 90 || miss > 4 || now - shot.at + 180 < flight * 1000 || !visible(terrain, shot, target)) return 0;
    player.shot = null;
    return 20;
  }
  if (type !== player.equipped || !['knife', 'lasgun'].includes(type) || !visible(terrain, player, target)) return 0;
  const range = distance(player, target);
  const facing = Math.sin(player.rotY) * (target.x - player.x) + Math.cos(player.rotY) * (target.z - player.z);
  if (type === 'knife') {
    if (range > 7 || Math.abs(player.y - target.y) > 6 || facing < range * Math.cos(50 * Math.PI / 180)
        || now - player.lastKnifeAt < 460) return 0;
    player.lastKnifeAt = now;
    return 25;
  }
  if (range > 505 || (range > 10 && facing < range * Math.cos(20 * Math.PI / 180))) return 0;
  const elapsed = Math.min(.1, Math.max(0, (now - player.lastLaserAt) / 1000));
  player.laserCharge = Math.min(1, player.laserCharge + Math.max(0, (now - player.laserUpdatedAt) / 1000 - .15) * .10);
  player.laserUpdatedAt = now;
  player.lastLaserAt = now;
  const duration = Math.min(elapsed, player.laserCharge / .24);
  player.laserCharge = Math.max(0, player.laserCharge - duration * .24);
  return 50 * duration;
}

module.exports = { record, finite, WEAPONS, distance, reset, move, visible, fireDart, hit, shield, noiseFloor };
