/**
 * T6-2b: STRICTLY offline mock-only dispatch boundary.
 * This module cannot access douyin-im or PlatformPort.
 * The ledger's 'sent' here means simulated acknowledgement, not a real send.
 */
import {createHash} from 'node:crypto';
import {EveArchive} from '../archive/store.ts';

export type MockOutcome='confirmed'|'rejected_before_dispatch'|'ambiguous'|'throws'|'hang';

export class MockSendPort{
 readonly kind='mock_send_port' as const;
 calls=0;
 readonly outcome:MockOutcome;
 constructor(outcome:MockOutcome='confirmed'){this.outcome=outcome;}
 async transmit(conversationId:string,text:string):Promise<
  |{kind:'mock_confirmed';evidence:string}
  |{kind:'rejected_before_dispatch'}
  |{kind:'ambiguous'}>{
  this.calls++;
  if(this.outcome==='throws')throw Error('mock_transport_failure');
  if(this.outcome==='hang')return new Promise(()=>undefined);
  if(this.outcome==='rejected_before_dispatch')return {kind:'rejected_before_dispatch'};
  if(this.outcome==='ambiguous')return {kind:'ambiguous'};
  const digest=createHash('sha256').update(conversationId+'\0'+text).digest('hex');
  return {kind:'mock_confirmed',evidence:'mock:'+digest};
 }
}
export type MockDispatchResult=
 |{status:'blocked';reason:'mock_not_authorized'|'invalid_context'|'source_unverified'|'already_claimed'}
 |{status:'mock_sent';intentId:string}
 |{status:'failed';intentId:string}
 |{status:'unknown';intentId:string;reason:'timeout'|'transport_error'|'ambiguous_result'};

/** No SDK reachable. Even a positive outcome is proof of MOCK only. */
export async function dispatchMockOnce(
 archive:EveArchive,port:MockSendPort,
 input:{
  intentId:string;
  now:number;
  maxAgeMs:number;
  maxLength:number;
  timeoutMs:number;
  identity:{ownerUid:string;targetUid:string;ownImUid?:string};
  runtime:{phase:string;paused:boolean};
  allowMockOnly:true;
 },
):Promise<MockDispatchResult>{
 if(input.allowMockOnly!==true||!(port instanceof MockSendPort))
  return {status:'blocked',reason:'mock_not_authorized'};
 if(!Number.isSafeInteger(input.now)||!Number.isSafeInteger(input.maxAgeMs)||
    !Number.isSafeInteger(input.timeoutMs)||!Number.isSafeInteger(input.maxLength)||
    input.maxAgeMs<1||input.timeoutMs<1||input.timeoutMs>30_000||
    input.maxLength<1||input.maxLength>500||
    input.runtime.phase!=='running'||input.runtime.paused||
    !archive.matchSendIdentity(input.identity))
  return {status:'blocked',reason:'invalid_context'};
 const ready=archive.mockDispatchCandidate(input.intentId,input.now,input.maxAgeMs);
 if(!ready||ready.text.length>input.maxLength)
  return {status:'blocked',reason:'source_unverified'};
 if(!archive.claimSendIntent(input.intentId,input.now))
  return {status:'blocked',reason:'already_claimed'};
 // Check proof, body expiry and T5 recorded digest AGAIN after claim, before
 // any mock invocation. No more asynchronous work until port.transmit().
 const latest=archive.mockDispatchCandidate(input.intentId,input.now,input.maxAgeMs);
 if(!latest||latest.conversationId!==ready.conversationId||latest.text!==ready.text){
  archive.settleSendIntent(input.intentId,{status:'failed',reasonCode:'rejected_before_dispatch'},input.now);
  return {status:'failed',intentId:input.intentId};
 }
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const timed=new Promise<never>((_,reject)=>{
   timer=setTimeout(()=>reject(Error('mock_timeout')),input.timeoutMs);
  });
  const result=await Promise.race([port.transmit(latest.conversationId,latest.text),timed]);
  if(result.kind==='mock_confirmed'&&/^mock:[a-f0-9]{64}$/.test(result.evidence)){
   archive.settleSendIntent(input.intentId,{status:'sent',evidence:result.evidence},input.now);
   return {status:'mock_sent',intentId:input.intentId};
  }
  if(result.kind==='rejected_before_dispatch'){
   archive.settleSendIntent(input.intentId,{status:'failed',reasonCode:'rejected_before_dispatch'},input.now);
   return {status:'failed',intentId:input.intentId};
  }
  archive.settleSendIntent(input.intentId,{status:'unknown',reasonCode:'ambiguous_result'},input.now);
  return {status:'unknown',intentId:input.intentId,reason:'ambiguous_result'};
 }catch(e){
  const reason=e instanceof Error&&e.message==='mock_timeout'?'timeout':'transport_error';
  archive.settleSendIntent(input.intentId,{status:'unknown',reasonCode:reason},input.now);
  return {status:'unknown',intentId:input.intentId,reason};
 }finally{if(timer)clearTimeout(timer);}
}
