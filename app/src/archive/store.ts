import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,lstatSync,existsSync,chmodSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import type {InboundMessage} from '../platform/types.ts';
export interface ArchiveIdentity {ownerUid:string;targetUid:string;ownUids:readonly string[]}
export interface Batch {batchId:string;conversationId:string;source:'live'|'history';messages:readonly InboundMessage[];gapReason?:string}
export interface BatchResult {outcomes:readonly ('new'|'matched'|'ambiguous')[];replayed:boolean;requiresReconcile:true}
export class ArchiveError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const sql=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
function digest(r:Batch){return createHash('sha256').update(JSON.stringify([r.conversationId,r.source,r.gapReason??null,r.messages.map(m=>[m.conversationId,m.serverMessageId,m.clientMessageId,m.senderUid,m.fromSelf,m.text,m.kind,m.messageType,m.createTime,m.indexInConversation])])).digest('hex');}
export class EveArchive {
 private closed=false;
 private readonly db:DatabaseSync;
 private readonly identity:ArchiveIdentity;
 private constructor(db:DatabaseSync,identity:ArchiveIdentity){this.db=db;this.identity=identity;}
 static open(filename:string,i:ArchiveIdentity){
  if(!/^\d+$/.test(i.ownerUid)||!/^\d+$/.test(i.targetUid)||i.ownerUid===i.targetUid||!i.ownUids.includes(i.ownerUid)||i.ownUids.includes(i.targetUid)||!i.ownUids.every(x=>/^\d+$/.test(x)))throw new ArchiveError('identity_invalid');
  const path=resolve(filename),dir=dirname(path);
  const checked=(file:string,isDir:boolean):boolean=>{
    try{
      const st=lstatSync(file);
      if(st.isSymbolicLink()||(isDir?!st.isDirectory():!st.isFile()))throw new ArchiveError('unsafe_path');
      return true;
    }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
  };
  // Reject symlink ancestors, including a dangling symlink in the requested directory.
  let part=dir;
  const ancestors:string[]=[];
  while(part!==dirname(part)){ancestors.push(part);part=dirname(part);}
  for(const ancestor of ancestors.reverse()) checked(ancestor,true);
  mkdirSync(dir,{recursive:true,mode:0o700});
  checked(dir,true);
  const fresh=!checked(path,false);
  // Check SQLite sidecar paths before opening, not after a malicious symlink can be followed.
  checked(path+'-wal',false);checked(path+'-shm',false);
  chmodSync(dir,0o700);
  if(fresh){const fd=openSync(path,'wx',0o600);closeSync(fd);}
  chmodSync(path,0o600);
  const db=new DatabaseSync(path);
  try{
   db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000');
   const version=(db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
   if(version!==0&&version!==1)throw new ArchiveError('schema_unsupported');
   if(version===0){
    // SQLite user_version 0 has no versioned Eve schema. Only an EMPTY
    // pre-existing SQLite DB may safely initialize as v1.
    const count=(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as {n:number}).n;
    if(count!==0)throw new ArchiveError('schema_unsupported');
   }else{
    const meta=db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1').get() as {schema_version:number;owner_uid:string;target_uid:string}|undefined;
    if(!meta||meta.schema_version!==1)throw new ArchiveError('schema_unsupported');
    if(meta.owner_uid!==i.ownerUid||meta.target_uid!==i.targetUid)throw new ArchiveError('account_mismatch');
    const integrity=(db.prepare('PRAGMA quick_check').get() as {quick_check:string}).quick_check;
    if(integrity!=='ok')throw new ArchiveError('database_corrupt');
   }
   // Do not activate WAL/create sidecars before account+schema preflight.
   db.exec('PRAGMA journal_mode=WAL');
   db.exec('BEGIN IMMEDIATE');
   try{
    if(version===0){
     if(!sql)throw new ArchiveError('schema_missing');
     db.exec(sql);
     db.prepare('INSERT INTO archive_meta VALUES(1,1,?,?,?)').run(i.ownerUid,i.targetUid,Date.now());
     db.exec('PRAGMA user_version=1');
    }
    const meta=db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1').get() as {schema_version:number;owner_uid:string;target_uid:string}|undefined;
    if(!meta||meta.schema_version!==1)throw new ArchiveError('schema_unsupported');
    if(meta.owner_uid!==i.ownerUid||meta.target_uid!==i.targetUid)throw new ArchiveError('account_mismatch');
    db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   for(const ext of ['','-wal','-shm']){
    const sidecar=path+ext;
    if(checked(sidecar,false))chmodSync(sidecar,0o600);
   }
   return new EveArchive(db,{...i,ownUids:[...i.ownUids]});
  }catch(e){db.close();throw e;}
 }
 private check(){if(this.closed)throw new ArchiveError('closed');}
 close(){if(!this.closed){this.closed=true;this.db.close();}}
 private valid(r:Batch,m:InboundMessage){
  const own=new Set(this.identity.ownUids),parts=r.conversationId.split(':');
  return parts.length===4&&parts[0]==='0'&&parts[1]==='1'&&
   ((own.has(parts[2]??'')&&parts[3]===this.identity.targetUid)||(own.has(parts[3]??'')&&parts[2]===this.identity.targetUid))&&
   m.conversationId===r.conversationId&&(own.has(m.senderUid)||m.senderUid===this.identity.targetUid)&&m.fromSelf===own.has(m.senderUid)&&
   typeof m.text==='string'&&['text','non_text'].includes(m.kind)&&Number.isInteger(m.messageType)&&
   (m.serverMessageId===null||(typeof m.serverMessageId==='string'&&m.serverMessageId.length>0));
 }
 archiveBatch(r:Batch,failAt=-1):BatchResult{
  this.check();
  if(!r.batchId||!r.conversationId||!['live','history'].includes(r.source)||!Array.isArray(r.messages)||r.messages.some(m=>!this.valid(r,m)))throw new ArchiveError('rejected');
  if(r.gapReason!==undefined&&(!r.gapReason||r.gapReason.length>100))throw new ArchiveError('invalid_gap');
  const hash=digest(r);this.db.exec('BEGIN IMMEDIATE');
  try{
   const prior=this.db.prepare('SELECT request_digest,outcomes_json FROM archive_batches WHERE batch_id=?').get(r.batchId) as {request_digest:string;outcomes_json:string}|undefined;
   if(prior){
    if(prior.request_digest!==hash)throw new ArchiveError('batch_conflict');
    this.db.exec('COMMIT');
    return {replayed:true,requiresReconcile:true,outcomes:JSON.parse(prior.outcomes_json) as ('new'|'matched'|'ambiguous')[]};
   }
   const now=Date.now(),outcomes:('new'|'matched'|'ambiguous')[]=[];
   this.db.prepare('INSERT INTO conversations(conversation_id,updated_at_ms) VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms').run(r.conversationId,now);
   for(let idx=0;idx<r.messages.length;idx++){
    if(idx===failAt)throw new ArchiveError('injected_failure');const m=r.messages[idx]!;
    if(m.serverMessageId===null){
     this.db.prepare('INSERT INTO uncertain_messages(conversation_id,client_message_id,sender_uid,from_self,text,kind,message_type,create_time,index_in_conversation,source,batch_id,reason,archived_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.conversationId,m.clientMessageId,m.senderUid,Number(m.fromSelf),m.text,m.kind,m.messageType,m.createTime,m.indexInConversation,r.source,r.batchId,'missing_server_id',now);
     outcomes.push('ambiguous');continue;
    }
    const old=this.db.prepare('SELECT sender_uid,from_self,text,kind,message_type,create_time FROM messages WHERE conversation_id=? AND server_message_id=?').get(r.conversationId,m.serverMessageId) as {sender_uid:string;from_self:number;text:string;kind:string;message_type:number;create_time:string|null}|undefined;
    if(old){
     if(old.sender_uid!==m.senderUid||old.from_self!==Number(m.fromSelf)||old.text!==m.text||old.kind!==m.kind||old.message_type!==m.messageType||(old.create_time!==null&&m.createTime!==null&&old.create_time!==m.createTime))throw new ArchiveError('message_conflict');
     outcomes.push('matched');continue;
    }
    this.db.prepare('INSERT INTO messages(conversation_id,server_message_id,client_message_id,sender_uid,from_self,text,kind,message_type,create_time,index_in_conversation,first_source,archived_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
     .run(r.conversationId,m.serverMessageId,m.clientMessageId,m.senderUid,Number(m.fromSelf),m.text,m.kind,m.messageType,m.createTime,m.indexInConversation,r.source,now);
    outcomes.push('new');
   }
   if(r.gapReason){this.db.prepare('INSERT INTO archive_gaps(conversation_id,reason,detected_at_ms) VALUES(?,?,?)').run(r.conversationId,r.gapReason,now);this.db.prepare("UPDATE conversations SET sync_state='gap' WHERE conversation_id=?").run(r.conversationId);}
   else if(outcomes.includes('ambiguous'))this.db.prepare("UPDATE conversations SET sync_state=CASE WHEN sync_state='gap' THEN 'gap' ELSE 'ambiguous' END WHERE conversation_id=?").run(r.conversationId);
   this.db.prepare('INSERT INTO archive_batches(batch_id,conversation_id,source,request_digest,outcomes_json,item_count,committed_at_ms,inserted_count,matched_count,ambiguous_count) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(r.batchId,r.conversationId,r.source,hash,JSON.stringify(outcomes),outcomes.length,now,outcomes.filter(x=>x==='new').length,outcomes.filter(x=>x==='matched').length,outcomes.filter(x=>x==='ambiguous').length);
   this.db.exec('COMMIT');return {outcomes,replayed:false,requiresReconcile:true};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 counts(){this.check();const get=(table:string)=>Number((this.db.prepare('SELECT COUNT(*) n FROM '+table).get() as {n:number}).n);return {messages:get('messages'),uncertain:get('uncertain_messages'),gaps:get('archive_gaps'),batches:get('archive_batches')};}
 conversationState(id:string){this.check();return (this.db.prepare('SELECT sync_state FROM conversations WHERE conversation_id=?').get(id) as {sync_state:string}|undefined)?.sync_state??null;}
}
