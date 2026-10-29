import assert from 'node:assert/strict';
import {test} from 'node:test';
import {claudeDecisionSchema} from '../../src/ai/decision-schema.ts';
import {DECISION_LIMITS,validateDecision} from '../../src/ai/decision.ts';
import {buildClaudeArguments,claudeHelpRequirements,CLAUDE_FLAGS} from '../../src/ai/claude-invocation.ts';

type SchemaNode=Record<string,unknown>;
const root=claudeDecisionSchema;
const branches=root.properties.decision.anyOf as unknown as SchemaNode[];

function shapeAllows(value:unknown):boolean{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const obj=value as Record<string,unknown>;
 return branches.some(branch=>{
  const properties=branch['properties'] as Record<string,SchemaNode>;
  const required=branch['required'] as string[];
  if(Object.keys(obj).length!==required.length||
     !required.every(k=>Object.hasOwn(obj,k)))return false;
  return required.every(k=>{
   const spec=properties[k]!;
   if(spec['type']==='integer')return typeof obj[k]==='number'&&Number.isInteger(obj[k]);
   if(spec['type']==='string'){
    if(typeof obj[k]!=='string')return false;
    if(spec['enum'])return (spec['enum'] as string[]).includes(obj[k] as string);
    return true;
   }
   return false;
  });
 });
}

test('Claude schema uses object root and nested anyOf, never unsupported oneOf or bounds',()=>{
 assert.equal(root.type,'object');
 assert.equal(root.additionalProperties,false);
 assert.deepEqual(root.required,['decision']);
 assert.equal(branches.length,3);
 assert.deepEqual(branches.map(b=>(b['properties'] as Record<string,{enum?:string[]}>).action?.enum?.[0]),
  ['reply','skip','defer']);
 for(const b of branches){
  assert.equal(b['type'],'object');
  assert.equal(b['additionalProperties'],false);
  assert.deepEqual(Object.keys(b['properties'] as object).sort(),(b['required'] as string[]).slice().sort());
 }
 const text=JSON.stringify(root);
 for(const unsupported of ['oneOf','minimum','maximum','minLength','maxLength','multipleOf'])
  assert.ok(!text.includes('"'+unsupported+'":'),unsupported);
 assert.ok(text.includes(String(DECISION_LIMITS.replyDelayMax)));
 assert.ok(text.includes(String(DECISION_LIMITS.deferDelayMin)));
});
test('Claude structural schema rejects exactly the invalid action-key combinations',()=>{
 const cases:[unknown,boolean][]=[
  [{action:'reply',text:'你好',reason:'x',delayMs:0},true],
  [{action:'skip',reason:'x'},true],
  [{action:'defer',reason:'x',delayMs:1000},true],
  [{action:'reply',reason:'x',delayMs:0},false],
  [{action:'skip',reason:'x',delayMs:0},false],
  [{action:'defer',reason:'x'},false],
  [{action:'reply',text:'x',reason:'x'},false],
  [{action:'reply',text:'x',reason:'x',delayMs:0,toolCall:'shell'},false],
  [{action:'defer',reason:'x',delayMs:'1000'},false],
  [{action:'unknown',reason:'x'},false],
 ];
 for(const [value,allow] of cases){
  assert.equal(shapeAllows(value),allow,JSON.stringify(value));
  if(!allow)assert.throws(()=>validateDecision(value),/invalid_decision/);
  else assert.equal(validateDecision(value).action,(value as {action:string}).action);
 }
});
test('Claude numeric and text restrictions are enforced locally, even if remote schema cannot',()=>{
 const valid=[
  {action:'reply',text:'x',reason:'y',delayMs:DECISION_LIMITS.replyDelayMin},
  {action:'reply',text:'x',reason:'y',delayMs:DECISION_LIMITS.replyDelayMax},
  {action:'defer',reason:'x',delayMs:DECISION_LIMITS.deferDelayMin},
  {action:'defer',reason:'x',delayMs:DECISION_LIMITS.deferDelayMax},
 ];
 for(const value of valid){
  assert.ok(shapeAllows(value));
  assert.doesNotThrow(()=>validateDecision(value));
 }
 const invalid=[
  {action:'reply',text:'x',reason:'y',delayMs:DECISION_LIMITS.replyDelayMax+1},
  {action:'defer',reason:'x',delayMs:DECISION_LIMITS.deferDelayMin-1},
  {action:'reply',text:' ',reason:'x',delayMs:0},
  {action:'reply',text:'x'.repeat(DECISION_LIMITS.replyTextMax+1),reason:'x',delayMs:0},
 ];
 for(const value of invalid){
  assert.equal(shapeAllows(value),true,'remote shape intentionally cannot enforce length/range');
  assert.throws(()=>validateDecision(value),/invalid_decision/);
 }
});
test('Claude preflight flags derive from invocation; hidden max-turns is the only deliberate exception',()=>{
 const args=buildClaudeArguments();
 assert.ok(args.includes('--max-turns'));
 assert.equal(args[args.indexOf('--max-turns')+1],'1');
 assert.deepEqual(claudeHelpRequirements(),
  CLAUDE_FLAGS.filter(x=>!x.hiddenFromHelp).map(x=>x.flag==='-p'?'--print':x.flag));
 assert.equal(CLAUDE_FLAGS.filter(x=>x.hiddenFromHelp).length,1);
 assert.equal(CLAUDE_FLAGS.filter(x=>x.hiddenFromHelp)[0]?.flag,'--max-turns');
 assert.ok(!args.join(' ').includes('PRIVATE_REAL_CHAT'));
});
