import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {mkdir,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {loadConfig,parseConfig,type RuntimeConfig} from './runtime/config.ts';
import {paths,readState,runtimeSnapshot,isAlive,initDirs,durableRequest,readJson,atomicJson,BLOCKED} from './runtime/state.ts';
import {doctor} from './runtime/doctor.ts';
import {Runner} from './runtime/runner.ts';
import type {ControlRequest,Action} from './runtime/runner.ts';
import type {PlatformPort} from './platform/types.ts';
import {MockPlatformPort} from './platform/mock.ts';
import {DouyinReadOnlyPort} from './platform/douyin.ts';

const args=process.argv.slice(2);
const cmd=args[0]??'help';
const option=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const here=process.cwd();
const dataDir=resolve(here,'data');
const stateDir=resolve(option('--state-dir')??join(here,'state'));
const configPath=resolve(option('--config')??join(dataDir,'config.json'));
const p=paths(stateDir);
const mock=args.includes('--mock');
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const reply=(x:unknown)=>console.log(JSON.stringify(x));
async function control(action:Action):Promise<number> {
  const snap=await runtimeSnapshot(p),s=snap.state;
  if (!s || !snap.alive) {console.error('没有可确认的活动实例');return 2;}
  await initDirs(p);
  const id=randomUUID();
  const req:ControlRequest={id,instanceId:s.instanceId,action,at:Date.now()};
  await durableRequest(join(p.requests,id+'.json'),req);
  for(let i=0;i<40;i++) {
    try {
      const ack=await readJson(join(p.acks,id+'.json')) as {ok:boolean;reason:string;phase:string};
      if (!ack.ok) {console.error('控制被拒绝：'+ack.reason);return 2;}
      console.log(action+' 已确认: '+ack.phase);
      return 0;
    } catch {await sleep(100);}
  }
  console.error('控制确认超时（请求已提交，不代表没有执行）');
  return 4;
}
async function main():Promise<number> {
  if(cmd==='doctor') {
    const result=await doctor(configPath,stateDir,dataDir,resolve(here,'src'));
    if(args.includes('--json')) reply(result);
    else result.checks.forEach(x=>console.log(x.id,x.level,x.detail));
    return result.summary.fail>0?2:0;
  }
  if(cmd==='status') {
    // status 只读：不得创建目录或修改任何状态
    const snapshot=await runtimeSnapshot(p);
    if (args.includes('--json')) reply(snapshot);
    else console.log(snapshot.state?.phase??'stopped',snapshot.alive?'alive':snapshot.stale?'stale':'not_running');
    return 0;
  }
  if(cmd==='pause'||cmd==='resume'||cmd==='stop') return control(cmd);
  if(cmd==='unblock') {
    const reason=option('--reason');
    if (!reason || reason.trim().length<3) {console.error('必须提供 --reason (至少三个字符)');return 2;}
    await initDirs(p);
    const snap=await runtimeSnapshot(p);
    if (snap.state && isAlive(snap.state)) {console.error('进程仍存活，请先正常停止');return 2;}
    if (!snap.state || !BLOCKED.includes(snap.state.phase)) {console.error('当前没有持久业务阻塞');return 2;}
    await atomicJson(p.state,{...snap.state,phase:'stopped',pid:0,processStart:'',reason:'manual_unblock',updatedAt:Date.now()});
    console.log('已明确解除业务阻塞，请核实风险后再 run');return 0;
  }
  if(cmd==='run') {
    await initDirs(p);
    if(!args.includes('--locked') || process.env['EVE_T2_LOCK_HANDOFF'] !== '1') {
      const subprocess=spawn('flock',['-n','-E','4','--no-fork',p.lock,process.execPath,
        process.argv[1]!,...args,'--locked'],{stdio:'inherit',env:{...process.env,EVE_T2_LOCK_HANDOFF:'1'}});
      const stop=(signal:NodeJS.Signals)=>{if(subprocess.pid)process.kill(subprocess.pid,signal);};
      process.on('SIGINT',stop);process.on('SIGTERM',stop);
      return new Promise<number>(resolve=>{
        subprocess.on('error',()=>resolve(1));
        subprocess.on('exit',(code,signal)=>resolve(code??(signal?1:0)));
      });
    }
    const previous=await readState(p);
    if(previous && BLOCKED.includes(previous.phase)) {console.error('业务阻塞：需人工解除');return 3;}
    let config:RuntimeConfig;
    if(mock) config=parseConfig({version:1,selfUid:'111',targetUid:'222',pollMs:150,queueCapacity:32});
    else {
      try {config=await loadConfig(configPath);}
      catch {console.error('运行配置不存在或无效，先执行 doctor');return 2;}
    }
    let port:PlatformPort;
    if(mock) port=new MockPlatformPort();
    else port=new DouyinReadOnlyPort({
      dataDir,selfUid:config.selfUid,targetUid:config.targetUid,
      allowLocalVerification:config.allowLocalVerification,
      notifyQrPath:path=>console.log('本机扫码文件：'+path),
    });
    return new Runner(stateDir,port,config,mock?undefined:join(dataDir,'eve.sqlite'),args.includes('--experimental-reconcile')).run();
  }
  console.log('dac: doctor [--json], status [--json], run [--mock] [--experimental-reconcile], pause, resume, stop, unblock --reason <说明>');
  return cmd==='help'?0:2;
}
main().then(code=>{process.exitCode=code;}).catch(()=>{
  console.error('命令执行失败：检查配置及运行状态');process.exitCode=1;
});
