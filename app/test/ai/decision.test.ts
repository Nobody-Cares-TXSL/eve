import assert from 'node:assert/strict';
import {test} from 'node:test';
import {validateDecision} from '../../src/ai/decision.ts';

test('reply requires bounded, nonempty content and delay',()=>{
 const reply=validateDecision({action:'reply',text:'  你好 ',reason:'回应问候',delayMs:200});
 assert.deepEqual(reply,{action:'reply',text:'你好',reason:'回应问候',delayMs:200});
 for(const invalid of [
  {action:'reply',text:' ',reason:'x',delayMs:0},
  {action:'reply',text:'hello',reason:'x',delayMs:-1},
  {action:'reply',text:'hello',reason:'x',delayMs:600001},
  {action:'reply',text:'a'.repeat(501),reason:'x',delayMs:0},
  {action:'reply',text:'a',reason:'x',delayMs:0,send:true},
  {action:'reply',text:'a',reason:'x',delayMs:'10'},
 ])assert.throws(()=>validateDecision(invalid),/invalid_decision/);
});
test('skip/defer strict discriminants; never accept unexpected tool permissions',()=>{
 assert.deepEqual(validateDecision({action:'skip',reason:'无需回复'}),{action:'skip',reason:'无需回复'});
 assert.deepEqual(validateDecision({action:'defer',reason:'稍后',delayMs:1000}),
  {action:'defer',reason:'稍后',delayMs:1000});
 for(const invalid of [
  {action:'skip',reason:'x',text:'payload'},
  {action:'skip',reason:'x',delayMs:0},
  {action:'defer',reason:'x',delayMs:999},
  {action:'defer',reason:'x',delayMs:86400001},
  {action:'defer',reason:'x',delayMs:1000,tools:['shell']},
  {action:'execute',command:'curl xxx',reason:'x'},
  {action:'reply',text:'hello',reason:'\u0000',delayMs:0},
  'reply',null,[],{},
 ])assert.throws(()=>validateDecision(invalid),/invalid_decision/);
});
