import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createClaudeBackend,createEveAgentRegistry,AgentRegistry,RegisteredAgentBackend} from '../../src/ai/agent-registry.ts';
import {buildClaudeArguments,claudeHelpRequirements} from '../../src/ai/claude-invocation.ts';
import {claudeDecisionSchema} from '../../src/ai/decision-schema.ts';
import type {AiRequest} from '../../src/ai/contracts.ts';
import type {AgentProcessTransport,AgentInvocation} from '../../src/ai/agent-transport.ts';
import {dryRunOne} from '../../src/ai/engine.ts';
import {EveArchive} from '../../src/archive/store.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const request:AiRequest={instructions:'Always output a decision JSON',turns:[{role:'user',text:'hello'}]};
const envelope=(decision:unknown)=>JSON.stringify({
 type:'result',subtype:'success',is_error:false,structured_output:{decision},
});
test('T5 Agent registry only enables Claude; unregistered tools are rejected',()=>{
 const registry=createEveAgentRegistry();
 assert.deepEqual(registry.ids(),['claude_code']);
 assert.throws(()=>registry.get('opencode'),/agent_not_registered/);
 assert.throws(()=>registry.register(registry.get('claude_code')),/agent_definition_rejected/);
 const insecure={...registry.get('claude_code'),id:'unsafe',capabilities:{
  toolExecution:true,filesystem:false,mcp:false,messageSend:false,
 }};
 assert.throws(()=>registry.register(insecure as never),/agent_definition_rejected/);
});
test('Claude Code invocation: stdin contains conversation; argv contains no private text and tools/MCP disabled',async()=>{
 let seen:AgentInvocation|undefined;
 const transport:AgentProcessTransport={run:async(invocation)=>{
  seen=invocation;
  return {exitCode:0,stdout:envelope({action:'skip',reason:'no reply'})};
 }};
 const result=await createClaudeBackend(transport).evaluate(request,new AbortController().signal);
 assert.deepEqual(result,{action:'skip',reason:'no reply'});
 assert.ok(seen);
 assert.equal(seen.executable,'claude');
 assert.ok(seen.args.includes('--safe-mode'));
 assert.ok(seen.args.includes('--strict-mcp-config'));
 assert.ok(seen.args.includes('--no-chrome'));
 assert.ok(seen.args.includes('--disable-slash-commands'));
 assert.ok(seen.args.includes('--no-session-persistence'));
 assert.ok(seen.args.includes('--json-schema'));
 // --json-schema 依赖内置 StructuredOutput 工具；只放行它，不放行其他工具。
 assert.equal(seen.args[seen.args.indexOf('--tools')+1],'StructuredOutput');
 assert.equal(seen.args.includes('--disallowedTools'),false,'不能再用 * 把 StructuredOutput 一并禁掉');
 // 不设 --max-turns：结构化输出需要额外工具回合，实测 1/2 都会 error_max_turns。
 assert.equal(seen.args.includes('--max-turns'),false);
 assert.ok(seen.stdin.includes('hello'));
 assert.ok(!seen.args.join(' ').includes('hello'));
 assert.equal(seen.timeoutMs,30000);
 assert.equal(seen.maxOutputBytes,65536);
 assert.deepEqual(JSON.parse(seen.stdin),request);
 assert.deepEqual(seen.args,buildClaudeArguments());
 assert.deepEqual(JSON.parse(seen.args[seen.args.indexOf('--json-schema')+1]!),claudeDecisionSchema);
 assert.ok(claudeHelpRequirements().includes('--print'));
 assert.ok(claudeHelpRequirements().includes('--tools'));
});
test('Claude result parser: only result success structured_output may cross boundary',async()=>{
 const malformed=[
  '{}','not json',JSON.stringify({type:'result',subtype:'error',is_error:true,structured_output:{action:'skip',reason:'ok'}}),
  JSON.stringify({type:'result',subtype:'success',is_error:false,result:'{"action":"skip","reason":"ok"}'}),
  JSON.stringify({type:'assistant',is_error:false,structured_output:{action:'skip',reason:'ok'}}),
 ];
 for(const stdout of malformed){
  const transport:AgentProcessTransport={run:async()=>({exitCode:0,stdout})};
  await assert.rejects(createClaudeBackend(transport).evaluate(request,new AbortController().signal),
   /agent_(invalid_output|result_error)/);
 }
});
test('Claude backend: aborted call never reaches CLI transport',async()=>{
 let calls=0;
 const transport:AgentProcessTransport={run:async()=>{calls++;return {exitCode:0,stdout:envelope({action:'skip',reason:'ok'})};}};
 const ctrl=new AbortController();ctrl.abort();
 await assert.rejects(createClaudeBackend(transport).evaluate(request,ctrl.signal),/agent_aborted/);
 assert.equal(calls,0);
});
test('Claude backend: concurrent invocation rejected, no second subprocess',async()=>{
 let calls=0,unblock:((value:{exitCode:number;stdout:string})=>void)|undefined;
 const transport:AgentProcessTransport={run:async()=>{
  calls++;return new Promise(resolve=>{unblock=resolve;});
 }};
 const backend=createClaudeBackend(transport);
 const first=backend.evaluate(request,new AbortController().signal);
 await assert.rejects(backend.evaluate(request,new AbortController().signal),/agent_execution_failed/);
 assert.equal(calls,1);
 assert.ok(unblock);unblock({exitCode:0,stdout:envelope({action:'skip',reason:'ok'})});
 assert.deepEqual(await first,{action:'skip',reason:'ok'});
});
test('Claude backend: capability flags do not authorize arbitrary Agent command',()=>{
 const registry=new AgentRegistry();
 const wrong={id:'allow_shell',executable:'sh',capabilities:{
  toolExecution:false,filesystem:false,mcp:false,messageSend:true,
 },buildInvocation:()=>({executable:'sh',args:[],stdin:'',timeoutMs:1000,maxOutputBytes:1000}),parseOutput:()=>({})};
 assert.throws(()=>registry.register(wrong as never),/agent_definition_rejected/);
});
