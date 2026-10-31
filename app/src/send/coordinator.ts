/**
 * T6-2a offline composition: trusted archive coverage + durable budget
 * snapshot -> SendPolicy -> durable pending intent. No SDK, no claim, no send.
 *
 * Caller runtime/identity MUST come from the authenticated Runner once wired.
 * This module is NOT a production dispatch authorization.
 */
import {EveArchive,ArchiveError} from '../archive/store.ts';
import {validateDecision,DecisionContractError} from '../ai/decision.ts';
import type {AiDecision} from '../ai/contracts.ts';
import {evaluateSendIntent,type SendPolicy,type SendRejectCode} from './policy.ts';

export interface PrepareSendInput{
 readonly conversationId:string;
 readonly sourceEventId:string;
 readonly eventIds:readonly string[];
 readonly decision:AiDecision;
 readonly identity:{readonly ownerUid:string;readonly targetUid:string;readonly ownImUid?:string};
 readonly runtime:{readonly phase:string;readonly paused:boolean};
 readonly policy:Omit<SendPolicy,'recentSends'>;
 readonly now:number;
 readonly coverageMaxAgeMs:number;
 readonly retentionMs:number;
}
export type PrepareSendResult=
 | {readonly status:'rejected';readonly reasonCode:SendRejectCode|'ledger_unavailable'|'invalid_decision'|'invalid_event_group'}
 | {readonly status:'created';readonly intentId:string}
 | {readonly status:'duplicate';readonly intentId:string;readonly existingStatus?:string};

/** Privacy: success and failure contain no message body. */
export function prepareSendIntent(archive:EveArchive,input:PrepareSendInput):PrepareSendResult{
 const reject=(reasonCode:Extract<PrepareSendResult,{status:'rejected'}>['reasonCode']):PrepareSendResult=>
  ({status:'rejected',reasonCode});
 if(!Number.isSafeInteger(input.now)||!Number.isSafeInteger(input.retentionMs)||
    input.retentionMs<1||input.retentionMs>7*86_400_000||
    !Number.isSafeInteger(input.coverageMaxAgeMs)||input.coverageMaxAgeMs<1)
  return reject('invalid_policy');
 if(!Array.isArray(input.eventIds)||input.eventIds.length<1||input.eventIds.length>3||
    !input.eventIds.includes(input.sourceEventId)||
    new Set(input.eventIds).size!==input.eventIds.length||
    input.eventIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id)))
  return reject('invalid_event_group');
 let decision:AiDecision;
 try{decision=validateDecision(input.decision);}
 catch(e){
  if(e instanceof DecisionContractError)return reject('invalid_decision');
  return reject('invalid_decision');
 }
 try{
  // SQLite v4 is required. A claimed runtime 'verified' is never accepted.
  if(!archive.matchSendIdentity(input.identity))return reject('identity_invalid');
  const proof=archive.coverageEpoch(input.conversationId,input.coverageMaxAgeMs);
  const coverage=archive.coverageStatus(input.conversationId,input.coverageMaxAgeMs);
  const history=archive.sendPolicySnapshot(input.conversationId,input.now);
  const evaluation=evaluateSendIntent({
   decision,conversationId:input.conversationId,sourceEventId:input.sourceEventId,
   identity:input.identity,coverage:{usable:coverage.usable,state:coverage.state},
   runtime:input.runtime,now:input.now,
   policy:{...input.policy,recentSends:history.recentSends},
   priorIntents:history.priorIntents,
  });
  if(!evaluation.ok)return reject(evaluation.code);
  // Defensive recheck: proof must not rotate between evaluation and persistence.
  if(!proof)return reject('coverage_unusable');
  const r=archive.saveSendIntent({
   intentId:evaluation.intent.intentId,
   conversationId:evaluation.intent.conversationId,
   sourceEventId:evaluation.intent.sourceEventId,
   text:evaluation.intent.text,
   textDigest:evaluation.intent.textDigest,
   decisionDigest:evaluation.intent.decisionDigest,
   eventIds:input.eventIds,now:input.now,retentionMs:input.retentionMs,
   expectedProofEpoch:proof,proofMaxAgeMs:input.coverageMaxAgeMs,
   ratePolicy:{
    minIntervalMs:input.policy.minIntervalMs,
    maxPerHour:input.policy.maxPerHour,
    maxPerDay:input.policy.maxPerDay,
   },
  });
  if(!r.created)return r.existingStatus===undefined
   ?{status:'duplicate',intentId:r.intentId}
   :{status:'duplicate',intentId:r.intentId,existingStatus:r.existingStatus};
  return {status:'created',intentId:r.intentId};
 }catch(e){
  if(e instanceof ArchiveError){
   if(e.code==='send_coverage_changed'||e.code==='coverage_unusable')
    return reject('coverage_unusable');
   if(e.code==='rejected')return reject('identity_invalid');
   if(e.code==='invalid_event_group')return reject('invalid_event_group');
   if(e.code==='send_rate_limited')return reject('rate_limited');
   if(e.code==='send_min_interval')return reject('min_interval');
   if(e.code==='send_clock_rollback'||e.code==='invalid_send_rate_policy')
    return reject('invalid_policy');
  }
  return reject('ledger_unavailable');
 }
}
