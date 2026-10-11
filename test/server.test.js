const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const { io } = require('socket.io-client');
const World = require('../world');
const terrain = World.createTerrain(0xabcdef);
const delay = ms => new Promise(r => setTimeout(r, ms));
const event = (s, name) => new Promise((resolve, reject) => {
  const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${name}`)),5000);
  s.once(name, data=>{clearTimeout(timer);resolve(data);});
});
async function fixture(t) {
  const child=spawn(process.execPath,['server.js'], {cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'0',MAP_SEED:'11259375'}});
  const sockets=[];let logs=''; child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{sockets.forEach(s=>s.disconnect());child.kill();});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server startup timeout '+logs)),5000);
    child.stdout.on('data',d=>{const m=String(d).match(/listening on :(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs));});
  });
  const base=`http://127.0.0.1:${port}`;
  const connect=async(auth={})=>{
    const s=io(base,{autoConnect:false,transports:['websocket'],reconnection:false,auth});sockets.push(s);
    const welcome=event(s,'welcome');s.connect();const w=await welcome;return {s,w};
  };
  return {child,port,base,connect};
}
function request(port,url) {
  return new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port,path:url},r=>{
    let body='';r.on('data',d=>body+=d);r.on('end',()=>resolve({status:r.statusCode,body}));
  }).on('error',reject));
}

test('public routes work; dotfiles, source, raw/encoded traversal and symlink escape do not', async t=>{
  const f=await fixture(t);
  for(const url of ['/','/world.js','/mobile-controls.js','/vendor/socket.io.min.js']) assert.equal((await request(f.port,url)).status,200,url);
  for(const url of ['/.git/HEAD','/.env','/server.js','/package.json','/review/server-checks.json','/missing.js','/../server.js','/%2e%2e/server.js','/assets/%2e%2e/server.js','/assets/..%5cserver.js']) {
    assert.equal((await request(f.port,url)).status,404,url);
  }
  assert.equal((await request(f.port,'/%ZZ')).status,400);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'spice-static-'));
  const link=path.resolve(__dirname,'../assets/review-test-link.png');
  t.after(async()=>{await fs.rm(link,{force:true});await fs.rm(temp,{recursive:true,force:true});});
  await fs.writeFile(path.join(temp,'marker.png'),'outside');await fs.symlink(path.join(temp,'marker.png'),link);
  assert.equal((await request(f.port,'/assets/review-test-link.png')).status,404);
});

test('malformed handshakes, event payloads and floods cannot terminate the process', async t=>{
  const f=await fixture(t);const {s}=await f.connect({name:{toString:1},seed:{toString:1},playerToken:{toString:1}});
  for(const name of ['move','noiseHotspot','holtzmanDetonation','harvestNode','beginHarvest','hitPlayer','maulaHitPlayer','weaponFired','equipWeapon']) {
    for(const data of [null,[],42,'bad',{}, {x:{valueOf:1,toString:1},kind:{toString:1}}]) s.emit(name,data);
  }
  for(let i=0;i<300;i++)s.emit('hitPlayer',{damage:100});
  await delay(250);assert.equal(f.child.exitCode,null);assert.equal((await request(f.port,'/')).status,200);
  assert.ok((await f.connect()).w.id);
});

test('remote harvest, teleport banking, invented kills, poison, NPC drops and arbitrary atomics are rejected', async t=>{
  const f=await fixture(t);const a=await f.connect(),b=await f.connect();
  const damage=[],drops=[],explosions=[];
  b.s.on('playerDamaged',d=>damage.push(d));b.s.on('spiceDrop',d=>drops.push(d));b.s.on('holtzmanDetonation',d=>explosions.push(d));
  await delay(1100);
  const carry=event(a.s,'playerCarryUpdated');a.s.emit('harvestNode',{id:7,takenAmount:100});assert.equal((await carry).spiceCarry,0);
  const corrected=event(a.s,'positionCorrection');a.s.emit('move',{x:600,y:30,z:600,rotY:0,equipped:'knife'});assert.ok((await corrected).x<0);
  a.s.emit('hitPlayer',{targetId:b.w.id,damage:100,attackType:'generic'});
  a.s.emit('poisonPlayer',{targetId:b.w.id});a.s.emit('npcSpiceDrop',{x:a.w.spawn.x,z:a.w.spawn.z});
  a.s.emit('holtzmanDetonation',{x:b.w.spawn.x,z:b.w.spawn.z});
  await delay(300);assert.deepEqual(damage,[]);assert.deepEqual(drops,[]);assert.deepEqual(explosions,[]);
});

test('a real timed harvest and bank trip updates authoritative carry and team score', {timeout:30000}, async t=>{
  const f=await fixture(t),a=await f.connect();let pos={...a.w.spawn};const corrections=[];a.s.on('positionCorrection',p=>corrections.push(p));
  async function travel(destination) {
    while(Math.hypot(pos.x-destination.x,pos.z-destination.z)>.1){
      await delay(100);
      const d=Math.hypot(pos.x-destination.x,pos.z-destination.z), step=Math.min(2.3,d);
      pos={x:pos.x+(destination.x-pos.x)*step/d,z:pos.z+(destination.z-pos.z)*step/d};
      a.s.emit('move',{...pos,y:World.groundHeight(terrain,pos.x,pos.z),rotY:0,equipped:'knife',harvestActive:false});
    }
    await delay(150);
  }
  const node=a.w.snapshot.spiceNodes[0];await travel(node);
  a.s.emit('beginHarvest',{id:0});let carry=event(a.s,'playerCarryUpdated');a.s.emit('harvestNode',{id:0});assert.equal((await carry).spiceCarry,0,'instant harvest rejected');
  a.s.emit('beginHarvest',{id:0});await delay(4500);
  carry=event(a.s,'playerCarryUpdated');a.s.emit('harvestNode',{id:0});const amount=(await carry).spiceCarry;assert.ok(amount>0 && amount<=3);
  const rejected=event(a.s,'spiceDepositRejected');a.s.emit('spiceDeposited');assert.equal((await rejected).reason,'not_at_depot');
  await travel({x:-380,z:-390});const deposited=event(a.s,'spiceDepositAccepted');a.s.emit('spiceDeposited');const result=await deposited;
  assert.equal(result.amount,amount);assert.equal(result.spiceCarry,0);assert.equal(result.scores[a.w.team],amount);assert.deepEqual(corrections,[]);
});

test('a nearby thumper attracts a warning and breach at its location; remote placement is rejected', {timeout:35000}, async t=>{
  const f=await fixture(t),a=await f.connect();let pos={...a.w.spawn};
  const node=a.w.snapshot.spiceNodes[0];const phases=[];
  a.s.on('wormSync',w=>phases.push(w));
  a.s.emit('noiseHotspot',{kind:'thumper',x:node.x,z:node.z,strength:1});
  await delay(250);assert.ok(phases.every(w=>w.state==='off_map'));
  async function travel(destination, thumperActive) {
    while(Math.hypot(pos.x-destination.x,pos.z-destination.z)>.1){
      await delay(100);const d=Math.hypot(pos.x-destination.x,pos.z-destination.z),step=Math.min(2.3,d);
      pos={x:pos.x+(destination.x-pos.x)*step/d,z:pos.z+(destination.z-pos.z)*step/d};
      a.s.emit('move',{...pos,y:World.groundHeight(terrain,pos.x,pos.z),rotY:0,equipped:'knife',thumperActive});
    }
  }
  await travel(node,false);await delay(150);
  let consumed=false;a.s.once('wormConsumedThumper',()=>{consumed=true;});
  a.s.emit('noiseHotspot',{kind:'thumper',x:node.x,z:node.z,strength:1});
  await travel({x:-380,z:-390},true);
  const deadline=Date.now()+22000;
  while(!consumed && Date.now()<deadline)await delay(100);
  assert.equal(consumed,true);
  const breach=phases.find(w=>w.phase==='breach');assert.ok(breach);
  assert.ok(Math.hypot(breach.target.x-node.x,breach.target.z-node.z)<2);
  const observer=await f.connect();assert.equal(observer.w.snapshot.players.find(p=>p.id===a.w.id).health,100);
});

test('a quick reconnect with the same session keeps position and carried spice', {timeout:30000}, async t=>{
  const f=await fixture(t),token='reconnect-test-token';const a=await f.connect({playerToken:token});let pos={...a.w.spawn};
  const node=a.w.snapshot.spiceNodes[0];
  while(Math.hypot(pos.x-node.x,pos.z-node.z)>.1){
    await delay(100);const d=Math.hypot(pos.x-node.x,pos.z-node.z),step=Math.min(2.3,d);
    pos={x:pos.x+(node.x-pos.x)*step/d,z:pos.z+(node.z-pos.z)*step/d};
    a.s.emit('move',{...pos,y:World.groundHeight(terrain,pos.x,pos.z),rotY:0,equipped:'knife',harvestActive:true});
  }
  await delay(150);a.s.emit('beginHarvest',{id:0});await delay(4500);
  const carry=event(a.s,'playerCarryUpdated');a.s.emit('harvestNode',{id:0});const amount=(await carry).spiceCarry;assert.ok(amount>0);
  a.s.disconnect();await delay(200);
  const back=await f.connect({playerToken:token});const self=back.w.snapshot.players.find(p=>p.id===back.w.id);
  assert.equal(self.spiceCarry,amount);assert.equal(self.team,a.w.team);
  assert.ok(Math.hypot(back.w.spawn.x-node.x,back.w.spawn.z-node.z)<1);
  const stranger=await f.connect({playerToken:'another-player-token'});
  assert.equal(stranger.w.snapshot.players.find(p=>p.id===stranger.w.id).spiceCarry,0);
});

test('a player cannot detonate their own shield, and leaving while in danger forfeits the restore', {timeout:20000}, async t=>{
  const f=await fixture(t);const a=await f.connect(),b=await f.connect({playerToken:'danger-test-token'});
  const kills=[];b.s.on('playerKilled',k=>kills.push(k));await delay(1100);
  const apos={...a.w.spawn,y:World.groundHeight(terrain,a.w.spawn.x,a.w.spawn.z),rotY:0};
  a.s.emit('move',{...apos,equipped:'lasgun',shieldActive:true});await delay(100);
  a.s.emit('holtzmanDetonation',{x:apos.x,z:apos.z,targetId:a.w.id});await delay(300);
  assert.deepEqual(kills,[],'self-targeted atomic rejected');
  // Stand b just in front of a, knife b, then b drops: the 75-health state must not be restored.
  let bpos={...b.w.spawn};const dest={x:apos.x,z:apos.z+3};
  while(Math.hypot(bpos.x-dest.x,bpos.z-dest.z)>.1){
    await delay(100);const d=Math.hypot(bpos.x-dest.x,bpos.z-dest.z),step=Math.min(2.3,d);
    bpos={x:bpos.x+(dest.x-bpos.x)*step/d,z:bpos.z+(dest.z-bpos.z)*step/d};
    b.s.emit('move',{...bpos,y:World.groundHeight(terrain,bpos.x,bpos.z),rotY:0,equipped:'knife'});
  }
  a.s.emit('move',{...apos,equipped:'knife',shieldActive:false});await delay(150);
  const hit=event(b.s,'playerDamaged');a.s.emit('hitPlayer',{targetId:b.w.id,attackType:'knife'});
  assert.equal((await hit).health,75);
  b.s.disconnect();await delay(200);const back=await f.connect({playerToken:'danger-test-token'});
  assert.equal(back.w.snapshot.players.find(p=>p.id===back.w.id).health,100,'fresh spawn, not a restore');
});

test('other players see darts and beams but not internal anti-cheat state', {timeout:15000}, async t=>{
  const f=await fixture(t);const a=await f.connect(),b=await f.connect();
  assert.equal(b.w.snapshot.players.find(p=>p.id===a.w.id).moveBudget,undefined);
  await delay(1100);const y=World.groundHeight(terrain,a.w.spawn.x,a.w.spawn.z);
  a.s.emit('move',{...a.w.spawn,y,rotY:0,equipped:'maula'});await delay(100);
  const dart=event(b.s,'dartFired');a.s.emit('weaponFired',{direction:{x:0,y:0,z:1}});
  assert.equal((await dart).id,a.w.id);
  const beam=new Promise(r=>b.s.on('playerMoved',m=>{if(m.beamEnd)r(m);}));
  a.s.emit('move',{...a.w.spawn,y,rotY:0,equipped:'lasgun',beamEnd:{x:a.w.spawn.x,y,z:a.w.spawn.z+40}});
  assert.equal((await beam).beamEnd.z,a.w.spawn.z+40);
});
