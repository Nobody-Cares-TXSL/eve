import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Runtime-neutral stdio transport; all agents go through the same bounded lifecycle. */
export interface AgentInvocation {
 readonly executable:string;
 readonly args:readonly string[];
 readonly stdin:string;
 readonly timeoutMs:number;
 readonly maxOutputBytes:number;
}
export interface AgentOutput { readonly stdout:string; readonly exitCode:number }
export interface AgentProcessTransport {
 run(invocation:AgentInvocation,signal:AbortSignal):Promise<AgentOutput>;
}
export type AgentTransportCode = 'agent_aborted'|'agent_timeout'|'agent_start_failed'|
 'agent_execution_failed'|'agent_output_too_large'|'agent_invalid_output'|
 'agent_cli_configuration_error'|'agent_auth_error'|'agent_network_error'|
 'agent_rate_limit'|'agent_result_error';

/** Never surface stderr content: classify only a bounded raw fragment to a fixed code. */
export function classifyAgentFailure(stderr:string):AgentTransportCode{
 const s=stderr.slice(0,8192).toLowerCase();
 if(/unknown option|unknown argument|unrecognized option|invalid flag|invalid argument|invalid value for option|unknown flag/.test(s))
  return 'agent_cli_configuration_error';
 if(/not logged in|unauthorized|authentication failed|invalid api key|token expired|oauth token|sign in|login required/.test(s))
  return 'agent_auth_error';
 if(/rate limit|usage limit|quota exceeded|budget limit|credits exhausted|billing limit|insufficient credits/.test(s))
  return 'agent_rate_limit';
 if(/econnreset|etimedout|enotfound|eai_again|fetch failed|network error|connection refused|could not connect|tls error/.test(s))
  return 'agent_network_error';
 return 'agent_execution_failed';
}
/** Extract only public envelope shape, never a model message or raw error. */
export function classifyAgentExit(stderr:string,stdout:string):AgentTransportCode{
 const fromStderr=classifyAgentFailure(stderr);
 if(fromStderr!=='agent_execution_failed')return fromStderr;
 if(stdout.length<=65536){
  try{
   const data:unknown=JSON.parse(stdout);
   if(data&&typeof data==='object'&&!Array.isArray(data)){
    const o=data as Record<string,unknown>;
    if(o['type']==='result'&&(o['is_error']===true||o['subtype']==='error'))
     return 'agent_result_error';
   }
  }catch{/* raw text never logged */}
 }
 return 'agent_execution_failed';
}
export class AgentTransportError extends Error{
 readonly code:AgentTransportCode;
 constructor(code:AgentTransportCode){super(code);this.code=code;}
}

export function safeAgentEnvironment():NodeJS.ProcessEnv{
 const allowed=[
  'HOME','PATH','USER','LOGNAME','LANG','LC_ALL','TERM','TZ',
  'XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_STATE_HOME',
  'HTTPS_PROXY','HTTP_PROXY','NO_PROXY','https_proxy','http_proxy','no_proxy',
  'ANTHROPIC_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX',
  // 模型路由配置：不是 Eve 的私密凭据，而是部署环境对 CLI 的模型映射。
  // 过滤掉它们会让子进程落到 CLI 内置默认模型名，与本地网关不匹配而失败。
  'ANTHROPIC_MODEL','ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL','ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL','CLAUDE_CODE_MODEL_CAPABILITIES',
  'CLAUDE_CODE_SUBAGENT_MODEL',
 ];
 const env:NodeJS.ProcessEnv={};
 for(const key of allowed){
  const value=process.env[key];
  if(value!==undefined)env[key]=value;
 }
 // Allow Claude Code to use its normal auth, but not Eve's unrelated secrets.
 env['CI']='1';
 env['CLAUDE_CODE_SKIP_PROMPT_HISTORY']='1';
 return env;
}

/** Tools disabled by the caller spec; this is NOT an OS-level sandbox. */
export class StdioAgentTransport implements AgentProcessTransport {
 async run(input:AgentInvocation,signal:AbortSignal):Promise<AgentOutput>{
  if(signal.aborted)throw new AgentTransportError('agent_aborted');
  if(!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<1||input.timeoutMs>120000||
     !Number.isSafeInteger(input.maxOutputBytes)||input.maxOutputBytes<1||
     input.maxOutputBytes>262144||input.stdin.length>16000||
     !input.executable||input.args.some(a=>typeof a!=='string'))
   throw new AgentTransportError('agent_start_failed');
  const workspace=mkdtempSync(join(tmpdir(),'eve-claude-'));
  try{
   return await new Promise<AgentOutput>((resolve,reject)=>{
    let child;
    try{
     child=spawn(input.executable,[...input.args],{
      cwd:workspace,env:safeAgentEnvironment(),stdio:['pipe','pipe','pipe'],
      shell:false,detached:process.platform!=='win32',windowsHide:true,
     });
    }catch{reject(new AgentTransportError('agent_start_failed'));return;}
    const processHandle=child;
    let ended=false,timer:ReturnType<typeof setTimeout>|undefined;
    let killTimer:ReturnType<typeof setTimeout>|undefined;
    const chunks:Buffer[]=[];
    let outputBytes=0,stderrSample='';
    const terminate=()=>{
     if(processHandle.pid&&process.platform!=='win32'){
      try{process.kill(-processHandle.pid,'SIGTERM');}catch{/* exited */}
     }
     try{processHandle.kill('SIGTERM');}catch{/* exited */}
     killTimer=setTimeout(()=>{
      if(processHandle.pid&&process.platform!=='win32'){
       try{process.kill(-processHandle.pid,'SIGKILL');}catch{/* exited */}
      }
      try{processHandle.kill('SIGKILL');}catch{/* exited */}
     },500);
     killTimer.unref();
    };
    const fail=(code:AgentTransportError['code'])=>{
     if(ended)return;
     ended=true;
     terminate();
     cleanup();
     reject(new AgentTransportError(code));
    };
    const onAbort=()=>fail('agent_aborted');
    const cleanup=()=>{
     if(timer)clearTimeout(timer);
     signal.removeEventListener('abort',onAbort);
    };
    signal.addEventListener('abort',onAbort,{once:true});
    timer=setTimeout(()=>fail('agent_timeout'),input.timeoutMs);
    processHandle.stdout.on('data',(chunk:Buffer)=>{
     outputBytes+=chunk.length;
     if(outputBytes>input.maxOutputBytes){fail('agent_output_too_large');return;}
     chunks.push(chunk);
    });
    // Raw stderr may contain cookies, model output or local paths: never log/persist it.
    // Keep only a bounded in-memory fragment for fixed-category classification.
    processHandle.stderr.on('data',(chunk:Buffer)=>{
     if(stderrSample.length<8192)stderrSample+=chunk.toString('utf8').slice(0,8192-stderrSample.length);
    });
    processHandle.on('error',()=>fail('agent_start_failed'));
    processHandle.on('close',(exitCode:number|null)=>{
     // The child is gone: never signal a reused PID from a stale kill timer.
     if(killTimer)clearTimeout(killTimer);
     if(ended)return;
     ended=true;
     cleanup();
     if(exitCode!==0){reject(new AgentTransportError(classifyAgentExit(stderrSample,Buffer.concat(chunks).toString('utf8'))));return;}
     resolve({exitCode:0,stdout:Buffer.concat(chunks).toString('utf8')});
    });
    if(signal.aborted){fail('agent_aborted');return;}
    processHandle.stdin.on('error',()=>undefined);
    processHandle.stdin.end(input.stdin);
   });
  }finally{
   rmSync(workspace,{recursive:true,force:true});
  }
 }
}
