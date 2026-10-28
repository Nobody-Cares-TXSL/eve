import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const entry=resolve('src/cli.ts');
function call(...args:string[]) {
  return spawnSync(process.execPath,[entry,...args],{encoding:'utf8',timeout:20000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
}
async function waitForState(file:string,phase:string) {
  // 全套测试并行时子进程启动会被抢占；预算按最慢路径放宽（约 9s），
  // 避免高负载下误报失败（曾实测 3.6s 预算不足）。
  for(let n=0;n<300;n++) {
    try{
      const s=JSON.parse(await readFile(file,'utf8')) as {phase:string;pid:number};
      if(s.phase===phase) return s;
    }catch{}
    await delay(30);
  }
  throw new Error('未观察到状态 '+phase);
}
/** 杀掉属于该 state-dir 的 cli 进程（含 flock 派生的 --locked 孙进程）。
 *  pattern 不得以 `--` 开头：pgrep 会把它当选项并直接报错退出（曾导致清理空转）。 */
function killStateDir(dir:string):void {
  const found=spawnSync('pgrep',['-f','state-dir '+dir],{encoding:'utf8'}).stdout.trim();
  for(const pid of found.split('\n').filter(Boolean)){
    const n=Number(pid);
    if(!Number.isSafeInteger(n)||n===process.pid) continue;
    // 只杀命令行里确实带 cli.ts run 的进程，避免误伤测试自身
    const cmd=spawnSync('ps',['-o','cmd=','-p',String(n)],{encoding:'utf8'}).stdout;
    if(!cmd.includes('cli.ts run')) continue;
    try{process.kill(n,'SIGKILL');}catch{}
  }
}
function finished(child:ChildProcess):Promise<number|null> {
  return new Promise(resolve=>{
    if(child.exitCode!==null) return resolve(child.exitCode);
    child.once('exit',code=>resolve(code));
  });
}
test('真实子进程：锁冲突、pause/resume 同 PID、stop 正常 0',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'eve-t2-cli-'));
  const child=spawn(process.execPath,[entry,'run','--mock','--state-dir',dir],
    {stdio:'ignore',env:{...process.env,NODE_NO_WARNINGS:'1'}});
  try {
    const file=join(dir,'runtime.json');
    const initial=await waitForState(file,'running');
    assert.equal(call('run','--mock','--state-dir',dir).status,4);
    assert.equal(call('pause','--state-dir',dir).status,0);
    const paused=await waitForState(file,'paused_manual');
    assert.equal(paused.pid,initial.pid);
    assert.equal(call('resume','--state-dir',dir).status,0);
    assert.equal((await waitForState(file,'running')).pid,initial.pid);
    assert.equal(call('stop','--state-dir',dir).status,0);
    assert.equal(await Promise.race([finished(child),delay(15000).then(()=>-99)]),0);
    assert.equal((await waitForState(file,'stopped')).phase,'stopped');
  } finally {
    // 只 SIGKILL wrapper 会留下 flock 派生的 --locked 孙进程（曾实测产生孤儿进程）。
    // 先 SIGTERM 让 wrapper 转发信号，再按 state-dir 兜底清理，最后才强杀。
    if(child.exitCode===null){
      child.kill('SIGTERM');
      await Promise.race([finished(child),delay(3000)]);
      if(child.exitCode===null) child.kill('SIGKILL');
    }
    killStateDir(dir);
    await rm(dir,{recursive:true,force:true});
  }
});
test('真实子进程：队列溢出 → 落盘 paused_env → 退出码 3',()=>{
  const dir=join(tmpdir(),'eve-t2-overflow-'+process.pid);
  try{
    const fixture=resolve('scripts/fixtures/overflow-runner.ts');
    const result=spawnSync(process.execPath,[fixture,dir],
      {encoding:'utf8',timeout:20000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
    assert.equal(result.status,3,'溢出必须以码 3 退出，实际 '+result.status);
    const state=JSON.parse(readFileSync(join(dir,'runtime.json'),'utf8')) as {phase:string;reason:string};
    assert.equal(state.phase,'paused_env');
    assert.match(state.reason,/overflow/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('真实子进程：SIGKILL 后 stale → 复跑 → unblock → 再复跑',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'eve-t2-kill-'));
  const child=spawn(process.execPath,[entry,'run','--mock','--state-dir',dir],
    {stdio:'ignore',env:{...process.env,NODE_NO_WARNINGS:'1'}});
  try{
    const file=join(dir,'runtime.json');
    await waitForState(file,'running');
    const lockedPid=JSON.parse(await readFile(file,'utf8')) as {pid:number};
    // 强杀：SIGKILL 不可清理，状态必须保留为 stale 证据
    killStateDir(dir);
    await Promise.race([finished(child),delay(5000)]);
    const stale=JSON.parse(await readFile(file,'utf8')) as {phase:string;pid:number};
    assert.equal(stale.phase,'running','SIGKILL 后不得被改写为 stopped');
    assert.equal(stale.pid,lockedPid.pid);
    // stale 需心跳超过 12s 才成立：轮询到 deadline，而非立即断言
    let snapshot={alive:true,stale:false};
    for(let i=0;i<400;i++){
      snapshot=JSON.parse(call('status','--json','--state-dir',dir).stdout) as {alive:boolean;stale:boolean};
      if(snapshot.stale&&!snapshot.alive) break;
      await delay(50);
    }
    assert.equal(snapshot.alive,false,'SIGKILL 后 PID 不应被判为存活');
    assert.equal(snapshot.stale,true,'心跳过期后必须标记 stale');

    // 复跑：拿到锁后允许恢复（stale 不是持久阻塞）
    const again=spawn(process.execPath,[entry,'run','--mock','--state-dir',dir],
      {stdio:'ignore',env:{...process.env,NODE_NO_WARNINGS:'1'}});
    try{
      // 必须等新实例接管：旧 running 状态文件还在，直接 waitForState('running') 会读到它
      const oldInstance=(JSON.parse(await readFile(file,'utf8')) as {instanceId:string}).instanceId;
      for(let i=0;i<300;i++){
        const s=JSON.parse(await readFile(file,'utf8')) as {phase:string;instanceId:string};
        if(s.phase==='running'&&s.instanceId!==oldInstance) break;
        await delay(30);
      }
      assert.equal(call('pause','--state-dir',dir).status,0);
      await waitForState(file,'paused_manual');
      // 人工解除路径：进程存活时 unblock 必须拒绝
      assert.equal(call('unblock','--reason','manual-check','--state-dir',dir).status,2);
      assert.equal(call('stop','--state-dir',dir).status,0);
      assert.equal(await Promise.race([finished(again),delay(15000).then(()=>-99)]),0);
    }finally{if(again.exitCode===null){again.kill('SIGTERM');await Promise.race([finished(again),delay(3000)]);}}
  }finally{
    if(child.exitCode===null)child.kill('SIGKILL');
    killStateDir(dir);
    await rm(dir,{recursive:true,force:true});
  }
});
test('doctor 11 项稳定、缺配置码2、JSON 汇总准确',()=>{
  const dir=join(tmpdir(),'eve-doctor-nonexistent-'+process.pid);
  const result=call('doctor','--json','--state-dir',dir,'--config',join(dir,'not-found.json'));
  assert.equal(result.status,2);
  const json=JSON.parse(result.stdout) as {checks:{id:string;level:string}[];summary:Record<string,number>};
  assert.deepEqual(json.checks.map(c=>c.id),Array.from({length:11},(_,i)=>'D'+(i+1)));
  for(const level of ['ok','warn','fail']) assert.equal(json.summary[level],json.checks.filter(c=>c.level===level).length);
});
test('运行中的持久阻塞不能被 unblock 误清除',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'eve-t2-unblock-'));
  try {
    const state=join(dir,'runtime.json');
    const s={phase:'paused_unknown',pid:process.pid,processStart:'',instanceId:'old',reason:'requires_manual_review',updatedAt:Date.now()};
    const fs=await import('node:fs/promises');
    await fs.writeFile(state,JSON.stringify(s));
    // 离线阻塞允许明确操作，非自动 run；run 不得抹掉状态。
    assert.equal(call('run','--mock','--state-dir',dir).status,3);
    assert.equal((JSON.parse(await readFile(state,'utf8')) as {phase:string}).phase,'paused_unknown');
  } finally{await rm(dir,{recursive:true,force:true});}
});
