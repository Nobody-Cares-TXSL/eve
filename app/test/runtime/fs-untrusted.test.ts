/** T2 Gate ⑥：不可信文件系统——符号链接与状态文件篡改。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, symlink, writeFile, mkdir, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Runner, type ControlRequest } from '../../src/runtime/runner.ts';
import { parseConfig } from '../../src/runtime/config.ts';
import { paths, readState, initDirs, atomicJson } from '../../src/runtime/state.ts';
import type { HistoryPage, PlatformPort, PlatformSink } from '../../src/platform/types.ts';

class QuietPort implements PlatformPort {
  subscribe(sink: PlatformSink): void { void sink; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async readHistory(): Promise<HistoryPage> { throw new Error('T2 不用历史'); }
}
const cfg = parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 8, pollMs: 50 });
/** 等到 run 真正进入 running（并行负载下固定延迟不可靠）。 */
async function waitRunning(p: ReturnType<typeof paths>) {
  for (let i = 0; i < 200; i++) {
    const s = await readState(p).catch(() => null);
    if (s?.phase === 'running') return s;
    await delay(30);
  }
  throw new Error('run 未进入 running');
}

test('请求目录中的符号链接不被当作控制指令', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t2-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'eve-t2-outside-'));
  try {
    const p = paths(dir);
    await initDirs(p);
    const victim = join(outside, 'victim.json');
    const fake: ControlRequest = { id: randomUUID(), instanceId: 'x', action: 'stop', at: Date.now() };
    await writeFile(victim, JSON.stringify(fake));
    // 文件名符合 UUID 规则，但本体是指向外部的符号链接
    const linked = join(p.requests, fake.id + '.json');
    await symlink(victim, linked);

    const runner = new Runner(dir, new QuietPort(), cfg);
    const running = runner.run();
    // 链接文件被拒绝读取并移除（removeFile 只删链接本身），外部文件内容不变
    let gone = false;
    for (let i = 0; i < 100; i++) {
      if (await lstat(linked).then(() => false, () => true)) { gone = true; break; }
      await delay(30);
    }
    assert.equal(gone, true, '链接本身应被移除');
    assert.equal(await readFile(victim, 'utf8'), JSON.stringify(fake));
    // 未执行 stop：run 仍在循环
    const state = await readState(p);
    assert.equal(state?.phase, 'running');

    const stopId = randomUUID();
    await atomicJson(join(p.requests, stopId + '.json'),
      { id: stopId, instanceId: state?.instanceId ?? '', action: 'stop', at: Date.now() });
    assert.equal(await running, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('状态文件被替换为符号链接时不写穿到外部目标', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t2-link2-'));
  const outside = await mkdtemp(join(tmpdir(), 'eve-t2-out2-'));
  try {
    const p = paths(dir);
    await initDirs(p);
    const target = join(outside, 'target.json');
    await writeFile(target, '{"phase":"stopped","pid":0,"processStart":"","instanceId":"x","updatedAt":1,"reason":""}');
    const before = await readFile(target, 'utf8');
    await rm(p.state, { force: true });
    await symlink(target, p.state);
    // 原子写用 rename 替换路径本身：链接被替换为真实文件，外部目标不受影响
    const runner = new Runner(dir, new QuietPort(), cfg);
    const running = runner.run();
    // 等到状态路径不再是链接（原子 rename 已替换它），而非固定等待
    for (let i = 0; i < 100; i++) {
      if (!(await lstat(p.state).catch(() => null))?.isSymbolicLink()) break;
      await delay(30);
    }
    assert.equal((await lstat(p.state)).isSymbolicLink(), false, '状态路径应为真实文件');
    assert.equal(await readFile(target, 'utf8'), before, '外部目标不得被写入');
    const state = await readState(p);
    const stopId = randomUUID();
    await atomicJson(join(p.requests, stopId + '.json'),
      { id: stopId, instanceId: state?.instanceId ?? '', action: 'stop', at: Date.now() });
    await running;
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('请求文件名与内部 id 不一致时被拒绝，防止伪造实例身份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t2-forge-'));
  try {
    const p = paths(dir);
    await initDirs(p);
    const runner = new Runner(dir, new QuietPort(), cfg);
    const running = runner.run();
    const state = await waitRunning(p);
    const fileId = randomUUID();
    const otherId = randomUUID();
    // 文件名是 fileId，内容 id 是 otherId → validControl 的 id+'.json'!==name 检查应拒绝
    await atomicJson(join(p.requests, fileId + '.json'),
      { id: otherId, instanceId: state?.instanceId ?? '', action: 'stop', at: Date.now() });
    await delay(500);
    assert.equal((await readState(p))?.phase, 'running', '伪造请求不得生效');
    const stopId = randomUUID();
    await atomicJson(join(p.requests, stopId + '.json'),
      { id: stopId, instanceId: state?.instanceId ?? '', action: 'stop', at: Date.now() });
    assert.equal(await running, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('目录中的非法 JSON 请求被丢弃，不阻塞后续合法请求', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t2-bad-'));
  try {
    const p = paths(dir);
    await initDirs(p);
    const runner = new Runner(dir, new QuietPort(), cfg);
    const running = runner.run();
    await delay(400);
    const badId = randomUUID();
    await writeFile(join(p.requests, badId + '.json'), '{ not json');
    // 轮询等待而非固定延迟：全套并行时扫描周期会被拉长
    let removed = false;
    for (let i = 0; i < 100; i++) {
      if (await lstat(join(p.requests, badId + '.json')).then(() => false, () => true)) { removed = true; break; }
      await delay(30);
    }
    assert.equal(removed, true, '非法 JSON 请求应被移除');
    const state = await readState(p);
    assert.equal(state?.phase, 'running');
    const stopId = randomUUID();
    await atomicJson(join(p.requests, stopId + '.json'),
      { id: stopId, instanceId: state?.instanceId ?? '', action: 'stop', at: Date.now() });
    assert.equal(await running, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
