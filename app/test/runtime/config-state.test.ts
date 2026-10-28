import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseConfig} from '../../src/runtime/config.ts';
import {paths,initDirs,writeState,readState,runtimeSnapshot,processStart,BLOCKED} from '../../src/runtime/state.ts';
test('有效 config 与非法字段、UID 的反向测试',()=>{
  const x=parseConfig({version:1,selfUid:'111',targetUid:'222'});
  assert.equal(x.queueCapacity,32);
  assert.throws(()=>parseConfig({version:1,selfUid:'111',targetUid:'111'}),/不得相同/);
  assert.throws(()=>parseConfig({version:1,selfUid:'111',targetUid:'222',secret:'x'}),/未知字段/);
  assert.throws(()=>parseConfig({version:1,targetUid:'222'}),/selfUid/);
});
test('状态原子落盘、死 PID 不改写业务阻塞',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'eve-state-'));
  try{
    const p=paths(dir);await initDirs(p);
    for (const phase of BLOCKED) {
      const s={phase,pid:99999999,processStart:'',instanceId:'sample',updatedAt:Date.now(),reason:'locked'};
      await writeState(p,s);
      const shot=await runtimeSnapshot(p);
      assert.equal(shot.state?.phase,phase);
      assert.equal(shot.alive,false);
      assert.equal((await readState(p))?.phase,phase);
      assert.ok((await readFile(p.state,'utf8')).includes('locked'));
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('Linux 进程启动戳非空',()=>assert.ok(processStart(process.pid).length>0));
