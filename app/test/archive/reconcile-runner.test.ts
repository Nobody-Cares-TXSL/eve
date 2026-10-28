import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {EveArchive} from '../../src/archive/store.ts';
import {Runner} from '../../src/runtime/runner.ts';
import {parseConfig} from '../../src/runtime/config.ts';
import {paths,readState,initDirs,durableRequest,readJson} from '../../src/runtime/state.ts';
import type {InboundMessage} from '../../src/platform/types.ts';
const thread='0:1:222:333',identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const config=parseConfig({version:1,selfUid:'111',targetUid:'333',pollMs:50});
const msg=(i:number):InboundMessage=>({conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'test-'+i,kind:'text',messageType:7,createTime:String(i+1),indexInConversation:String(i+1)});
async function until(verify:()=>Promise<boolean>){
 for(let i=0;i<200;i++){
  if(await verify())return;
  await new Promise(r=>setTimeout(r,25));
 }
 throw new Error('timeout_waiting_for_condition');
}
async function stop(dir:string){
 const p=paths(dir),state=await readState(p);assert.ok(state);
 await initDirs(p);
 const id=randomUUID();
 await durableRequest(join(p.requests,id+'.json'),{id,instanceId:state.instanceId,action:'stop',at:Date.now()});
 await until(async()=>{try{await readJson(join(p.acks,id+'.json'));return true;}catch{return false;}});
}
test('T4 opt-in Runner: 可信会话的初始历史对账与重连新增资格，仍不发送',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t4-runner-'));
 const stateDir=join(dir,'state'),db=join(dir,'eve.sqlite');
 const port=new MockPlatformPort({uid:'111',imUid:'222'});
 port.delivered.push(...Array.from({length:5},(_,i)=>msg(i)));
 const runner=new Runner(stateDir,port,config,db,true);
 const running=runner.run();
 try{
  await until(async()=>(await readState(paths(stateDir)))?.phase==='running');
  // The thread is learned from a platform-confirmed incoming event, never fabricated.
  port.pushMessage(msg(5));
  await until(async()=>{
   try{const a=EveArchive.open(db,identity);const ready=a.conversationState(thread)==='verified';a.close();return ready;}catch{return false;}
  });
  const a=EveArchive.open(db,identity);assert.equal(a.counts().messages,6);assert.equal(a.getVerifiedAnchor(thread),msg(5).serverMessageId);a.close();
  port.pushStatus({type:'reconnecting',attempt:1,delayMs:10});
  await until(async()=>{
   const check=EveArchive.open(db,identity);
   const closed=check.conversationState(thread)==='unverified';check.close();return closed;
  });
  port.pushMessage(msg(6));
  port.pushStatus({type:'online',uid:'111',imUid:'222',nickname:'mock'});
  await until(async()=>{
   try{const b=EveArchive.open(db,identity);const done=b.getVerifiedAnchor(thread)===msg(6).serverMessageId;b.close();return done;}catch{return false;}
  });
  const b=EveArchive.open(db,identity);assert.equal(b.counts().messages,7);b.close();
  await stop(stateDir);assert.equal(await running,0);
  const stopped=EveArchive.open(db,identity);
  assert.equal(stopped.conversationState(thread),'unverified');
  assert.equal(stopped.getVerifiedAnchor(thread),msg(6).serverMessageId);
  stopped.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('T4 opt-in Runner: 未知目标会话不拼 thread，继续 unverified',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t4-no-thread-'));
 const stateDir=join(dir,'state'),db=join(dir,'eve.sqlite');
 const port=new MockPlatformPort({uid:'111',imUid:'222'});
 const runner=new Runner(stateDir,port,config,db,true);
 const running=runner.run();
 try{
  await until(async()=>(await readState(paths(stateDir)))?.phase==='running');
  const a=EveArchive.open(db,identity);
  assert.deepEqual(a.knownConversations(),[]);
  a.close();
  await stop(stateDir);assert.equal(await running,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
