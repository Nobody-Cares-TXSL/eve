import type {AiBackend,AiRequest} from './contracts.ts';
import type {AgentInvocation,AgentProcessTransport} from './agent-transport.ts';
import {AgentTransportError,StdioAgentTransport} from './agent-transport.ts';
import {buildClaudeArguments} from './claude-invocation.ts';

export interface AgentCapabilities{
 readonly toolExecution:false;
 readonly filesystem:false;
 readonly mcp:false;
 readonly messageSend:false;
}
export interface AgentRuntimeDef {
 readonly id:string;
 readonly executable:string;
 readonly capabilities:AgentCapabilities;
 buildInvocation(request:AiRequest):AgentInvocation;
 parseOutput(stdout:string):unknown;
}

const claudeDef:AgentRuntimeDef={
 id:'claude_code',executable:'claude',
 capabilities:{toolExecution:false,filesystem:false,mcp:false,messageSend:false},
 buildInvocation(request){
  if(!request.instructions||request.instructions.length>5000||
    request.turns.length<1||request.turns.length>6||
    request.turns.some(t=>t.text.length>1200))throw new AgentTransportError('agent_start_failed');
  const stdin=JSON.stringify({instructions:request.instructions,turns:request.turns});
  return{
   executable:this.executable,stdin,timeoutMs:30000,maxOutputBytes:65536,
   args:buildClaudeArguments(),
  };
 },
 parseOutput(stdout){
  if(stdout.length>65536)throw new AgentTransportError('agent_output_too_large');
  let envelope:unknown;
  try{envelope=JSON.parse(stdout) as unknown;}
  catch{throw new AgentTransportError('agent_invalid_output');}
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))
   throw new AgentTransportError('agent_invalid_output');
  const result=envelope as Record<string,unknown>;
  if(result['type']==='result'&&(result['is_error']===true||result['subtype']==='error'))
   throw new AgentTransportError('agent_result_error');
  if(result['type']!=='result'||result['subtype']!=='success'||result['is_error']!==false||
    !result['structured_output']||typeof result['structured_output']!=='object'||
    Array.isArray(result['structured_output']))
   throw new AgentTransportError('agent_invalid_output');
  const output=result['structured_output'] as Record<string,unknown>;
  // The schema keeps a plain object root for Claude CLI compatibility; the
  // nested decision is an anyOf discriminated union with exact keys.
  if(Object.keys(output).length!==1||!output['decision']||
     typeof output['decision']!=='object'||Array.isArray(output['decision']))
   throw new AgentTransportError('agent_invalid_output');
  return output['decision'];
 },
};

/** Registry of explicitly reviewed, trusted CLI definitions. No arbitrary user-supplied commands. */
export class AgentRegistry{
 private readonly agents=new Map<string,AgentRuntimeDef>();
 register(def:AgentRuntimeDef):void{
  if(!/^[a-z][a-z0-9_-]{0,31}$/.test(def.id)||!def.executable||
    Object.values(def.capabilities).some(value=>value!==false)||
    this.agents.has(def.id))throw new Error('agent_definition_rejected');
  this.agents.set(def.id,def);
 }
 get(id:string):AgentRuntimeDef{
  const def=this.agents.get(id);
  if(!def)throw new Error('agent_not_registered');
  return def;
 }
 ids():readonly string[]{return [...this.agents.keys()];}
}

/** Only Claude is enabled. A future adapter adds one reviewed definition. */
export function createEveAgentRegistry():AgentRegistry{
 const registry=new AgentRegistry();
 registry.register(claudeDef);
 return registry;
}

export class RegisteredAgentBackend implements AiBackend{
 readonly id:string;
 readonly kind='agent-runtime' as const;
 private readonly definition:AgentRuntimeDef;
 private readonly transport:AgentProcessTransport;
 private running=false;
 constructor(definition:AgentRuntimeDef,transport:AgentProcessTransport=new StdioAgentTransport()){
  this.id=definition.id;
  this.definition=definition;
  this.transport=transport;
 }
 async evaluate(request:AiRequest,signal:AbortSignal):Promise<unknown>{
  if(this.running)throw new AgentTransportError('agent_execution_failed');
  if(signal.aborted)throw new AgentTransportError('agent_aborted');
  this.running=true;
  try{
   const invocation=this.definition.buildInvocation(request);
   const output=await this.transport.run(invocation,signal);
   return this.definition.parseOutput(output.stdout);
  }finally{this.running=false;}
 }
}

export function createClaudeBackend(transport?:AgentProcessTransport):AiBackend{
 return new RegisteredAgentBackend(createEveAgentRegistry().get('claude_code'),transport);
}
