/** T2 Gate 补强：控制请求幂等/重放/优先级、队列溢出→paused_env→码 3、停机异常→码 1（进程内）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Runner, type ControlRequest } from '../../src/runtime/runner.ts';
import { parseConfig } from '../../src/runtime/config.ts';
import { paths, readState, initDirs, atomicJson } from '../../src/runtime/state.ts';
import type { HistoryPage, InboundMessage, PlatformPort, PlatformSink } from '../../src/platform/types.ts';

const msg = (id: string): InboundMessage => ({
  conversationId: '0:1:111:222', serverMessageId: id, clientMessageId: null,
  senderUid: '222', fromSelf: false, text: 'x', kind: 'text', messageType: 7,
  createTime: '1', indexInConversation: null,
});

class TestPort implements PlatformPort {
  private sink?: PlatformSink;
  private readonly mode: 'clean' | 'overflow' | 'reject-stop';
  stopCalls = 0;
  constructor(mode: 'clean' | 'overflow' | 'reject-stop') { this.mode = mode; }
  subscribe(sink: PlatformSink): void { this.sink = sink; }
  async start(): Promise<void> {
    if (this.mode === 'overflow') {
      // capacity=1：第 1 条被 kick 立即取走（pending=0），第 2 条进入 pending(=1)，
      // 第 3 条时 pending(1) ≥ capacity(1) → 必然触发溢出。
      this.sink?.onMessage(msg('1'));
      this.sink?.onMessage(msg('2'));
      this.sink?.onMessage(msg('3'));
    }
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.mode === 'reject-stop') throw new Error('logout_rejected');
  }
  async readHistory(): Promise<HistoryPage> { throw new Error('T2 不用历史'); }
}

async function freshDir(): Promise<string> { return mkdtemp(join(tmpdir(), 'eve-t2-ctl-')); }
async function waitFor(phase: string, file: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((JSON.parse(await readFile(file, 'utf8')) as { phase: string }).phase === phase) return; } catch { /* 尚未落盘 */ }
    await delay(30);
  }
  throw new Error('未观察到状态 ' + phase);
}
async function putRequest(dir: string, req: ControlRequest): Promise<void> {
  const p = paths(dir);
  await atomicJson(join(p.requests, req.id + '.json'), req);
}
async function getAck(dir: string, id: string): Promise<{ ok: boolean; reason: string }> {
  const p = paths(dir);
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(join(p.acks, id + '.json'), 'utf8')) as { ok: boolean; reason: string }; }
    catch { await delay(30); }
  }
  throw new Error('ack 超时 ' + id);
}

test('队列溢出：持久化 paused_env，run 返回码 3', async () => {
  const dir = await freshDir();
  try {
    const port = new TestPort('overflow');
    const code = await new Runner(dir, port,
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 1, pollMs: 50 })).run();
    assert.equal(code, 3);
    const state = await readState(paths(dir));
    assert.equal(state?.phase, 'paused_env');
    assert.match(state?.reason ?? '', /overflow/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('同一请求重放不二次执行；已 resume 后旧 pause 重放被丢弃', async () => {
  const dir = await freshDir();
  try {
    const port = new TestPort('clean');
    const runner = new Runner(dir, port,
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 50 }));
    const running = runner.run();
    const file = paths(dir).state;
    await waitFor('running', file);
    const instanceId = (await readState(paths(dir)))?.instanceId ?? '';
    const pauseId = randomUUID();
    await putRequest(dir, { id: pauseId, instanceId, action: 'pause', at: Date.now() });
    assert.equal((await getAck(dir, pauseId)).ok, true);
    await waitFor('paused_manual', file);
    const resumeId = randomUUID();
    await putRequest(dir, { id: resumeId, instanceId, action: 'resume', at: Date.now() });
    assert.equal((await getAck(dir, resumeId)).ok, true);
    await waitFor('running', file);
    // 重放：完全相同的 pause 请求文件重建（同 id、同 instanceId）
    await putRequest(dir, { id: pauseId, instanceId, action: 'pause', at: Date.now() });
    await delay(400); // ≥8 个 poll 周期
    const after = await readState(paths(dir));
    assert.equal(after?.phase, 'running', '重放的 pause 不得再次执行');
    // 首次 ack 内容保持不变（未被重放覆盖、未生成新结果）
    const replayed = JSON.parse(await readFile(join(paths(dir).acks, pauseId + '.json'), 'utf8')) as { ok: boolean; phase: string };
    assert.equal(replayed.ok, true);
    assert.equal(replayed.phase, 'paused_manual');
    await putRequest(dir, { id: randomUUID(), instanceId, action: 'stop', at: Date.now() });
    assert.equal(await running, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stop 与 pause 同轮并发：stop 优先，pause 得到明确拒绝', async () => {
  const dir = await freshDir();
  try {
    const port = new TestPort('clean');
    const runner = new Runner(dir, port,
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 1500 }));
    const running = runner.run();
    await waitFor('running', paths(dir).state);
    const instanceId = (await readState(paths(dir)))?.instanceId ?? '';
    const stopId = randomUUID(); const pauseId = randomUUID();
    const at = Date.now();
    // 大 pollMs 下两个请求都落在同一个 1500ms 扫描间隙内 → 同轮处理
    await Promise.all([
      putRequest(dir, { id: stopId, instanceId, action: 'stop', at }),
      putRequest(dir, { id: pauseId, instanceId, action: 'pause', at: at + 1 }),
    ]);
    assert.equal((await getAck(dir, stopId)).ok, true);
    const pauseAck = await getAck(dir, pauseId);
    assert.equal(pauseAck.ok, false);
    assert.equal(pauseAck.reason, 'stopping');
    assert.equal(await running, 0);
    assert.equal((await readState(paths(dir)))?.phase, 'stopped');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('port.stop 拒绝：不谎称干净退出，run 返回码 1 且状态 error', async () => {
  const dir = await freshDir();
  try {
    const port = new TestPort('reject-stop');
    const runner = new Runner(dir, port,
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 50 }));
    const running = runner.run();
    await waitFor('running', paths(dir).state);
    const instanceId = (await readState(paths(dir)))?.instanceId ?? '';
    const stopId = randomUUID();
    await putRequest(dir, { id: stopId, instanceId, action: 'stop', at: Date.now() });
    assert.equal((await getAck(dir, stopId)).ok, true, '停机请求本身已确认');
    assert.equal(await running, 1, 'logout 被拒 → 不得报 0');
    const state = await readState(paths(dir));
    assert.equal(state?.phase, 'error');
    assert.equal(state?.reason, 'shutdown_unconfirmed');
    assert.equal(port.stopCalls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('过期实例指令：跨重启重放只得到 old_instance ack，不影响新实例', async () => {
  const dir = await freshDir();
  try {
    const p = paths(dir);
    await initDirs(p);
    const oldInstance = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // 伪造上一实例留下的请求（当前无实例，交给第一次 run 处理）
    const reqId = randomUUID();
    const stateFile = join(dir, 'runtime.json');
    const runner1 = new Runner(dir, new TestPort('clean'),
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 50 }));
    const run1 = runner1.run();
    await waitFor('running', stateFile);
    await putRequest(dir, { id: reqId, instanceId: oldInstance, action: 'pause', at: Date.now() });
    const ack = await getAck(dir, reqId);
    assert.equal(ack.ok, false);
    assert.equal(ack.reason, 'old_instance');
    assert.equal((await readState(p))?.phase, 'running', '旧实例指令不得改变新实例状态');
    const live = (await readState(p))?.instanceId ?? '';
    assert.notEqual(live, oldInstance);
    await putRequest(dir, { id: randomUUID(), instanceId: live, action: 'stop', at: Date.now() });
    assert.equal(await run1, 0);
    void stateFile;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('伪造损坏的状态文件文本被拒绝读取，绝不静默覆盖', async () => {
  const dir = await freshDir();
  try {
    const p = paths(dir);
    await initDirs(p);
    await writeFile(p.state, '{"phase":"running","pid":oops}\n');
    await assert.rejects(readState(p), /损坏/);
    // run 在写入路径之前就读取状态，因此必须直接失败，且原文件保持原样
    const runner = new Runner(dir, new TestPort('clean'),
      parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 50 }));
    await assert.rejects(runner.run(), /损坏/);
    assert.equal(await readFile(p.state, 'utf8'), '{"phase":"running","pid":oops}\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
