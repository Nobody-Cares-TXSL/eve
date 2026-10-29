import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {safeAgentEnvironment} from './agent-transport.ts';
import {claudeHelpRequirements} from './claude-invocation.ts';
import {spawnSync} from 'node:child_process';

export type ClaudeCheckCode =
 | 'ready' | 'cli_missing' | 'cli_version_unreadable'
 | 'cli_help_unavailable' | 'cli_flags_missing'
 | 'auth_unavailable' | 'not_logged_in';

export type ClaudeCheck = {
 readonly status:'ready'|'blocked';
 readonly code:ClaudeCheckCode;
 readonly cliVersion:string|null;
 readonly loggedIn:boolean;
 readonly authMode:'oauth'|'api'|'other'|'none';
 readonly flagsPresent:boolean;
 readonly modelRequests:0;
 readonly note:'max_turns_documented_but_not_in_help';
};

/** Only runs --version, --help and auth status. NEVER invokes -p or contacts a model. */
export function inspectClaudeExecutable(executable='claude'):ClaudeCheck{
 const blocked=(code:ClaudeCheckCode,version:string|null=null):ClaudeCheck=>({
  status:'blocked',code,cliVersion:version,loggedIn:false,
  authMode:'none',flagsPresent:false,modelRequests:0,
  note:'max_turns_documented_but_not_in_help',
 });
 // Match AgentProcessTransport's real invocation environment and working
 // directory, not the developer's interactive shell or project directory.
 const workspace=mkdtempSync(join(tmpdir(),'eve-claude-preflight-'));
 try{
 function command(args:readonly string[]){
  return spawnSync(executable,[...args],{
   cwd:workspace,env:safeAgentEnvironment(),
   encoding:'utf8',timeout:5000,maxBuffer:65536,
   windowsHide:true,stdio:['ignore','pipe','pipe'],
  });
 }
 const versionResult=command(['--version']);
 if(versionResult.error||versionResult.status!==0)return blocked('cli_missing');
 const m=/\b(\d+\.\d+\.\d+)\b/.exec(versionResult.stdout??'');
 if(!m)return blocked('cli_version_unreadable');
 const version=m[1]!;
 const help=command(['--help']);
 if(help.error||help.status!==0)return blocked('cli_help_unavailable',version);
 const body=help.stdout??'';
 if(claudeHelpRequirements().some(flag=>!body.includes(flag)))return blocked('cli_flags_missing',version);
 const auth=command(['auth','status']);
 if(auth.error||auth.status!==0)return blocked('auth_unavailable',version);
 let data:unknown;
 try{data=JSON.parse(auth.stdout);}catch{return blocked('auth_unavailable',version);}
 if(!data||typeof data!=='object'||Array.isArray(data))
  return blocked('auth_unavailable',version);
 const record=data as Record<string,unknown>;
 if(record['loggedIn']!==true)return blocked('not_logged_in',version);
 const mode=record['authMethod']==='oauth_token'?'oauth':
  record['authMethod']==='api_key'?'api':'other';
 return {
  status:'ready',code:'ready',cliVersion:version,loggedIn:true,authMode:mode,
  flagsPresent:true,modelRequests:0,note:'max_turns_documented_but_not_in_help',
 };
 }finally{rmSync(workspace,{recursive:true,force:true});}
}
