import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EveArchive} from '../../src/archive/store.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import type {InboundMessage} from '../../src/platform/types.ts';

const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const msg=(i:number):InboundMessage=>({
 conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'test-only-text',
 kind:'text',messageType:7,createTime:String(10+i),indexInConversation:String(i),
});
test('T5-2 true SIGKILL: committed AI claim survives process death, startup leaves it interrupted and never auto retries',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-kill-')),file=join(dir,'db.sqlite');
 const a=EveArchive.open(file,identity),port=new MockPlatformPort();
 let child:ReturnType<typeof spawn>|undefined;
 try{
  a.upgradeToV2();
  port.delivered.push(msg(0));
  const first=await reconcileOnce({archive:a,port,conversationId:thread,imUid:'222',instanceId:'first',isSafe:()=>true});
  assert.equal(first.state,'verified');
  a.upgradeToV3();
  port.delivered.push(msg(1));
  const next=await reconcileOnce({archive:a,port,conversationId:thread,imUid:'222',instanceId:'second',isSafe:()=>true});
  assert.equal(next.state,'verified');
  const path=new URL('../../src/archive/store.ts',import.meta.url).href;
  const source=`
   import {EveArchive} from ${JSON.stringify(path)};
   const a=EveArchive.open(${JSON.stringify(file)},${JSON.stringify(identity)});
   const claim=a.claimAiDryRun({conversationId:${JSON.stringify(thread)},maxAgeMs:90000,
    backendId:'claude_code',backendKind:'agent-runtime'});
   if(!claim)process.exit(2);
   process.stdout.write('COMMITTED_CLAIM\\n');
   setInterval(()=>{},1000);
  `;
  child=spawn(process.execPath,['--input-type=module','-e',source],
   {stdio:['ignore','pipe','ignore'],env:{...process.env}});
  const processHandle=child;
  const ready=await Promise.race([
   new Promise<boolean>((resolve,reject)=>{
    let output='';
    processHandle.stdout!.on('data',(part:Buffer)=>{
     output+=part.toString('utf8');
     if(output.includes('COMMITTED_CLAIM'))resolve(true);
    });
    processHandle.once('exit',()=>reject(Error('child_exited_without_claim')));
   }),
   new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('child_not_ready')),3000)),
  ]);
  assert.equal(ready,true);
  assert.equal(a.aiAttemptStats().claimed,1);
  processHandle.kill('SIGKILL');
  const exitSignal=await new Promise<NodeJS.Signals|null>(resolve=>processHandle.once('close',(_code,signal)=>resolve(signal)));
  assert.equal(exitSignal,'SIGKILL');
  a.close();
  const reopened=EveArchive.open(file,identity);
  try{
   assert.equal(reopened.aiAttemptStats().claimed,1);
   assert.equal(reopened.recoverAbandonedAiClaims(),1);
   assert.equal(reopened.aiAttemptStats().interrupted,1);
   assert.equal(reopened.claimAiDryRun({conversationId:thread,maxAgeMs:90000,backendId:'claude_code',backendKind:'agent-runtime'}),null);
  }finally{reopened.close();}
 }finally{
  if(child&&!child.killed)child.kill('SIGKILL');
  a.close();
  rmSync(dir,{recursive:true,force:true});
 }
});
