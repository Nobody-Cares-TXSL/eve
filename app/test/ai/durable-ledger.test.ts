import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EveArchive} from '../../src/archive/store.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import {durableDryRunOne} from '../../src/ai/engine.ts';
import type {AiBackend} from '../../src/ai/contracts.ts';
import type {InboundMessage} from '../../src/platform/types.ts';

const thread='0:1:222:333';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
function message(i:number):InboundMessage {
 return {conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
  clientMessageId:null,senderUid:'333',fromSelf:false,text:'mock-message-'+i,
  kind:'text',messageType:7,createTime:String(1793089447000+i*1000),indexInConversation:String(i)};
}
const opts={conversationId:thread,maxAgeMs:90_000,timeoutMs:1000};
const result=(action:'reply'|'skip'|'defer'='skip')=>
 action==='reply'?{action:'reply',text:'虚构回复',reason:'测试',delayMs:0}:
 action==='defer'?{action:'defer',reason:'稍后',delayMs:1000}:{action:'skip',reason:'无需回复'};
const fake=(fn:AiBackend['evaluate']):AiBackend=>({id:'claude_code',kind:'agent-runtime',evaluate:fn});
async function fixture(fn:(archive:EveArchive,port:MockPlatformPort,path:string)=>Promise<void>,
 events=1):Promise<void>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-durable-')),path=join(dir,'eve.sqlite');
 const archive=EveArchive.open(path,identity),port=new MockPlatformPort({uid:'111',imUid:'222'});
 try{
  archive.upgradeToV2();
  port.delivered.push(message(0));
  const b=await reconcileOnce({archive,port,conversationId:thread,instanceId:'base',imUid:'222',isSafe:()=>true});
  assert.equal(b.state,'verified');
  archive.upgradeToV3();
  for(let i=1;i<=events;i++)port.delivered.push(message(i));
  if(events>0){
   const next=await reconcileOnce({archive,port,conversationId:thread,instanceId:'new',imUid:'222',isSafe:()=>true});
   assert.equal(next.state,'verified',next.reason);
   assert.equal(archive.reconcileStats(next.epochId).eligible,events);
  }
  await fn(archive,port,path);
 }finally{archive.close();rmSync(dir,{recursive:true,force:true});}
}
function stats(file:string){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  return {
   schema:(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,
   meta:(db.prepare('SELECT schema_version FROM archive_meta').get() as {schema_version:number}).schema_version,
   messages:(db.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n,
   eligibles:(db.prepare('SELECT COUNT(*) n FROM eligible_events WHERE state=\'pending\'').get() as {n:number}).n,
   attempts:db.prepare('SELECT state,action,decision_digest,reply_length,failure_code FROM ai_decision_attempts ORDER BY rowid').all(),
  };
 }finally{db.close();}
}

test('T5-2 v2→v3 显式事务迁移；失败回滚、v3 重开与 T4 对账仍兼容',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-v3-migrate-')),p=join(dir,'db.sqlite');
 try{
  const a=EveArchive.open(p,identity);
  a.upgradeToV2();
  assert.throws(()=>a.upgradeToV3(true),/migration_injected_failure/);
  const db=new DatabaseSync(p,{readOnly:true});
  try{
   assert.equal((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,2);
   assert.equal((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='ai_decision_attempts'").get() as {n:number}).n,0);
  }finally{db.close();}
  a.upgradeToV3();
  a.upgradeToV3();
  a.upgradeToV2(); // backwards-compatible T4 startup must be no-op
  a.close();
  const reopened=EveArchive.open(p,identity);
  const port=new MockPlatformPort();
  port.delivered.push(message(0));
  const proof=await reconcileOnce({archive:reopened,port,conversationId:thread,imUid:'222',instanceId:'v3',isSafe:()=>true});
  assert.equal(proof.state,'verified',proof.reason);
  reopened.close();
  assert.equal(stats(p).schema,3);
  assert.equal(stats(p).meta,3);
  assert.equal(stats(p).messages,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('T5-2 durable: 一条消息仅能自动认领一次，成功审计不保存正文',()=>fixture(async(a,_,p)=>{
 let calls=0;
 const b=fake(async()=>{calls++;return result('reply');});
 const first=await durableDryRunOne(a,b,opts);
 assert.equal(first.status,'dry_run');
 const second=await durableDryRunOne(a,b,opts);
 assert.equal(second.status,'blocked');
 if(second.status==='blocked')assert.equal(second.reasonCode,'no_pending_event');
 assert.equal(calls,1);
 const db=stats(p);
 assert.equal(db.schema,3);
 assert.equal(db.eligibles,1); // T6 still has no permission to dispatch
 assert.equal(db.attempts.length,1);
 assert.equal((db.attempts[0] as {state:string}).state,'recorded');
 assert.equal((db.attempts[0] as {action:string}).action,'reply');
 assert.equal(JSON.stringify(db).includes('虚构回复'),false);
}));
test('T5-2 durable: 两个并发调用只能启动一个 Agent',()=>fixture(async(a)=>{
 let calls=0;
 const b=fake(async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));return result();});
 const [first,second]=await Promise.all([durableDryRunOne(a,b,opts),durableDryRunOne(a,b,opts)]);
 assert.equal([first,second].filter(x=>x.status==='dry_run').length,1);
 assert.equal(calls,1);
 assert.deepEqual(a.aiAttemptStats(),{claimed:0,recorded:1,blocked:0,interrupted:0});
}));
test('T5-2 durable: 多条 pending 跳过已审计事件、处理下一条',()=>fixture(async(a)=>{
 let calls=0;
 const b=fake(async()=>{calls++;return result();});
 const x=await durableDryRunOne(a,b,opts);
 const y=await durableDryRunOne(a,b,opts);
 assert.equal(x.status,'dry_run');assert.equal(y.status,'dry_run');
 if(x.status==='dry_run'&&y.status==='dry_run')assert.notEqual(x.eventDigest,y.eventDigest);
 assert.equal(calls,2);
 assert.equal(a.aiAttemptStats().recorded,2);
},2));
test('T5-2 durable: 证明过期即使 sync_state verified 也不能认领',()=>fixture(async(a,_,p)=>{
 const db=new DatabaseSync(p);
 try{db.prepare('UPDATE conversations SET last_verified_at_ms=?').run(Date.now()-92_000);}
 finally{db.close();}
 let calls=0;
 const x=await durableDryRunOne(a,fake(async()=>{calls++;return result();}),opts);
 assert.equal(x.status,'blocked');
 if(x.status==='blocked')assert.equal(x.reasonCode,'coverage_unusable');
 assert.equal(calls,0);
 assert.equal(a.aiAttemptStats().claimed,0);
 assert.equal(a.aiAttemptStats().recorded,0);
}));
test('T5-2 durable: 后端超时写入 blocked，不自动重试',()=>fixture(async(a)=>{
 let calls=0;
 const backend=fake(async()=>{calls++;return new Promise(()=>{});});
 const x=await durableDryRunOne(a,backend,{...opts,timeoutMs:25});
 assert.equal(x.status,'blocked');
 if(x.status==='blocked')assert.equal(x.reasonCode,'backend_timeout');
 assert.equal(a.aiAttemptStats().blocked,1);
 const second=await durableDryRunOne(a,backend,opts);
 assert.equal(second.status,'blocked');
 assert.equal(calls,1);
}));
test('T5-2 durable: 推理中失去证明，审计 blocked 且不产出 reply',()=>fixture(async(a)=>{
 const x=await durableDryRunOne(a,fake(async()=>{
  a.invalidateCurrentCoverage();
  return result('reply');
 }),opts);
 assert.equal(x.status,'blocked');
 if(x.status==='blocked')assert.equal(x.reasonCode,'coverage_lost_after_inference');
 assert.equal(a.aiAttemptStats().blocked,1);
 assert.equal(a.aiAttemptStats().recorded,0);
}));
test('T5-2 durable: crash/重启保留 claimed，只能标记 interrupted，禁止自动重做',()=>fixture(async(a,_,p)=>{
 const claimed=a.claimAiDryRun({conversationId:thread,maxAgeMs:90_000,backendId:'claude_code',backendKind:'agent-runtime'});
 assert.ok(claimed);
 assert.equal(a.aiAttemptStats().claimed,1);
 const recovered=a.recoverAbandonedAiClaims();
 assert.equal(recovered,1);
 assert.equal(a.recoverAbandonedAiClaims(),0);
 assert.equal(a.aiAttemptStats().interrupted,1);
 let calls=0;
 const x=await durableDryRunOne(a,fake(async()=>{calls++;return result();}),opts);
 assert.equal(x.status,'blocked');
 assert.equal(calls,0);
 assert.equal((stats(p).attempts[0] as {failure_code:string}).failure_code,'crash_interrupted');
}));
test('T5-2 durable: 仅在 v3 才能认领，v2 不会被隐式迁移',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-v2-')),file=join(dir,'db.sqlite');
 const a=EveArchive.open(file,identity);
 try{
  a.upgradeToV2();
  const x=await durableDryRunOne(a,fake(async()=>result()),opts);
  assert.equal(x.status,'blocked');
  if(x.status==='blocked')assert.equal(x.reasonCode,'ledger_unavailable');
  const db=new DatabaseSync(file,{readOnly:true});
  try{assert.equal((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,2);}
  finally{db.close();}
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
});

test('T5-4 batching: three adjacent eligible messages become one Claude call and three durable reservations',()=>fixture(async(a,_,path)=>{
 let calls=0,turns:readonly {role:string;text:string}[]=[];
 const b=fake(async(req)=>{
  calls++;turns=req.turns;
  return result('reply');
 });
 const first=await durableDryRunOne(a,b,{...opts,maxBatchEvents:3});
 assert.equal(first.status,'dry_run');
 assert.equal(calls,1);
 assert.equal(a.aiAttemptStats().recorded,1);
 assert.equal(a.aiBatchItems(),3);
 assert.ok(turns.at(-1)?.text.includes('mock-message-1'));
 assert.ok(turns.at(-1)?.text.includes('mock-message-2'));
 assert.ok(turns.at(-1)?.text.includes('mock-message-3'));
 assert.equal((await durableDryRunOne(a,b,{...opts,maxBatchEvents:3})).status,'blocked');
 assert.equal(calls,1);
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  assert.equal((db.prepare('SELECT COUNT(*) n FROM ai_batch_items').get() as {n:number}).n,3);
  const records=db.prepare('SELECT COUNT(*) n FROM ai_decision_attempts').get() as {n:number};
  assert.equal(records.n,1);
 }finally{db.close();}
},3));
test('T5-4 batching: gap over 15 seconds splits invocations, all events reserved once',()=>fixture(async(a,_,path)=>{
 const db=new DatabaseSync(path);
 try{
  db.prepare('UPDATE messages SET create_time=? WHERE server_message_id=?')
   .run('1793089500000',String(7701260499833538097n+2n));
 }finally{db.close();}
 let calls=0;
 const b=fake(async()=>{calls++;return result('skip');});
 const x=await durableDryRunOne(a,b,{...opts,maxBatchEvents:3});
 assert.equal(x.status,'dry_run');
 assert.equal(a.aiBatchItems(),1);
 const y=await durableDryRunOne(a,b,{...opts,maxBatchEvents:3});
 assert.equal(y.status,'dry_run');
 assert.equal(a.aiBatchItems(),2);
 assert.equal(calls,2);
},2));
test('T5-4 rolling-hour budget survives new Archive connection and refuses second Claude call',()=>fixture(async(a,_,path)=>{
 let calls=0;
 const policy={maxPerHour:1,maxPerDay:3};
 const b=fake(async()=>{calls++;return result();});
 const first=await durableDryRunOne(a,b,{...opts,policy});
 assert.equal(first.status,'dry_run');
 const reopened=EveArchive.open(path,identity);
 try{
  const second=await durableDryRunOne(reopened,b,{...opts,policy});
  assert.equal(second.status,'blocked');
  if(second.status==='blocked')assert.equal(second.reasonCode,'ai_budget_hourly');
  assert.equal(reopened.aiAttemptStats().recorded,1);
 }finally{reopened.close();}
 assert.equal(calls,1);
},2));
test('T5-4 rolling-day budget is enforced independently of hourly limit',()=>fixture(async(a)=>{
 let calls=0;
 const b=fake(async()=>{calls++;return result();});
 const policy={maxPerHour:10,maxPerDay:1};
 assert.equal((await durableDryRunOne(a,b,{...opts,policy})).status,'dry_run');
 const second=await durableDryRunOne(a,b,{...opts,policy});
 assert.equal(second.status,'blocked');
 if(second.status==='blocked')assert.equal(second.reasonCode,'ai_budget_daily');
 assert.equal(calls,1);
},2));
test('T5-4 failure cooldown prevents next eligible, persists through reopening',()=>fixture(async(a,_,path)=>{
 let calls=0;
 const b=fake(async()=>{calls++;throw new Error('synthetic error with secret');});
 const policy={failureCooldownMs:60000,maxPerDay:10,maxPerHour:10};
 const first=await durableDryRunOne(a,b,{...opts,policy});
 assert.equal(first.status,'blocked');
 assert.equal(a.aiAttemptStats().blocked,1);
 const reopened=EveArchive.open(path,identity);
 try{
  const next=await durableDryRunOne(reopened,b,{...opts,policy});
  assert.equal(next.status,'blocked');
  if(next.status==='blocked')assert.equal(next.reasonCode,'ai_cooldown');
 }finally{reopened.close();}
 assert.equal(calls,1);
},2));
test('T5-4 min interval and future timestamps fail closed',()=>fixture(async(a,_,path)=>{
 const b=fake(async()=>result());
 assert.equal((await durableDryRunOne(a,b,{...opts,policy:{minIntervalMs:10000}})).status,'dry_run');
 const db=new DatabaseSync(path);
 try{
  db.prepare('UPDATE ai_decision_attempts SET claimed_at_ms=?').run(Date.now()+60000);
 }finally{db.close();}
 const next=await durableDryRunOne(a,b,{...opts,policy:{minIntervalMs:10000}});
 assert.equal(next.status,'blocked');
 if(next.status==='blocked')assert.equal(next.reasonCode,'ai_cooldown');
},2));
test('T5-4 invalid budget cannot reserve an event',()=>fixture(async(a)=>{
 const b=fake(async()=>result());
 const x=await durableDryRunOne(a,b,{...opts,policy:{maxPerHour:0}});
 assert.equal(x.status,'blocked');
 assert.equal(a.aiAttemptStats().claimed,0);
 assert.equal(a.aiBatchItems(),0);
}));

test('T5-4 batching: outbound self-message between user messages breaks group',()=>fixture(async(a,_,path)=>{
 const db=new DatabaseSync(path);
 try{
  const id=String(7701260499833538097n+2n);
  db.prepare('DELETE FROM eligible_events WHERE server_message_id=?').run(id);
  db.prepare("UPDATE messages SET sender_uid='111',from_self=1 WHERE server_message_id=?").run(id);
 }finally{db.close();}
 const b=fake(async()=>result());
 assert.equal((await durableDryRunOne(a,b,{...opts,maxBatchEvents:3})).status,'dry_run');
 assert.equal(a.aiBatchItems(),1);
 assert.equal((await durableDryRunOne(a,b,{...opts,maxBatchEvents:3})).status,'dry_run');
 assert.equal(a.aiBatchItems(),2);
},3));
test('T5-4 batching: missing timestamp prevents unverified chronological merge',()=>fixture(async(a,_,path)=>{
 const db=new DatabaseSync(path);
 try{
  const id=String(7701260499833538097n+2n);
  db.prepare("UPDATE messages SET create_time='unknown' WHERE server_message_id=?").run(id);
 }finally{db.close();}
 let calls=0;
 const b=fake(async()=>{calls++;return result();});
 assert.equal((await durableDryRunOne(a,b,{...opts,maxBatchEvents:3})).status,'dry_run');
 assert.equal(a.aiBatchItems(),1);
 assert.equal(calls,1);
},3));
test('T5-4 batching: future messages are not included in earlier AI context',()=>fixture(async(a,_,path)=>{
 // Deliberately scramble insertion order. The trusted timeline still filters context.
 let latest:string|undefined;
 const b=fake(async req=>{latest=req.turns.at(-1)?.text;return result();});
 const audit=await durableDryRunOne(a,b,{...opts,maxBatchEvents:1});
 assert.equal(audit.status,'dry_run');
 assert.equal(latest,'mock-message-1');
 assert.equal(latest?.includes('mock-message-2'),false);
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  assert.equal((db.prepare('SELECT COUNT(*) n FROM ai_batch_items').get() as {n:number}).n,1);
 }finally{db.close();}
},3));
