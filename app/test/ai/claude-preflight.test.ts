import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectClaudeExecutable} from '../../src/ai/claude-preflight.ts';
import {claudeHelpRequirements} from '../../src/ai/claude-invocation.ts';

const flags=claudeHelpRequirements().join(' ');
function stub(auth=true,help=flags){
 const dir=mkdtempSync(join(tmpdir(),'eve-claude-preflight-'));
 const bin=join(dir,'claude');
 const code=[
  '#!/usr/bin/env node',
  "if(process.argv.includes('-p')||process.argv.includes('--print'))process.exit(100);",
  "if(process.argv[2]==='--version'){console.log('2.1.310 (Claude Code)');process.exit(0)}",
  "if(process.argv[2]==='--help'){console.log("+JSON.stringify(help)+");process.exit(0)}",
  "if(process.argv[2]==='auth'&&process.argv[3]==='status'){console.log("+JSON.stringify(JSON.stringify({loggedIn:auth,authMethod:'oauth_token',email:'not_for_output@example.net'}))+");process.exit(0)}",
  'process.exit(90)',
 ].join('\n');
 writeFileSync(bin,code,{mode:0o700});
 return {bin,close:()=>rmSync(dir,{recursive:true,force:true})};
}

test('Claude preflight uses only local --version/--help/auth status and emits no private fields',()=>{
 const x=stub();
 try{
  const check=inspectClaudeExecutable(x.bin);
  assert.equal(check.status,'ready');
  assert.equal(check.code,'ready');
  assert.equal(check.authMode,'oauth');
  assert.equal(check.modelRequests,0);
  assert.equal(check.cliVersion,'2.1.310');
  assert.ok(!JSON.stringify(check).includes('not_for_output'));
 }finally{x.close();}
});
test('Claude preflight fails closed for missing CLI, missing flag, and logged-out auth',()=>{
 assert.equal(inspectClaudeExecutable('/missing/claude-bin').code,'cli_missing');
 const a=stub(false),b=stub(true,flags.replace('--json-schema',''));
 try{
  assert.equal(inspectClaudeExecutable(a.bin).code,'not_logged_in');
  assert.equal(inspectClaudeExecutable(b.bin).code,'cli_flags_missing');
 }finally{a.close();b.close();}
});
