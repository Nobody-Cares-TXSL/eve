import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EveArchive} from '../../src/archive/store.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import type {HistoryPage,InboundMessage,PlatformPort,PlatformSink} from '../../src/platform/types.ts';

const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
function message(i:number):InboundMessage {
 return {conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(i)),
  clientMessageId:null,senderUid:'333',fromSelf:false,text:'item-'+i,kind:'text',messageType:7,
  createTime:String(1000+i),indexInConversation:String(9007199254740995n+BigInt(i))};
}
const base=9007199254740995n;
class HistoryPort implements PlatformPort{
 messages:InboundMessage[];
 readonly pageSize=50;
 calls=0;
 closingHook:()=>void=()=>undefined;
 mutate:(p:HistoryPage)=>HistoryPage=(p)=>p;
 constructor(messages:InboundMessage[]){this.messages=messages;}
 async start(){} async stop(){} subscribe(_sink:PlatformSink){}
 async readHistory(conversationId:string,cursor?:string|null):Promise<HistoryPage>{
  assert.equal(conversationId,thread);
  this.calls++;
  if(cursor===null||cursor===undefined) this.closingHook();
  const end=cursor==null?this.messages.length:Number(BigInt(cursor)-base);
  const start=Math.max(0,end-this.pageSize),selection=this.messages.slice(start,end);
  const page:HistoryPage={statusCode:0,hasMore:start>0,cursor:String(base+BigInt(start)),
    direction:'older',requestedCursor:cursor??null,requestedDirection:'older',
    rawCount:selection.length,acceptedCount:selection.length,excludedCount:0,missingIdCount:0,
    exclusions:{foreignConversation:0,foreignSender:0,deleted:0,unrepresentable:0},
    messages:selection};
  return this.mutate(page);
 }
}
function fixture(fn:(a:EveArchive,port:HistoryPort)=>Promise<void>,length=120):Promise<void>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-recon-'));
 const a=EveArchive.open(join(dir,'eve.sqlite'),identity);a.upgradeToV2();
 const port=new HistoryPort(Array.from({length},(_,i)=>message(i)));
 return fn(a,port).finally(()=>{a.close();rmSync(dir,{recursive:true,force:true});});
}
const run=(a:EveArchive,port:HistoryPort,instanceId='instance')=>reconcileOnce({
 archive:a,port,conversationId:thread,imUid:'222',instanceId,isSafe:()=>true,limits:{maxPages:12,maxMessages:200,readTimeoutMs:2000,maxDurationMs:10000},
});
test('T4-3 首次 120 条多页归档 + 头页闭合，首轮不产生 eligible',()=>fixture(async(a,port)=>{
 const result=await run(a,port);
 assert.equal(result.state,'verified',result.reason);
 assert.equal(result.pages,4); // three older pages + closing head
 assert.equal(a.counts().messages,120);
 assert.equal(a.reconcileStats(result.epochId).eligible,0);
 assert.equal(a.conversationState(thread),'verified');
 assert.equal(a.getVerifiedAnchor(thread),message(119).serverMessageId);
 assert.equal(port.calls,4);
}));
test('T4-3 51 条跨页，锚点重叠后仅新入站目标文本产生一次 eligible',()=>fixture(async(a,port)=>{
 const first=await run(a,port);assert.equal(first.state,'verified',first.reason);
 port.messages.push(message(51),message(52),message(53));
 const second=await run(a,port,'instance-two');
 assert.equal(second.state,'verified',second.reason);
 assert.equal(a.counts().messages,54);
 assert.equal(a.reconcileStats(second.epochId).eligible,3);
 assert.equal(a.getVerifiedAnchor(thread),message(53).serverMessageId);
 const third=await run(a,port,'instance-three');
 assert.equal(third.state,'verified',third.reason);
 assert.equal(a.reconcileStats(third.epochId).eligible,0);
},51));
test('T4-3 无旧锚点重叠时 gap，原锚点不可被新历史覆盖',()=>fixture(async(a,port)=>{
 assert.equal((await run(a,port)).state,'verified');
 const oldAnchor=a.getVerifiedAnchor(thread);
 port.messages=[message(300),message(301)];
 const result=await run(a,port,'new-process');
 assert.equal(result.state,'gap');
 assert.equal(result.reason,'anchor_not_covered');
 assert.equal(a.conversationState(thread),'gap');
 assert.equal(a.getVerifiedAnchor(thread),oldAnchor);
},4));
test('T4-3 页被过滤不能签发 verified',()=>fixture(async(a,port)=>{
 port.mutate=p=>({...p,rawCount:p.rawCount+1,excludedCount:1,
  exclusions:{foreignConversation:1,foreignSender:0,deleted:0,unrepresentable:0}});
 const result=await run(a,port);
 assert.equal(result.state,'gap');assert.equal(result.reason,'page_unverifiable');
 assert.equal(a.counts().batches,0);assert.equal(a.getVerifiedAnchor(thread),null);
},4));
test('T4-3 头部持续变动不得过审',()=>fixture(async(a,port)=>{
 let n=0;
 port.closingHook=()=>{n++;if(n===2)port.messages.push(message(51));};
 const result=await run(a,port);
 assert.equal(result.state,'gap');assert.equal(result.reason,'head_not_closed');
 assert.equal(a.getVerifiedAnchor(thread),null);
},51));
test('T4-3 hasMore + 重复 cursor 应迅速停止并保留 gap',()=>fixture(async(a,port)=>{
 port.mutate=p=>({...p,hasMore:true,cursor:p.requestedCursor??'0'});
 const result=await run(a,port);
 assert.equal(result.state,'gap');assert.equal(result.reason,'cursor_not_advancing');
 assert.equal(a.reconcileStats(result.epochId).pages,1); // first page durable; next looping cursor rejected
},51));
test('T4-3 人工失效 epoch 栅栏，不存在已提交 proof',()=>fixture(async(a,port)=>{
 const result=await reconcileOnce({archive:a,port,conversationId:thread,imUid:'222',
  instanceId:'before-reconnect',isSafe:()=>false});
 assert.equal(result.state,'gap');assert.equal(result.reason,'epoch_invalidated');
 assert.equal(a.getVerifiedAnchor(thread),null);
},51));
test('T4-3 页提交前故障注入：消息与页证据一并回滚',()=>fixture(async(a,port)=>{
 const epochId='11111111-1111-4111-8111-111111111111';
 a.beginEpoch({epochId,conversationId:thread,instanceId:'test',imUid:'222'});
 const page=await port.readHistory(thread);
 assert.throws(()=>a.recordReconcilePage({epochId,pageNo:0,phase:'older',page},true),
  /reconcile_page_injected_failure/);
 assert.deepEqual(a.counts(),{messages:0,uncertain:0,gaps:0,batches:0});
 assert.equal(a.reconcileStats(epochId).pages,0);
 assert.equal(a.getVerifiedAnchor(thread),null);
},51));
test('T4-3 旧 epoch 被新进程取代后不能继续写入',()=>fixture(async(a,port)=>{
 const old='22222222-2222-4222-8222-222222222222',fresh='33333333-3333-4333-8333-333333333333';
 a.beginEpoch({epochId:old,conversationId:thread,instanceId:'old',imUid:'222'});
 a.beginEpoch({epochId:fresh,conversationId:thread,instanceId:'new',imUid:'222'});
 const page=await port.readHistory(thread);
 assert.throws(()=>a.recordReconcilePage({epochId:old,pageNo:0,phase:'older',page}),/epoch_stale/);
 assert.equal(a.reconcileStats(old).state,'cancelled');
 assert.equal(a.reconcileStats(fresh).pages,0);
},5));
test('T4-3 历史空白不能产生 synthetic anchor',()=>fixture(async(a,port)=>{
 const res=await run(a,port);assert.equal(res.state,'gap');
 assert.equal(res.reason,'empty_history_unverifiable');
 assert.equal(a.getVerifiedAnchor(thread),null);
},0));
test('T4-3 读历史接口超时有界失败，未签发证明',()=>fixture(async(a,port)=>{
 port.readHistory=async()=>new Promise<HistoryPage>(()=>undefined);
 const result=await reconcileOnce({archive:a,port,conversationId:thread,imUid:'222',
  instanceId:'timeout',isSafe:()=>true,limits:{readTimeoutMs:30,maxDurationMs:500,maxPages:10}});
 assert.equal(result.state,'gap');
 assert.equal(result.reason,'history_timeout');
 assert.equal(a.reconcileStats(result.epochId).pages,0);
},10));
test('T4-3 头部闭合与 verified/eligible 更新必须同事务回滚',()=>fixture(async(a,port)=>{
 const baseline=await run(a,port);assert.equal(baseline.state,'verified');
 const anchor=a.getVerifiedAnchor(thread);
 port.messages.push(message(51));
 const epochId='55555555-5555-4555-8555-555555555555';
 a.beginEpoch({epochId,conversationId:thread,instanceId:'fault',imUid:'222'});
 const head=await port.readHistory(thread);
 a.recordReconcilePage({epochId,pageNo:0,phase:'older',page:head});
 assert.throws(()=>a.recordReconcilePage({epochId,pageNo:1,phase:'head_close',page:head},true),
  /reconcile_page_injected_failure/);
 const s=a.reconcileStats(epochId);
 assert.equal(s.pages,1);
 assert.equal(s.eligible,0);
 assert.equal(s.state,'reconciling');
 assert.equal(a.getVerifiedAnchor(thread),anchor);
},51));
test('T4: 头页 ID 未变但 cursor/hasMore 改变，拒绝闭合证明',()=>fixture(async(a,port)=>{
 port.mutate=p=>port.calls===2?{...p,cursor:'changed-cursor',hasMore:!p.hasMore}:p;
 const result=await run(a,port);
 assert.equal(result.state,'gap');
 assert.equal(result.reason,'head_not_closed');
 assert.equal(a.getVerifiedAnchor(thread),null);
},5));
test('T4: 同一页内部重复 serverMessageId 不能冒充覆盖',()=>fixture(async(a,port)=>{
 port.mutate=p=>({...p,messages:[p.messages[0]!,p.messages[0]!],
  rawCount:2,acceptedCount:2,excludedCount:0});
 const result=await run(a,port);
 assert.equal(result.state,'gap');
 assert.equal(result.reason,'page_unverifiable');
 assert.equal(a.counts().batches,0);
},2));

test('T4: 新进程先关闭当前 verified 栅栏，保留旧锚点供重新对账',()=>fixture(async(a,port)=>{
 const old=await run(a,port);assert.equal(old.state,'verified');
 const anchor=a.getVerifiedAnchor(thread);
 a.invalidateCurrentCoverage();
 assert.equal(a.conversationState(thread),'unverified');
 assert.equal(a.getVerifiedAnchor(thread),anchor);
 const resumed=await run(a,port,'restart-process');
 assert.equal(resumed.state,'verified');
 assert.equal(a.getVerifiedAnchor(thread),anchor);
 assert.equal(a.reconcileStats(resumed.epochId).eligible,0);
},51));
