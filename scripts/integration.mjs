import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
const root=path.resolve(import.meta.dirname,'..');
const go=process.env.DBX_GO??'go';
mkdirSync(path.join(root,'backend/bin'),{recursive:true});
const binary=process.env.DBX_TEST_BINARY??path.join(root,'backend/bin',process.platform==='win32'?'dbx-doudizhu.exe':'dbx-doudizhu');
if(!process.env.DBX_TEST_BINARY){const built=spawnSync(go,['build','-o',binary,'.'],{cwd:path.join(root,'backend'),stdio:'inherit'});assert.equal(built.status,0);}
assert.ok(existsSync(binary),'test binary must exist');
const clients=[];let actions=0;
function client(name){
 const data=mkdtempSync(path.join(tmpdir(),'dbx-ddz-test-'));const child=spawn(binary,[],{env:{...process.env,DBX_PLUGIN_DATA_DIR:data},stdio:['pipe','pipe','pipe']});
 const pending=new Map();let next=1;const events=[];const c={child,data,events,call(method,params={}){const id=next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${name}: ${method} timeout`));},12000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}};
 readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}}else events.push(m);});child.stderr.on('data',b=>process.stderr.write(`[${name}] ${b}`));child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(`${name} exited`));}pending.clear();});clients.push(c);return c;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function snap(c){return c.call('room.snapshot');}
async function action(c,s,p){actions++;return c.call('game.action',{actionId:`it-${actions}`,expectedRevision:s.revision,...p});}
const results=[];const passed=name=>{results.push(name);console.log(`PASS ${name}`);};
try{
 const a=client('host'),b=client('guest-b'),c=client('guest-c');
 for(const [i,p]of [a,b,c].entries()){const init=await p.call('plugin/initialize',{host:{protocolVersions:[1]}});assert.equal(init.plugin.id,'io.dbx.doudizhu');await p.call('profile.save',{nickname:['阿禾','青竹','长安'][i],character:[0,3,4][i],music:0,sound:0,voice:0,lowMotion:false});}
 passed('three independent sidecars initialize through DBX JSONL');
 const room=await a.call('room.create',{name:'集成测试',password:'tea123',initialBeans:10000});
 const address=room.room.address;
 await assert.rejects(b.call('room.join',{address,password:'wrong'}));passed('password rejects incorrect join');
 await b.call('room.join',{address,password:'tea123'});await c.call('room.join',{address,password:'tea123'});
 await a.call('room.ready',{ready:true});await b.call('room.ready',{ready:true});await c.call('room.ready',{ready:true});
 const states=await Promise.all([a,b,c].map(snap));assert.equal(new Set(states.flatMap(s=>s.game.hand)).size,51);assert.ok(states.every(s=>s.game.hand.length===17&&s.game.bottom.length===0));assert.ok(states.every(s=>s.players.length===3));passed('three real TLS clients see only their own unique hands');
 const seatClients=new Map(states.map((s,i)=>[s.players.find(p=>p.id===s.selfId).seat,[a,b,c][i]]));
 let hostState=await snap(a);const bidder=seatClients.get(hostState.game.turn);await action(bidder,await snap(bidder),{type:'bid',score:3});
 for(const p of [a,b,c])await action(p,await snap(p),{type:'double',double:false});
 hostState=await snap(a);assert.equal(hostState.game.phase,'playing');assert.equal(hostState.game.bottom.length,3);passed('bidding and simultaneous doubling reach playing');
 const actor=seatClients.get(hostState.game.turn);const actorState=await snap(actor);const firstCard=actorState.game.hand.at(-1);const id=`it-${++actions}`;
 const first=await actor.call('game.action',{actionId:id,expectedRevision:actorState.revision,type:'play',cards:[firstCard]});
 await actor.call('game.action',{actionId:id,expectedRevision:actorState.revision,type:'play',cards:[firstCard]});
 const after=await snap(actor);assert.equal(after.game.hand.length,first.game.hand.length);passed('duplicate action does not play or charge twice');
 const other=[a,b,c].find(p=>p!==seatClients.get(after.game.turn));await assert.rejects(action(other,await snap(other),{type:'play',cards:[firstCard]}));passed('out-of-turn and stale cards rejected');
 const to=(await snap(b)).selfId;await a.call('social.send',{actionId:'gift-1',targetId:to,kind:'tea'});await delay(150);const gifts=[a,b,c].map(p=>p.events.filter(e=>e.method==='social.event'&&e.params.kind==='tea'));assert.ok(gifts.every(g=>g.length===1&&g[0].params.targetId===to));assert.equal(new Set(gifts.map(g=>g[0].params.id)).size,1);await assert.rejects(a.call('social.send',{actionId:'gift-2',targetId:to,kind:'flower'}));passed('same gift and target delivered once to all three with cooldown enforcement');
 for(let i=0;i<400;i++){const s=await snap(a);if(s.game.phase==='finished')break;assert.equal(s.game.phase,'playing');const p=seatClients.get(s.game.turn);const v=await snap(p);const h=await p.call('game.hint');const cards=h.candidates?.[0];await action(p,v,cards?.length?{type:'play',cards}:{type:'pass'});}
 const finished=await snap(a);assert.equal(finished.game.phase,'finished');assert.equal(finished.game.settlement.deltas.reduce((x,y)=>x+y,0),0);assert.equal(finished.game.settlement.balances.reduce((x,y)=>x+y,0),30000);passed('full real three-process round completes with conserved balances');
 for(let round=2;round<=3;round++){
  const previous=await snap(a);if(previous.players.some(p=>p.beans===0))for(const p of [a,b,c])await p.call('room.reset',{agree:true});
  for(const p of [a,b,c])await p.call('room.ready',{ready:true});
  let s=await snap(a);assert.notEqual(s.game.roundId,previous.game.roundId);const bidder2=seatClients.get(s.game.turn);await action(bidder2,await snap(bidder2),{type:'bid',score:3});
  for(const p of [a,b,c])await action(p,await snap(p),{type:'double',double:round===2});
  for(let i=0;i<400;i++){s=await snap(a);if(s.game.phase==='finished')break;const p=seatClients.get(s.game.turn),v=await snap(p),h=await p.call('game.hint'),cards=h.candidates?.[0];await action(p,v,cards?.length?{type:'play',cards}:{type:'pass'});}
  s=await snap(a);assert.equal(s.game.phase,'finished');assert.equal(s.players.reduce((sum,p)=>sum+p.beans,0),30000);assert.ok(s.players.every(p=>p.beans>=0));
 }
 passed('three consecutive full rounds retain nonnegative conserved room balances');
 const before=(await snap(b)).players.find(p=>p.id===to).beans;await b.call('room.leave');await b.call('room.join',{address,password:'tea123'});assert.equal((await snap(b)).players.find(p=>p.id===to).beans,before);passed('leave and rejoin retains room ledger');
 await a.call('room.leave');for(let i=0;i<20&&(await snap(b))!==null;i++)await delay(100);assert.equal(await snap(b),null);passed('host close ends room for guests');
 mkdirSync(path.join(root,'test-results'),{recursive:true});writeFileSync(path.join(root,'test-results','stdio-integration.json'),JSON.stringify({at:new Date().toISOString(),results,actions,environment:'three independent local OS processes over real TLS; not three physical computers'},null,2));
 console.log(`All ${results.length} checks passed; ${actions} game commands.`);
}finally{for(const c of clients)c.child.stdin.end();await delay(200);for(const c of clients)if(c.child.exitCode===null)c.child.kill();}
