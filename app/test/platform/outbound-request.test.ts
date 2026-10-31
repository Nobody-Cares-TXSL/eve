import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {prepareSdkTextDraft,type SdkTextDraftInput,type TextDraftReject} from '../../src/platform/outbound-request.ts';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const NOW=1_793_520_000_000;
const THREAD='0:1:10000000000002:1000000000000003';
const BODY='这是一条模拟的 SDK 文本消息';
const base=():SdkTextDraftInput=>({
 intent:{
  intentId:hash(THREAD+'\0'+'9000000000000000001'),
  aiClaimId:'01234567-89ab-cdef-0123-456789abcdef',
  conversationId:THREAD,sourceEventId:'9000000000000000001',status:'pending',attempt:0,
  notBeforeMs:NOW-10,expiresAtMs:NOW+600000,textDigest:hash(BODY),body:BODY,
 },
 expected:{ownerUid:'1000000000000001',ownImUid:'10000000000002',targetUid:'1000000000000003'},
 session:{accountCount:1,uid:'1000000000000001',
  imUid:'10000000000002',verified:true,online:true},
 contact:{kind:'friend',uid:'1000000000000003',accountUid:'1000000000000001',
  threadId:THREAD,conversationType:1,blocked:false},
 nowMs:NOW,maxTextLength:500,
});
function reject(input:SdkTextDraftInput,code:TextDraftReject){
 const result=prepareSdkTextDraft(input);
 assert.deepEqual(result,{ok:false,code});
 assert.equal(JSON.stringify(result).includes(BODY),false);
}

test('T6-3b: text-only SDK draft, no side effects or model/platform calls',()=>{
 const x=base(),res=prepareSdkTextDraft(x);
 assert.equal(res.ok,true);
 if(!res.ok)return;
 assert.equal(res.draft.message,BODY);
 assert.equal(res.draft.intentId,x.intent.intentId);
 assert.equal(res.draft.recipientUid,x.expected.targetUid);
 assert.equal(res.draft.conversationId,THREAD);
 assert.equal(res.draft.contactKind,'friend');
 assert.equal(res.draft.textDigest,hash(BODY));
 assert.equal(Object.keys(res.draft).sort().join(','),
  'aiClaimId,contactKind,conversationId,intentId,message,recipientUid,textDigest');
 assert.equal(Object.isFrozen(res.draft),true);
});
test('T6-3b: authenticated stranger contact also supports pure-text draft',()=>{
 const x=base();
 const res=prepareSdkTextDraft({...x,contact:{...x.contact,kind:'stranger'}});
 assert.equal(res.ok,true);
 if(res.ok)assert.equal(res.draft.contactKind,'stranger');
});
test('T6-3b: account mismatch, offline, session invalid, or multiple accounts block',()=>{
 const x=base();
 reject({...x,session:{...x.session,verified:false}},'session_unverified');
 reject({...x,session:{...x.session,online:false}},'session_unverified');
 reject({...x,session:{...x.session,uid:'999'}},'session_unverified');
 reject({...x,session:{...x.session,imUid:'999'}},'session_unverified');
 reject({...x,session:{...x.session,accountCount:2}},'session_unverified');
 reject({...x,session:{...x.session,accountCount:0}},'session_unverified');
 reject({...x,expected:{...x.expected,targetUid:x.expected.ownerUid}},'identity_invalid');
});
test('T6-3b: foreign thread or contact is rejected, never infer target from nicknames',()=>{
 const x=base();
 reject({...x,contact:{...x.contact,threadId:'0:1:10000000000002:999'}},'foreign_conversation');
 reject({...x,contact:{...x.contact,uid:'999'}},'contact_unverified');
 reject({...x,contact:{...x.contact,accountUid:'999'}},'contact_unverified');
 reject({...x,contact:{...x.contact,conversationType:2}},'contact_unverified');
 reject({...x,contact:{...x.contact,kind:'group'}},'contact_unverified');
 reject({...x,intent:{...x.intent,conversationId:'0:2:10000000000002:1000000000000003'}},'foreign_conversation');
 reject({...x,intent:{...x.intent,conversationId:'0:1:999:1000000000000003'}},'foreign_conversation');
});
test('T6-3b: missing blocked metadata, known blocked both fail closed',()=>{
 const x=base();
 reject({...x,contact:{...x.contact,blocked:undefined}},'contact_blocked');
 reject({...x,contact:{...x.contact,blocked:true}},'contact_blocked');
});
test('T6-3b: only linked v5 pending, first attempt is accepted',()=>{
 const x=base();
 reject({...x,intent:{...x.intent,status:'dispatching'}},'source_unverified');
 reject({...x,intent:{...x.intent,status:'sent'}},'source_unverified');
 reject({...x,intent:{...x.intent,attempt:1}},'source_unverified');
 reject({...x,intent:{...x.intent,aiClaimId:''}},'source_unverified');
 reject({...x,intent:{...x.intent,intentId:'invented'}},'source_unverified');
 reject({...x,intent:{...x.intent,sourceEventId:'9000000000000000002'}},'source_unverified');
 reject({...x,intent:{...x.intent,intentId:hash('forged')}},'source_unverified');
 reject({...x,intent:{...x.intent,textDigest:'bad'}},'source_unverified');
 reject({...x,intent:{...x.intent,expiresAtMs:x.intent.notBeforeMs}},'source_unverified');
});
test('T6-3b: not_before and expiry boundary [not_before, expiry)',()=>{
 const x=base();
 reject({...x,nowMs:x.intent.notBeforeMs-1},'not_due');
 assert.equal(prepareSdkTextDraft({...x,nowMs:x.intent.notBeforeMs}).ok,true);
 assert.equal(prepareSdkTextDraft({...x,nowMs:x.intent.expiresAtMs-1}).ok,true);
 reject({...x,nowMs:x.intent.expiresAtMs},'expired');
 reject({...x,nowMs:x.intent.expiresAtMs+1},'expired');
});
test('T6-3b: content whitespace, digest, control chars and UTF-16 length',()=>{
 const x=base();
 reject({...x,intent:{...x.intent,body:'    '}},'content_empty');
 reject({...x,intent:{...x.intent,body:BODY+'x'}},'content_digest_mismatch');
 reject({...x,intent:{...x.intent,body:'hello\u0000world'}},'content_control_chars');
 const exact='x'.repeat(500);
 const valid=prepareSdkTextDraft({...x,intent:{...x.intent,body:exact,textDigest:hash(exact)}});
 assert.equal(valid.ok,true);
 const tooLong='x'.repeat(501);
 reject({...x,intent:{...x.intent,body:tooLong,textDigest:hash(tooLong)}},'content_too_long');
 const emoji='😀'.repeat(250);
 assert.equal(emoji.length,500);
 assert.equal(prepareSdkTextDraft({...x,intent:{...x.intent,body:emoji,textDigest:hash(emoji)}}).ok,true);
 reject({...x,maxTextLength:501},'invalid_input');
});
test('T6-3b: request builder has no runtime SDK import or send invocation',()=>{
 const source=readFileSync(new URL('../../src/platform/outbound-request.ts',import.meta.url),'utf8');
 assert.match(source,/import type \{SendableMessage\} from 'douyin-im'/);
 assert.doesNotMatch(source,/import\s*\{[^}]+\}\s*from ['"]douyin-im['"]/);
 assert.doesNotMatch(source,/\.sendMsg\s*\(/);
 assert.doesNotMatch(source,/\.pickFriend\s*\(/);
 assert.doesNotMatch(source,/\.pickStranger\s*\(/);
});
