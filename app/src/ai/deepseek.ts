import type {AiBackend,AiRequest} from './contracts.ts';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

function record(value:unknown):value is Record<string,unknown>{
 return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Explicitly configured, opt-in API backend. No automatic calls, tool calls, shell,
 * platform SDK, retry storms, or credential logging. Tests inject a local fetcher.
 */
export class DeepSeekBackend implements AiBackend {
 readonly id='deepseek';
 readonly kind='model-api';
 private readonly key:string;
 private readonly model:string;
 private readonly fetcher:typeof fetch;
 private readonly requestLimit:number;
 private attempts=0;
 private lastRequestAt=0;

 constructor(options:{
  apiKey:string;
  model?:'deepseek-flash'|'deepseek-v4-pro';
  fetcher?:typeof fetch;
  maxRequests?:number;
 }){
  if(!options.apiKey||options.apiKey.trim().length<8)throw new Error('model_api_key_missing');
  this.key=options.apiKey;
  this.model=options.model??'deepseek-flash';
  this.fetcher=options.fetcher??fetch;
  const limit=options.maxRequests??8;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('model_request_budget_invalid');
  this.requestLimit=limit;
 }

 async evaluate(request:AiRequest,signal:AbortSignal):Promise<unknown>{
  if(signal.aborted)throw Error('model_api_aborted');
  if(this.attempts>=this.requestLimit)throw Error('model_api_budget_exhausted');
  if(this.lastRequestAt>0&&Date.now()-this.lastRequestAt<1000)throw Error('model_api_local_rate_limit');
  if(!request.instructions||request.turns.length<1||request.turns.length>6 ||
     request.turns.some(t=>!t.text||t.text.length>1200))
   throw Error('model_api_input_out_of_bounds');
  // Only system + text chat messages. No tools, external links, IDs or platform credentials.
  const body={
   model:this.model,stream:false,max_tokens:450,
   response_format:{type:'json_object'},
   messages:[{role:'system',content:request.instructions},
     ...request.turns.map(t=>({role:t.role,content:t.text}))],
  };
  this.attempts++;
  this.lastRequestAt=Date.now();
  let response:Response;
  try{
   response=await this.fetcher(ENDPOINT,{
    method:'POST',signal,headers:{
     'Authorization':'Bearer '+this.key,
     'Content-Type':'application/json',
    },
    body:JSON.stringify(body),
   });
  }catch{throw Error('model_api_transport_failed');}
  if(!response.ok)throw Error('model_api_http_failed');
  const lengthHeader=response.headers.get('content-length');
  if(lengthHeader!==null&&Number(lengthHeader)>32_768)throw Error('model_api_output_too_large');
  let payload:unknown;
  try{
   const raw=await response.text();
   if(raw.length>32_768)throw Error('response_too_large');
   payload=JSON.parse(raw) as unknown;
  }catch{throw Error('model_api_invalid_response');}
  if(!record(payload)||!Array.isArray(payload['choices']))throw Error('model_api_invalid_response');
  const first:unknown=payload['choices'][0];
  if(!record(first)||first['finish_reason']!=='stop'||!record(first['message']))
   throw Error('model_api_incomplete_response');
  const msg=first['message'];
  if(msg['tool_calls']!==undefined)throw Error('model_api_tools_rejected');
  if(typeof msg['content']!=='string'||!msg['content']||msg['content'].length>6000)
   throw Error('model_api_invalid_response');
  try{return JSON.parse(msg['content']) as unknown;}
  catch{throw Error('model_api_invalid_response');}
 }
}
