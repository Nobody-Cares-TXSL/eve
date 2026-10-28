import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EveArchive} from '../../src/archive/store.ts';
import {reconcileOnce} from '../../src/runtime/reconcile.ts';
import type {HistoryPage,InboundMessage,PlatformPort,PlatformSink} from '../../src/platform/types.ts';

const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const first=7701260499833538097n;
function msg(i:number):InboundMessage{
 return {conversationId:thread,serverMessageId:String(first+BigInt(i)),clientMessageId:null,
  senderUid:'333',fromSelf:false,text:'load-fixture-'+i,kind:'text',messageType:7,
  createTime:String(100000+i),indexInConversation:String(9007199254740995n+BigInt(i))};
}
class SizedHistoryPort implements PlatformPort {
 calls=0; readonly messages:InboundMessage[];
 constructor(count:number){this.messages=Array.from({length:count},(_,i)=>msg(i));}
 subscribe(_sink:PlatformSink):void{}
 async start():Promise<void>{}
 async stop():Promise<void>{}
 async readHistory(id:string,cursor?:string|null):Promise<HistoryPage>{
  assert.equal(id,thread);
  this.calls++;
  const end=cursor==null?this.messages.length:Number(cursor);
  const start=Math.max(0,end-50);
  const messages=this.messages.slice(start,end);
  return {statusCode:0,requestedCursor:cursor??null,requestedDirection:'older',
   direction:'older',hasMore:start>0,cursor:String(start),messages,rawCount:messages.length,
   acceptedCount:messages.length,excludedCount:0,missingIdCount:0,
   exclusions:{foreignConversation:0,foreignSender:0,deleted:0,unrepresentable:0}};
 }
}
function fixture(fn:(a:EveArchive,p:SizedHistoryPort,file:string)=>Promise<void>,count=600):Promise<void>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-budget-')),file=join(dir,'eve.sqlite');
 const a=EveArchive.open(file,identity);a.upgradeToV2();
 return fn(a,new SizedHistoryPort(count),file).finally(()=>{a.close();rmSync(dir,{recursive:true,force:true});});
}
const run=(a:EveArchive,p:SizedHistoryPort,limits:Record<string,number>)=>reconcileOnce({
 archive:a,port:p,conversationId:thread,imUid:'222',instanceId:'load-check',isSafe:()=>true,limits,
});
test('T4-5: 600 条 12 页 + 头页闭合，持久消息恰好 600，重扫不重复',()=>fixture(async(a,p,file)=>{
 const r=await run(a,p,{maxPages:15,maxMessages:650,maxDurationMs:20000,readTimeoutMs:5000});
 assert.equal(r.state,'verified',r.reason);
 assert.equal(r.pages,13);
 assert.equal(p.calls,13);
 assert.equal(a.counts().messages,600);
 assert.equal(a.reconcileStats(r.epochId).eligible,0);
 assert.ok(statSync(file).size>0);
 const again=await run(a,p,{maxPages:15,maxMessages:650,maxDurationMs:20000,readTimeoutMs:5000});
 assert.equal(again.state,'verified',again.reason);
 assert.equal(a.counts().messages,600);
 assert.equal(a.reconcileStats(again.epochId).eligible,0);
},600));
test('T4-5: 页数上限不能越过，已入库部分保留而当前门控 gap',()=>fixture(async(a,p)=>{
 const r=await run(a,p,{maxPages:3,maxMessages:999,maxDurationMs:30000,readTimeoutMs:5000});
 assert.equal(r.state,'gap');assert.equal(r.reason,'page_budget_exhausted');
 assert.equal(p.calls,3);
 assert.equal(a.counts().messages,150);
 assert.equal(a.reconcileStats(r.epochId).eligible,0);
 assert.equal(a.getVerifiedAnchor(thread),null);
 assert.equal(a.conversationState(thread),'gap');
},600));
test('T4-5: 消息数上限拒绝并且超过预算的页不提交',()=>fixture(async(a,p)=>{
 const r=await run(a,p,{maxPages:20,maxMessages:105,maxDurationMs:30000,readTimeoutMs:5000});
 assert.equal(r.state,'gap');assert.equal(r.reason,'message_budget_exhausted');
 assert.equal(p.calls,3);
 assert.equal(a.counts().messages,100);
 assert.equal(a.reconcileStats(r.epochId).pages,2);
 assert.equal(a.getVerifiedAnchor(thread),null);
},600));
test('T4-5: 有界时长低于 SDK 读取耗时，不得写 verified',()=>fixture(async(a,p)=>{
 const orig=p.readHistory.bind(p);
 p.readHistory=async(id,cursor)=>{
  await new Promise(r=>setTimeout(r,35));
  return orig(id,cursor);
 };
 const r=await run(a,p,{maxPages:20,maxMessages:999,maxDurationMs:1,readTimeoutMs:300});
 assert.equal(r.state,'gap');
 assert.equal(r.reason,'epoch_invalidated');
 assert.equal(a.getVerifiedAnchor(thread),null);
},600));
