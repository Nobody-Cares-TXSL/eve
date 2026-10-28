/** Opt-in T4 real history coverage rehearsal using disposable SQLite only. No send. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {loadConfig} from '../src/runtime/config.ts';
import {DouyinReadOnlyPort,belongsToTarget} from '../src/platform/douyin.ts';
import type {PlatformPort,PlatformStatus,HistoryPage} from '../src/platform/types.ts';
import {EveArchive} from '../src/archive/store.ts';
import {reconcileOnce} from '../src/runtime/reconcile.ts';

if(process.env['EVE_T4_SHADOW_PROOF']!=='1'){
 console.error('shadow_proof_disabled');process.exit(2);
}
const app=process.cwd(),production=join(app,'data','eve.sqlite');
const config=await loadConfig(join(app,'data','config.json'));
if(!existsSync(production))throw Error('production_archive_missing');
function fingerprint(){
 return [production,production+'-wal',production+'-shm'].map(p=>existsSync(p)
  ?createHash('sha256').update(readFileSync(p)).digest('hex'):'absent').join('|');
}
const before=fingerprint();
const source=new DatabaseSync(production,{readOnly:true});
let conversationId:string;
try{
 const m=source.prepare('SELECT owner_uid,target_uid FROM archive_meta WHERE singleton=1').get() as
  {owner_uid:string;target_uid:string}|undefined;
 const c=source.prepare('SELECT conversation_id FROM conversations').all() as {conversation_id:string}[];
 const version=(source.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
 if(version!==1||!m||m.owner_uid!==config.selfUid||m.target_uid!==config.targetUid||c.length!==1)
  throw Error('production_identity_or_schema_invalid');
 conversationId=c[0]!.conversation_id;
}finally{source.close();}
const volatileRoot=existsSync('/dev/shm')?'/dev/shm':(process.env['XDG_RUNTIME_DIR']??'/tmp');
const dir=await mkdtemp(join(volatileRoot,'eve-t4-shadow-'));
const port=new DouyinReadOnlyPort({dataDir:resolve(app,'data'),selfUid:config.selfUid,
 targetUid:config.targetUid,allowLocalVerification:false,notifyQrPath:()=>undefined});
let online:{uid:string;imUid:string}|null=null;
let unsafe=false;
port.subscribe({
 onMessage:()=>undefined,
 onStatus:(s:PlatformStatus)=>{
  if(s.type==='online')online={uid:s.uid,imUid:s.imUid};
  if(s.type==='reconnecting'||s.type==='offline'||s.type==='session_rejected'||
     s.type==='qr_required'||s.type==='verification_required')unsafe=true;
 },
});
let archive:EveArchive|undefined;
let started=false;
let networkCalls=0;
try{
 await port.start();started=true;
 const id=online;
 if(unsafe||!id||id.uid!==config.selfUid||
    !belongsToTarget(conversationId,new Set([id.uid,id.imUid]),config.targetUid))
   throw Error('trusted_identity_unavailable');
 archive=EveArchive.open(join(dir,'shadow.sqlite'),
  {ownerUid:id.uid,targetUid:config.targetUid,ownUids:[...new Set([id.uid,id.imUid])]});
 archive.upgradeToV2();
 const wait=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
 const throttle:PlatformPort={
  start:()=>port.start(),stop:()=>port.stop(),subscribe:sink=>port.subscribe(sink),
  readHistory:async(cid:string,cursor?:string|null):Promise<HistoryPage>=>{
   if(unsafe)throw Error('connection_changed');
   if(networkCalls>0)await wait(1000);
   networkCalls++;
   return port.readHistory(cid,cursor);
  },
 };
 const result=await reconcileOnce({
  port:throttle,archive,conversationId,imUid:id.imUid,instanceId:randomUUID(),
  isSafe:()=>!unsafe,limits:{maxPages:20,maxMessages:900,maxDurationMs:80000,readTimeoutMs:15000},
 });
 const stats=archive.reconcileStats(result.epochId);
 const dbState=archive.conversationState(conversationId);
 const counts=archive.counts();
 const confirmed=result.state==='verified'&&stats.state==='verified'&&
  dbState==='verified'&&stats.anchor!==null&&stats.eligible===0;
 console.log(JSON.stringify({
  mode:'shadow_only',reconcileState:result.state,reason:result.reason,
  archiveState:dbState,pages:stats.pages,networkCalls,
  archivedMessages:counts.messages,eligibleEvents:stats.eligible,
  shadowVerified:confirmed,productionSchemaMigrated:false,
  productionFileChanged:fingerprint()!==before,
 }));
 if(!confirmed)process.exitCode=3;
}catch(e){
 const code=e instanceof Error&&/^[a-z_]{3,80}$/.test(e.message)?e.message:'shadow_probe_failure';
 console.error(JSON.stringify({probe:'shadow_failed',reason:code,networkCalls}));
 process.exitCode=3;
}finally{
 try{archive?.close();}catch{process.exitCode=3;}
 if(started){try{await port.stop();}catch{process.exitCode=3;}}
 try{await rm(dir,{recursive:true,force:true});}catch{process.exitCode=3;}
 if(fingerprint()!==before){console.error('production_fingerprint_changed');process.exitCode=3;}
}
