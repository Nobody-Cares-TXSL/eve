import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,lstatSync,existsSync,chmodSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import type {InboundMessage,HistoryPage} from '../platform/types.ts';
export interface ArchiveIdentity {ownerUid:string;targetUid:string;ownUids:readonly string[]}
export interface Batch {batchId:string;conversationId:string;source:'live'|'history';messages:readonly InboundMessage[];gapReason?:string}
export interface BatchResult {outcomes:readonly ('new'|'matched'|'ambiguous')[];replayed:boolean;requiresReconcile:true}
export class ArchiveError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const sql=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
const sqlV2=readFileSync(new URL('./schema-v2.sql',import.meta.url),'utf8');
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
   if(version!==0&&version!==1&&version!==2)throw new ArchiveError('schema_unsupported');
   if(version===0){
    // SQLite user_version 0 has no versioned Eve schema. Only an EMPTY
    // pre-existing SQLite DB may safely initialize as v1.
    const count=(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as {n:number}).n;
    if(count!==0)throw new ArchiveError('schema_unsupported');
   }else{
    const meta=db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1').get() as {schema_version:number;owner_uid:string;target_uid:string}|undefined;
    if(!meta||meta.schema_version!==version)throw new ArchiveError('schema_unsupported');
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
    if(!meta||meta.schema_version!==(version===0?1:version))throw new ArchiveError('schema_unsupported');
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
 /** T4-only explicit migration: no implicit mutation of a T3 v1 archive. */
 upgradeToV2(injectFailure=false):void{
  this.check();
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version===2)return;
  if(version!==1)throw new ArchiveError('schema_unsupported');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.exec(sqlV2);
   if(injectFailure)throw new ArchiveError('migration_injected_failure');
   this.db.exec('UPDATE archive_meta SET schema_version=2 WHERE singleton=1');
   this.db.exec('PRAGMA user_version=2');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
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
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const result=this.archiveBatchInTransaction(r,failAt);
   this.db.exec('COMMIT');return result;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private archiveBatchInTransaction(r:Batch,failAt=-1):BatchResult{
  this.check();
  if(!r.batchId||!r.conversationId||!['live','history'].includes(r.source)||!Array.isArray(r.messages)||r.messages.some(m=>!this.valid(r,m)))throw new ArchiveError('rejected');
  if(r.gapReason!==undefined&&(!r.gapReason||r.gapReason.length>100))throw new ArchiveError('invalid_gap');
  const hash=digest(r);
  {
   const prior=this.db.prepare('SELECT request_digest,outcomes_json FROM archive_batches WHERE batch_id=?').get(r.batchId) as {request_digest:string;outcomes_json:string}|undefined;
   if(prior){
    if(prior.request_digest!==hash)throw new ArchiveError('batch_conflict');
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
   return {outcomes,replayed:false,requiresReconcile:true};
  }
 }
  private requireV2():void{
    this.check();
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(version!==2)throw new ArchiveError('reconcile_requires_v2');
  }
  private validThread(thread:string):boolean {
    const p=thread.split(':'), own=new Set(this.identity.ownUids);
    return p.length===4&&p[0]==='0'&&p[1]==='1'&&
      ((own.has(p[2]??'')&&p[3]===this.identity.targetUid)||
       (own.has(p[3]??'')&&p[2]===this.identity.targetUid));
  }
  /** Clears CURRENT eligibility gate without deleting last proven anchor or archived events. */
  invalidateCurrentCoverage():void{
    this.requireV2();
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const now=Date.now();
      this.db.prepare("UPDATE reconcile_epochs SET state='cancelled',reason_code='runtime_invalidated',completed_at_ms=? WHERE state='reconciling'").run(now);
      this.db.prepare("UPDATE conversations SET sync_state='unverified',updated_at_ms=? WHERE sync_state IN ('verified','reconciling')").run(now);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  getVerifiedAnchor(thread:string):string|null{
    this.requireV2();
    if(!this.validThread(thread))throw new ArchiveError('rejected');
    const row=this.db.prepare('SELECT verified_anchor_id FROM conversations WHERE conversation_id=?')
      .get(thread) as {verified_anchor_id:string|null}|undefined;
    return row?.verified_anchor_id??null;
  }
  beginEpoch(input:{epochId:string;conversationId:string;instanceId:string;imUid:string}):string|null{
    this.requireV2();
    const {epochId,conversationId,instanceId,imUid}=input;
    if(!/^[a-f0-9-]{36}$/.test(epochId)||!instanceId||!this.validThread(conversationId)||
       !this.identity.ownUids.includes(imUid))throw new ArchiveError('epoch_invalid');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const concurrent=this.db.prepare("SELECT instance_id FROM reconcile_epochs WHERE conversation_id=? AND state='reconciling'")
        .all(conversationId) as {instance_id:string}[];
      if(concurrent.some(c=>c.instance_id===instanceId))throw new ArchiveError('epoch_in_progress');
      this.db.prepare("UPDATE reconcile_epochs SET state='cancelled',reason_code='superseded',completed_at_ms=? WHERE conversation_id=? AND state='reconciling'")
        .run(Date.now(),conversationId);
      this.db.prepare('INSERT INTO conversations(conversation_id,updated_at_ms) VALUES(?,?) ON CONFLICT(conversation_id) DO NOTHING')
        .run(conversationId,Date.now());
      const anchor=(this.db.prepare('SELECT verified_anchor_id FROM conversations WHERE conversation_id=?')
        .get(conversationId) as {verified_anchor_id:string|null}).verified_anchor_id;
      this.db.prepare("UPDATE conversations SET sync_state='reconciling',updated_at_ms=? WHERE conversation_id=?")
        .run(Date.now(),conversationId);
      this.db.prepare("INSERT INTO reconcile_epochs(epoch_id,conversation_id,instance_id,owner_uid,im_uid,target_uid,started_at_ms,old_anchor_id,state) VALUES(?,?,?,?,?,?,?,?,'reconciling')")
        .run(epochId,conversationId,instanceId,this.identity.ownerUid,imUid,this.identity.targetUid,Date.now(),anchor);
      this.db.exec('COMMIT');
      return anchor;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  failEpoch(epochId:string,code:string):void{
    this.requireV2();
    if(!/^[a-z0-9_]{3,80}$/.test(code))throw new ArchiveError('bad_reason');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const ep=this.db.prepare("SELECT conversation_id,state FROM reconcile_epochs WHERE epoch_id=?")
        .get(epochId) as {conversation_id:string;state:string}|undefined;
      if(!ep){throw new ArchiveError('epoch_not_found');}
      if(ep.state==='reconciling'){
        this.db.prepare("UPDATE reconcile_epochs SET state='gap',reason_code=?,completed_at_ms=? WHERE epoch_id=?")
          .run(code,Date.now(),epochId);
        this.db.prepare("UPDATE conversations SET sync_state='gap',updated_at_ms=? WHERE conversation_id=?")
          .run(Date.now(),ep.conversation_id);
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  recordReconcilePage(input:{
    epochId:string;pageNo:number;phase:'older'|'head_close';page:HistoryPage;
  },injectBeforeCommit=false):{verified:boolean;replayed:boolean}{
    this.requireV2();
    const {epochId,pageNo,phase,page}=input;
    if(!Number.isSafeInteger(pageNo)||pageNo<0||page.statusCode!==0||page.direction!=='older'||
       page.requestedDirection!=='older'||page.excludedCount!==0||page.missingIdCount!==0||
       page.rawCount!==page.acceptedCount+page.excludedCount||
       page.acceptedCount!==page.messages.length||
       Object.values(page.exclusions).reduce((a,b)=>a+b,0)!==page.excludedCount||
       page.messages.some(m=>!m.serverMessageId)||
       typeof page.cursor!=='string'||typeof page.hasMore!=='boolean')
      throw new ArchiveError('page_unverifiable');
    const ids=page.messages.map(m=>m.serverMessageId!);
    if(new Set(ids).size!==ids.length)throw new ArchiveError('duplicate_page_ids');
    const idsJson=JSON.stringify(ids),idsDigest=createHash('sha256').update(idsJson).digest('hex');
    const batchId=epochId+':'+pageNo;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const ep=this.db.prepare("SELECT conversation_id,state,owner_uid,im_uid,target_uid FROM reconcile_epochs WHERE epoch_id=?")
        .get(epochId) as {conversation_id:string;state:string;owner_uid:string;im_uid:string;target_uid:string}|undefined;
      if(!ep||ep.state!=='reconciling'||ep.owner_uid!==this.identity.ownerUid||
         ep.target_uid!==this.identity.targetUid||!this.identity.ownUids.includes(ep.im_uid))
        throw new ArchiveError('epoch_stale');
      const previous=this.db.prepare('SELECT page_no,phase,returned_cursor,has_more FROM reconcile_pages WHERE epoch_id=? ORDER BY page_no DESC LIMIT 1')
        .get(epochId) as {page_no:number;phase:string;returned_cursor:string;has_more:number}|undefined;
      if(pageNo!==(previous?previous.page_no+1:0)||previous?.phase==='head_close'||
         (phase==='head_close'&&(!previous||page.requestedCursor!==null))||
         (phase==='older'&&page.requestedCursor!==(previous?previous.returned_cursor:null))||
         (phase==='older'&&previous?.has_more===0))
        throw new ArchiveError('page_chain_invalid');
      if(phase==='older'&&page.hasMore&&(page.cursor===page.requestedCursor||page.cursor.length===0))
        throw new ArchiveError('cursor_not_advancing');
      const items=this.archiveBatchInTransaction({
        batchId,conversationId:ep.conversation_id,source:'history',messages:page.messages,
      });
      this.db.prepare('INSERT INTO reconcile_pages(epoch_id,page_no,batch_id,phase,requested_cursor,returned_cursor,direction,has_more,raw_count,accepted_count,excluded_count,missing_id_count,ids_digest,ids_json,committed_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(epochId,pageNo,batchId,phase,page.requestedCursor,page.cursor,page.direction,Number(page.hasMore),
          page.rawCount,page.acceptedCount,page.excludedCount,page.missingIdCount,idsDigest,idsJson,Date.now());
      let verified=false;
      if(phase==='head_close') {this.finalizeEpochInTransaction(epochId);verified=true;}
      // Failure here is after the proof and eligibility writes, but before COMMIT.
      if(injectBeforeCommit)throw new ArchiveError('reconcile_page_injected_failure');
      this.db.exec('COMMIT');return {verified,replayed:items.replayed};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  private finalizeEpochInTransaction(epochId:string):void{
    const ep=this.db.prepare("SELECT conversation_id,state,old_anchor_id FROM reconcile_epochs WHERE epoch_id=?")
      .get(epochId) as {conversation_id:string;state:string;old_anchor_id:string|null}|undefined;
    if(!ep||ep.state!=='reconciling')throw new ArchiveError('epoch_stale');
    const pages=this.db.prepare('SELECT page_no,phase,requested_cursor,returned_cursor,has_more,raw_count,accepted_count,excluded_count,missing_id_count,ids_digest,ids_json FROM reconcile_pages WHERE epoch_id=? ORDER BY page_no')
      .all(epochId) as {page_no:number;phase:string;requested_cursor:string|null;returned_cursor:string;has_more:number;raw_count:number;accepted_count:number;excluded_count:number;missing_id_count:number;ids_digest:string;ids_json:string}[];
    if(pages.length<2||pages[0]?.phase!=='older'||pages.at(-1)?.phase!=='head_close')
      throw new ArchiveError('proof_incomplete');
    const older=pages.slice(0,-1),close=pages.at(-1)!;
    const ids=(p:typeof close):string[]=>{
      const arr:unknown=JSON.parse(p.ids_json);
      if(!Array.isArray(arr)||!arr.every(x=>typeof x==='string'&&x.length>0)||
         createHash('sha256').update(p.ids_json).digest('hex')!==p.ids_digest||
         arr.length!==p.accepted_count||p.accepted_count!==p.raw_count||
         p.excluded_count!==0||p.missing_id_count!==0)throw new ArchiveError('proof_incomplete');
      return arr as string[];
    };
    const firstIds=ids(older[0]!);
    if(firstIds.length===0)throw new ArchiveError('empty_history_unverifiable');
    if(JSON.stringify(ids(close))!==JSON.stringify(firstIds)||close.requested_cursor!==null||
       close.returned_cursor!==older[0]!.returned_cursor||close.has_more!==older[0]!.has_more)
      throw new ArchiveError('head_not_closed');
    let anchorFound=false,seenEnd=false;
    const newIds:string[]=[];
    const visited=new Set<string>();
    for(let n=0;n<older.length;n++){
      const p=older[n]!,current=ids(p);
      if(p.phase!=='older'||p.page_no!==n||
         p.requested_cursor!==(n===0?null:older[n-1]!.returned_cursor)||
         (n>0&&older[n-1]!.has_more===0))
        throw new ArchiveError('proof_incomplete');
      const req=p.requested_cursor;
      if(p.has_more===1&&(p.returned_cursor===req||visited.has(p.returned_cursor)))
        throw new ArchiveError('cursor_not_advancing');
      visited.add(p.returned_cursor);
      if(!anchorFound){
        for(const id of [...current].reverse()){
          if(id===ep.old_anchor_id){anchorFound=true;break;}
          newIds.push(id);
        }
      }
      if(p.has_more===0)seenEnd=true;
    }
    if(ep.old_anchor_id?!anchorFound:!seenEnd)throw new ArchiveError('anchor_not_covered');
    const bad=this.db.prepare("SELECT (SELECT COUNT(*) FROM uncertain_messages WHERE conversation_id=? AND status='pending') AS uncertain,(SELECT COUNT(*) FROM archive_gaps WHERE conversation_id=? AND resolved_at_ms IS NULL) AS gaps")
      .get(ep.conversation_id,ep.conversation_id) as {uncertain:number;gaps:number};
    if(bad.uncertain||bad.gaps)throw new ArchiveError('unresolved_uncertainty');
    const newAnchor=firstIds.at(-1)!;
    if(ep.old_anchor_id){
      const unique=new Set(newIds);
      for(const id of unique){
        const m=this.db.prepare('SELECT sender_uid,kind,text FROM messages WHERE conversation_id=? AND server_message_id=?')
          .get(ep.conversation_id,id) as {sender_uid:string;kind:string;text:string}|undefined;
        if(m&&m.sender_uid===this.identity.targetUid&&m.kind==='text'&&m.text.length>0){
          this.db.prepare('INSERT OR IGNORE INTO eligible_events(conversation_id,server_message_id,epoch_id,eligible_at_ms) VALUES(?,?,?,?)')
            .run(ep.conversation_id,id,epochId,Date.now());
        }
      }
    }
    this.db.prepare("UPDATE reconcile_epochs SET state='verified',new_anchor_id=?,completed_at_ms=? WHERE epoch_id=?")
      .run(newAnchor,Date.now(),epochId);
    this.db.prepare("UPDATE conversations SET sync_state='verified',verified_anchor_id=?,last_verified_at_ms=?,updated_at_ms=? WHERE conversation_id=?")
      .run(newAnchor,Date.now(),Date.now(),ep.conversation_id);
  }
  reconcileStats(epochId:string):{state:string;pages:number;eligible:number;anchor:string|null}{
    this.requireV2();
    const ep=this.db.prepare('SELECT state,conversation_id FROM reconcile_epochs WHERE epoch_id=?')
      .get(epochId) as {state:string;conversation_id:string}|undefined;
    if(!ep)throw new ArchiveError('epoch_not_found');
    const pages=(this.db.prepare('SELECT COUNT(*) n FROM reconcile_pages WHERE epoch_id=?').get(epochId) as {n:number}).n;
    const eligible=(this.db.prepare('SELECT COUNT(*) n FROM eligible_events WHERE epoch_id=?').get(epochId) as {n:number}).n;
    return {state:ep.state,pages,eligible,anchor:this.getVerifiedAnchor(ep.conversation_id)};
  }
 counts(){this.check();const get=(table:string)=>Number((this.db.prepare('SELECT COUNT(*) n FROM '+table).get() as {n:number}).n);return {messages:get('messages'),uncertain:get('uncertain_messages'),gaps:get('archive_gaps'),batches:get('archive_batches')};}
 knownConversations():readonly string[]{
  this.check();
  const rows=this.db.prepare('SELECT conversation_id FROM conversations ORDER BY conversation_id').all() as {conversation_id:string}[];
  return rows.map(x=>x.conversation_id).filter(id=>this.validThread(id));
 }
 conversationState(id:string){this.check();return (this.db.prepare('SELECT sync_state FROM conversations WHERE conversation_id=?').get(id) as {sync_state:string}|undefined)?.sync_state??null;}
}
