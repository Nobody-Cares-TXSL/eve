import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {EveArchive} from '../../src/archive/store.ts';
import {Runner} from '../../src/runtime/runner.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import {parseConfig} from '../../src/runtime/config.ts';
import {paths,readState,readJson,durableRequest,initDirs} from '../../src/runtime/state.ts';
import type {InboundMessage} from '../../src/platform/types.ts';
import type {AiBackend} from '../../src/ai/contracts.ts';
import {AgentTransportError} from '../../src/ai/agent-transport.ts';

const thread='0:1:222:333';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const config=parseConfig({version:1,selfUid:'111',targetUid:'333',pollMs:50});
const message=(i:number):InboundMessage=>({
 conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'mock-message-'+i,
 kind:'text',messageType:7,createTime:String(1793089447000+i*1000),indexInConversation:String(i),
});
async function waitUntil(fn:()=>Promise<boolean>,label='condition'){
 for(let i=0;i<200;i++){
  if(await fn())return;
  await new Promise(r=>setTimeout(r,25));
 }
 throw Error('timeout_waiting_for_'+label);
}
async function control(dir:string,action:'pause'|'resume'|'stop'){
 const p=paths(dir),state=await readState(p);assert.ok(state);
 const id=randomUUID();
 await initDirs(p);
 await durableRequest(join(p.requests,id+'.json'),{id,instanceId:state.instanceId,action,at:Date.now()});
 let response:{ok:boolean;phase:string}|undefined;
 await waitUntil(async()=>{
  try{response=await readJson(join(p.acks,id+'.json')) as {ok:boolean;phase:string};return true;}
  catch{return false;}
 },action);
 assert.equal(response?.ok,true);
 return response.phase;
}
async function fixture(callback:(p:{db:string;stateDir:string;port:MockPlatformPort;archive:EveArchive})=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'eve-t5-runner-'));
 const db=join(dir,'db.sqlite'),stateDir=join(dir,'state'),port=new MockPlatformPort({uid:'111',imUid:'222'});
 const archive=EveArchive.open(db,identity);
 try{
  archive.upgradeToV2();
  port.delivered.push(message(0));
  assert.equal((await reconcileOnce({archive,port,conversationId:thread,imUid:'222',instanceId:'base',isSafe:()=>true})).state,'verified');
  archive.upgradeToV3();
  port.delivered.push(message(1));
  assert.equal((await reconcileOnce({archive,port,conversationId:thread,imUid:'222',instanceId:'new',isSafe:()=>true})).state,'verified');
  await callback({db,stateDir,port,archive});
 }finally{archive.close();await rm(dir,{recursive:true,force:true});}
}
test('T5 Runner: opt-in fake Claude gets exactly one eligible; repeat scans never call again',()=>fixture(async x=>{
 let calls=0;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
  calls++;
  assert.ok(x.archive.coverageEpoch(thread,90000));
  return {action:'skip',reason:'fixture'};
 }};
 const runner=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:1});
 const running=runner.run();
 try{
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===1,'recorded');
  assert.equal(calls,1);
  assert.deepEqual(x.archive.aiAttemptStats(),{claimed:0,recorded:1,blocked:0,interrupted:0});
  await new Promise(r=>setTimeout(r,250));
  assert.equal(calls,1);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
  assert.equal(x.archive.conversationState(thread),'unverified');
  assert.equal(x.archive.aiAttemptStats().recorded,1);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));
test('T5 Runner: pause during Agent invokes Abort and cannot record reply',()=>fixture(async x=>{
 let called=0,seenAbort=false;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async(_req,signal)=>{
  called++;
  return new Promise(resolve=>{
   if(signal.aborted){seenAbort=true;resolve({action:'reply',text:'stale',reason:'x',delayMs:0});return;}
   signal.addEventListener('abort',()=>{
    seenAbort=true;resolve({action:'reply',text:'stale',reason:'x',delayMs:0});
   },{once:true});
  });
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:1}).run();
 try{
  await waitUntil(async()=>called===1,'backend_started');
  assert.equal(await control(x.stateDir,'pause'),'paused_manual');
  await waitUntil(async()=>x.archive.aiAttemptStats().blocked===1,'blocked_after_pause');
  assert.equal(seenAbort,true);
  assert.equal(x.archive.aiAttemptStats().recorded,0);
  assert.equal(x.archive.conversationState(thread),'unverified');
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));
test('T5 Runner: stale claimed from old process becomes interrupted before new scan',()=>fixture(async x=>{
 const claim=x.archive.claimAiDryRun({conversationId:thread,maxAgeMs:90000,backendId:'claude_code',backendKind:'agent-runtime'});
 assert.ok(claim);
 let calls=0;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
  calls++;return {action:'skip',reason:'should not run'};
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:1}).run();
 try{
  await waitUntil(async()=>x.archive.aiAttemptStats().interrupted===1,'interrupted');
  await new Promise(r=>setTimeout(r,250));
  assert.equal(calls,0);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
  assert.equal(x.archive.aiAttemptStats().interrupted,1);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));
test('T5 Runner: refusing v2 DB preserves schema; never silently migrates on opt-in',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t5-v2-runner-'));
 const db=join(dir,'db.sqlite'),stateDir=join(dir,'state'),port=new MockPlatformPort({uid:'111',imUid:'222'});
 const a=EveArchive.open(db,identity);
 a.upgradeToV2();a.close();
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>({action:'skip',reason:'x'})};
 try{
  const code=await new Runner(stateDir,port,config,db,true,0,90000,{backend,maxAttempts:1}).run();
  assert.equal(code,3);
  const saved=EveArchive.open(db,identity);
  try{assert.throws(()=>saved.aiAttemptStats(),/ai_requires_v3/);}
  finally{saved.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('T5 Runner: cannot register AI slot without reconciler/archive or invalid budgets',()=>{
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>({action:'skip',reason:'x'})};
 assert.throws(()=>new Runner('/tmp',new MockPlatformPort(),config,undefined,true,0,90000,{backend,maxAttempts:1}),/ai_dry_run_invalid_options/);
 assert.throws(()=>new Runner('/tmp',new MockPlatformPort(),config,'/tmp/never.sqlite',false,0,90000,{backend,maxAttempts:1}),/ai_dry_run_invalid_options/);
 assert.throws(()=>new Runner('/tmp',new MockPlatformPort(),config,'/tmp/never.sqlite',true,0,90000,{backend,maxAttempts:0}),/ai_dry_run_invalid_options/);
});

test('T5 Runner: live message after startup triggers T4 re-proof and next eligible AI',()=>fixture(async x=>{
 let calls=0;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
  calls++;return {action:'skip',reason:'fixture'};
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:2}).run();
 try{
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===1,'first_ai');
  assert.equal(calls,1);
  x.port.pushMessage(message(2)); // no SDK reconnect event
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===2,'second_ai');
  assert.equal(calls,2);
  assert.equal(x.archive.getVerifiedAnchor(thread),message(2).serverMessageId);
  assert.equal(x.archive.counts().messages,3);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));
test('T5 Runner: new live context cancels old Agent and does not resurrect its decision',()=>fixture(async x=>{
 let calls=0,aborted=false;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async(_req,signal)=>{
  calls++;
  if(calls===1)return new Promise(resolve=>{
   const onAbort=()=>{aborted=true;resolve({action:'reply',text:'stale',reason:'x',delayMs:0});};
   if(signal.aborted)onAbort();
   else signal.addEventListener('abort',onAbort,{once:true});
  });
  return {action:'skip',reason:'fresh'};
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:2}).run();
 try{
  await waitUntil(async()=>calls===1,'old_agent_started');
  x.port.pushMessage(message(2));
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===1 &&
   x.archive.aiAttemptStats().blocked===1,'new_agent_recorded');
  assert.equal(aborted,true);
  assert.equal(calls,2);
  assert.equal(x.archive.getVerifiedAnchor(thread),message(2).serverMessageId);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));

test('T5 Runner: SDK reconnecting cancels Claude, invalidates gate, and never auto-retries old claim',()=>fixture(async x=>{
 let calls=0,aborted=false;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async(_req,signal)=>{
  calls++;
  return new Promise(resolve=>{
   const cancel=()=>{aborted=true;resolve({action:'reply',text:'stale',reason:'x',delayMs:0});};
   if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
  });
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:2}).run();
 try{
  await waitUntil(async()=>calls===1,'reconnect_agent_started');
  x.port.pushStatus({type:'reconnecting',attempt:1,delayMs:10});
  await waitUntil(async()=>aborted&&x.archive.aiAttemptStats().blocked===1,'reconnect_blocked');
  assert.equal(x.archive.conversationState(thread),'unverified');
  x.port.pushStatus({type:'online',uid:'111',imUid:'222',nickname:'mock'});
  await waitUntil(async()=>x.archive.conversationState(thread)==='verified','reconnected');
  await new Promise(r=>setTimeout(r,250));
  assert.equal(calls,1);
  assert.equal(x.archive.aiAttemptStats().blocked,1);
  assert.equal(x.archive.aiAttemptStats().recorded,0);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));


test('T5 CLI: unsupported experimental-ai-dry-run flag is explicitly rejected before login',()=>{
 const result=spawnSync(process.execPath,['src/cli.ts','run','--experimental-ai-dry-run'],
  {cwd:process.cwd(),encoding:'utf8'});
 assert.equal(result.status,2);
 assert.match(result.stderr,/T5 Runner AI/);
 assert.ok(!result.stdout.includes('扫码'));
});

test('T5-4 Runner: quiet window coalesces two close live messages into one additional Claude invocation',()=>fixture(async x=>{
 let calls=0;
 const seen:string[]=[];
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async req=>{
  calls++;seen.push(req.turns.at(-1)?.text??'');
  return {action:'skip',reason:'test'};
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{
  backend,maxAttempts:2,maxBatchEvents:3,quietPeriodMs:450,
 }).run();
 try{
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===1,'first_ai');
  x.port.pushMessage(message(2));
  await new Promise(resolve=>setTimeout(resolve,50));
  x.port.pushMessage(message(3));
  await waitUntil(async()=>x.archive.aiAttemptStats().recorded===2,'merged_ai');
  assert.equal(calls,2);
  assert.ok(seen[1]?.includes('mock-message-2'));
  assert.ok(seen[1]?.includes('mock-message-3'));
  assert.equal(x.archive.aiBatchItems(),3);
  assert.equal(x.archive.counts().messages,4);
  assert.equal(await control(x.stateDir,'stop'),'stopping');
  assert.equal(await running,0);
 }finally{
  if((await readState(paths(x.stateDir)))?.phase!=='stopped')await control(x.stateDir,'stop').catch(()=>undefined);
  await running;
 }
}));


test('T5 Runner: agent auth failure blocks whole AI slot and cannot consume further pending events',()=>fixture(async x=>{
 let calls=0;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
  calls++;
  throw new AgentTransportError('agent_auth_error');
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{
  backend,maxAttempts:3,
 }).run();
 try{
  // The Runner explicitly exits after a persistent backend fault. Checking
  // its settled result avoids assuming a 5s polling schedule under parallel tests.
  assert.equal(await running,3);
  assert.equal(calls,1);
  assert.equal(x.archive.aiAttemptStats().blocked,1);
  assert.equal(x.archive.aiAttemptStats().recorded,0);
  assert.equal(x.archive.conversationState(thread),'unverified');
  assert.equal((await readState(paths(x.stateDir)))?.phase,'paused_env');
 }finally{
  await running;
 }
}));

test('T5 Runner: formerly collapsed agent_execution_failed is audited and halts AI',()=>fixture(async x=>{
 let calls=0;
 const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
  calls++;
  throw new AgentTransportError('agent_execution_failed');
 }};
 const running=new Runner(x.stateDir,x.port,config,x.db,true,0,90000,{backend,maxAttempts:3}).run();
 assert.equal(await running,3);
 assert.equal(calls,1);
 assert.equal(x.archive.aiAttemptStats().blocked,1);
 assert.equal(x.archive.aiAttemptStats().recorded,0);
 assert.equal(x.archive.conversationState(thread),'unverified');
 assert.equal((await readState(paths(x.stateDir)))?.phase,'paused_env');
}));
