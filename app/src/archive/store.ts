import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,lstatSync,existsSync,chmodSync,openSync,closeSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {InboundMessage,HistoryPage} from '../platform/types.ts';
import type {AiDecision} from '../ai/contracts.ts';
// 纯函数、无 I/O、无反向依赖：仅用于在事务内做发送策略判定。
import {evaluateSendIntent} from '../send/policy.ts';
import type {SendRejectCode} from '../send/policy.ts';
/** 当前程序支持的最高 schema 版本；所有「版本区间」判断都应引用它。 */
export const MAX_SCHEMA_VERSION=5;

export type HandoffBlockReason='claim_inactive'|'coverage_changed'|'source_invalid'|'storage_unavailable'|'policy_invalid';
export type HandoffNoIntentReason='not_reply'|'already_finalized'|SendRejectCode;
export type HandoffResult=
 |{readonly status:'recorded_no_intent';readonly reasonCode:HandoffNoIntentReason}
 |{readonly status:'recorded_pending';readonly intentId:string;readonly notBeforeMs:number;readonly expiresAtMs:number}
 |{readonly status:'blocked';readonly reasonCode:HandoffBlockReason};

export interface ArchiveIdentity {ownerUid:string;targetUid:string;ownUids:readonly string[]}
export interface Batch {batchId:string;conversationId:string;source:'live'|'history';messages:readonly InboundMessage[];gapReason?:string}
export interface BatchResult {outcomes:readonly ('new'|'matched'|'ambiguous')[];replayed:boolean;requiresReconcile:true}
export interface AiCallPolicy {
 readonly maxPerHour?:number;
 readonly maxPerDay?:number;
 readonly minIntervalMs?:number;
 readonly failureCooldownMs?:number;
}
export interface DryRunCandidate {
 readonly eventId:string;
 readonly eventIds:readonly string[];
 readonly turns:readonly {role:'user'|'assistant';text:string}[];
}

export class ArchiveError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;}}
const sql=readFileSync(new URL('./schema.sql',import.meta.url),'utf8');
const sqlV2=readFileSync(new URL('./schema-v2.sql',import.meta.url),'utf8');
const sqlV3=readFileSync(new URL('./schema-v3.sql',import.meta.url),'utf8');
const sqlV4=readFileSync(new URL('./schema-v4.sql',import.meta.url),'utf8');
const sqlV5=readFileSync(new URL('./schema-v5.sql',import.meta.url),'utf8');
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
   if(version!==0&&version!==1&&version!==2&&version!==3&&version!==4&&version!==5)throw new ArchiveError('schema_unsupported');
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
  if(version>=2&&version<=5)return;
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
 /** T5 explicit migration: only invoke on a backed-up, authorized database. */
 upgradeToV3(injectFailure=false):void{
  this.check();
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version>=3&&version<=5)return;
  if(version!==2)throw new ArchiveError('migration_requires_v2');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.exec(sqlV3);
   if(injectFailure)throw new ArchiveError('migration_injected_failure');
   this.db.exec('UPDATE archive_meta SET schema_version=3 WHERE singleton=1');
   this.db.exec('PRAGMA user_version=3');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** T6 explicit migration: only invoke on a backed-up, authorized database. */
 upgradeToV4(injectFailure=false):void{
  this.check();
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version===4||version===5)return;
  if(version!==3)throw new ArchiveError('migration_requires_v3');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.exec(sqlV4);
   if(injectFailure)throw new ArchiveError('migration_injected_failure');
   this.db.exec('UPDATE archive_meta SET schema_version=4 WHERE singleton=1');
   this.db.exec('PRAGMA user_version=4');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private requireV3():void{
  this.check();
  if((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version<3)
   throw new ArchiveError('ai_requires_v3');
 }
 private requireV4():void{
  this.check();
  if((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version<4)
   throw new ArchiveError('send_requires_v4');
 }
 /** T6-3a explicit migration: handoff binding + not_before_ms. */
 upgradeToV5(injectFailure=false):void{
  this.check();
  const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
  if(version===5)return;
  if(version!==4)throw new ArchiveError('migration_requires_v4');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.exec(sqlV5);
   if(injectFailure)throw new ArchiveError('migration_injected_failure');
   this.db.exec('UPDATE archive_meta SET schema_version=5 WHERE singleton=1');
   this.db.exec('PRAGMA user_version=5');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 private requireV5():void{
  this.check();
  if((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version!==5)
   throw new ArchiveError('handoff_requires_v5');
 }
 private schemaVersion():number{
  return (this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
 }

 /**
  * T6-2 offline composition only. Read authoritative send reservations.
  * 'unknown' consumes quota, because it might have reached the platform.
  * 'pending'/'dispatching' also consume quota conservatively; failed means
  * proven not sent. This is reservation time, not the SDK receipt time.
  */
 sendPolicySnapshot(conversationId:string,now:number):{
  priorIntents:readonly {conversationId:string;sourceEventId:string}[];
  recentSends:readonly number[];
 }{
  this.requireV4();
  if(!this.validThread(conversationId)||!Number.isSafeInteger(now))
   throw new ArchiveError('send_snapshot_rejected');
  const entries=this.db.prepare(
   'SELECT source_event_id,status,created_at_ms FROM send_intents WHERE conversation_id=?'
  ).all(conversationId) as {source_event_id:string;status:string;created_at_ms:number}[];
  if(entries.some(x=>x.created_at_ms>now))throw new ArchiveError('send_clock_rollback');
  return {
   priorIntents:entries.map(x=>({conversationId,sourceEventId:x.source_event_id})),
   recentSends:entries.filter(x=>x.status!=='failed'&&now-x.created_at_ms<86_400_000)
    .map(x=>x.created_at_ms),
  };
 }
 /** Explicit identity match to authenticated account + IM UID; never infer from thread text. */
 matchSendIdentity(input:{ownerUid:string;targetUid:string;ownImUid?:string}):boolean{
  this.requireV4();
  return input.ownerUid===this.identity.ownerUid&&
   input.targetUid===this.identity.targetUid&&
   (input.ownImUid===undefined||this.identity.ownUids.includes(input.ownImUid));
 }

 /** 终态码封闭集合：不接受任意字符串，避免审计里出现不可解释的状态。 */
 /** 明确「未发送」的失败原因 —— 只有这些才能进 failed。 */
 static readonly SEND_FAILURE_CODES=['rejected_before_dispatch','identity_changed','content_rejected','budget_blocked','platform_rejected','risk_controlled'] as const;
 /** 结果不确定（超时、断线、崩溃）只允许 unknown。 */
 static readonly SEND_UNKNOWN_CODES=['timeout','interrupted','ambiguous_result','transport_error'] as const;

 /**
  * T6-1b：保存经安全校验的发送意图。
  *
  * 幂等三重：intent_id 主键、UNIQUE(conversation_id, source_event_id)、
  * 以及 send_intent_events 的 (conversation_id, server_message_id) 主键——
  * 后者保证同一批合并消息不会被拆成多个意图。
  *
  * 正文写入独立表 send_text 并带过期时间；账本只留摘要。
  * 返回 created=false 时表示已存在，调用方不得据此再次发送。
  */
 saveSendIntent(input:{
  intentId:string;conversationId:string;sourceEventId:string;text:string;
  textDigest:string;decisionDigest:string;eventIds:readonly string[];
  now:number;retentionMs:number;failAtEvent?:number;
  expectedProofEpoch?:string;proofMaxAgeMs?:number;
  ratePolicy?:{minIntervalMs:number;maxPerHour:number;maxPerDay:number};
 }):{created:boolean;intentId:string;existingStatus?:string;conflict?:'duplicate_intent'|'duplicate_event'}{
  this.requireV4();
  if(!input.intentId||!input.conversationId||!input.sourceEventId||
     !Array.isArray(input.eventIds)||input.eventIds.length<1||
     new Set(input.eventIds).size!==input.eventIds.length||
     !Number.isSafeInteger(input.now)||!Number.isSafeInteger(input.retentionMs)||input.retentionMs<1)
   throw new ArchiveError('rejected');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   // The offline composition gate may provide a proof epoch. Recheck while
   // holding the same write transaction that creates the intent to close the
   // evaluate→persist proof-rotation race.
   if(input.expectedProofEpoch!==undefined&&
      (!input.proofMaxAgeMs||
       this.coverageEpoch(input.conversationId,input.proofMaxAgeMs)!==input.expectedProofEpoch))
    throw new ArchiveError('send_coverage_changed');
   const prior=this.db.prepare('SELECT intent_id,status FROM send_intents WHERE intent_id=? OR (conversation_id=? AND source_event_id=?)')
    .get(input.intentId,input.conversationId,input.sourceEventId) as {intent_id:string;status:string}|undefined;
   if(prior){this.db.exec('COMMIT');return {created:false,intentId:prior.intent_id,existingStatus:prior.status,conflict:'duplicate_intent'};}
   for(const id of input.eventIds){
    const taken=this.db.prepare('SELECT intent_id FROM send_intent_events WHERE conversation_id=? AND server_message_id=?')
     .get(input.conversationId,id) as {intent_id:string}|undefined;
    if(taken){this.db.exec('COMMIT');return {created:false,intentId:taken.intent_id,conflict:'duplicate_event'};}
   }
   // Only the trusted coordinator passes a proof epoch. Inside the same write
   // transaction, demand actual eligible messages of this exact conversation.
   // A caller-supplied numeric ID is NEVER proof of an eligible event.
   if(input.expectedProofEpoch!==undefined){
    const lookup=this.db.prepare(
     'SELECT e.state,m.sender_uid,m.from_self,m.kind,m.text '+
     'FROM eligible_events e JOIN messages m ON e.conversation_id=m.conversation_id '+
     'AND e.server_message_id=m.server_message_id '+
     'WHERE e.conversation_id=? AND e.server_message_id=?'
    );
    for(const id of input.eventIds){
     const row=lookup.get(input.conversationId,id) as {
      state:string;sender_uid:string;from_self:number;kind:string;text:string
     }|undefined;
     if(!row||row.state!=='pending'||row.sender_uid!==this.identity.targetUid||
        row.from_self!==0||row.kind!=='text'||!row.text.trim())
      throw new ArchiveError('invalid_event_group');
    }
    // Already AI-claimed groups may not be mixed, reshuffled, or split.
    const claimed=this.db.prepare(
     'SELECT claim_id,server_message_id FROM ai_batch_items '+
     'WHERE conversation_id=? AND server_message_id=?'
    );
    const assignments=input.eventIds.map(id=>claimed.get(input.conversationId,id) as {
     claim_id:string;server_message_id:string
    }|undefined);
    if(assignments.some(Boolean)){
     const claim=assignments[0]?.claim_id;
     if(!claim||assignments.some(x=>x?.claim_id!==claim))
      throw new ArchiveError('invalid_event_group');
     const entire=this.db.prepare(
      'SELECT server_message_id FROM ai_batch_items WHERE claim_id=? ORDER BY ordinal'
     ).all(claim) as {server_message_id:string}[];
     if(entire.length!==input.eventIds.length||
        entire.some((r,i)=>r.server_message_id!==input.eventIds[i]))
      throw new ArchiveError('invalid_event_group');
    }
   }
   if(input.ratePolicy){
    const p=input.ratePolicy;
    if(!Number.isSafeInteger(p.minIntervalMs)||p.minIntervalMs<0||
       !Number.isSafeInteger(p.maxPerHour)||p.maxPerHour<1||
       !Number.isSafeInteger(p.maxPerDay)||p.maxPerDay<1)
     throw new ArchiveError('invalid_send_rate_policy');
    // Recheck while BEGIN IMMEDIATE is held; a second worker cannot slip
    // through based on a stale read of the previous policy snapshot.
    const records=this.db.prepare(
     "SELECT created_at_ms FROM send_intents WHERE conversation_id=? AND status IN ('pending','dispatching','sent','unknown')"
    ).all(input.conversationId) as {created_at_ms:number}[];
    if(records.some(x=>x.created_at_ms>input.now))throw new ArchiveError('send_clock_rollback');
    if(records.some(x=>input.now-x.created_at_ms<p.minIntervalMs))
     throw new ArchiveError('send_min_interval');
    if(records.filter(x=>input.now-x.created_at_ms<3_600_000).length>=p.maxPerHour||
       records.filter(x=>input.now-x.created_at_ms<86_400_000).length>=p.maxPerDay)
     throw new ArchiveError('send_rate_limited');
   }
   this.db.prepare('INSERT INTO send_intents(intent_id,conversation_id,source_event_id,text_digest,decision_digest,status,attempt,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,0,?,?)')
    .run(input.intentId,input.conversationId,input.sourceEventId,input.textDigest,input.decisionDigest,'pending',input.now,input.now);
   this.db.prepare('INSERT INTO send_text(intent_id,body,created_at_ms,expires_at_ms) VALUES(?,?,?,?)')
    .run(input.intentId,input.text,input.now,input.now+input.retentionMs);
   input.eventIds.forEach((id,ordinal)=>{
    if(ordinal===input.failAtEvent)throw new ArchiveError('send_save_injected_failure');
    this.db.prepare('INSERT INTO send_intent_events(conversation_id,server_message_id,intent_id,ordinal) VALUES(?,?,?,?)')
     .run(input.conversationId,id,input.intentId,ordinal);
   });
   this.db.exec('COMMIT');
   return {created:true,intentId:input.intentId};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }

 /**
  * pending → dispatching 的唯一入口：条件更新，两个 Worker 不可能同时成功。
  * 返回 false 表示认领失败（已被认领或已是终态），调用方**不得发送**。
  */
 claimSendIntent(intentId:string,now:number):boolean{
  this.requireV4();
  if(!Number.isSafeInteger(now))throw new ArchiveError('rejected');
  // v5 起：未到 not_before_ms 的意图不得被认领（delayMs 必须真正生效）。
  // v4 行没有该列，保持原行为。
  const r=this.schemaVersion()>=5
   ?this.db.prepare("UPDATE send_intents SET status='dispatching',attempt=attempt+1,claimed_at_ms=?,updated_at_ms=? WHERE intent_id=? AND status='pending' AND (not_before_ms IS NULL OR not_before_ms<=?)")
    .run(now,now,intentId,now)
   :this.db.prepare("UPDATE send_intents SET status='dispatching',attempt=attempt+1,claimed_at_ms=?,updated_at_ms=? WHERE intent_id=? AND status='pending'")
    .run(now,now,intentId);
  return Number(r.changes)===1;
 }

 /**
  * dispatching → sent/failed/unknown。只允许从 dispatching 结算，终态不可再变。
  *
  * sent 必须有平台证据（回执 ID）；failed 必须是确定的「未发送」原因；
  * 超时/断线/崩溃只能 unknown。unknown 永不自动重试。
  */
 settleSendIntent(intentId:string,settle:{status:'sent';evidence:string}|{status:'failed'|'unknown';reasonCode:string},now:number):boolean{
  this.requireV4();
  if(!Number.isSafeInteger(now))throw new ArchiveError('rejected');
  let evidence:string|null=null,reason:string|null=null;
  if(settle.status==='sent'){
   if(typeof settle.evidence!=='string'||settle.evidence.trim()==='')
    throw new ArchiveError('sent_requires_evidence');
   evidence=settle.evidence;
  }else{
   const allowed:readonly string[]=settle.status==='failed'
    ?EveArchive.SEND_FAILURE_CODES:EveArchive.SEND_UNKNOWN_CODES;
   if(!allowed.includes(settle.reasonCode))throw new ArchiveError('invalid_reason_code');
   reason=settle.reasonCode;
  }
  const r=this.db.prepare("UPDATE send_intents SET status=?,reason_code=?,evidence=?,settled_at_ms=?,updated_at_ms=? WHERE intent_id=? AND status='dispatching'")
   .run(settle.status,reason,evidence,now,now,intentId);
  if(Number(r.changes)!==1)return false;
  // 终态即清理正文：账本保留摘要与证据供审计，正文不再可读。
  this.db.prepare('DELETE FROM send_text WHERE intent_id=?').run(intentId);
  return true;
 }

 /**
  * T6-3a：受信内部交接 —— T5 决策结算与 T6 发送意图入库在**同一个事务**内完成。
  *
  * 契约：docs/contracts/ai-send-handoff.md。
  * 只有 reply 且通过发送策略才写 send_text；skip/defer/被拒一律只写 recorded 审计。
  * 任何异常整体回滚，claim 保持 claimed，重启后由恢复流程标记 interrupted。
  */
 finalizeAiWithSend(input:{
  claimId:string;
  decision:AiDecision;
  identity:{ownerUid:string;targetUid:string;ownImUid?:string};
  runtime:{phase:string;paused:boolean};
  policy:{minIntervalMs:number;maxPerHour:number;maxPerDay:number;
   silence:{startMinute:number;endMinute:number};maxTextLength:number};
  now:number;
  coverageMaxAgeMs:number;
  bodyRetentionMs:number;
  failAfterWrites?:boolean;
 }):HandoffResult{
  try{this.requireV5();}catch{return {status:'blocked',reasonCode:'storage_unavailable'};}
  if(!Number.isSafeInteger(input.now)||!Number.isSafeInteger(input.coverageMaxAgeMs)||
     input.coverageMaxAgeMs<1||!Number.isSafeInteger(input.bodyRetentionMs)||
     input.bodyRetentionMs<1||input.bodyRetentionMs>3_600_000)
   return {status:'blocked',reasonCode:'policy_invalid'};
  if(!this.matchSendIdentity(input.identity))return {status:'blocked',reasonCode:'source_invalid'};

  const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const claim=this.db.prepare('SELECT claim_id,conversation_id,server_message_id,proof_epoch_id,state FROM ai_decision_attempts WHERE claim_id=?')
    .get(input.claimId) as {claim_id:string;conversation_id:string;server_message_id:string;proof_epoch_id:string;state:string}|undefined;
   if(!claim){this.db.exec('ROLLBACK');return {status:'blocked',reasonCode:'claim_inactive'};}

   // 重放：已终结的 claim 不得产生第二条意图，也不得覆盖旧正文
   if(claim.state!=='claimed'){
    const existing=this.db.prepare('SELECT intent_id,not_before_ms FROM send_intents WHERE ai_claim_id=?')
     .get(input.claimId) as {intent_id:string;not_before_ms:number|null}|undefined;
    const exp=existing?this.db.prepare('SELECT expires_at_ms FROM send_text WHERE intent_id=?')
     .get(existing.intent_id) as {expires_at_ms:number}|undefined:undefined;
    this.db.exec('ROLLBACK');
    if(existing&&existing.not_before_ms!==null)
     return {status:'recorded_pending',intentId:existing.intent_id,
      notBeforeMs:existing.not_before_ms,expiresAtMs:exp?.expires_at_ms??0};
    return {status:'recorded_no_intent',reasonCode:'already_finalized'};
   }

   // Proof 必须仍是该 claim 签发时的同一个 epoch
   if(this.coverageEpoch(claim.conversation_id,input.coverageMaxAgeMs)!==claim.proof_epoch_id)
    throw new ArchiveError('handoff_coverage_changed');

   // 事件组以数据库为准，绝不相信调用方
   const items=(this.db.prepare('SELECT server_message_id FROM ai_batch_items WHERE claim_id=? ORDER BY ordinal')
    .all(input.claimId) as {server_message_id:string}[]).map(r=>r.server_message_id);
   if(items.length<1)throw new ArchiveError('handoff_source_invalid');
   const elig=this.db.prepare('SELECT e.state,m.sender_uid,m.from_self,m.kind FROM eligible_events e '+
    'JOIN messages m ON e.conversation_id=m.conversation_id AND e.server_message_id=m.server_message_id '+
    'WHERE e.conversation_id=? AND e.server_message_id=?');
   for(const id of items){
    const x=elig.get(claim.conversation_id,id) as {state:string;sender_uid:string;from_self:number;kind:string}|undefined;
    if(!x||x.state!=='pending'||x.sender_uid!==this.identity.targetUid||
       x.from_self!==0||x.kind!=='text')throw new ArchiveError('handoff_source_invalid');
   }

   const decisionDigest=sha(JSON.stringify(input.decision));
   const replyLength=input.decision.action==='reply'?input.decision.text.length:0;
   const finish=()=>{
    const r=this.db.prepare("UPDATE ai_decision_attempts SET state='recorded',finished_at_ms=?,action=?,decision_digest=?,reply_length=?,failure_code=NULL WHERE claim_id=? AND state='claimed'")
     .run(input.now,input.decision.action,decisionDigest,replyLength,input.claimId);
    if(Number(r.changes)!==1)throw new ArchiveError('handoff_claim_inactive');
   };

   if(input.decision.action!=='reply'){
    finish();this.db.exec('COMMIT');
    return {status:'recorded_no_intent',reasonCode:'not_reply'};
   }

   const text=input.decision.text;
   const notBeforeMs=input.now+input.decision.delayMs;
   const expiresAtMs=input.now+input.bodyRetentionMs;
   if(!Number.isSafeInteger(notBeforeMs)||notBeforeMs>=expiresAtMs)
    throw new ArchiveError('handoff_policy_invalid');

   const snapshot=this.sendPolicySnapshot(claim.conversation_id,input.now);
   const coverage=this.coverageStatus(claim.conversation_id,input.coverageMaxAgeMs);
   const evaluation=evaluateSendIntent({
    decision:input.decision,conversationId:claim.conversation_id,
    sourceEventId:claim.server_message_id,identity:input.identity,
    coverage:{usable:coverage.usable,state:coverage.state},
    runtime:input.runtime,now:input.now,
    policy:{...input.policy,recentSends:snapshot.recentSends},
    priorIntents:snapshot.priorIntents,
   });
   if(!evaluation.ok){
    // 决策本身有效，仍要记账；只是不产生发送意图与正文
    finish();this.db.exec('COMMIT');
    return {status:'recorded_no_intent',reasonCode:evaluation.code};
   }

   const intentId=evaluation.intent.intentId;
   this.db.prepare('INSERT INTO send_intents(intent_id,conversation_id,source_event_id,text_digest,decision_digest,status,attempt,created_at_ms,updated_at_ms,ai_claim_id,not_before_ms) VALUES(?,?,?,?,?,?,0,?,?,?,?)')
    .run(intentId,claim.conversation_id,claim.server_message_id,
     sha(text),decisionDigest,'pending',input.now,input.now,input.claimId,notBeforeMs);
   this.db.prepare('INSERT INTO send_text(intent_id,body,created_at_ms,expires_at_ms) VALUES(?,?,?,?)')
    .run(intentId,text,input.now,expiresAtMs);
   items.forEach((id,ordinal)=>{
    this.db.prepare('INSERT INTO send_intent_events(conversation_id,server_message_id,intent_id,ordinal) VALUES(?,?,?,?)')
     .run(claim.conversation_id,id,intentId,ordinal);
   });
   if(input.failAfterWrites)throw new ArchiveError('handoff_injected_failure');
   finish();
   this.db.exec('COMMIT');
   return {status:'recorded_pending',intentId,notBeforeMs,expiresAtMs};
  }catch(e){
   this.db.exec('ROLLBACK');
   if(e instanceof ArchiveError){
    if(e.code==='handoff_coverage_changed')return {status:'blocked',reasonCode:'coverage_changed'};
    if(e.code==='handoff_source_invalid')return {status:'blocked',reasonCode:'source_invalid'};
    if(e.code==='handoff_policy_invalid')return {status:'blocked',reasonCode:'policy_invalid'};
    if(e.code==='handoff_claim_inactive')return {status:'blocked',reasonCode:'claim_inactive'};
    if(e.code==='handoff_injected_failure')return {status:'blocked',reasonCode:'storage_unavailable'};
   }
   return {status:'blocked',reasonCode:'storage_unavailable'};
  }
 }

 /**
  * T6-3c：发送执行前读取可信账本绑定。
  * 调用方不得自带会话/事件/摘要——一律以本方法返回的数据库事实为准。
  */
 sendDispatchBinding(intentId:string):{
  conversationId:string;sourceEventId:string;status:string;attempt:number;
  aiClaimId:string|null;notBeforeMs:number|null;decisionDigest:string;
  /** 账本保存的原始正文摘要：调用方必须用它校验正文，不得自行重算后自证。 */
  textDigest:string;
  expiresAtMs:number|null;text:string|null;eventIds:readonly string[];
  claimState:string|null;claimProofEpoch:string|null;claimDecisionDigest:string|null;claimReplyLength:number|null;
 }|null{
  this.requireV5();
  const row=this.db.prepare(
   'SELECT i.conversation_id,i.source_event_id,i.status,i.attempt,i.ai_claim_id,i.not_before_ms,'+
   'i.decision_digest,i.text_digest,t.body,t.expires_at_ms FROM send_intents i '+
   'LEFT JOIN send_text t ON t.intent_id=i.intent_id WHERE i.intent_id=?'
  ).get(intentId) as {conversation_id:string;source_event_id:string;status:string;attempt:number;
   ai_claim_id:string|null;not_before_ms:number|null;decision_digest:string;text_digest:string;
   body:string|null;expires_at_ms:number|null}|undefined;
  if(!row)return null;
  const claim=row.ai_claim_id===null?undefined:this.db.prepare(
   'SELECT state,proof_epoch_id,decision_digest,reply_length FROM ai_decision_attempts WHERE claim_id=?'
  ).get(row.ai_claim_id) as {state:string;proof_epoch_id:string;decision_digest:string|null;reply_length:number|null}|undefined;
  return {
   conversationId:row.conversation_id,sourceEventId:row.source_event_id,
   status:row.status,attempt:row.attempt,aiClaimId:row.ai_claim_id,
   notBeforeMs:row.not_before_ms,decisionDigest:row.decision_digest,
   textDigest:row.text_digest,
   expiresAtMs:row.expires_at_ms,text:row.body,
   eventIds:this.sendIntentEvents(intentId),
   claimState:claim?.state??null,claimProofEpoch:claim?.proof_epoch_id??null,
   claimDecisionDigest:claim?.decision_digest??null,claimReplyLength:claim?.reply_length??null,
  };
 }

 /**
  * 崩溃恢复：所有遗留 dispatching 一律转 unknown。绝不自动重发。
  * 必须在取得单实例锁之后、开始处理新意图之前调用。
  */
 recoverInterruptedSends(now:number):number{
  this.requireV4();
  if(!Number.isSafeInteger(now))throw new ArchiveError('rejected');
  const r=this.db.prepare("UPDATE send_intents SET status='unknown',reason_code='interrupted',settled_at_ms=?,updated_at_ms=? WHERE status='dispatching'")
   .run(now,now);
  return Number(r.changes);
 }

 getSendIntent(intentId:string):{
  intentId:string;conversationId:string;sourceEventId:string;status:string;attempt:number;
  reasonCode:string|null;evidence:string|null;createdAtMs:number;settledAtMs:number|null;
 }|null{
  this.requireV4();
  const row=this.db.prepare('SELECT intent_id,conversation_id,source_event_id,status,attempt,reason_code,evidence,created_at_ms,settled_at_ms FROM send_intents WHERE intent_id=?')
   .get(intentId) as {intent_id:string;conversation_id:string;source_event_id:string;status:string;attempt:number;
    reason_code:string|null;evidence:string|null;created_at_ms:number;settled_at_ms:number|null}|undefined;
  if(!row)return null;
  return {intentId:row.intent_id,conversationId:row.conversation_id,sourceEventId:row.source_event_id,
   status:row.status,attempt:row.attempt,reasonCode:row.reason_code,evidence:row.evidence,
   createdAtMs:row.created_at_ms,settledAtMs:row.settled_at_ms};
 }

 sendIntentEvents(intentId:string):readonly string[]{
  this.requireV4();
  const rows=this.db.prepare('SELECT server_message_id FROM send_intent_events WHERE intent_id=? ORDER BY ordinal')
   .all(intentId) as {server_message_id:string}[];
  return rows.map(r=>r.server_message_id);
 }

 /** 只有未过期的正文可取用；过期即视为不可发送（保守）。 */
 /** T6-2b MOCK ONLY: proven T5 decision + unchanged epoch + exact event group. */
 mockDispatchCandidate(intentId:string,now:number,maxAgeMs:number):
  {conversationId:string;text:string}|null{
  this.requireV4();
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1)return null;
  const row=this.db.prepare(
   'SELECT i.conversation_id,i.source_event_id,i.status,i.text_digest,i.decision_digest,'+
   't.body,t.expires_at_ms FROM send_intents i LEFT JOIN send_text t ON t.intent_id=i.intent_id '+
   'WHERE i.intent_id=?'
  ).get(intentId) as {
   conversation_id:string;source_event_id:string;status:string;text_digest:string;
   decision_digest:string;body:string|null;expires_at_ms:number|null
  }|undefined;
  if(!row||(row.status!=='pending'&&row.status!=='dispatching')||!row.body||row.expires_at_ms===null||
     now>=row.expires_at_ms||
     createHash('sha256').update(row.body).digest('hex')!==row.text_digest)return null;
  const claim=this.db.prepare(
   "SELECT claim_id,proof_epoch_id,decision_digest,reply_length FROM ai_decision_attempts "+
   "WHERE conversation_id=? AND server_message_id=? AND state='recorded' AND action='reply'"
  ).get(row.conversation_id,row.source_event_id) as {
   claim_id:string;proof_epoch_id:string;decision_digest:string;reply_length:number
  }|undefined;
  if(!claim||claim.decision_digest!==row.decision_digest||
     claim.reply_length!==row.body.length||
     this.coverageEpoch(row.conversation_id,maxAgeMs)!==claim.proof_epoch_id)return null;
  const sendItems=this.sendIntentEvents(intentId);
  const aiItems=this.db.prepare(
   'SELECT server_message_id FROM ai_batch_items WHERE claim_id=? ORDER BY ordinal'
  ).all(claim.claim_id) as {server_message_id:string}[];
  if(sendItems.length!==aiItems.length||
     sendItems.some((id,i)=>id!==aiItems[i]?.server_message_id))return null;
  const eligible=this.db.prepare(
   'SELECT e.state,m.sender_uid,m.from_self,m.kind FROM eligible_events e '+
   'JOIN messages m ON e.conversation_id=m.conversation_id AND e.server_message_id=m.server_message_id '+
   'WHERE e.conversation_id=? AND e.server_message_id=?'
  );
  for(const id of sendItems){
   const x=eligible.get(row.conversation_id,id) as {
    state:string;sender_uid:string;from_self:number;kind:string
   }|undefined;
   if(!x||x.state!=='pending'||x.sender_uid!==this.identity.targetUid||
      x.from_self!==0||x.kind!=='text')return null;
  }
  return {conversationId:row.conversation_id,text:row.body};
 }

 getSendText(intentId:string,now:number):string|null{
  this.requireV4();
  const row=this.db.prepare('SELECT body,expires_at_ms FROM send_text WHERE intent_id=?')
   .get(intentId) as {body:string;expires_at_ms:number}|undefined;
  if(!row||now>=row.expires_at_ms)return null;
  return row.body;
 }

 /** 保留期限清理：只删正文，账本与摘要保留供审计。 */
 purgeExpiredSendText(now:number):number{
  this.requireV4();
  const r=this.db.prepare('DELETE FROM send_text WHERE expires_at_ms<=?').run(now);
  return Number(r.changes);
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
    // 对账依赖 v2 引入的表，但结构在 v3/v4/v5 中只增不改，因此向上兼容。
    // 新增 schema 版本时必须同步上调这个上限（曾两次因写死版本号导致回归）。
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(version<2||version>MAX_SCHEMA_VERSION)throw new ArchiveError('reconcile_requires_v2');
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

 /**
  * 证明是否仍可用（T4 安全门控）。
  *
  * verified 不是永久状态：一份 coverageProof 只在 maxAgeMs 内有效。
  * 超过有效期即视为无法继续证明其有效性，**即使 SDK 从未报告断线**。
  * 调用方（未来 T5 领取消息前）必须以此为准，而不是只读 sync_state。
  *
  * 返回值区分「为什么不可用」，便于上层记录原因且不暴露正文：
  *   state    当前 sync_state（null = 会话不存在）
  *   verified 是否 verified
  *   fresh    是否在有效期内
  *   usable   两者同时成立才为 true
  *   ageMs    verified 距今多久（未 verified 时为 null）
  */
 /**
  * T5 proof revision. Prevents ABA: pause/reconnect may invalidate proof and
  * finish a NEW verified epoch while an AI backend is still evaluating.
  */
 coverageEpoch(id:string,maxAgeMs:number):string|null{
  if(!this.coverageStatus(id,maxAgeMs).usable)return null;
  const row=this.db.prepare(
   "SELECT epoch_id FROM reconcile_epochs WHERE conversation_id=? AND state='verified' ORDER BY rowid DESC LIMIT 1"
  ).get(id) as {epoch_id:string}|undefined;
  return row?.epoch_id??null;
 }
 /**
  * T5 preview only. Does NOT claim/consume an eligible event.
  * Performs the T4 usable gate before exposing text even to our own AI engine.
  */
 readDryRunCandidate(id:string,maxAgeMs:number,maxTurns=5,excludeAttempted=false,maxBatchEvents=1):DryRunCandidate|null{
  this.requireV2();
  if(!this.validThread(id))throw new ArchiveError('rejected');
  if(!Number.isSafeInteger(maxTurns)||maxTurns<1||maxTurns>6)throw new ArchiveError('invalid_context_limit');
  if(!this.coverageStatus(id,maxAgeMs).usable)throw new ArchiveError('coverage_unusable');
  if(excludeAttempted)this.requireV3();
  if(!Number.isSafeInteger(maxBatchEvents)||maxBatchEvents<1||maxBatchEvents>3)throw new ArchiveError('invalid_batch_limit');
  const query=
   "SELECT e.server_message_id AS event_id,m.local_id,m.text,m.kind,m.sender_uid,m.from_self,m.create_time,m.index_in_conversation "+
   "FROM eligible_events e JOIN messages m ON m.conversation_id=e.conversation_id AND m.server_message_id=e.server_message_id "+
   "WHERE e.conversation_id=? AND e.state='pending' "+
   (excludeAttempted?"AND NOT EXISTS (SELECT 1 FROM ai_batch_items a WHERE a.conversation_id=e.conversation_id AND a.server_message_id=e.server_message_id) ":"")+
    "ORDER BY CASE WHEN length(m.create_time)=13 AND m.create_time NOT GLOB '*[^0-9]*' "+
   "THEN CAST(m.create_time AS INTEGER) ELSE 9223372036854775807 END,m.local_id LIMIT 1";
  const row=this.db.prepare(query).get(id) as {event_id:string;local_id:number;text:string;kind:string;sender_uid:string;from_self:number;create_time:string|null;index_in_conversation:string|null}|undefined;
  if(!row)return null;
  if(row.sender_uid!==this.identity.targetUid||row.from_self!==0||row.kind!=='text'||!row.text.trim())
   throw new ArchiveError('eligible_invalid');
  // local_id reflects SDK page insertion order, not necessarily send chronology.
  // Only inject time-ordered context with a trustworthy millisecond timestamp.
  const timeValid=row.create_time!==null&&/^\d{13}$/.test(row.create_time);
  const indexValid=row.index_in_conversation!==null&&/^\d+$/.test(row.index_in_conversation)&&
   Number.isSafeInteger(Number(row.index_in_conversation));
  const history=(timeValid?this.db.prepare(
   "SELECT sender_uid,from_self,text,kind FROM messages WHERE conversation_id=? "+
   "AND length(create_time)=13 AND create_time NOT GLOB '*[^0-9]*' "+
   "AND (CAST(create_time AS INTEGER)<? OR (CAST(create_time AS INTEGER)=? AND local_id=?)) "+
   "AND kind='text' AND length(text)>0 ORDER BY CAST(create_time AS INTEGER) DESC,local_id DESC LIMIT ?"
  ).all(id,Number(row.create_time),Number(row.create_time),row.local_id,maxTurns)
   :indexValid?this.db.prepare(
    "SELECT sender_uid,from_self,text,kind FROM messages WHERE conversation_id=? "+
    "AND index_in_conversation NOT GLOB '*[^0-9]*' "+
    "AND index_in_conversation IS NOT NULL "+
    "AND (CAST(index_in_conversation AS INTEGER)<? OR (CAST(index_in_conversation AS INTEGER)=? AND local_id=?)) "+
    "AND kind='text' AND length(text)>0 "+
    "ORDER BY CAST(index_in_conversation AS INTEGER) DESC,local_id DESC LIMIT ?"
   ).all(id,Number(row.index_in_conversation),Number(row.index_in_conversation),row.local_id,maxTurns)
   :[{sender_uid:row.sender_uid,from_self:row.from_self,text:row.text,kind:row.kind}]) as {sender_uid:string;from_self:number;text:string;kind:string}[];
  if(!history.length)throw new ArchiveError('eligible_invalid');
  const own=new Set(this.identity.ownUids);
  const turns=history.reverse().map(item=>{
   const target=item.sender_uid===this.identity.targetUid && item.from_self===0;
   const sender=own.has(item.sender_uid)&&item.from_self===1;
   if(!target&&!sender)throw new ArchiveError('context_identity_invalid');
   return {role:(target?'user':'assistant') as 'user'|'assistant',text:item.text.slice(0,1200)};
  });
  if(turns.at(-1)?.role!=='user')throw new ArchiveError('eligible_invalid');
  const eventIds=[row.event_id];
  if(excludeAttempted&&maxBatchEvents>1){
   // Missing/invalid timestamps anywhere in the archived thread make
   // "consecutive" impossible to prove. Fail closed to single-event claims.
   const unknownTimeline=this.db.prepare(
    "SELECT COUNT(*) n FROM messages WHERE conversation_id=? "+
    "AND (create_time IS NULL OR length(create_time)<>13 OR create_time GLOB '*[^0-9]*')"
   ).get(id) as {n:number};
   if(unknownTimeline.n>0)return {eventId:row.event_id,eventIds,turns};
   // Only consecutive, *eligible* incoming text records: stop at outgoing messages,
   // unsupported timestamps, non-text, attempted items or a long time gap.
   const followers=this.db.prepare(
    "SELECT m.server_message_id,m.sender_uid,m.from_self,m.kind,m.text,m.create_time,m.local_id,"+
    "e.state AS eligible_state,b.claim_id AS attempted "+
    "FROM messages m LEFT JOIN eligible_events e ON e.conversation_id=m.conversation_id AND e.server_message_id=m.server_message_id "+
    "LEFT JOIN ai_batch_items b ON b.conversation_id=m.conversation_id AND b.server_message_id=m.server_message_id "+
    "WHERE m.conversation_id=? AND length(m.create_time)=13 "+
    "AND m.create_time NOT GLOB '*[^0-9]*' "+
    "AND (CAST(m.create_time AS INTEGER)>? OR (CAST(m.create_time AS INTEGER)=? AND m.local_id>?)) "+
    "ORDER BY CAST(m.create_time AS INTEGER),m.local_id LIMIT 8"
   ).all(id,Number(row.create_time),Number(row.create_time),row.local_id) as {
    server_message_id:string;sender_uid:string;from_self:number;
    kind:string;text:string;create_time:string|null;local_id:number;eligible_state:string|null;attempted:string|null}[];
   let previousTime=timeValid?Number(row.create_time):NaN;
   let total=turns.at(-1)!.text.length;
   const merged=[turns.at(-1)!.text];
   for(const f of followers){
    if(eventIds.length>=maxBatchEvents)break;
    const nextTime=f.create_time&&/^\d{13}$/.test(f.create_time)?Number(f.create_time):NaN;
    if(f.sender_uid!==this.identity.targetUid||f.from_self!==0||f.kind!=='text'||
       f.eligible_state!=='pending'||f.attempted!==null||!f.text.trim()||
       !Number.isFinite(previousTime)||!Number.isFinite(nextTime)||
       nextTime<=previousTime||nextTime-previousTime>15000||
       total+1+f.text.length>1200)break;
    eventIds.push(f.server_message_id);
    merged.push(f.text);
    total+=1+f.text.length;
    previousTime=nextTime;
   }
   if(merged.length>1)turns[turns.length-1]={role:'user',text:merged.join('\n')};
  }
  return {eventId:row.event_id,eventIds,turns};
 }
 /** Claim is a permanent, single-attempt dry-run reservation: crashes never auto-retry an AI call. */
 claimAiDryRun(input:{conversationId:string;maxAgeMs:number;backendId:string;backendKind:'model-api'|'agent-runtime';maxBatchEvents?:number;policy?:AiCallPolicy}):
   {claimId:string;proofEpoch:string;candidate:DryRunCandidate}|null{
  this.requireV3();
  if(!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.backendId)||!['model-api','agent-runtime'].includes(input.backendKind))
   throw new ArchiveError('invalid_backend');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const proofEpoch=this.coverageEpoch(input.conversationId,input.maxAgeMs);
   if(!proofEpoch)throw new ArchiveError('coverage_unusable');
   const candidate=this.readDryRunCandidate(input.conversationId,input.maxAgeMs,5,true,input.maxBatchEvents??1);
   if(!candidate){this.db.exec('COMMIT');return null;}
   const p=input.policy??{};
   const maxHour=p.maxPerHour??6,maxDay=p.maxPerDay??30;
   const minInterval=p.minIntervalMs??0,failCooldown=p.failureCooldownMs??0;
   if(![maxHour,maxDay,minInterval,failCooldown].every(Number.isSafeInteger)||
      maxHour<1||maxHour>100||maxDay<1||maxDay>500||
      minInterval<0||minInterval>3600000||failCooldown<0||failCooldown>86400000)
    throw new ArchiveError('invalid_ai_policy');
   const now=Date.now();
   const usage=this.db.prepare(
    "SELECT COUNT(*) AS all_calls,"+
    "SUM(CASE WHEN claimed_at_ms>? THEN 1 ELSE 0 END) AS recent_hour "+
    "FROM ai_decision_attempts WHERE claimed_at_ms>?"
   ).get(now-3600000,now-86400000) as {all_calls:number;recent_hour:number|null};
   if(Number(usage.recent_hour??0)>=maxHour)throw new ArchiveError('ai_budget_hourly');
   if(usage.all_calls>=maxDay)throw new ArchiveError('ai_budget_daily');
   const latest=this.db.prepare(
    "SELECT claimed_at_ms,state,finished_at_ms FROM ai_decision_attempts ORDER BY claimed_at_ms DESC LIMIT 1"
   ).get() as {claimed_at_ms:number;state:string;finished_at_ms:number|null}|undefined;
   if(latest){
    if(now<latest.claimed_at_ms)throw new ArchiveError('ai_cooldown');
    if(now-latest.claimed_at_ms<minInterval)throw new ArchiveError('ai_cooldown');
   }
   const failed=this.db.prepare(
    "SELECT MAX(finished_at_ms) AS at FROM ai_decision_attempts WHERE state IN ('blocked','interrupted')"
   ).get() as {at:number|null};
   if(failed.at!==null&&(now<failed.at||now-failed.at<failCooldown))
    throw new ArchiveError('ai_cooldown');
   const claimId=randomUUID();
   const eventDigest=createHash('sha256').update(candidate.eventId).digest('hex');
   this.db.prepare(
    "INSERT INTO ai_decision_attempts(claim_id,conversation_id,server_message_id,proof_epoch_id,backend_id,backend_kind,state,claimed_at_ms,event_digest) "+
    "VALUES(?,?,?,?,?,?,'claimed',?,?)"
   ).run(claimId,input.conversationId,candidate.eventId,proofEpoch,
    input.backendId,input.backendKind,now,eventDigest);
   const insert=this.db.prepare(
    "INSERT INTO ai_batch_items(claim_id,conversation_id,server_message_id,ordinal) VALUES(?,?,?,?)"
   );
   for(const [ordinal,eventId] of candidate.eventIds.entries())
    insert.run(claimId,input.conversationId,eventId,ordinal);
   this.db.exec('COMMIT');
   return {claimId,proofEpoch,candidate};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** Finalization is atomic and compares the same proof epoch inside the write transaction. */
 finishAiDryRun(input:{claimId:string;maxAgeMs:number;outcome:
  |{status:'recorded';action:'reply'|'skip'|'defer';decisionDigest:string;replyLength:number}
  |{status:'blocked';reasonCode:string}}):{status:'recorded'|'blocked';reasonCode:string|null}{
  this.requireV3();
  if(!/^[a-f0-9-]{36}$/.test(input.claimId))throw new ArchiveError('claim_invalid');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare(
    "SELECT conversation_id,proof_epoch_id,state FROM ai_decision_attempts WHERE claim_id=?"
   ).get(input.claimId) as {conversation_id:string;proof_epoch_id:string;state:string}|undefined;
   if(!row||row.state!=='claimed')throw new ArchiveError('claim_not_active');
   const sameProof=this.coverageEpoch(row.conversation_id,input.maxAgeMs)===row.proof_epoch_id;
   const outcome=input.outcome;
   const reason=!sameProof?'coverage_lost_after_inference':
    outcome.status==='blocked'?outcome.reasonCode:null;
   if(reason!==null){
    if(!/^[a-z0-9_]{3,80}$/.test(reason))throw new ArchiveError('invalid_audit_reason');
    this.db.prepare("UPDATE ai_decision_attempts SET state='blocked',finished_at_ms=?,failure_code=? WHERE claim_id=?")
     .run(Date.now(),reason,input.claimId);
   }else{
    if(outcome.status!=='recorded'||!['reply','skip','defer'].includes(outcome.action)||
       !/^[a-f0-9]{64}$/.test(outcome.decisionDigest)||
       !Number.isSafeInteger(outcome.replyLength)||outcome.replyLength<0||outcome.replyLength>500)
     throw new ArchiveError('invalid_audit');
    this.db.prepare(
     "UPDATE ai_decision_attempts SET state='recorded',finished_at_ms=?,action=?,decision_digest=?,reply_length=? WHERE claim_id=?"
    ).run(Date.now(),outcome.action,outcome.decisionDigest,outcome.replyLength,input.claimId);
   }
   this.db.exec('COMMIT');
   return reason!==null?{status:'blocked',reasonCode:reason}:{status:'recorded',reasonCode:null};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 /** Single-instance startup only; avoids replay of a possibly billable Agent invocation. */
 recoverAbandonedAiClaims():number{
  this.requireV3();
  const result=this.db.prepare(
   "UPDATE ai_decision_attempts SET state='interrupted',finished_at_ms=?,failure_code='crash_interrupted' WHERE state='claimed'"
  ).run(Date.now());
  return Number(result.changes);
 }
 aiBatchItems():number{
  this.requireV3();
  return Number((this.db.prepare('SELECT COUNT(*) n FROM ai_batch_items').get() as {n:number}).n);
 }
 aiAttemptStats():{claimed:number;recorded:number;blocked:number;interrupted:number}{
  this.requireV3();
  const states:{[key:string]:number}={claimed:0,recorded:0,blocked:0,interrupted:0};
  const rows=this.db.prepare('SELECT state,COUNT(*) n FROM ai_decision_attempts GROUP BY state')
   .all() as {state:string;n:number}[];
  for(const row of rows)states[row.state]=row.n;
  return {claimed:states['claimed']!,recorded:states['recorded']!,blocked:states['blocked']!,interrupted:states['interrupted']!};
 }
 coverageStatus(id:string,maxAgeMs:number):{
  state:string|null;verified:boolean;fresh:boolean;usable:boolean;ageMs:number|null;
 }{
  this.requireV2();
  if(!this.validThread(id))throw new ArchiveError('rejected');
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1)throw new ArchiveError('invalid_max_age');
  const row=this.db.prepare('SELECT sync_state,last_verified_at_ms FROM conversations WHERE conversation_id=?')
   .get(id) as {sync_state:string;last_verified_at_ms:number|null}|undefined;
  const state=row?.sync_state??null;
  const verified=state==='verified';
  const at=row?.last_verified_at_ms??null;
  const ageMs=verified&&at!==null?Date.now()-at:null;
  // 时间戳缺失或倒退一律视为不可用（保守，不假设「刚验证过」）
  const fresh=ageMs!==null&&ageMs>=0&&ageMs<=maxAgeMs;
  return {state,verified,fresh,usable:verified&&fresh,ageMs};
 }
}
