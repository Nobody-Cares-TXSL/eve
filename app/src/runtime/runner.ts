import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readState,writeState,paths,initDirs,processStart,BLOCKED,readJson,listRequests,atomicJson,removeFile,type RuntimeState,type Phase,type Paths} from './state.ts';
import {BoundedQueue} from './queue.ts';
import {reconcileOnce} from './reconcile.ts';
import {EveArchive,type ArchiveIdentity} from '../archive/store.ts';
import type {InboundMessage} from '../platform/types.ts';
import type {PlatformPort,PlatformSink} from '../platform/types.ts';
import type {RuntimeConfig} from './config.ts';

/**
 * 一份 coverageProof 的最长可用时间。超过即撤销，即使 SDK 从未报告断线。
 * 取值需小于 SDK 心跳周期（15s）的若干倍：多次心跳未确认即不再信任旧证明。
 */
export const COVERAGE_MAX_AGE_MS = 90_000;

export type Action = 'pause'|'resume'|'stop';
export interface ControlRequest { readonly id:string; readonly instanceId:string; readonly action:Action; readonly at:number; }
const actions = new Set(['pause','resume','stop']);
function validControl(x: unknown): x is ControlRequest {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const v=x as Record<string,unknown>;
  return typeof v['id']==='string' && /^[a-f0-9-]{36}$/.test(v['id']) &&
    typeof v['instanceId']==='string' && actions.has(String(v['action'])) && typeof v['at']==='number';
}
async function ackExists(p: Paths, id: string): Promise<boolean> {
  try { await readFile(join(p.acks,id+'.json'),'utf8'); return true; }
  catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return false; throw e; }
}
export class Runner {
  private readonly id=randomUUID();
  private readonly p:Paths;
  private s:RuntimeState;
  private readonly q:BoundedQueue<InboundMessage>;
  private archive: EveArchive | undefined;
  private trustedIdentity:ArchiveIdentity | undefined;
  private readonly archivePath: string | undefined;
  private readonly reconcileEnabled:boolean;
  private readonly historyPageGapMs:number;
  private readonly coverageMaxAgeMs:number;
  private reconciliationGeneration=0;
  private reconciliationRequested=false;
  private reconciliationRunning:Promise<void>|undefined;
  private reconciliationAbort:AbortController|undefined;
  private platformOnline=false;
  private coverageInvalidationPending=false;
  private coverageInvalidationChain:Promise<void>=Promise.resolve();
  private confirmedConversationId:string|undefined;
  private stopping=false;
  private faulted=false;
  private active=false;
  private blockPending: Promise<void> | undefined;
  private messages=0;
  private readonly processed=new Set<string>();
  private wake: (()=>void)|undefined;
  private readonly port:PlatformPort;
  private readonly config:RuntimeConfig;
  constructor(root:string, port:PlatformPort, config:RuntimeConfig, archivePath?:string,
              reconcileEnabled=false, historyPageGapMs=0, coverageMaxAgeMs=COVERAGE_MAX_AGE_MS) {
    this.reconcileEnabled=reconcileEnabled;
    this.historyPageGapMs=historyPageGapMs;
    this.coverageMaxAgeMs=coverageMaxAgeMs;
    this.archivePath=archivePath;
    this.port=port;this.config=config;
    this.p=paths(root);
    this.s={phase:'starting',instanceId:this.id,pid:process.pid,processStart:processStart(process.pid),
      updatedAt:Date.now(),reason:''};
    this.q=new BoundedQueue(config.queueCapacity,async message=>{
      if(this.archivePath){
        if(!this.archive || !this.trustedIdentity) throw new Error('archive_identity_unverified');
        const batchId=randomUUID();
        this.archive.archiveBatch({batchId,conversationId:message.conversationId,source:'live',messages:[message]});
      }
      this.messages++;
    },reason=>{void this.block('paused_env',reason);});
  }
  private async set(phase:Phase,reason=''):Promise<void> {
    this.s={...this.s,phase,reason,updatedAt:Date.now()};
    await writeState(this.p,this.s);
  }
  private block(phase:'paused_auth'|'paused_risk'|'paused_env'|'paused_unknown',reason:string):Promise<void> {
    if (this.blockPending) return this.blockPending;
    if (this.faulted || this.stopping) return Promise.resolve();
    this.faulted=true;
    this.q.pause();
    // run() 退出前必须 await 这个 promise：否则返回码读到的是落盘前的 phase。
    this.blockPending=(async()=>{
      try {await this.set(phase,reason);}catch{this.faulted=true;}
      this.wake?.();
    })();
    return this.blockPending;
  }
  private readonly sink:PlatformSink={
    onMessage:message=>{
      if (this.stopping || this.faulted || BLOCKED.includes(this.s.phase)) return;
      if(this.archivePath && (!this.archive||!this.trustedIdentity)) {
        void this.block('paused_env','archive_identity_unverified');return;
      }
      if(this.reconcileEnabled){
        if(this.confirmedConversationId&&this.confirmedConversationId!==message.conversationId){
          void this.block('paused_env','conversation_identity_changed');return;
        }
        if(!this.confirmedConversationId){
          this.confirmedConversationId=message.conversationId;
          this.reconciliationRequested=true;
        }
      }
      this.q.push(message);
    },
    onStatus:status=>{
      if(status.type==='online' && this.archivePath){
        // 契约 §1：SDK 回调内禁止同步 DB 调用。此处只记录纯数据身份，
        // 建库在 run() 中 await port.start() 之后完成（那时本事件已同步触发完毕）。
        if(status.uid!==this.config.selfUid || !/^[0-9]+$/.test(status.imUid)){
          void this.block('paused_auth','archive_identity_mismatch');return;
        }
        if(this.trustedIdentity && !this.trustedIdentity.ownUids.includes(status.imUid)){
          void this.block('paused_auth','archive_identity_changed');return;
        }
        this.trustedIdentity={ownerUid:this.config.selfUid,targetUid:this.config.targetUid,
          ownUids:[...new Set([status.uid,status.imUid])]};
        this.platformOnline=true;
        if(this.reconcileEnabled){
          this.reconciliationGeneration++;
          this.reconciliationAbort?.abort();
          this.reconciliationRequested=true;
          this.wake?.();
        }
      }
      if((status.type==='offline'||status.type==='reconnecting')&&this.reconcileEnabled){
        this.platformOnline=false;
        this.reconciliationGeneration++;
        this.reconciliationAbort?.abort();
        this.reconciliationRequested=true;
        // 立即排队撤销（不在 SDK 回调栈上做同步 DB 调用，契约 §1）。
        // 撤销与重新对账之间必须有明确顺序：对账启动前 await 此 promise，
        // 否则重连过快时（实测 ~1.2s）会跨过撤销窗口，旧 verified 直接续用。
        this.coverageInvalidationPending=true;
        this.coverageInvalidationChain=this.coverageInvalidationChain.then(async()=>{
          if(!this.coverageInvalidationPending||!this.archive)return;
          this.coverageInvalidationPending=false;
          this.archive.invalidateCurrentCoverage();
        }).catch(()=>{void this.block('paused_env','coverage_invalidation_failed');});
        this.wake?.();
      }
      if (status.type==='session_rejected') void this.block('paused_auth','session_rejected');
      else if (status.type==='verification_required' && !this.config.allowLocalVerification)
        void this.block('paused_risk','verification_required');
    },
  };
  private async ack(req:ControlRequest,ok:boolean,reason=''):Promise<void> {
    await atomicJson(join(this.p.acks,req.id+'.json'),{id:req.id,instanceId:this.id,ok,reason,phase:this.s.phase});
    await removeFile(join(this.p.requests,req.id+'.json'));
  }
  private async controls():Promise<void> {
    const names=await listRequests(this.p);
    const pending:ControlRequest[]=[];
    for(const name of names) {
      const full=join(this.p.requests,name);
      let value:unknown;
      try {value=await readJson(full);} catch {await removeFile(full);continue;}
      if (!validControl(value) || value.id+'.json'!==name) {await removeFile(full);continue;}
      if (value.instanceId!==this.id) {await this.ack(value,false,'old_instance');continue;}
      pending.push(value);
    }
    pending.sort((a,b)=>(a.action==='stop'?0:a.action==='pause'?1:2) -
      (b.action==='stop'?0:b.action==='pause'?1:2) || a.at-b.at);
    for(const req of pending) {
      // 幂等三层：内存 processed 挡同进程重复轮询；已存在的 ack 挡跨重启/文件重建
      // 的重放（不重新执行已完成语义的请求）；不同实例由上方 instanceId 校验拒绝。
      if (this.processed.has(req.id) || await ackExists(this.p,req.id)) {
        this.processed.add(req.id);
        await removeFile(join(this.p.requests,req.id+'.json'));
        continue;
      }
      this.processed.add(req.id);
      if (this.stopping) {await this.ack(req,false,'stopping');continue;}
      if (req.action==='stop') {
        this.stopping=true;this.q.pause();this.reconciliationAbort?.abort();await this.set('stopping','stop_requested');
        await this.ack(req,true);this.wake?.();
      } else if (this.faulted) await this.ack(req,false,'blocked');
      else if (req.action==='pause') {
        this.q.pause();this.reconciliationGeneration++;this.reconciliationAbort?.abort();
        // A paused runtime must not retain an old current-coverage gate.
        // Persist gate invalidation before returning the pause acknowledgement.
        if(this.reconcileEnabled&&this.archive){
          try{
            this.coverageInvalidationPending=false;
            await this.coverageInvalidationChain;
            this.archive.invalidateCurrentCoverage();
          }
          catch{
            await this.block('paused_env','coverage_invalidation_failed');
            await this.ack(req,false,'coverage_invalidation_failed');
            continue;
          }
        }
        await this.set('paused_manual','manual');await this.ack(req,true);
      } else if (this.s.phase==='paused_manual') {
        await this.set('running');this.q.resume();if(this.reconcileEnabled)this.reconciliationRequested=true;await this.ack(req,true);
      } else await this.ack(req,false,'not_paused');
    }
  }
  async run():Promise<number> {
    await initDirs(this.p);
    const prev=await readState(this.p);
    if (prev && BLOCKED.includes(prev.phase)) return 3;
    this.port.subscribe(this.sink);
    let closeFail=false;
    let pendingAtStop=0;
    const signal=()=>{if (this.stopping) return;this.stopping=true;this.q.pause();this.reconciliationAbort?.abort();this.wake?.();};
    process.on('SIGINT',signal);
    process.on('SIGTERM',signal);
    try {
      await this.set('starting');
      // A signal during initial SDK login must not leave an active connection after stop.
      await this.port.start();
      // 建库在此处而非 SDK 回调：身份已由 system.online 核验并记录，
      // 同步 DB 调用不落在回调线程上（契约 §1）。
      if(this.archivePath && !this.faulted && !this.stopping){
        if(!this.trustedIdentity){await this.block('paused_env','archive_identity_unverified');}
        else {
          try{
            this.archive=EveArchive.open(this.archivePath,this.trustedIdentity);
            if(this.reconcileEnabled){
              this.archive.upgradeToV2();
              this.archive.invalidateCurrentCoverage();
              const known=this.archive.knownConversations();
              // An Eve-authenticated, already archived thread is evidence; a guessed thread is not.
              if(known.length===1) this.confirmedConversationId=known[0];
            }
          }
          catch{await this.block('paused_env','archive_open_failed');}
        }
      }
      if (!this.stopping && !this.faulted) {await this.set('running');this.q.resume();}
      while(!this.stopping && !this.faulted) {
        await this.controls();
        if(this.stopping || this.faulted) break;
        // 断线撤销必须先完成，才允许启动新一轮对账。
        if(this.reconcileEnabled&&this.archive)await this.coverageInvalidationChain;
        // 证明有效期门控：verified 不是永久状态。即使 SDK 从未报告断线，
        // 过期证明也必须撤销，不能无限期沿用（T4 安全边界）。
        if(this.reconcileEnabled&&this.archive&&this.confirmedConversationId&&
           this.s.phase==='running'&&!this.reconciliationRunning){
          const status=this.archive.coverageStatus(this.confirmedConversationId,this.coverageMaxAgeMs);
          if(status.state==='verified'&&!status.usable){
            this.archive.invalidateCurrentCoverage();
            this.reconciliationRequested=true;
            this.wake?.();
          }
        }
        if(this.reconcileEnabled&&this.archive&&this.trustedIdentity&&this.platformOnline&&
           this.reconciliationRequested&&this.confirmedConversationId&&!this.reconciliationRunning&&this.q.isIdle&&
           this.s.phase==='running'){
          this.reconciliationRequested=false;
          const generation=this.reconciliationGeneration;
          const controller=new AbortController();
          this.reconciliationAbort=controller;
          const archive=this.archive,imUid=this.trustedIdentity.ownUids.at(-1)!;
          this.reconciliationRunning=reconcileOnce({
            port:this.port,archive,conversationId:this.confirmedConversationId!,
            imUid,instanceId:this.id,signal:controller.signal,
            limits:{pageGapMs:this.historyPageGapMs},
            isSafe:()=>!this.stopping&&!this.faulted&&this.s.phase==='running'&&
              generation===this.reconciliationGeneration&&this.platformOnline&&this.q.isIdle,
          }).then(result=>{
            if(result.state!=='verified')return; // remain read-only if coverage cannot be proved
          }).catch(()=>{void this.block('paused_env','reconcile_runtime_failed');})
            .finally(()=>{this.reconciliationRunning=undefined;if(this.reconciliationAbort===controller)this.reconciliationAbort=undefined;this.wake?.();});
        }
        this.s={...this.s,updatedAt:Date.now()};await writeState(this.p,this.s);
        await new Promise<void>(resolve=>{
          this.wake=resolve;
          setTimeout(()=>{if(this.wake===resolve)this.wake=undefined;resolve();},this.config.pollMs);
        });
      }
    } catch {
      if (!this.faulted && !this.stopping) {
        this.faulted=true;
        await this.set('error','runtime_failure').catch(()=>undefined);
      }
    } finally {
      process.off('SIGINT',signal);process.off('SIGTERM',signal);
      this.stopping=true;
      this.reconciliationAbort?.abort();
      // 故障阻塞的落盘可能仍在飞行中（溢出/拒登录都是同步触发）：
      // 必须等它完成，否则返回码与状态文件会读到落盘前的 phase。
      await this.blockPending?.catch(()=>undefined);
      pendingAtStop=this.q.length;
      await this.reconciliationRunning?.catch(()=>undefined);
      await this.q.stop();
      if(this.reconcileEnabled&&this.archive){
        try{this.archive.invalidateCurrentCoverage();}catch{closeFail=true;}
      }
      try{this.archive?.close();}catch{closeFail=true;}
      this.archive=undefined;
      // SDK offline after rejected logout is still a completed shutdown: T1 observed this case.
      try {await this.port.stop();}
      catch {closeFail=true;}
      this.wake=undefined;
    }
    if (this.faulted) return BLOCKED.includes(this.s.phase)?3:1;
    if (pendingAtStop>0) {
      await this.set('paused_env','undrained_queue_requires_reconciliation');return 3;
    }
    if (closeFail) {
      // Cannot generally prove SDK is offline from PlatformPort.stop rejecting.
      // Rejecting stop is not silently treated as clean; follow-up T2 exit semantics check.
      await this.set('error','shutdown_unconfirmed').catch(()=>undefined);
      return 1;
    }
    await this.set('stopped','normal_stop');
    return 0;
  }
}
