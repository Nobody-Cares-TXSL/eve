import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EveArchive} from '../../src/archive/store.ts';
import type {InboundMessage} from '../../src/platform/types.ts';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
const thread='0:1:222:333';
const message:InboundMessage={conversationId:thread,serverMessageId:'7701260499833538097',
 clientMessageId:null,senderUid:'333',fromSelf:false,text:'fixture',kind:'text',messageType:7,
 createTime:'1793089447000',indexInConversation:null};
function version(file:string){
 const db=new DatabaseSync(file);
 try{
  const pragma=(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  const meta=(db.prepare('SELECT schema_version FROM archive_meta WHERE singleton=1').get() as {schema_version:number}).schema_version;
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'reconcile_%' OR type='table' AND name='eligible_events'").all() as {name:string}[]).map(x=>x.name);
  return {pragma,meta,tables};
 }finally{db.close();}
}
test('T4-2 v1 → v2 无损迁移且不自动升级、不重复迁移',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-v2-'));
 const file=join(dir,'eve.sqlite');
 try{
  let a=EveArchive.open(file,identity);
  a.archiveBatch({batchId:'old',conversationId:thread,source:'live',messages:[message]});
  assert.deepEqual(version(file),{pragma:1,meta:1,tables:[]});
  a.upgradeToV2();
  assert.deepEqual(version(file),{pragma:2,meta:2,tables:['reconcile_epochs','reconcile_pages','eligible_events']});
  assert.equal(a.counts().messages,1);
  a.upgradeToV2();
  a.close();
  a=EveArchive.open(file,identity);
  assert.equal(a.counts().messages,1);
  assert.deepEqual(a.archiveBatch({batchId:'new',conversationId:thread,source:'history',messages:[message]}).outcomes,['matched']);
  a.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('T4-2 事务注入失败回滚全部 v2 DDL、保持 v1 消息',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-fault-'));
 const file=join(dir,'eve.sqlite');
 try{
  const a=EveArchive.open(file,identity);
  a.archiveBatch({batchId:'first',conversationId:thread,source:'live',messages:[message]});
  assert.throws(()=>a.upgradeToV2(true),/migration_injected_failure/);
  assert.deepEqual(version(file),{pragma:1,meta:1,tables:[]});
  assert.equal(a.counts().messages,1);
  a.upgradeToV2();
  a.close();
  assert.deepEqual(version(file),{pragma:2,meta:2,tables:['reconcile_epochs','reconcile_pages','eligible_events']});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
