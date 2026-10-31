/**
 * T6-3b — PURE SDK text request construction. No SDK instance, no I/O,
 * no sendMsg, no contact lookup and no real transmission capability.
 *
 * Inputs are snapshots from an authenticated platform boundary; they are
 * cross-checked, NOT themselves proof of a live session or L1 approval.
 */
import {createHash} from 'node:crypto';
import type {SendableMessage} from 'douyin-im';

export type TextDraftReject =
 | 'invalid_input'|'identity_invalid'|'session_unverified'
 | 'contact_unverified'|'foreign_conversation'|'contact_blocked'
 | 'source_unverified'|'not_due'|'expired'
 | 'content_empty'|'content_too_long'|'content_control_chars'
 | 'content_digest_mismatch';

export interface SdkTextDraftInput{
 readonly intent:{
  readonly intentId:string; readonly aiClaimId:string;
  readonly conversationId:string;readonly sourceEventId:string;readonly status:string;readonly attempt:number;
  readonly notBeforeMs:number;readonly expiresAtMs:number;
  readonly textDigest:string;readonly body:string;
 };
 readonly expected:{readonly ownerUid:string;readonly ownImUid:string;readonly targetUid:string};
 readonly session:{
  readonly accountCount:number;readonly uid:string;readonly imUid:string;
  readonly verified:boolean;readonly online:boolean;
 };
 /** Synchronous, read-only contact snapshot. Never perform a contact search here. */
 readonly contact:{
  readonly kind:'friend'|'stranger'|'group';
  readonly uid:string;readonly accountUid:string;readonly threadId:string;
  readonly conversationType:number;readonly blocked:boolean|undefined;
 };
 readonly nowMs:number;
 readonly maxTextLength:number;
}
export interface PreparedSdkTextDraft{
 readonly intentId:string;readonly aiClaimId:string;
 readonly conversationId:string;readonly recipientUid:string;
 readonly contactKind:'friend'|'stranger';
 /** SDK text argument; never log. */
 readonly message:string;
 readonly textDigest:string;
}
export type SdkTextDraftResult=
 |{readonly ok:true;readonly draft:PreparedSdkTextDraft}
 |{readonly ok:false;readonly code:TextDraftReject};

const digits=(v:unknown):v is string=>typeof v==='string'&&/^\d+$/.test(v);
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const control=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;
const rejected=(code:TextDraftReject):SdkTextDraftResult=>({ok:false,code});

/** Verify only immutable arguments; never execute the request. */
export function prepareSdkTextDraft(input:SdkTextDraftInput):SdkTextDraftResult{
 if(!input||typeof input!=='object'||!input.intent||!input.expected||
    !input.session||!input.contact)
  return rejected('invalid_input');
 const {intent:i,expected:e,session:s,contact:c}=input;
 if(!Number.isSafeInteger(input.nowMs)||!Number.isSafeInteger(input.maxTextLength)||
    input.maxTextLength<1||input.maxTextLength>500)
  return rejected('invalid_input');
 if(!digits(e.ownerUid)||!digits(e.ownImUid)||!digits(e.targetUid)||
    e.ownerUid===e.targetUid||e.ownImUid===e.targetUid)
  return rejected('identity_invalid');
 if(s.verified!==true||s.online!==true||s.accountCount!==1||
    s.uid!==e.ownerUid||s.imUid!==e.ownImUid)
  return rejected('session_unverified');
 if(c.kind!=='friend'&&c.kind!=='stranger')
  return rejected('contact_unverified');
 if(c.uid!==e.targetUid||c.accountUid!==e.ownerUid||
    c.conversationType!==1)
  return rejected('contact_unverified');
 const p=i.conversationId?.split(':');
 if(!p||p.length!==4||p[0]!=='0'||p[1]!=='1'||
    !((p[2]===e.ownerUid||p[2]===e.ownImUid)&&p[3]===e.targetUid||
      (p[3]===e.ownerUid||p[3]===e.ownImUid)&&p[2]===e.targetUid)||
    c.threadId!==i.conversationId)
  return rejected('foreign_conversation');
 // SDK does not guarantee blocked is populated; unknown must not be
 // silently interpreted as "not blocked".
 if(c.blocked!==false)return rejected('contact_blocked');
 if(!digits(i.sourceEventId)||
    i.intentId!==digest(i.conversationId+'\0'+i.sourceEventId)||
    !/^[a-f0-9]{64}$/.test(i.intentId)||
    !/^[0-9a-f-]{36}$/.test(i.aiClaimId)||
    !/^[a-f0-9]{64}$/.test(i.textDigest)||
    i.status!=='pending'||i.attempt!==0||
    !Number.isSafeInteger(i.notBeforeMs)||
    !Number.isSafeInteger(i.expiresAtMs)||
    i.expiresAtMs<=i.notBeforeMs)
  return rejected('source_unverified');
 if(input.nowMs<i.notBeforeMs)return rejected('not_due');
 if(input.nowMs>=i.expiresAtMs)return rejected('expired');
 if(typeof i.body!=='string'||i.body.trim().length===0)
  return rejected('content_empty');
 // UTF-16 code units; exact platform length semantics remain unverified.
 if(i.body.length>input.maxTextLength)return rejected('content_too_long');
 if(control.test(i.body))return rejected('content_control_chars');
 if(digest(i.body)!==i.textDigest)return rejected('content_digest_mismatch');

 const sdkMessage:SendableMessage=i.body; // Compile-time SDK API compatibility
 if(typeof sdkMessage!=='string')return rejected('invalid_input');
 return {ok:true,draft:Object.freeze({
  intentId:i.intentId,aiClaimId:i.aiClaimId,
  conversationId:i.conversationId,recipientUid:e.targetUid,
  contactKind:c.kind,message:sdkMessage,textDigest:i.textDigest,
 })};
}
