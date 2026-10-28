import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {Runner} from '../../src/runtime/runner.ts';
import {parseConfig} from '../../src/runtime/config.ts';
import {paths,readState,initDirs,durableRequest,readJson} from '../../src/runtime/state.ts';
import {EveArchive} from '../../src/archive/store.ts';
import type {InboundMessage} from '../../src/platform/types.ts';
const cfg=parseConfig({version:1,selfUid:'111',targetUid:'333',pollMs:50});
const inbound:InboundMessage={conversationId:'0:1:222:333',serverMessageId:'1000000000000000001',
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'fixture',kind:'text',messageType:7,createTime:'123',indexInConversation:null};
async function wait(verify:()=>Promise<boolean>){
 for(let i=0;i<160;i++){if(await verify())return;await new Promise(r=>setTimeout(r,25));}
 throw new Error('condition_not_met');
}
async function stop(dir:string){
 const p=paths(dir);await initDirs(p);const s=await readState(p);assert.ok(s);
 const id=randomUUID();
 await durableRequest(join(p.requests,id+'.json'),{id,instanceId:s.instanceId,action:'stop',at:Date.now()});
 await wait(async()=>{try{return !!(await readJson(join(p.acks,id+'.json')));}catch{return false;}});
}
test('T3 Runner: 认证 imUid → 队列 → 本机归档；同一事件重复不会二次插入',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t3-runner-'));
 const file=join(dir,'data','eve.sqlite'),port=new MockPlatformPort({uid:'111',imUid:'222'});
 try{
  const runner=new Runner(join(dir,'state'),port,cfg,file);const run=runner.run();
  await wait(async()=>(await readState(paths(join(dir,'state'))))?.phase==='running');
  port.pushMessage(inbound);port.pushMessage(inbound);
  await wait(async()=>{try{const a=EveArchive.open(file,{ownerUid:'111',targetUid:'333',ownUids:['111','222']});const got=a.counts().messages;a.close();return got===1;}catch{return false;}});
  await stop(join(dir,'state'));assert.equal(await run,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('T3 Runner: 错误平台 UID 拦截，停机码3且数据库未建',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t3-bad-login-'));
 const file=join(dir,'data','eve.sqlite'),port=new MockPlatformPort({uid:'999',imUid:'222'});
 try{
  const code=await new Runner(join(dir,'state'),port,cfg,file).run();
  assert.equal(code,3);
  assert.equal((await readState(paths(join(dir,'state'))))?.phase,'paused_auth');
  await assert.rejects(readFile(file),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('T3 Runner: 同一服务端 ID 的冲突正文导致持久 paused_env，不静默继续归档',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'eve-t3-conflict-'));
 const file=join(dir,'data','eve.sqlite'),port=new MockPlatformPort({uid:'111',imUid:'222'});
 try{
  const runner=new Runner(join(dir,'state'),port,cfg,file),run=runner.run();
  await wait(async()=>(await readState(paths(join(dir,'state'))))?.phase==='running');
  port.pushMessage(inbound);
  await wait(async()=>{
   try{const a=EveArchive.open(file,{ownerUid:'111',targetUid:'333',ownUids:['111','222']});
    const count=a.counts().messages;a.close();return count===1;}catch{return false;}
  });
  port.pushMessage({...inbound,text:'contradicting event'});
  assert.equal(await run,3);
  const state=await readState(paths(join(dir,'state')));
  assert.equal(state?.phase,'paused_env');
  const a=EveArchive.open(file,{ownerUid:'111',targetUid:'333',ownUids:['111','222']});
  assert.deepEqual(a.counts().messages,1);
  a.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
