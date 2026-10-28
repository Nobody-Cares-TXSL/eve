/**
 * T4 Runner 集成：SDK 静默失联（从不发 offline/reconnecting）时，
 * 过期的证明必须被 Runner 主动撤销，不能无限期沿用。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { Runner } from '../../src/runtime/runner.ts';
import { parseConfig } from '../../src/runtime/config.ts';
import { paths, readState, initDirs, durableRequest, readJson } from '../../src/runtime/state.ts';
import { EveArchive } from '../../src/archive/store.ts';
import type { InboundMessage } from '../../src/platform/types.ts';

const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const thread = '0:1:222:333';
const config = parseConfig({ version: 1, selfUid: '111', targetUid: '333', pollMs: 50 });
const msg = (i: number): InboundMessage => ({
  conversationId: thread, serverMessageId: `10000000000000000${i}`, clientMessageId: null,
  senderUid: '333', fromSelf: false, text: 'x', kind: 'text', messageType: 7,
  createTime: String(i), indexInConversation: null,
});

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25); }
  throw new Error('condition_not_met: ' + label);
}
async function stop(dir: string): Promise<void> {
  const p = paths(dir); await initDirs(p);
  const s = await readState(p); assert.ok(s);
  const id = randomUUID();
  await durableRequest(join(p.requests, id + '.json'), { id, instanceId: s.instanceId, action: 'stop', at: Date.now() });
  await until(async () => { try { return !!(await readJson(join(p.acks, id + '.json'))); } catch { return false; } }, 'stop ack');
}

test('SDK 从不发 offline：过期证明仍必须被 Runner 撤销并重新对账', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t4-expiry-runner-'));
  const stateDir = join(dir, 'state');
  const db = join(dir, 'eve.sqlite');
  const port = new MockPlatformPort({ uid: '111', imUid: '222' });
  port.delivered.push(...[0, 1, 2, 3, 4].map(msg));
  // 极短有效期（1ms 级别不合适，用 100ms）便于在测试内触发过期
  const running = new Runner(stateDir, port, config, db, true, 0, 100).run();
  try {
    await until(async () => (await readState(paths(stateDir)))?.phase === 'running', 'running');

    // 先建立一次 verified
    port.pushMessage(msg(5));
    await until(async () => {
      try {
        const a = EveArchive.open(db, identity);
        const ok = a.conversationState(thread) === 'verified';
        a.close(); return ok;
      } catch { return false; }
    }, 'initial verified');

    // 关键：让 SDK 静默失联——platformOnline 仍为 true（没有 offline 事件），
    // 但对账实际无法再成功（readHistory 抛错），证明不会被刷新。
    port.failHistory = true;

    // 等到证明确实过期（ageMs 超过有效期），此时 Runner 必须撤销。
    // 不依赖某一瞬间的状态字符串：对账失败路径可能落到 gap 或 unverified。
    let expired = false;
    for (let i = 0; i < 120; i++) {
      const a = EveArchive.open(db, identity);
      const s = a.coverageStatus(thread, 100);
      a.close();
      if (s.ageMs !== null && s.ageMs > 100) { expired = true; break; }
      if (!s.verified) { expired = true; break; }
      await delay(50);
    }
    assert.equal(expired, true, '证明必须最终过期或退出 verified');
    // 过期后给 Runner 一个轮询周期执行撤销
    await delay(300);

    // 撤销后必须不可用；具体落到 unverified 还是 gap 取决于失败路径，
    // 两者都不放行——断言行为而非字符串。
    const a = EveArchive.open(db, identity);
    try {
      const state = a.conversationState(thread);
      assert.notEqual(state, 'verified', '过期后绝不能仍是 verified');
      assert.equal(a.coverageStatus(thread, 100).usable, false, '过期后必须不可用');
      assert.ok(a.getVerifiedAnchor(thread) !== null, '历史锚点必须保留以便重新对账');
    } finally { a.close(); }

    await stop(stateDir);
    assert.equal(await running, 0);
  } finally {
    if (port.startCount > 0) { /* 已在 stop 中处理 */ }
    await rm(dir, { recursive: true, force: true });
  }
});

test('有效期内证明不被误撤销', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t4-expiry-keep-'));
  const stateDir = join(dir, 'state');
  const db = join(dir, 'eve.sqlite');
  const port = new MockPlatformPort({ uid: '111', imUid: '222' });
  port.delivered.push(...[0, 1, 2, 3, 4].map(msg));
  // 很长的有效期：测试期间不应触发过期
  const running = new Runner(stateDir, port, config, db, true, 0, 600_000).run();
  try {
    await until(async () => (await readState(paths(stateDir)))?.phase === 'running', 'running');
    port.pushMessage(msg(5));
    await until(async () => {
      try {
        const a = EveArchive.open(db, identity);
        const ok = a.conversationState(thread) === 'verified';
        a.close(); return ok;
      } catch { return false; }
    }, 'verified');
    // 观察一段时间，证明不应被撤销
    await delay(800);
    const a = EveArchive.open(db, identity);
    try { assert.equal(a.conversationState(thread), 'verified', '有效期内不得误撤销'); }
    finally { a.close(); }
    await stop(stateDir);
    assert.equal(await running, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
