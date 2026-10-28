import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EveArchive,ArchiveError,type Batch} from '../../src/archive/store.ts';
import type {InboundMessage} from '../../src/platform/types.ts';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const msg=(over:Partial<InboundMessage>={}):InboundMessage=>({
 conversationId:thread,serverMessageId:'1000000000000000001',clientMessageId:null,senderUid:'333',fromSelf:false,
 text:'你好',kind:'text',messageType:7,createTime:'1793089447000',indexInConversation:'123',...over
});
const batch=(id:string,messages:InboundMessage[],extra:Partial<Batch>={}):Batch=>({batchId:id,conversationId:thread,source:'live',messages,...extra});
function withDB(fn:(a:EveArchive,file:string)=>void){const dir=mkdtempSync(join(tmpdir(),'eve-t3-')),file=join(dir,'eve.sqlite');try{const a=EveArchive.open(file,identity);try{fn(a,file);}finally{a.close();}}finally{rmSync(dir,{recursive:true,force:true});}}
test('同文不同 ID 与双方同文均保存，重放只 matched',()=>withDB(a=>{
 assert.deepEqual(a.archiveBatch(batch('a',[msg(),msg({serverMessageId:'1000000000000000002'}),msg({serverMessageId:'1000000000000000003',senderUid:'222',fromSelf:true})])).outcomes,['new','new','new']);
 assert.deepEqual(a.archiveBatch(batch('b',[msg()])).outcomes,['matched']);
 assert.equal(a.counts().messages,3);
}));
test('同一 batchId 重放不新增 uncertain；修改正文冲突不可覆盖',()=>withDB(a=>{
 const r=batch('b1',[msg({serverMessageId:null})]);
 assert.deepEqual(a.archiveBatch(r).outcomes,['ambiguous']);
 assert.equal(a.archiveBatch(r).replayed,true);
 assert.deepEqual(a.archiveBatch(r).outcomes,['ambiguous']);
 assert.equal(a.counts().uncertain,1);
 assert.throws(()=>a.archiveBatch(batch('b1',[msg({serverMessageId:null,text:'不同'})])),(e:unknown)=>e instanceof ArchiveError&&e.code==='batch_conflict');
 a.archiveBatch(batch('b2',[msg({serverMessageId:null})]));
 assert.equal(a.counts().uncertain,2);
 assert.equal(a.conversationState(thread),'ambiguous');
}));
test('服务器 ID 相同但正文冲突拒绝并保留旧内容',()=>withDB(a=>{
 a.archiveBatch(batch('x',[msg()]));
 assert.throws(()=>a.archiveBatch(batch('y',[msg({text:'被替换'})])),(e:unknown)=>e instanceof ArchiveError&&e.code==='message_conflict');
 assert.equal(a.counts().messages,1);assert.equal(a.counts().batches,1);
}));
test('非法发件方/方向/其他会话整批拒绝',()=>withDB(a=>{
 for(const m of [msg({senderUid:'444'}),msg({senderUid:'222',fromSelf:false}),msg({conversationId:'0:1:222:444'})]){
  assert.throws(()=>a.archiveBatch(batch('x',[msg(),m])),/rejected/);
 }
 assert.equal(a.counts().messages,0);
}));
test('事务中间故障完全回滚及 gap 留证',()=>withDB(a=>{
 assert.throws(()=>a.archiveBatch(batch('one',[msg(),msg({serverMessageId:'2222'})]),1),/injected_failure/);
 assert.deepEqual(a.counts(),{messages:0,uncertain:0,gaps:0,batches:0});
 a.archiveBatch(batch('gap',[msg()],{gapReason:'no_history_overlap'}));
 assert.equal(a.counts().gaps,1);assert.equal(a.conversationState(thread),'gap');
}));
test('持久化重启、账户绑定、权限和关闭后拒绝',()=>withDB((a,file)=>{
 a.archiveBatch(batch('persist',[msg()]));
 assert.equal(statSync(file).mode&0o777,0o600);
 const folder=join(file,'..');assert.equal(statSync(folder).mode&0o777,0o700);
 const other=EveArchive.open(file,identity);
 assert.equal(other.counts().messages,1);
 other.close();
 assert.throws(()=>EveArchive.open(file,{...identity,targetUid:'444'}),/account_mismatch/);
}));
