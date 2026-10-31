import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MockSendPort,dispatchMockOnce} from '../../src/send/mock-dispatcher.ts';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {EveArchive} from '../../src/archive/store.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import {prepareSendIntent,type PrepareSendInput} from '../../src/send/coordinator.ts';
import type {InboundMessage} from '../../src/platform/types.ts';

const ID={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const THREAD='0:1:222:333';
const eventId='9000000000000000001';

const message=(id:string):InboundMessage=>({
 conversationId:THREAD,serverMessageId:id,clientMessageId:null,senderUid:'333',
 fromSelf:false,text:'今晚聊聊？',kind:'text',messageType:7,
 createTime:String(Date.now()-2000+Number(BigInt(id)%10n)),indexInConversation:String(BigInt(id)%10n),
});

async function withV4(fn:(a:EveArchive,p:MockPlatformPort,input:PrepareSendInput,file:string)=>Promise<void>,version=4){
 const dir=mkdtempSync(join(tmpdir(),'eve-t6-coordinate-'));
 const file=join(dir,'demo.sqlite'),a=EveArchive.open(file,ID);
 const p=new MockPlatformPort({uid:'111',imUid:'222'});
 try{
  a.upgradeToV2();a.upgradeToV3();if(version===4)a.upgradeToV4();
  const first=message('9000000000000000000');
  p.delivered.push(first);
  assert.equal((await reconcileOnce({
   port:p,archive:a,conversationId:THREAD,imUid:'222',instanceId:'baseline',
   isSafe:()=>true,
  })).state,'verified');
  p.delivered.push(...[1,2,3,4].map(i=>message('900000000000000000'+i)));
  assert.equal((await reconcileOnce({
   port:p,archive:a,conversationId:THREAD,imUid:'222',instanceId:'new',
   isSafe:()=>true,
  })).state,'verified');
  const now=Date.now();
  const localMinute=new Date(now).getHours()*60+new Date(now).getMinutes();
  const policy={
   minIntervalMs:0,maxPerHour:6,maxPerDay:30,maxTextLength:500,
   silence:{startMinute:(localMinute+20)%1440,endMinute:(localMinute+21)%1440},
  };
  const input:PrepareSendInput={
   conversationId:THREAD,sourceEventId:eventId,eventIds:[eventId],
   decision:{action:'reply',text:'这是一条只供离线测试的回复',reason:'测试',delayMs:0},
   identity:{ownerUid:'111',targetUid:'333',ownImUid:'222'},
   runtime:{phase:'running',paused:false},
   policy,now,retentionMs:3600000,coverageMaxAgeMs:90000,
  };
  await fn(a,p,input,file);
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
}
function rows(file:string,table:string):number{
 const db=new DatabaseSync(file,{readOnly:true});
 try{return Number((db.prepare('SELECT COUNT(*) n FROM '+table).get() as {n:number}).n);}
 finally{db.close();}
}

test('T6-2a: policy -> SQLite pending with current real coverage, no SDK dispatch',()=>withV4(async(a,p,input,file)=>{
 const r=prepareSendIntent(a,input);
 assert.equal(r.status,'created');
 if(r.status!=='created')return;
 assert.equal(a.getSendIntent(r.intentId)?.status,'pending');
 assert.equal(a.getSendText(r.intentId,input.now),(input.decision as {text:string}).text);
 assert.deepEqual(a.sendIntentEvents(r.intentId),[eventId]);
 assert.equal(rows(file,'send_intents'),1);
 assert.equal(rows(file,'send_text'),1);
 assert.equal(p.startCount,0);
 assert.equal(p.stopCount,0);
 assert.equal(JSON.stringify(r).includes('离线测试'),false);
}));

test('T6-2a: current DB proof is authoritative, caller cannot fake verified',()=>withV4(async(a,_,input,file)=>{
 a.invalidateCurrentCoverage();
 const result=prepareSendIntent(a,input);
 assert.deepEqual(result,{status:'rejected',reasonCode:'coverage_unusable'});
 assert.equal(rows(file,'send_intents'),0);
}));

test('T6-2a: paused runtime, non-reply and forged identity never create intent',()=>withV4(async(a,_,input,file)=>{
 const variants:PrepareSendInput[]=[
  {...input,runtime:{phase:'paused_manual',paused:true}},
  {...input,decision:{action:'skip',reason:'无须回复'}},
  {...input,identity:{ownerUid:'111',targetUid:'999',ownImUid:'222'}},
  {...input,identity:{ownerUid:'111',targetUid:'333',ownImUid:'999'}},
  {...input,conversationId:'0:1:999:333'},
 ];
 for(const variant of variants)assert.equal(prepareSendIntent(a,variant).status,'rejected');
 assert.equal(rows(file,'send_intents'),0);
}));

test('T6-2a: repeated event and overlapping batch cannot create a second intent',()=>withV4(async(a,_,input,file)=>{
 const first=prepareSendIntent(a,{...input,eventIds:[eventId,'9000000000000000002','9000000000000000003']});
 assert.equal(first.status,'created');
 const duplicate=prepareSendIntent(a,input);
 assert.equal(duplicate.status,'rejected');
 if(duplicate.status==='rejected')assert.equal(duplicate.reasonCode,'duplicate_event');
 const overlap=prepareSendIntent(a,{
  ...input,sourceEventId:'9000000000000000002',
  eventIds:['9000000000000000002','9000000000000000004'],
 });
 assert.equal(overlap.status,'duplicate');
 if(overlap.status==='duplicate'&&first.status==='created')
  assert.equal(overlap.intentId,first.intentId);
 assert.equal(rows(file,'send_intents'),1);
}));

test('T6-2a: rate budget comes from durable reservations, not caller-injected empty history',()=>withV4(async(a,_,input,file)=>{
 const first=prepareSendIntent(a,input);
 assert.equal(first.status,'created');
 const another=prepareSendIntent(a,{
  ...input,sourceEventId:'9000000000000000002',
  eventIds:['9000000000000000002'],
  policy:{...input.policy,maxPerHour:1},
 });
 assert.deepEqual(another,{status:'rejected',reasonCode:'rate_limited'});
 assert.equal(rows(file,'send_intents'),1);
}));

test('T6-2a: ambiguous unknown still reserves budget; failed can release it',()=>withV4(async(a,_,input)=>{
 const first=prepareSendIntent(a,input);
 assert.equal(first.status,'created');
 if(first.status!=='created')return;
 assert.equal(a.claimSendIntent(first.intentId,input.now+10),true);
 assert.equal(a.settleSendIntent(first.intentId,{status:'unknown',reasonCode:'ambiguous_result'},input.now+15),true);
 const blocked=prepareSendIntent(a,{
  ...input,now:input.now+20,
  sourceEventId:'9000000000000000002',eventIds:['9000000000000000002'],
  policy:{...input.policy,maxPerDay:1},
 });
 assert.deepEqual(blocked,{status:'rejected',reasonCode:'rate_limited'});
}));

test('T6-2a: expired/missing source group and invalid decision fail closed',()=>withV4(async(a,_,input,file)=>{
 assert.deepEqual(prepareSendIntent(a,{...input,eventIds:['9000000000000000002']}),
  {status:'rejected',reasonCode:'invalid_event_group'});
 assert.deepEqual(prepareSendIntent(a,{
  ...input,decision:{action:'reply',text:'x',reason:'x',delayMs:700000},
 }),{status:'rejected',reasonCode:'invalid_decision'});
 assert.deepEqual(prepareSendIntent(a,{...input,retentionMs:0}),
  {status:'rejected',reasonCode:'invalid_policy'});
 assert.equal(rows(file,'send_intents'),0);
}));

test('T6-2a: proof recheck is transactional, rotated proof cannot write intent',()=>withV4(async(a,_,input,file)=>{
 const epoch=a.coverageEpoch(THREAD,input.coverageMaxAgeMs);
 assert.ok(epoch);
 a.invalidateCurrentCoverage();
 assert.throws(()=>a.saveSendIntent({
  intentId:'intent',conversationId:THREAD,sourceEventId:eventId,
  text:'private',textDigest:'a'.repeat(64),decisionDigest:'b'.repeat(64),
  eventIds:[eventId],now:input.now,retentionMs:1000,
  expectedProofEpoch:epoch!,proofMaxAgeMs:input.coverageMaxAgeMs,
 }),/send_coverage_changed/);
 assert.equal(rows(file,'send_intents'),0);
}));

test('T6-2a: v3 ledger refuses pending send, no automatic v4 migration',()=>withV4(async(a,_,input,file)=>{
 assert.deepEqual(prepareSendIntent(a,input),{status:'rejected',reasonCode:'ledger_unavailable'});
 const db=new DatabaseSync(file,{readOnly:true});
 try{assert.equal((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,3);}
 finally{db.close();}
},3));

test('T6-2a: two archive connections cannot bypass maxPerHour inside SQLite write transaction',()=>withV4(async(a,_,input,file)=>{
 const p={minIntervalMs:0,maxPerHour:1,maxPerDay:30};
 const first=prepareSendIntent(a,{...input,policy:{...input.policy,maxPerHour:1}});
 assert.equal(first.status,'created');
 const second=EveArchive.open(file,ID);
 try{
  const proof=second.coverageEpoch(THREAD,input.coverageMaxAgeMs);
  assert.ok(proof);
  assert.throws(()=>second.saveSendIntent({
   intentId:'separate-id',conversationId:THREAD,
   sourceEventId:'9000000000000000002',
   eventIds:['9000000000000000002'],
   text:'另一个测试意图',textDigest:'a'.repeat(64),
   decisionDigest:'b'.repeat(64),now:input.now+1,retentionMs:1000,
   expectedProofEpoch:proof!,proofMaxAgeMs:input.coverageMaxAgeMs,
   ratePolicy:p,
  }),/send_rate_limited/);
  assert.equal(rows(file,'send_intents'),1);
  assert.equal(rows(file,'send_text'),1);
 }finally{second.close();}
}));
test('T6-2a: T5 AI ledger and T4 reconcile still function on v4',()=>withV4(async(a,_,input)=>{
 const claimed=a.claimAiDryRun({
  conversationId:THREAD,maxAgeMs:input.coverageMaxAgeMs,
  backendId:'claude_code',backendKind:'agent-runtime',
 });
 assert.ok(claimed,'v4 must still support T5 atomic AI claims');
 if(claimed)assert.equal(claimed.candidate.eventId,eventId);
}));
test('T6-2a: definitively failed sends release conservative reservation',()=>withV4(async(a,_,input)=>{
 const first=prepareSendIntent(a,input);
 assert.equal(first.status,'created');
 if(first.status!=='created')return;
 assert.equal(a.claimSendIntent(first.intentId,input.now+5),true);
 assert.equal(a.settleSendIntent(first.intentId,{
  status:'failed',reasonCode:'rejected_before_dispatch',
 },input.now+10),true);
 const next=prepareSendIntent(a,{
  ...input,now:input.now+15,
  sourceEventId:'9000000000000000002',
  eventIds:['9000000000000000002'],
  policy:{...input.policy,maxPerDay:1},
 });
 assert.equal(next.status,'created');
}));

test('T6-2b AC: unknown and baseline-only events are not eligible, cannot be written',()=>withV4(async(a,_,input,file)=>{
 const unknown=prepareSendIntent(a,{...input,eventIds:[eventId,'9000000000000000099']});
 assert.deepEqual(unknown,{status:'rejected',reasonCode:'invalid_event_group'});
 const baseline=prepareSendIntent(a,{...input,eventIds:[eventId,'9000000000000000000']});
 assert.deepEqual(baseline,{status:'rejected',reasonCode:'invalid_event_group'});
 assert.equal(rows(file,'send_intents'),0);
}));
test('T6-2b AC: processed/claimed eligible events cannot be saved',()=>withV4(async(a,_,input,file)=>{
 const db=new DatabaseSync(file);
 try{
  db.prepare("UPDATE eligible_events SET state='processed' WHERE conversation_id=? AND server_message_id=?")
   .run(THREAD,'9000000000000000002');
 }finally{db.close();}
 assert.deepEqual(prepareSendIntent(a,{...input,eventIds:[eventId,'9000000000000000002']}),
  {status:'rejected',reasonCode:'invalid_event_group'});
 assert.equal(rows(file,'send_intents'),0);
}));
test('T6-2b AC: one T5-claimed batch cannot be partially sent or mixed',()=>withV4(async(a,_,input,file)=>{
 const c=a.claimAiDryRun({conversationId:THREAD,maxAgeMs:input.coverageMaxAgeMs,
  backendId:'claude_code',backendKind:'agent-runtime',maxBatchEvents:2});
 assert.ok(c);
 if(!c)return;
 assert.equal(c.candidate.eventIds.length,2);
 assert.deepEqual(prepareSendIntent(a,{...input,sourceEventId:c.candidate.eventId,
  eventIds:[c.candidate.eventId]}),{status:'rejected',reasonCode:'invalid_event_group'});
 assert.deepEqual(prepareSendIntent(a,{...input,sourceEventId:c.candidate.eventId,
  eventIds:[...c.candidate.eventIds,'9000000000000000003']}),{
  status:'rejected',reasonCode:'invalid_event_group'});
 assert.equal(rows(file,'send_intents'),0);
}));

function recordedMockIntent(a:EveArchive,input:PrepareSendInput):string{
 const claim=a.claimAiDryRun({
  conversationId:THREAD,maxAgeMs:input.coverageMaxAgeMs,
  backendId:'claude_code',backendKind:'agent-runtime',maxBatchEvents:1,
 });
 assert.ok(claim,'fixture must produce real T5 ledger reservation');
 assert.equal(claim?.candidate.eventId,eventId);
 const decision=input.decision;
 assert.equal(decision.action,'reply');
 if(decision.action!=='reply'||!claim)throw Error('invalid_mock_setup');
 const digest=createHash('sha256').update(JSON.stringify(decision)).digest('hex');
 assert.deepEqual(a.finishAiDryRun({
  claimId:claim.claimId,maxAgeMs:input.coverageMaxAgeMs,
  outcome:{status:'recorded',action:'reply',replyLength:decision.text.length,
   decisionDigest:digest},
 }),{status:'recorded',reasonCode:null});
 const saved=prepareSendIntent(a,input);
 assert.equal(saved.status,'created');
 if(saved.status!=='created')throw Error('mock_intent_not_created');
 return saved.intentId;
}
function mockOptions(input:PrepareSendInput,intentId:string){
 return {
  intentId,now:input.now,maxAgeMs:input.coverageMaxAgeMs,maxLength:500,
  timeoutMs:50,identity:input.identity,runtime:input.runtime,
  allowMockOnly:true as const,
 };
}

test('T6-2b: unrecorded T5 output must never reach even a mock port',()=>withV4(async(a,_,input)=>{
 const saved=prepareSendIntent(a,input);
 assert.equal(saved.status,'created');
 if(saved.status!=='created')return;
 const port=new MockSendPort('confirmed');
 assert.deepEqual(await dispatchMockOnce(a,port,mockOptions(input,saved.intentId)),
  {status:'blocked',reason:'source_unverified'});
 assert.equal(port.calls,0);
 assert.equal(a.getSendIntent(saved.intentId)?.status,'pending');
}));
test('T6-2b: recorded T5 reply -> mock-confirmed only, no second claim or platform',()=>withV4(async(a,p,input)=>{
 const id=recordedMockIntent(a,input),port=new MockSendPort('confirmed');
 const result=await dispatchMockOnce(a,port,mockOptions(input,id));
 assert.deepEqual(result,{status:'mock_sent',intentId:id});
 assert.equal(a.getSendIntent(id)?.status,'sent');
 assert.match(a.getSendIntent(id)?.evidence??'',/^mock:[0-9a-f]{64}$/);
 assert.equal(a.getSendIntent(id)?.attempt,1);
 assert.equal(port.calls,1);
 assert.equal(JSON.stringify(result).includes('离线测试'),false);
 assert.deepEqual(await dispatchMockOnce(a,port,mockOptions(input,id)),
  {status:'blocked',reason:'source_unverified'});
 assert.equal(port.calls,1);
 assert.equal(p.startCount,0);
}));
test('T6-2b: confirmed not-sent mock rejection -> failed and terminal',()=>withV4(async(a,_,input)=>{
 const id=recordedMockIntent(a,input),port=new MockSendPort('rejected_before_dispatch');
 assert.deepEqual(await dispatchMockOnce(a,port,mockOptions(input,id)),{status:'failed',intentId:id});
 assert.equal(a.getSendIntent(id)?.reasonCode,'rejected_before_dispatch');
 assert.equal(a.claimSendIntent(id,input.now+5),false);
}));
test('T6-2b: ambiguous/transport/timeout are unknown, never auto retried',async()=>{
 for(const [mode,reason] of [
  ['ambiguous','ambiguous_result'],['throws','transport_error'],['hang','timeout']
 ] as const){
  await withV4(async(a,_,input)=>{
   const id=recordedMockIntent(a,input),port=new MockSendPort(mode);
   const result=await dispatchMockOnce(a,port,mockOptions(input,id));
   assert.deepEqual(result,{status:'unknown',intentId:id,reason});
   assert.equal(a.getSendIntent(id)?.status,'unknown');
   assert.equal(a.getSendIntent(id)?.attempt,1);
   assert.equal(a.claimSendIntent(id,input.now+100),false);
   assert.equal(port.calls,1);
  });
 }
});
test('T6-2b: identity/runtime/proof/expired text failures stop before mock send',()=>withV4(async(a,_,input)=>{
 const id=recordedMockIntent(a,input),port=new MockSendPort('confirmed');
 assert.equal((await dispatchMockOnce(a,port,{...mockOptions(input,id),
  identity:{...input.identity,targetUid:'999'}})).status,'blocked');
 assert.equal((await dispatchMockOnce(a,port,{...mockOptions(input,id),
  runtime:{phase:'paused_manual',paused:true}})).status,'blocked');
 assert.equal((await dispatchMockOnce(a,port,{...mockOptions(input,id),
  now:input.now+input.retentionMs+1})).status,'blocked');
 a.invalidateCurrentCoverage();
 assert.deepEqual(await dispatchMockOnce(a,port,mockOptions(input,id)),
  {status:'blocked',reason:'source_unverified'});
 assert.equal(port.calls,0);
 assert.equal(a.getSendIntent(id)?.status,'pending');
}));
test('T6-2b: persisted decision digest mismatch rejects mock dispatch',()=>withV4(async(a,_,input,file)=>{
 const id=recordedMockIntent(a,input),port=new MockSendPort('confirmed');
 const db=new DatabaseSync(file);
 try{db.prepare('UPDATE send_intents SET decision_digest=? WHERE intent_id=?')
   .run('c'.repeat(64),id);}finally{db.close();}
 assert.deepEqual(await dispatchMockOnce(a,port,mockOptions(input,id)),
  {status:'blocked',reason:'source_unverified'});
 assert.equal(port.calls,0);
}));

test('T6-2b AC: event valid in another authorized conversation is invalid in this one',()=>withV4(async(a,p,input,file)=>{
 const other='0:1:111:333';
 const copy=(id:string):InboundMessage=>({...message(id),conversationId:other});
 p.delivered.push(copy('9000000000000000098'));
 assert.equal((await reconcileOnce({
  port:p,archive:a,conversationId:other,imUid:'111',instanceId:'other-baseline',
  isSafe:()=>true,
 })).state,'verified');
 p.delivered.push(copy('9000000000000000099'));
 assert.equal((await reconcileOnce({
  port:p,archive:a,conversationId:other,imUid:'111',instanceId:'other-update',
  isSafe:()=>true,
 })).state,'verified');
 const result=prepareSendIntent(a,{...input,eventIds:[eventId,'9000000000000000099']});
 assert.deepEqual(result,{status:'rejected',reasonCode:'invalid_event_group'});
 assert.equal(rows(file,'send_intents'),0);
}));
