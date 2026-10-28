/** T4-5 bounded live-read diagnostic. Never writes Eve's SQLite or calls sendMsg. */
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {loadConfig} from '../src/runtime/config.ts';
import {DouyinReadOnlyPort,belongsToTarget} from '../src/platform/douyin.ts';
import type {HistoryPage,PlatformStatus} from '../src/platform/types.ts';

if(process.env['EVE_T4_READONLY_PROBE']!=='1'){
 console.error('probe_disabled');process.exit(2);
}
const cwd=process.cwd();
const archive=join(cwd,'data','eve.sqlite');
const config=await loadConfig(join(cwd,'data','config.json'));
// Capped opt-in limits; the CLI's external flock/timeout remains mandatory.
function boundedEnv(name:string,fallback:number,limit:number):number{
 const text=process.env[name];
 if(text===undefined)return fallback;
 if(!/^[1-9][0-9]*$/.test(text))throw new Error('invalid_probe_limit');
 const num=Number(text);
 if(!Number.isSafeInteger(num)||num>limit)throw new Error('invalid_probe_limit');
 return num;
}
const maxPages=boundedEnv('EVE_T4_MAX_PAGES',3,30);
const maxDurationMs=boundedEnv('EVE_T4_MAX_DURATION_SEC',26,120)*1000;
const gapMs=boundedEnv('EVE_T4_PAGE_GAP_MS',750,4000);
const started=Date.now();
const fingerprint=()=>{
 const parts=[archive,archive+'-wal',archive+'-shm'];
 return parts.map(file=>existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):'absent').join('|');
};

if(!existsSync(archive)){
 console.error('missing_existing_archive');process.exit(2);
}
const db=new DatabaseSync(archive,{readOnly:true});
let thread:string;
const before=fingerprint();
try{
 const meta=db.prepare('SELECT owner_uid,target_uid FROM archive_meta WHERE singleton=1').get() as {owner_uid:string;target_uid:string}|undefined;
 const rows=db.prepare('SELECT conversation_id FROM conversations').all() as {conversation_id:string}[];
 if(!meta||meta.owner_uid!==config.selfUid||meta.target_uid!==config.targetUid||rows.length!==1){
  console.error('archive_scope_not_unique');process.exit(2);
 }
 thread=rows[0]!.conversation_id;
}finally{db.close();}
let historyDiagnostic='none';
let shortIdHintMissing=false;
const port=new DouyinReadOnlyPort({
 dataDir:resolve(cwd,'data'),selfUid:config.selfUid,targetUid:config.targetUid,
 allowLocalVerification:false,notifyQrPath:()=>undefined,
 onHistoryDiagnostic:code=>{historyDiagnostic=code;if(code==='history_short_id_missing')shortIdHintMissing=true;},
});
let online:{uid:string;imUid:string}|undefined;
let invalid=false;
let failureStage='login';
const seen={qr:false,session:false,verification:false};
port.subscribe({
 onMessage:()=>undefined,
 onStatus:(s:PlatformStatus)=>{
  if(s.type==='online')online={uid:s.uid,imUid:s.imUid};
  if(s.type==='qr_required')seen.qr=true;
  if(s.type==='session_rejected')seen.session=true;
  if(s.type==='verification_required')seen.verification=true;
  if(s.type==='session_rejected'||s.type==='qr_required'||s.type==='verification_required')invalid=true;
 },
});
let pages=0,total=0,excluded=0,cursor:string|null=null,hasMore=true;
const cursorSeen=new Set<string>();
function accept(page:HistoryPage){
 if(page.statusCode!==0||page.requestedCursor!==cursor||page.direction!=='older'||
    page.requestedDirection!=='older'||page.rawCount!==page.acceptedCount+page.excludedCount||
    page.acceptedCount!==page.messages.length||page.missingIdCount>0)
  throw Error('history_page_inconsistent');
 const unique=new Set(page.messages.map(m=>m.serverMessageId));
 if(unique.has(null)||unique.size!==page.messages.length)throw Error('page_id_missing_or_repeated');
 if(page.hasMore&&(page.cursor===cursor||cursorSeen.has(page.cursor)||page.cursor.length===0))
  throw Error('cursor_not_advancing');
 cursorSeen.add(page.cursor);
 excluded+=page.excludedCount;total+=page.rawCount;
 cursor=page.cursor;hasMore=page.hasMore;pages++;
}
try{
 await port.start();
 failureStage='identity';
 if(invalid||!online||online.uid!==config.selfUid||!/^\d+$/.test(online.imUid)||
  !belongsToTarget(thread,new Set([online.uid,online.imUid]),config.targetUid))
  throw Error('account_or_session_unverified');
 while(pages<maxPages && hasMore && !invalid){
  if(Date.now()-started>=maxDurationMs)throw Error('probe_budget_exhausted');
  failureStage='history';
  const page=await port.readHistory(thread,cursor);
  accept(page);
  if(hasMore && pages<maxPages){
   if(Date.now()-started+gapMs>=maxDurationMs)throw Error('probe_budget_exhausted');
   await new Promise(r=>setTimeout(r,gapMs));
  }
 }
 failureStage='completed';
 console.log(JSON.stringify({
  mode:'live_read_only',readPages:pages,rawItems:total,excludedItems:excluded,
  reachedHistoryEnd:!hasMore,hasMultiplePages:pages>1,hitPageLimit:hasMore&&pages>=maxPages,
  coverageClaim:'none',sqliteModified:fingerprint()!==before,
  status:excluded===0?'pages_observed':'excluded_rows_require_review',
 }));
}catch(e){
 const exceptionType=e instanceof Error && /^[a-zA-Z]+$/.test(e.name)?e.name:'other';
 console.error(JSON.stringify({probe:'failed',stage:failureStage,historyDiagnostic,shortIdHintMissing,exceptionType,statusFlags:seen}));
 process.exitCode=3;
}finally{
 try{await port.stop();}catch{process.exitCode=1;}
}
