import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BoundedQueue} from '../../src/runtime/queue.ts';
const tick = () => new Promise<void>(r=>setImmediate(r));
test('暂停禁止新消费，恢复按 FIFO 消费',async()=>{
  const got:number[]=[];const faults:string[]=[];
  const q=new BoundedQueue<number>(3, async x=>{got.push(x);},s=>faults.push(s));
  q.pause();q.push(1);q.push(2);
  await tick();assert.deepEqual(got,[]);
  q.resume();await tick();await tick();
  assert.deepEqual(got,[1,2]);assert.deepEqual(faults,[]);
  await q.stop();
});
test('暂停中容量满必须明确故障且不消费',async()=>{
  let fault='';const seen:number[]=[];
  const q=new BoundedQueue<number>(1,async x=>{seen.push(x);},s=>{fault=s;});
  q.pause();assert.equal(q.push(1),true);assert.equal(q.push(2),false);
  q.resume();await tick();assert.deepEqual(seen,[]);
  assert.equal(q.isFaulted,true);assert.match(fault,/overflow/);
});
test('消费者抛异常后停止调度后续项',async()=>{
  let fault='';const q=new BoundedQueue<number>(3, async()=>{throw Error('private');},s=>fault=s);
  q.push(1);q.push(2);await tick();await tick();
  assert.equal(q.isFaulted,true);assert.equal(fault,'queue_consumer_failed');
});
