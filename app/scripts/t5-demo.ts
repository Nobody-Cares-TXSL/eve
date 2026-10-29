/** Fully offline T5 contract demo. Temporary SQLite only, no API key or SDK network. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EveArchive} from '../src/archive/store.ts';
import {MockPlatformPort} from '../src/platform/mock.ts';
import {reconcileOnce} from '../src/runtime/reconcile.ts';
import {durableDryRunOne} from '../src/ai/engine.ts';
import {createClaudeBackend} from '../src/ai/agent-registry.ts';
import {inspectClaudeExecutable} from '../src/ai/claude-preflight.ts';
import type {InboundMessage} from '../src/platform/types.ts';

const thread='0:1:222:333';
const fixture=(n:number,text:string):InboundMessage=>({
 conversationId:thread,serverMessageId:String(7701260499833538097n+BigInt(n)),
 clientMessageId:null,senderUid:'333',fromSelf:false,text,kind:'text',
 messageType:7,createTime:String(3000+n),indexInConversation:String(n),
});
const realClaude=process.argv.includes('--claude');
if(realClaude && process.env['EVE_T5_CLAUDE_CALL']!=='1'){
 console.error('claude_call_requires_explicit_opt_in');
 process.exit(2);
}
if(realClaude){
 const check=inspectClaudeExecutable();
 if(check.status!=='ready'){
  console.error('claude_preflight_'+check.code);
  process.exit(2);
 }
}
const dir=mkdtempSync(join(tmpdir(),'eve-t5-demo-'));
const archive=EveArchive.open(join(dir,'demo.sqlite'),
 {ownerUid:'111',targetUid:'333',ownUids:['111','222']});
const port=new MockPlatformPort({uid:'111',imUid:'222'});
const backend=createClaudeBackend(realClaude ? undefined : {
 run:async()=>({exitCode:0,stdout:JSON.stringify({
  type:'result',subtype:'success',is_error:false,
  structured_output:{decision:{action:'reply',text:'可以呀，什么时候方便？',
   reason:'回应约时间',delayMs:2000}},
 })}),
});
try{
 archive.upgradeToV2();
 archive.upgradeToV3();
 port.delivered.push(fixture(0,'你好'));
 const first=await reconcileOnce({
  archive,port,conversationId:thread,instanceId:'baseline',imUid:'222',isSafe:()=>true,
 });
 if(first.state!=='verified')throw Error('fixture_baseline_failed');
 port.delivered.push(fixture(1,'这周有时间一起聊聊吗？'));
 const second=await reconcileOnce({
  archive,port,conversationId:thread,instanceId:'incremental',imUid:'222',isSafe:()=>true,
 });
 if(second.state!=='verified')throw Error('fixture_reconcile_failed');
 const audit=await durableDryRunOne(archive,backend,{conversationId:thread,maxAgeMs:90_000,timeoutMs:30_000});
 console.log(JSON.stringify({mode:realClaude?'claude_code_manual_fixture':'offline_t5_demo',platformNetwork:'disabled',
  realModelNetwork:realClaude?'claude_opt_in':'disabled',messagesSent:0,eligibleConsumed:0,aiLedger:archive.aiAttemptStats(),audit},null,2));
 if(realClaude&&audit.status!=='dry_run')process.exitCode=4;
}finally{
 archive.close();
 rmSync(dir,{recursive:true,force:true});
}
