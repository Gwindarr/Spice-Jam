const test = require('node:test');
const assert = require('node:assert/strict');
const World = require('../world');
const Rules = require('../game-rules');
const terrain = World.createTerrain(0xabcdef);
function player(id = 'a', x = -380, z = -380) {
  const p = { id, x, z, y: World.groundHeight(terrain, x, z), rotY: 0, health: 100, equipped: 'knife' };
  Rules.reset(p, 1000);
  return p;
}

test('map generation gives eight distinct, reachable sand patches across seeds', () => {
  for (const seed of [0, 1, 0xabcdef, 0xffffff, 0x758d98]) {
    const t = World.createTerrain(seed), nodes = World.initialNodes(seed, t);
    assert.equal(nodes.length, 8);
    assert.deepEqual(nodes, World.initialNodes(seed));
    for (const node of nodes) {
      assert.ok(Math.abs(node.x) <= 680 && Math.abs(node.z) <= 680);
      assert.ok(t.rockPatches.every(p => Math.hypot(p.x-node.x,p.z-node.z) >= p.radius + 46));
    }
    assert.ok(Math.hypot(nodes[0].x+380, nodes[0].z+380) <= 116.01);
    const random = World.mulberry32(seed);
    assert.notEqual(random(), random(), 'RNG must advance between draws');
  }
});

test('movement accepts running but rejects teleporting, nonfinite input, and packet-rate speedups', () => {
  const p = player();
  const input = { ...p, x: p.x+2, y: p.y, harvestActive: false };
  assert.equal(Rules.move(p, input, terrain, 1100), true);
  p.x = input.x;
  assert.equal(Rules.move(p, { ...input, x: 600 }, terrain, 1100), false);
  assert.equal(Rules.move(p, { ...input, x: Infinity }, terrain, 1100), false);
  assert.equal(Rules.move(p, null, terrain, 1100), false);
  let accepted = 0;
  for (let i=0;i<100;i++) {
    const next = {...input, x:p.x+1};
    if (Rules.move(p,next,terrain,1100)) { p.x=next.x; accepted++; }
  }
  assert.ok(accepted < 5);
  p.health = 0;
  assert.equal(Rules.move(p, input, terrain, 2000), false);
});

test('combat rejects invented types, long-range knives, dead attackers, and cooldown bypasses', () => {
  const a = player(), b = player('b',-380,-376);
  assert.equal(Rules.hit(a,b,'generic',terrain,2000),0);
  assert.equal(Rules.hit(a,player('far',200,200),'knife',terrain,2000),0);
  assert.equal(Rules.hit(a,b,'knife',terrain,2000),25);
  assert.equal(Rules.hit(a,b,'knife',terrain,2001),0);
  a.health=0;
  assert.equal(Rules.hit(a,b,'knife',terrain,3000),0);
});

test('maula hits require a fired dart, plausible travel, aim, ammo, and one use per projectile', () => {
  const a=player(),b=player('b',-380,-372);a.equipped='maula';
  assert.equal(Rules.hit(a,b,'maula',terrain,2000),0);
  const direction={x:0,y:0,z:1};
  assert.equal(Rules.fireDart(a,{direction},2000),true);
  assert.equal(Rules.fireDart(a,{direction},2100),false);
  assert.equal(Rules.hit(a,b,'maula',terrain,2300),20);
  assert.equal(Rules.hit(a,b,'maula',terrain,2400),0);
  a.darts=0;
  assert.equal(Rules.fireDart(a,{direction},6000),false);
});

test('laser damage is limited by server time, range, facing and available charge', () => {
  const a=player(),b=player('b',-380,-372);a.equipped='lasgun';
  assert.equal(Rules.hit(a,b,'lasgun',terrain,2000),5);
  assert.equal(Rules.hit(a,b,'lasgun',terrain,2000),0);
  assert.ok(Rules.hit(a,b,'lasgun',terrain,2050)<=2.5);
  a.laserCharge=0;
  assert.equal(Rules.hit(a,b,'lasgun',terrain,2051),0);
});

test('the shield battery drains while up, cannot be held forever, and recharges', () => {
  const p = player();
  assert.equal(Rules.shield(p, true, 1000), true);
  let now = 1000;
  while (Rules.shield(p, true, now += 50) && now < 60000);
  assert.ok(now > 1000 + 6000 && now < 1000 + 9000, `shield lasted ${now - 1000}ms`);
  assert.equal(Rules.shield(p, true, now += 50), false, 'empty battery cannot re-engage');
  Rules.shield(p, false, now += 3000);
  assert.equal(Rules.shield(p, true, now += 50), true, 'recharged past the activation threshold');
});

test('a client reporting silence is still heard when harvesting, shielded or running on sand', () => {
  const quiet = player(); quiet.surfaceType = 'sand';
  assert.equal(Rules.noiseFloor(quiet, 0.05).noise, 0);
  const busy = player(); busy.surfaceType = 'sand'; busy.harvest = { id: 1 }; busy.shieldActive = true;
  let sign = 0; for (let i = 0; i < 100; i++) sign = Rules.noiseFloor(busy, 0.05).sign;
  assert.ok(sign > 0.32, `sign ${sign} reaches the worm's attack threshold`);
  const runner = player(); runner.surfaceType = 'sand'; runner.vx = 26;
  assert.ok(Rules.noiseFloor(runner, 0.05).noise > 0.5);
  const sheltered = player(); sheltered.surfaceType = 'rock'; sheltered.serverSign = 0.8;
  assert.ok(Rules.noiseFloor(sheltered, 1).sign < 0.8, 'rock bleeds sign');
});
