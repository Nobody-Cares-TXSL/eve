import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,symlinkSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EveArchive} from '../../src/archive/store.ts';
const identity={ownerUid:'111',targetUid:'333',ownUids:['111','222']};
test('future schema 拒绝，版本和现有数据保持不变',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t3-future-'));
 try{
  const file=join(dir,'eve.sqlite');const a=EveArchive.open(file,identity);a.close();
  const raw=new DatabaseSync(file);raw.exec('PRAGMA user_version=99');raw.close();
  assert.throws(()=>EveArchive.open(file,identity),/schema_unsupported/);
  const check=new DatabaseSync(file);
  assert.equal((check.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,99);
  check.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('数据库路径和 WAL/SHM 不允许使用符号链接，包括悬空链接',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t3-links-'));
 try{
  const outside=join(dir,'outside'),target=join(dir,'child','eve.sqlite');
  writeFileSync(outside,'original');
  const sub=join(dir,'child');const fs=requireFs();fs.mkdirSync(sub);
  symlinkSync(outside,target);
  assert.throws(()=>EveArchive.open(target,identity),/unsafe_path/);
  fs.unlinkSync(target);symlinkSync(join(dir,'missing'),target);
  assert.throws(()=>EveArchive.open(target,identity),/unsafe_path/);
  fs.unlinkSync(target);symlinkSync(outside,target+'-wal');
  assert.throws(()=>EveArchive.open(target,identity),/unsafe_path/);
  assert.equal(readFileSync(outside,'utf8'),'original');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
import * as fs from 'node:fs';
function requireFs(){return fs;}

test('空白 v0 数据库可以事务升级至 v1，未知旧库拒绝升级',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t3-v0-'));
 try{
  const blank=join(dir,'blank.sqlite');
  const init=new DatabaseSync(blank);init.close();
  const archive=EveArchive.open(blank,identity);archive.close();
  const inspect=new DatabaseSync(blank);
  assert.equal((inspect.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,1);
  inspect.close();
  const foreign=join(dir,'foreign.sqlite');
  const raw=new DatabaseSync(foreign);raw.exec('CREATE TABLE private_old_table(secret TEXT)');raw.close();
  assert.throws(()=>EveArchive.open(foreign,identity),/schema_unsupported/);
  const reopened=new DatabaseSync(foreign);
  assert.equal((reopened.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,0);
  assert.ok(reopened.prepare("SELECT name FROM sqlite_master WHERE name='private_old_table'").get());
  reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('错误账号或更高版本在数据库预检阶段拒绝',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t3-preflight-'));
 try{
  const file=join(dir,'eve.sqlite');
  const a=EveArchive.open(file,identity);a.close();
  assert.throws(()=>EveArchive.open(file,{...identity,targetUid:'444'}),/account_mismatch/);
  const db=new DatabaseSync(file);db.exec('PRAGMA user_version=99');db.close();
  assert.throws(()=>EveArchive.open(file,identity),/schema_unsupported/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
