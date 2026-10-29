import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

/** Production CLI entrypoint exercised with a fake binary; NEVER invokes actual Claude. */
function mockedClaude(script:string){
 const dir=mkdtempSync(join(tmpdir(),'eve-t5-cli-smoke-'));
 try{
  const bin=join(dir,'claude');
  const preflight=`
const argv=process.argv.slice(2);
if(argv.length===1&&argv[0]==='--version'){console.log('2.1.310 (Claude Code)');process.exit(0);}
if(argv.length===1&&argv[0]==='--help'){
 console.log('--safe-mode --print --output-format --json-schema --tools --disallowedTools --strict-mcp-config --disable-slash-commands --no-session-persistence --max-budget-usd --no-chrome');
 process.exit(0);
}
if(argv.length===2&&argv[0]==='auth'&&argv[1]==='status'){
 console.log(JSON.stringify({loggedIn:true,authMethod:'oauth_token'}));
 process.exit(0);
}
`;
  writeFileSync(bin,'#!/usr/bin/env node\n'+preflight+script,{mode:0o700});
  chmodSync(bin,0o700);
  const execution=spawnSync(process.execPath,['scripts/t5-demo.ts','--claude'],{
   cwd:resolve(process.cwd()),
   env:{...process.env,PATH:dir+':'+(process.env['PATH']??''),
    EVE_T5_CLAUDE_CALL:'1',EVE_TEST_ONLY_MARKER:'1'},
   encoding:'utf8',timeout:14000,maxBuffer:65536,
  });
  return execution;
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('T5 real-mode entrypoint with fake Claude succeeds ONLY for verified structured result',()=>{
 const r=mockedClaude(`
process.stdin.resume();
process.stdin.on('end',()=>{
 const envelope={type:'result',subtype:'success',is_error:false,
  structured_output:{decision:{action:'skip',reason:'synthetic'}}};
 process.stdout.write(JSON.stringify(envelope));
});
`);
 assert.equal(r.status,0,r.stderr);
 const obj=JSON.parse(r.stdout) as {mode:string;messagesSent:number;eligibleConsumed:number;
  aiLedger:{recorded:number};audit:{status:string;backendId:string}};
 assert.equal(obj.mode,'claude_code_manual_fixture');
 assert.equal(obj.messagesSent,0);
 assert.equal(obj.eligibleConsumed,0);
 assert.equal(obj.aiLedger.recorded,1);
 assert.equal(obj.audit.status,'dry_run');
 assert.equal(obj.audit.backendId,'claude_code');
});
test('T5 real-mode entrypoint with fake CLI auth failure exits nonzero and never leaks stderr',()=>{
 const r=mockedClaude(`
process.stderr.write('Authentication failed SECRET_TOKEN_very_private');
process.exit(3);
`);
 assert.equal(r.status,4);
 const obj=JSON.parse(r.stdout) as {messagesSent:number;aiLedger:{blocked:number};
  audit:{status:string;reasonCode:string}};
 assert.equal(obj.messagesSent,0);
 assert.equal(obj.aiLedger.blocked,1);
 assert.equal(obj.audit.status,'blocked');
 assert.equal(obj.audit.reasonCode,'agent_auth_error');
 assert.ok(!r.stdout.includes('SECRET_TOKEN'));
 assert.ok(!r.stderr.includes('SECRET_TOKEN'));
});
