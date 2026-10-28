import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EveArchive} from '../../src/archive/store.ts';
import {Runner} from '../../src/runtime/runner.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {parseConfig} from '../../src/runtime/config.ts';
import {paths,readState,readJson,initDirs,durableRequest} from '../../src/runtime/state.ts';
import type {HistoryPage,InboundMessage} from '../../src/platform/types.ts';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const message:InboundMessage={conversationId:thread,serverMessageId:'7701260499833538097',
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'fixture',kind:'text',messageType:7,
 createTime:'1',indexInConversation:'1'};
const page:HistoryPage={statusCode:0,hasMore:false,cursor:'0',direction:'older',
 requestedCursor:null,requestedDirection:'older',rawCount:1,acceptedCount:1,excludedCount:0,
 missingIdCount:0,exclusions:{foreignConversation:0,foreignSender:0,deleted:0,unrepresentable:0},
 messages:[message]};
async function waitFor(pred:()=>Promise<boolean>,timeoutMs=3000){
 const start=Date.now();
 while(Date.now()-start<timeoutMs){
  if(await pred())return;
  await new Promise(r=>setTimeout(r,20));
 }
 throw new Error('test_wait_timeout');
}
test('T4: abort 不等待僵死 SDK；迟到响应不能复活 epoch；旧请求未结束前拒绝重叠',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-pending-'));
 const archive=EveArchive.open(join(dir,'db.sqlite'),identity);archive.upgradeToV2();
 const port=new MockPlatformPort();
 let release:(p:HistoryPage)=>void=()=>undefined,calls=0;
 const stuck=new Promise<HistoryPage>(resolve=>{release=resolve;});
 port.readHistory=async()=>{calls++;return calls===1?stuck:page;};
 const abort=new AbortController();
 const first=reconcileOnce({archive,port,conversationId:thread,instanceId:'first',imUid:'222',
  isSafe:()=>true,signal:abort.signal,limits:{readTimeoutMs:1000}});
 try{
  await waitFor(async()=>calls===1);
  abort.abort();
  const result=await Promise.race([first,new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('abort_slow')),500))]);
  assert.equal(result.state,'gap');
  assert.equal(result.reason,'epoch_invalidated');
  const second=await reconcileOnce({archive,port,conversationId:thread,instanceId:'second',imUid:'222',
   isSafe:()=>true,limits:{readTimeoutMs:200}});
  assert.equal(second.state,'gap');
  assert.equal(second.reason,'history_request_still_pending');
  assert.equal(calls,1,'must not issue overlapping SDK history request');
  release(page);
  await new Promise(r=>setImmediate(r));
  assert.equal(archive.getVerifiedAnchor(thread),null);
  const third=await reconcileOnce({archive,port,conversationId:thread,instanceId:'third',imUid:'222',
   isSafe:()=>true,limits:{readTimeoutMs:1000}});
  assert.equal(third.state,'verified',third.reason);
  assert.equal(calls,3);
 }finally{archive.close();rmSync(dir,{recursive:true,force:true});}
});
test('T4: Runner stop 快速撤销正在等待的历史请求，迟到响应不写 DB',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t4-runner-cancel-'));
 const db=join(dir,'eve.sqlite'),stateDir=join(dir,'state');
 const port=new MockPlatformPort({uid:'111',imUid:'222'});
 let calls=0,release:(p:HistoryPage)=>void=()=>undefined;
 port.readHistory=async()=>{calls++;return new Promise<HistoryPage>(r=>{release=r;});};
 const runner=new Runner(stateDir,port,parseConfig({version:1,selfUid:'111',targetUid:'333',pollMs:50}),db,true);
 const running=runner.run();
 try{
  await waitFor(async()=>(await readState(paths(stateDir)))?.phase==='running');
  port.pushMessage(message);
  await waitFor(async()=>calls===1);
  const p=paths(stateDir);
  await initDirs(p);
  const state=await readState(p);assert.ok(state);
  const id=randomUUID();
  await durableRequest(join(p.requests,id+'.json'),{id,instanceId:state.instanceId,action:'stop',at:Date.now()});
  await waitFor(async()=>{try{return Boolean(await readJson(join(p.acks,id+'.json')));}catch{return false;}});
  assert.equal(await Promise.race([running,new Promise(r=>setTimeout(()=>r(-99),1500))]),0);
  release(page);
  await new Promise(r=>setImmediate(r));
  const after=EveArchive.open(db,identity);
  assert.notEqual(after.conversationState(thread),'verified');
  assert.equal(after.getVerifiedAnchor(thread),null);
  after.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
