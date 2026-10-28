/** T4 recovery: bounded, read-only, no AI, no sending, no ad hoc proof flags. */
import {randomUUID} from 'node:crypto';
import type {PlatformPort,HistoryPage} from '../platform/types.ts';
import {EveArchive} from '../archive/store.ts';

export interface ReconcileLimits {
 maxPages:number;
 maxMessages:number;
 maxDurationMs:number;
 readTimeoutMs:number;
}
const defaults:ReconcileLimits={maxPages:100,maxMessages:5000,maxDurationMs:60000,readTimeoutMs:12000};
export interface ReconcileInput{
 port:PlatformPort;
 archive:EveArchive;
 conversationId:string;
 imUid:string;
 instanceId:string;
 /** true only while authenticated and not reconnecting/stopping/paused; queue fully drained before proof */
 isSafe:()=>boolean;
 /** Invalidates the epoch promptly; SDK transport may still finish after cancellation. */
 signal?:AbortSignal;
 limits?:Partial<ReconcileLimits>;
}
export type ReconcileResult={state:'verified'|'gap';epochId:string;pages:number;reason:string};
class ReconcileFailure extends Error {readonly reasonCode:string;constructor(reasonCode:string){super(reasonCode);this.reasonCode=reasonCode;}}
/** SDK has no abort parameter. Keep a pending transport fence across epochs, including timed-out reads. */
const outstandingHistory=new WeakMap<PlatformPort,Promise<HistoryPage>>();
function checkPage(p:HistoryPage,cursor:string|null){
 if(p.statusCode!==0||p.direction!=='older'||p.requestedDirection!=='older'||
    p.requestedCursor!==cursor||p.excludedCount!==0||p.missingIdCount!==0||
    p.rawCount!==p.acceptedCount+p.excludedCount||
    p.acceptedCount!==p.messages.length||
    p.messages.some(m=>m.serverMessageId===null)||
    new Set(p.messages.map(m=>m.serverMessageId)).size!==p.messages.length){
  throw new ReconcileFailure('page_unverifiable');
 }
 if(p.hasMore&&(!p.cursor||p.cursor===cursor))throw new ReconcileFailure('cursor_not_advancing');
}
function codeFor(e:unknown):string{
 if(e instanceof ReconcileFailure)return e.reasonCode;
 if(e instanceof Error && /^[a-z_]{3,80}$/.test(e.message))return e.message;
 return 'history_or_archive_failure';
}
export async function reconcileOnce(input:ReconcileInput):Promise<ReconcileResult>{
 const limits={...defaults,...input.limits};
 if(Object.values(limits).some(x=>!Number.isSafeInteger(x)||x<1))
   throw new Error('invalid_reconcile_limits');
 const id=randomUUID();
 // Let archive own the epoch and its previous anchor; no caller-provided proof object.
 const oldAnchor=input.archive.beginEpoch({epochId:id,conversationId:input.conversationId,
  instanceId:input.instanceId,imUid:input.imUid});
 const started=Date.now();
 let pages=0,total=0,cursor:string|null=null;
 const visited=new Set<string>();
 const alive=()=>!input.signal?.aborted&&input.isSafe()&&Date.now()-started<=limits.maxDurationMs;
 const fetch=async(at:string|null):Promise<HistoryPage>=>{
  if(!alive())throw new ReconcileFailure('epoch_invalidated');
  if(outstandingHistory.has(input.port))throw new ReconcileFailure('history_request_still_pending');
  let attempt:Promise<HistoryPage>;
  try{attempt=Promise.resolve(input.port.readHistory(input.conversationId,at));}
  catch(e){throw e;}
  outstandingHistory.set(input.port,attempt);
  // Do not drop the fence on timeout/cancellation: old transport must actually settle first.
  void attempt.finally(()=>{
    if(outstandingHistory.get(input.port)===attempt)outstandingHistory.delete(input.port);
  }).catch(()=>undefined);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abortListener:(()=>void)|undefined;
  const fail=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new ReconcileFailure('history_timeout')),limits.readTimeoutMs);
    abortListener=()=>reject(new ReconcileFailure('epoch_invalidated'));
    input.signal?.addEventListener('abort',abortListener,{once:true});
    if(input.signal?.aborted)abortListener();
  });
  try{return await Promise.race([attempt,fail]);}
  finally{
    if(timer)clearTimeout(timer);
    if(abortListener)input.signal?.removeEventListener('abort',abortListener);
  }
 };
 try{
  let firstIds:string[]|null=null;
  let firstCursor:string|null=null,firstHasMore:boolean|null=null;
  let anchorSeen=false,terminal=false;
  for(;;){
   if(!alive())throw new ReconcileFailure('epoch_invalidated');
   if(pages>=limits.maxPages)throw new ReconcileFailure('page_budget_exhausted');
   const page=await fetch(cursor);
   if(!alive())throw new ReconcileFailure('epoch_invalidated');
   checkPage(page,cursor);
   if(page.hasMore && (visited.has(page.cursor)||page.rawCount===0))
     throw new ReconcileFailure('cursor_cycle_or_empty');
   if(page.hasMore)visited.add(page.cursor);
   total+=page.rawCount;
   if(total>limits.maxMessages)throw new ReconcileFailure('message_budget_exhausted');
   if(firstIds===null){
    firstIds=page.messages.map(m=>m.serverMessageId!);
    firstCursor=page.cursor;firstHasMore=page.hasMore;
   }
   if(oldAnchor&&page.messages.some(m=>m.serverMessageId===oldAnchor))anchorSeen=true;
   input.archive.recordReconcilePage({epochId:id,pageNo:pages,phase:'older',page});
   pages++;
   if(anchorSeen||!page.hasMore){
    terminal=!page.hasMore;
    break;
   }
   cursor=page.cursor;
  }
  if(oldAnchor?!anchorSeen:!terminal)throw new ReconcileFailure('anchor_not_covered');
  if(!firstIds?.length)throw new ReconcileFailure('empty_history_unverifiable');
  if(pages>=limits.maxPages)throw new ReconcileFailure('page_budget_exhausted');
  const head=await fetch(null);
  if(!alive())throw new ReconcileFailure('epoch_invalidated');
  checkPage(head,null);
  if(head.cursor!==firstCursor||head.hasMore!==firstHasMore||
     JSON.stringify(head.messages.map(m=>m.serverMessageId))!==JSON.stringify(firstIds))
    throw new ReconcileFailure('head_not_closed');
  // isSafe must include "no pending live writes" and stable authenticated identity.
  if(!alive())throw new ReconcileFailure('epoch_invalidated');
  const result=input.archive.recordReconcilePage({epochId:id,pageNo:pages,phase:'head_close',page:head});
  pages++;
  if(!result.verified)throw new ReconcileFailure('proof_incomplete');
  return {state:'verified',epochId:id,pages,reason:'covered'};
 }catch(e){
  const reason=codeFor(e);
  input.archive.failEpoch(id,reason);
  return {state:'gap',epochId:id,pages,reason};
 }
}
