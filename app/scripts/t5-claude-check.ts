import {inspectClaudeExecutable} from '../src/ai/claude-preflight.ts';

const check=inspectClaudeExecutable();
console.log(JSON.stringify(check,null,2));
if(check.status!=='ready')process.exitCode=2;
