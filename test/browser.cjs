// Run with npm run test:browser. Uses a disposable server unless GAME_URL is set.
const { chromium } = require('playwright');
const { io } = require('socket.io-client');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async()=>{
 let child,browser,observer;
 try {
  let base=process.env.GAME_URL;
  if(!base){child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,PORT:'0',MAP_SEED:'11259375'}});base=await new Promise((resolve,reject)=>{child.stdout.on('data',d=>{const m=String(d).match(/listening on :(\d+)/);if(m)resolve(`http://localhost:${m[1]}`)});child.stderr.on('data',d=>process.stderr.write(d));child.on('error',reject)});}
  const executablePath=process.env.CHROME_PATH || (process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
  browser=await chromium.launch({executablePath,headless:true,args:['--disable-features=LocalNetworkAccessChecks']});
  const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[],badResponses=[];
  const cdp=await page.context().newCDPSession(page);await cdp.send('Runtime.enable');cdp.on('Runtime.exceptionThrown',e=>errors.push({text:e.exceptionDetails.text,url:e.exceptionDetails.url,exception:e.exceptionDetails.exception?.description}));
  page.on('response',r=>{if(r.status()>=400)badResponses.push({url:r.url(),status:r.status()})});
  await page.route(base+'/**',async route=>{
   if(route.request().resourceType()!=='document')return route.continue();
   const response=await route.fetch();let body=await response.text();
   body=body.replace('    animate();','    window.__review={state,mp,player,controls,spiceObjective,spiceDepot,samplePlayerGroundHeight,thumper,remotePlayers};\n    animate();');
   await route.fulfill({response,body});
  });
  await page.goto(base+'/?seed=abcdef',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.__review?.mp.connected);
  await page.locator('#overlayCta').click();await page.waitForFunction(()=>window.__review.controls.isLocked);
  await page.evaluate(()=>{window.__corrections=[];window.__review.mp.socket.on('positionCorrection',d=>window.__corrections.push(d));});
  async function travel(destination){
   await page.evaluate(async destination=>{const r=window.__review;while(Math.hypot(r.player.position.x-destination.x,r.player.position.z-destination.z)>.2){await new Promise(resolve=>setTimeout(resolve,100));const p=r.player.position,d=Math.hypot(p.x-destination.x,p.z-destination.z),step=Math.min(1.3,d);const x=p.x+(destination.x-p.x)*step/d,z=p.z+(destination.z-p.z)*step/d;p.set(x,r.samplePlayerGroundHeight(x,z),z);r.player.userData.velocity.set(0,0,0);}},destination);
   await page.waitForTimeout(500);
  }
  const node=await page.evaluate(()=>{const n=window.__review.spiceObjective.nodes[0];return{x:n.x,z:n.z}});
  await travel(node);await page.keyboard.down('KeyE');
  try {await page.waitForFunction(()=>window.__review.state.spiceCarry>0,{},{timeout:40000});}
  catch(e){console.log('Harvest debug',await page.evaluate(()=>({state:window.__review.state,pos:window.__review.player.position,corrections:window.__corrections})));throw e;}
  await page.keyboard.up('KeyE');const harvested=await page.evaluate(()=>window.__review.state.spiceCarry);
  await travel({x:-380,z:-390});await page.keyboard.down('KeyE');await page.waitForTimeout(250);await page.keyboard.up('KeyE');
  await page.waitForFunction(()=>window.__review.state.spiceCarry===0 && window.__review.state.spiceScore>0);
  const banked=await page.evaluate(()=>window.__review.state.spiceScore);assert.equal(banked,harvested);
  assert.deepEqual(await page.evaluate(()=>window.__corrections),[],'valid travel should not be corrected');
  const oldId=await page.evaluate(()=>{const s=window.__review.mp.socket,id=s.id;s.io.engine.close();return id});
  await page.waitForFunction(oldId=>{const m=window.__review.mp;return m.connected && m.socket?.id && m.socket.id!==oldId},oldId,{timeout:20000});
  observer=io(base,{transports:['websocket'],reconnection:false});let moves=0;observer.on('playerMoved',()=>moves++);
  await new Promise(resolve=>observer.once('welcome',resolve));await page.waitForTimeout(300);const before=moves;
  await page.keyboard.down('KeyW');await page.waitForTimeout(800);await page.keyboard.up('KeyW');assert.ok(moves>before+3,'movement must reach other clients after reconnect');
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const mobilePage=await mobile.newPage();await mobilePage.goto(base+'/?seed=abcdef',{waitUntil:'networkidle'});await mobilePage.locator('#overlayCta').tap();await mobilePage.waitForFunction(()=>document.querySelector('#overlay').classList.contains('hidden'));
  console.log('Mobile controls',await mobilePage.locator('button').allTextContents());await mobilePage.getByRole('button',{name:/attack/i}).waitFor({state:'visible',timeout:10000});
  assert.deepEqual(errors,[],"no uncaught browser errors");
  assert.deepEqual(badResponses,[],"all requested assets load");
  const result={harvested,banked,reconnected:true,movementRelayed:true,mobile:true,errors,badResponses};
  if(process.env.REVIEW_OUTPUT){fs.mkdirSync(process.env.REVIEW_OUTPUT,{recursive:true});fs.writeFileSync(path.join(process.env.REVIEW_OUTPUT,'browser-verification.json'),JSON.stringify(result,null,2));await page.screenshot({path:path.join(process.env.REVIEW_OUTPUT,'desktop-fixed.png')});await mobilePage.screenshot({path:path.join(process.env.REVIEW_OUTPUT,'mobile-fixed.png')});}
  console.log(JSON.stringify(result,null,2));
 } finally {observer?.disconnect();await browser?.close();child?.kill();}
})().catch(e=>{console.error(e);process.exitCode=1;});
