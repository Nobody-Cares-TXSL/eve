import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EveArchive} from '../../src/archive/store.ts';
import {MockPlatformPort} from '../../src/platform/mock.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import {dryRunOne} from '../../src/ai/engine.ts';
import {AgentTransportError} from '../../src/ai/agent-transport.ts';
import type {AiBackend,AiRequest} from '../../src/ai/contracts.ts';
import type {InboundMessage} from '../../src/platform/types.ts';

const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
function msg(i:number,fromSelf=false,text='hello'):InboundMessage{
 return {conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
  clientMessageId:null,senderUid:fromSelf?'111':'333',fromSelf,
  text,kind:'text',messageType:7,createTime:String(2000+i),indexInConversation:String(i)};
}
async function fixture(fn:(a:EveArchive,p:MockPlatformPort,dbPath:string)=>Promise<void>,
 withEligible=true):Promise<void>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-dryrun-')),dbPath=join(dir,'eve.sqlite');
 const a=EveArchive.open(dbPath,identity),p=new MockPlatformPort({uid:'111',imUid:'222'});
 try{
  a.upgradeToV2();
  p.delivered.push(msg(0),msg(1,true,'你好'));
  const baseline=await reconcileOnce({archive:a,port:p,conversationId:thread,imUid:'222',
   instanceId:'initial',isSafe:()=>true});
  assert.equal(baseline.state,'verified');
  if(withEligible){
   p.delivered.push(msg(2,false,'这周有空吗？'));
   const second=await reconcileOnce({archive:a,port:p,conversationId:thread,imUid:'222',
    instanceId:'incremental',isSafe:()=>true});
   assert.equal(second.state,'verified',second.reason);
   assert.equal(a.reconcileStats(second.epochId).eligible,1);
  }
  await fn(a,p,dbPath);
 }finally{a.close();rmSync(dir,{recursive:true,force:true});}
}
function backend(value:unknown,kind:'model-api'|'agent-runtime'='model-api'):AiBackend{
 return {id:'fake_backend',kind,evaluate:async()=>value};
}
const options={conversationId:thread,maxAgeMs:90_000};

test('T5-1: eligible + usable → model-api backend → reply audit; no DB consumption',()=>fixture(async(a,_,path)=>{
 let request:AiRequest|undefined;
 const b:AiBackend={id:'model_fixture',kind:'model-api',evaluate:async(req)=>{
  request=req;return {action:'reply',text:'好的，有空！',reason:'回答约时间',delayMs:1500};
 }};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'dry_run');
 if(result.status!=='dry_run')throw Error('expected_success');
 assert.equal(result.action,'reply');
 assert.equal(result.replyLength,6);
 assert.match(result.eventDigest,/^[a-f0-9]{64}$/);
 assert.match(result.decisionDigest,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(result).includes('好的'),false);
 assert.deepEqual(request?.turns.map(x=>x.role),['user','assistant','user']);
 assert.equal(request?.turns.at(-1)?.text,'这周有空吗？');
 assert.ok(request?.instructions.includes('不可信'));
 const serialized=JSON.stringify(request);
 assert.ok(!serialized.includes('7701260499833538097'));
 assert.ok(!serialized.includes('0:1:222:333'));
 assert.ok(!serialized.includes('senderUid'));
 const db=new DatabaseSync(path,{readOnly:true});
 try{assert.equal((db.prepare("SELECT COUNT(*) n FROM eligible_events WHERE state='pending'").get() as {n:number}).n,1);}
 finally{db.close();}
}));
test('T5-1: agent-runtime 与 model-api 共享 Decision Contract',()=>fixture(async(a)=>{
 const result=await dryRunOne(a,backend({action:'skip',reason:'无须回应'},'agent-runtime'),options);
 assert.equal(result.status,'dry_run');
 if(result.status==='dry_run'){assert.equal(result.action,'skip');assert.equal(result.backendKind,'agent-runtime');}
}));
test('T5-1: defer audit 不包含响应正文',()=>fixture(async(a)=>{
 const result=await dryRunOne(a,backend({action:'defer',reason:'等待进一步消息',delayMs:2000}),options);
 assert.equal(result.status,'dry_run');
 if(result.status==='dry_run'){assert.equal(result.action,'defer');assert.equal(result.replyLength,0);}
}));
test('T5-1: 首次基线没有 eligible 时不调用模型',()=>fixture(async(a)=>{
 let calls=0;const b:AiBackend={id:'test',kind:'model-api',evaluate:async()=>{calls++;return {action:'skip',reason:'x'};}};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'no_pending_event');
 assert.equal(calls,0);
},false));
test('T5-1: paused/unverified 门控阻止任何正文送往 backend',()=>fixture(async(a)=>{
 a.invalidateCurrentCoverage();
 let calls=0;
 const b:AiBackend={id:'test',kind:'model-api',evaluate:async()=>{calls++;return {action:'skip',reason:'x'};}};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'coverage_unusable');
 assert.equal(calls,0);
}));
test('T5-1: 过期的 verified 即使 DB 状态仍 verified 也不给模型',()=>fixture(async(a,_,path)=>{
 const db=new DatabaseSync(path);
 try{db.prepare('UPDATE conversations SET last_verified_at_ms=? WHERE conversation_id=?').run(Date.now()-91_000,thread);}
 finally{db.close();}
 let calls=0;const b:AiBackend={id:'test',kind:'model-api',evaluate:async()=>{calls++;return {action:'skip',reason:'x'};}};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'coverage_unusable');
 assert.equal(calls,0);
}));
test('T5-1: 推理中停止，返回前二次 usable 检查丢弃 reply',()=>fixture(async(a)=>{
 const b:AiBackend={id:'test',kind:'model-api',evaluate:async()=>{
  a.invalidateCurrentCoverage();
  return {action:'reply',text:'不能输出的回复',reason:'x',delayMs:0};
 }};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'coverage_lost_after_inference');
 assert.equal(JSON.stringify(result).includes('不能输出'),false);
}));
test('T5-1: 模型伪造工具字段与脚本执行要求 → invalid_decision',()=>fixture(async(a)=>{
 const result=await dryRunOne(a,backend({
  action:'reply',text:'Hi',reason:'x',delayMs:0,toolCall:{name:'shell',args:'rm -rf /'}
 }),options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'invalid_decision');
}));
test('T5-1: 模型异常不得回显异常内容',()=>fixture(async(a)=>{
 const b:AiBackend={id:'test',kind:'model-api',evaluate:async()=>{throw Error('SECRET_TOKEN:message-body');}};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'backend_failed');
 assert.ok(!JSON.stringify(result).includes('SECRET_TOKEN'));
}));
test('T5-1: 后端悬挂按超时失败，任何结果不可重放发送',()=>fixture(async(a)=>{
 const b:AiBackend={id:'test',kind:'agent-runtime',evaluate:async()=>new Promise<never>(()=>{})};
 const result=await dryRunOne(a,b,{...options,timeoutMs:25});
 assert.equal(result.status,'blocked');if(result.status==='blocked')assert.equal(result.reasonCode,'backend_timeout');
}));
test('T5-1: 模型身份名称必须可安全审计，拒绝日志注入',()=>fixture(async(a)=>{
 const b:AiBackend={id:'secret\nmalicious',kind:'agent-runtime',evaluate:async()=>({action:'skip',reason:'x'})};
 await assert.rejects(dryRunOne(a,b,options),/invalid_backend/);
}));

test('T5-1: 推理期间暂停并重新签发 verified，旧 epoch 的 AI 结果仍必须丢弃',()=>fixture(async(a,p)=>{
 const oldEpoch=a.coverageEpoch(thread,90_000);
 assert.ok(oldEpoch);
 const b:AiBackend={id:'test',kind:'agent-runtime',evaluate:async()=>{
  a.invalidateCurrentCoverage();
  const res=await reconcileOnce({
   archive:a,port:p,conversationId:thread,imUid:'222',instanceId:'during-inference',
   isSafe:()=>true,
  });
  assert.equal(res.state,'verified',res.reason);
  assert.notEqual(a.coverageEpoch(thread,90_000),oldEpoch);
  return {action:'reply',text:'不该通过的旧回复',reason:'x',delayMs:0};
 }};
 const result=await dryRunOne(a,b,options);
 assert.equal(result.status,'blocked');
 if(result.status==='blocked')assert.equal(result.reasonCode,'coverage_lost_after_inference');
}));

test('T5 P0: all transport failure codes reach the AI audit without collapsing',()=>fixture(async(a)=>{
 const codes=[
  'agent_aborted','agent_timeout','agent_start_failed','agent_execution_failed',
  'agent_output_too_large','agent_invalid_output','agent_cli_configuration_error',
  'agent_auth_error','agent_network_error','agent_rate_limit','agent_result_error',
 ] as const;
 for(const code of codes){
  const backend:AiBackend={id:'claude_code',kind:'agent-runtime',evaluate:async()=>{
   throw new AgentTransportError(code);
  }};
  const result=await dryRunOne(a,backend,options);
  assert.equal(result.status,'blocked',code);
  if(result.status==='blocked')assert.equal(result.reasonCode,code);
 }
}));
