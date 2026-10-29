import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DeepSeekBackend} from '../../src/ai/deepseek.ts';
import type {AiRequest} from '../../src/ai/contracts.ts';

const req:AiRequest={instructions:'只返回 JSON，例如 {"action":"skip","reason":"无需回复"}',turns:[{role:'user',text:'你好'}]};
const OK={choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'skip',reason:'稍后再聊'})}}]};
function response(body:unknown,status=200):Response{
 return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
}
test('DeepSeek API adapter: exact endpoint, limited JSON body, no tools or UID',async()=>{
 let calls=0;
 const fetcher:typeof fetch=async(url,opts)=>{
  calls++;
  assert.equal(url,'https://api.deepseek.com/chat/completions');
  assert.equal(opts?.method,'POST');
  const headers=new Headers(opts?.headers);
  assert.equal(headers.get('authorization'),'Bearer dummy_secret');
  const json=JSON.parse(String(opts?.body)) as Record<string,unknown>;
  assert.equal(json['model'],'deepseek-flash');
  assert.equal(json['stream'],false);
  assert.deepEqual(json['response_format'],{type:'json_object'});
  assert.equal(json['tools'],undefined);
  assert.equal(json['tool_choice'],undefined);
  assert.equal(JSON.stringify(json).includes('0:1:222:333'),false);
  return response(OK);
 };
 const backend=new DeepSeekBackend({apiKey:'dummy_secret',fetcher});
 const result=await backend.evaluate(req,new AbortController().signal);
 assert.deepEqual(result,{action:'skip',reason:'稍后再聊'});
 assert.equal(calls,1);
});
test('DeepSeek adapter: HTTP error is redacted and never echoed',async()=>{
 const backend=new DeepSeekBackend({apiKey:'dummy_secret',fetcher:async()=>response({
  message:'SECRET_COOKIE_IN_HTTP_RESPONSE',
 },429)});
 await assert.rejects(backend.evaluate(req,new AbortController().signal),e=>{
  assert.ok(e instanceof Error);
  assert.equal(e.message,'model_api_http_failed');
  assert.ok(!e.message.includes('SECRET_'));return true;
 });
});
test('DeepSeek adapter: incomplete output and tool_calls rejected',async()=>{
 const cases=[
  {choices:[{finish_reason:'length',message:{content:'{"action":"skip"}'}}]},
  {choices:[{finish_reason:'stop',message:{content:'',tool_calls:[{function:{name:'shell'}}]}}]},
  {choices:[]},
 ];
 for(const item of cases){
  const backend=new DeepSeekBackend({apiKey:'dummy_secret',fetcher:async()=>response(item)});
  await assert.rejects(backend.evaluate(req,new AbortController().signal),
   /model_api_(incomplete_response|tools_rejected|invalid_response)/);
 }
});
test('DeepSeek adapter: quota blocks a second request before network use',async()=>{
 let calls=0;
 const backend=new DeepSeekBackend({apiKey:'dummy_secret',maxRequests:1,
  fetcher:async()=>{calls++;return response(OK);}});
 await backend.evaluate(req,new AbortController().signal);
 await assert.rejects(backend.evaluate(req,new AbortController().signal),/model_api_budget_exhausted/);
 assert.equal(calls,1);
});
test('DeepSeek adapter: stopped/aborted request never hits fetch',async()=>{
 let calls=0;
 const backend=new DeepSeekBackend({apiKey:'dummy_secret',fetcher:async()=>{calls++;return response(OK);}});
 const c=new AbortController();c.abort();
 await assert.rejects(backend.evaluate(req,c.signal),/model_api_aborted/);
 assert.equal(calls,0);
});
test('DeepSeek adapter: backend needs explicit credential, no implicit network access',()=>{
 assert.throws(()=>new DeepSeekBackend({apiKey:''}),/model_api_key_missing/);
 assert.throws(()=>new DeepSeekBackend({apiKey:'dummy_secret',maxRequests:0}),/model_request_budget_invalid/);
});
