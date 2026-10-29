import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StdioAgentTransport,classifyAgentFailure,classifyAgentExit} from '../../src/ai/agent-transport.ts';

function fixture(script:string,run:(bin:string)=>Promise<void>):Promise<void>{
 const dir=mkdtempSync(join(tmpdir(),'eve-agent-test-')),bin=join(dir,'fake-agent');
 writeFileSync(bin,'#!/usr/bin/env node\n'+script,{mode:0o700});
 chmodSync(bin,0o700);
 return run(bin).finally(()=>rmSync(dir,{recursive:true,force:true}));
}
const transport=new StdioAgentTransport();
const base={args:['-p','--tools',''],stdin:'PRIVATE_TEST_MESSAGE',timeoutMs:1500,maxOutputBytes:1000};
test('Agent transport: real child process receives input on stdin, not argv; cwd ephemeral',()=>fixture(`
let txt='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',x=>txt+=x);
process.stdin.on('end',()=>process.stdout.write(JSON.stringify({
 input:txt,argv:process.argv.slice(2),
 isolated:process.cwd().includes('eve-claude-'),envLeak:!!process.env.EVE_FAKE_SECRET,
})));
`,async(bin)=>{
 const old=process.env['EVE_FAKE_SECRET'];
 process.env['EVE_FAKE_SECRET']='secret_that_must_not_reach_child';
 try{
  const result=await transport.run({...base,executable:bin},new AbortController().signal);
  assert.equal(result.exitCode,0);
  const msg=JSON.parse(result.stdout) as Record<string,unknown>;
  assert.equal(msg['input'],'PRIVATE_TEST_MESSAGE');
  assert.deepEqual(msg['argv'],['-p','--tools','']);
  assert.equal(msg['isolated'],true);
  assert.equal(msg['envLeak'],false);
 }finally{
  if(old===undefined)delete process.env['EVE_FAKE_SECRET'];
  else process.env['EVE_FAKE_SECRET']=old;
 }
}));
test('Agent transport: hung child killed at hard timeout without exposing output',()=>fixture(`
process.stdin.resume();
setInterval(()=>{},1000);
`,async(bin)=>{
 const start=Date.now();
 await assert.rejects(transport.run({...base,executable:bin,timeoutMs:80},new AbortController().signal),
  /agent_timeout/);
 assert.ok(Date.now()-start<1200);
}));
test('Agent transport: output over configured byte limit aborts process',()=>fixture(`
process.stdin.on('data',()=>{});
process.stdout.write('z'.repeat(20000));
setInterval(()=>{},1000);
`,async(bin)=>{
 await assert.rejects(transport.run({...base,executable:bin,maxOutputBytes:400},new AbortController().signal),
  /agent_output_too_large/);
}));
test('Agent transport: user cancellation terminates CLI',()=>fixture(`
process.stdin.resume();
setInterval(()=>{},1000);
`,async(bin)=>{
 const c=new AbortController();
 const pending=transport.run({...base,executable:bin,timeoutMs:1000},c.signal);
 setTimeout(()=>c.abort(),35);
 await assert.rejects(pending,/agent_aborted/);
}));
test('Agent transport: nonexistent binary fails closed and does not return stderr',async()=>{
 await assert.rejects(transport.run({...base,executable:'/nonexistent/eve-agent-cli'},new AbortController().signal),
 /agent_start_failed/);
});


test('Agent CLI errors classify into fixed, privacy-safe codes only',()=>{
 const cases=[
  ['Unknown option --some-switch /home/PRIVATE/a','agent_cli_configuration_error'],
  ['Authentication failed: SECRET_BEARER_TO_HIDE','agent_auth_error'],
  ['fetch failed ECONNRESET at token=SECRET','agent_network_error'],
  ['Rate limit exceeded for account abc@example.org','agent_rate_limit'],
  ['Private failure from account name=SECRET','agent_execution_failed'],
 ] as const;
 for(const [raw,expected] of cases){
  const code=classifyAgentFailure(raw);
  assert.equal(code,expected);
  assert.ok(!code.includes('SECRET'));
  assert.ok(!code.includes('/home/'));
 }
});
test('Agent subprocess failure classifies stderr and never exposes raw content',()=>fixture(`
process.stderr.write('Unknown option --synthetic-secret /home/PRIVATE/test');
process.exit(3);
`,async(bin)=>{
 try{
  await transport.run({...base,executable:bin},new AbortController().signal);
  assert.fail('should reject');
 }catch(e){
  assert.ok(e instanceof Error);
  assert.equal(e.message,'agent_cli_configuration_error');
  assert.ok(!e.message.includes('PRIVATE'));
 }
}));


test('nonzero CLI with structured error envelope is classified without returning result text',()=>fixture(`
process.stdout.write(JSON.stringify({
 type:'result',subtype:'error',is_error:true,
 result:'PRIVATE_CHAT_AND_TOKEN',
}));
process.exit(7);
`,async(bin)=>{
 try{
  await transport.run({...base,executable:bin},new AbortController().signal);
  assert.fail('must fail closed');
 }catch(e){
  assert.ok(e instanceof Error);
  assert.equal(e.message,'agent_result_error');
  assert.equal(e.message.includes('PRIVATE_'),false);
 }
 assert.equal(classifyAgentExit('','garbage'), 'agent_execution_failed');
}));
