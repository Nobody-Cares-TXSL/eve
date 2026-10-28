/** T4 true process death: durable page, uncommitted page rollback, verified proof recovery. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EveArchive} from '../../src/archive/store.ts';
import type {HistoryPage} from '../../src/platform/types.ts';

const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const page:HistoryPage={
 statusCode:0,hasMore:false,cursor:'0',direction:'older',requestedCursor:null,
 requestedDirection:'older',rawCount:1,acceptedCount:1,excludedCount:0,missingIdCount:0,
 exclusions:{foreignConversation:0,foreignSender:0,deleted:0,unrepresentable:0},
 messages:[{conversationId:thread,serverMessageId:'7701260499833538097',clientMessageId:null,
  senderUid:'333',fromSelf:false,text:'fake-fixture',kind:'text',messageType:7,createTime:'1',indexInConversation:'1'}],
};
const epoch='77777777-7777-4777-8777-777777777777';
function executeKilled(file:string,source:string){
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],
  {encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1',EVE_T4_DB:file},timeout:10000});
 assert.equal(result.signal,'SIGKILL',result.stderr);
}
const modulePath=JSON.stringify(resolve('src/archive/store.ts'));
const initScript=`
import {EveArchive} from ${modulePath};
const archive=EveArchive.open(process.env.EVE_T4_DB,${JSON.stringify(identity)});
archive.upgradeToV2();
archive.beginEpoch({epochId:${JSON.stringify(epoch)},conversationId:${JSON.stringify(thread)},instanceId:'dead',imUid:'222'});
const page=${JSON.stringify(page)};
archive.recordReconcilePage({epochId:${JSON.stringify(epoch)},pageNo:0,phase:'older',page});
`;
function fixture(run:(file:string)=>void){
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-kill-')),file=join(dir,'archive.sqlite');
 try{run(file);}finally{rmSync(dir,{recursive:true,force:true});}
}
test('T4: SIGKILL 已提交页可恢复、旧 epoch 不能签发证明',()=>fixture(file=>{
 executeKilled(file,initScript+"process.kill(process.pid,'SIGKILL');");
 const archive=EveArchive.open(file,identity);
 try{
  assert.equal(archive.reconcileStats(epoch).pages,1);
  assert.equal(archive.counts().messages,1);
  assert.equal(archive.getVerifiedAnchor(thread),null);
  assert.equal(archive.reconcileStats(epoch).eligible,0);
  const next='88888888-8888-4888-8888-888888888888';
  archive.beginEpoch({epochId:next,conversationId:thread,instanceId:'new-process',imUid:'222'});
  assert.equal(archive.reconcileStats(epoch).state,'cancelled');
  assert.equal(archive.reconcileStats(next).pages,0);
  assert.equal(archive.counts().messages,1);
 }finally{archive.close();}
}));
test('T4: SIGKILL 事务中间：消息和页证据均不得半写',()=>fixture(file=>{
 const archive=EveArchive.open(file,identity);archive.upgradeToV2();archive.close();
 const source=`
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.env.EVE_T4_DB);
db.exec('PRAGMA foreign_keys=ON');
db.exec('BEGIN IMMEDIATE');
const thread=${JSON.stringify(thread)};
const epoch=${JSON.stringify(epoch)};
db.prepare('INSERT INTO conversations(conversation_id,updated_at_ms) VALUES(?,?)').run(thread,1);
db.prepare("INSERT INTO reconcile_epochs(epoch_id,conversation_id,instance_id,owner_uid,im_uid,target_uid,started_at_ms,state) VALUES(?,?,?,?,?,?,?,'reconciling')").run(epoch,thread,'dead','111','222','333',1);
db.prepare("INSERT INTO archive_batches(batch_id,conversation_id,source,request_digest,outcomes_json,item_count,committed_at_ms,inserted_count,matched_count,ambiguous_count) VALUES(?,?,?,?,?,?,?,?,?,?)").run('batch',thread,'history','digest','[]',1,1,1,0,0);
db.prepare("INSERT INTO messages(conversation_id,server_message_id,sender_uid,from_self,text,kind,message_type,first_source,archived_at_ms) VALUES(?,?,?,?,?,?,?,?,?)").run(thread,'777', '333',0,'test','text',7,'history',1);
db.prepare("INSERT INTO reconcile_pages(epoch_id,page_no,batch_id,phase,returned_cursor,direction,has_more,raw_count,accepted_count,excluded_count,missing_id_count,ids_digest,ids_json,committed_at_ms) VALUES(?,0,?,'older','0','older',0,1,1,0,0,'hash','[]',1)").run(epoch,'batch');
process.kill(process.pid,'SIGKILL');
`;
 executeKilled(file,source);
 const after=EveArchive.open(file,identity);
 try{
  assert.deepEqual(after.counts(),{messages:0,uncertain:0,gaps:0,batches:0});
  assert.equal(after.knownConversations().length,0);
  assert.throws(()=>after.reconcileStats(epoch),/epoch_not_found/);
 }finally{after.close();}
}));
test('T4: SIGKILL verified COMMIT 后：锚点和页证据持久、重扫不重复资格',()=>fixture(file=>{
 executeKilled(file,initScript+`
archive.recordReconcilePage({epochId:${JSON.stringify(epoch)},pageNo:1,phase:'head_close',page});
process.kill(process.pid,'SIGKILL');
`);
 const archive=EveArchive.open(file,identity);
 try{
  assert.equal(archive.conversationState(thread),'verified');
  assert.equal(archive.getVerifiedAnchor(thread),'7701260499833538097');
  assert.equal(archive.reconcileStats(epoch).pages,2);
  assert.equal(archive.reconcileStats(epoch).eligible,0);
  const fresh='99999999-9999-4999-8999-999999999999';
  archive.beginEpoch({epochId:fresh,conversationId:thread,instanceId:'next-process',imUid:'222'});
  archive.recordReconcilePage({epochId:fresh,pageNo:0,phase:'older',page});
  archive.recordReconcilePage({epochId:fresh,pageNo:1,phase:'head_close',page});
  assert.equal(archive.reconcileStats(fresh).eligible,0);
  assert.equal(archive.counts().messages,1);
 }finally{archive.close();}
}));
