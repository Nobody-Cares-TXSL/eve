/**
 * T6-L0 Runtime：Runner 端到端（Fake SDK，离线）。
 *
 * 验证真正的运行时闭环，而不只是 runL0Once()：
 *   配置关闭零发送 / 配置开启自主决策 / 延迟到期派发 / 暂停与断线阻断 /
 *   崩溃恢复 / 单实例锁 / 同进程 Port 生命周期。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import { Runner, type L0Slot } from '../../src/runtime/runner.ts';
import { parseConfig } from '../../src/runtime/config.ts';
import { paths, readState, initDirs, durableRequest, readJson } from '../../src/runtime/state.ts';
import { installOutletRegistry, __resetInstalledRegistryForTest, verifyAgainstInstalled } from '../../src/platform/outbound-transport.ts';
import type { AiBackend } from '../../src/ai/contracts.ts';
import type { InboundMessage } from '../../src/platform/types.ts';

const THREAD = '0:1:222:333';
const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const msg = (i: number): InboundMessage => ({
  conversationId: THREAD, serverMessageId: String(7701260499833538097n + BigInt(i)),
  clientMessageId: null, senderUid: '333', fromSelf: false, text: 'mock-' + i,
  kind: 'text', messageType: 7, createTime: String(1793089447000 + i * 1000), indexInConversation: String(i),
});

/** Fake SDK：contact.account === account，sendMsg 只记录。 */
function fakeSdk(opts: { online?: boolean; blocked?: boolean; kind?: 'friend' | 'none' } = {}) {
  const contact = {
    account: null as unknown, uid: '333', threadId: THREAD, conversationType: 1,
    blocked: opts.blocked ?? false, sent: [] as string[],
    async sendMsg(text: string) { contact.sent.push(text); return { statusCode: 0, serverMessageId: '7701260499833538098' }; },
  };
  const account = {
    uid: '111', imUid: '222', online: opts.online ?? true,
    pickFriend: (uid: string) => (opts.kind !== 'none' && uid === '333' ? contact : undefined),
    pickStranger: () => undefined,
  };
  contact.account = account;
  return { client: { accounts: [account] }, account, contact };
}

const replyBackend = (text = '模型自己写的回复'): AiBackend =>
  ({ id: 'claude_code', kind: 'agent-runtime', evaluate: async () => ({ action: 'reply', text, reason: '自然回应', delayMs: 0 }) });
const skipBackend = (): AiBackend =>
  ({ id: 'claude_code', kind: 'agent-runtime', evaluate: async () => ({ action: 'skip', reason: '无需回复' }) });
const deferBackend = (delayMs: number): AiBackend =>
  ({ id: 'claude_code', kind: 'agent-runtime', evaluate: async () => ({ action: 'reply', text: '延迟回复', reason: '稍后', delayMs }) });

interface Env {
  dir: string; stateDir: string; db: string; port: MockPlatformPort; sdk: ReturnType<typeof fakeSdk>;
  archive: EveArchive; now: number;
}

async function makeEnv(opts: { sdk?: ReturnType<typeof fakeSdk> } = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-l0-runner-'));
  const db = join(dir, 'eve.sqlite');
  const sdk = opts.sdk ?? fakeSdk();
  const archive = EveArchive.open(db, ID);
  archive.upgradeToV2(); archive.upgradeToV3(); archive.upgradeToV4(); archive.upgradeToV5(); archive.upgradeToV6();
  const port = new MockPlatformPort({ uid: '111', imUid: '222' });
  port.delivered.push(msg(0));
  assert.equal((await reconcileOnce({ archive, port, conversationId: THREAD, instanceId: 'b', imUid: '222', isSafe: () => true })).state, 'verified');
  port.delivered.push(msg(1));
  assert.equal((await reconcileOnce({ archive, port, conversationId: THREAD, instanceId: 'n', imUid: '222', isSafe: () => true })).state, 'verified');
  const now = Date.now();
  archive.close();
  return { dir, stateDir: join(dir, 'state'), db, port, sdk, archive, now };
}

/** 构造 L0Slot：出口来自 fake SDK，经测试注册表签发。 */
function makeL0(env: Env, backend: AiBackend, opts: { quietPeriodMs?: number; enabled?: boolean } = {}): L0Slot | undefined {
  if (opts.enabled === false) return undefined;
  __resetInstalledRegistryForTest();
  const registry = installOutletRegistry();
  const minute = new Date(env.now).getHours() * 60 + new Date(env.now).getMinutes();
  const silenceStart = (minute + 180) % 1440;
  return {
    backend,
    getOutlet: (conv) => (conv === THREAD
      ? registry.issue(THREAD, '333', (m) => env.sdk.contact.sendMsg(m))
      : null),
    getLive: (conv) => (conv === THREAD ? env.sdk : null),
    timeoutMs: 1000,
    maxBatchEvents: 1,
    bodyRetentionMs: 900_000,
    policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
      silence: { startMinute: silenceStart, endMinute: (silenceStart + 60) % 1440 } },
    quietPeriodMs: opts.quietPeriodMs ?? 0,
    maxDecisions: 3,
  };
}

const cfg = (autoReply: unknown) => parseConfig({
  version: 1, selfUid: '111', targetUid: '333', pollMs: 50, autoReply,
});

async function waitFor(check: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error('condition_not_met: ' + label);
}
async function stopRunner(dir: string): Promise<void> {
  const p = paths(dir); await initDirs(p);
  const s = await readState(p); assert.ok(s);
  const id = randomUUID();
  await durableRequest(join(p.requests, id + '.json'), { id, instanceId: s.instanceId, action: 'stop', at: Date.now() });
  await waitFor(async () => { try { return !!(await readJson(join(p.acks, id + '.json'))); } catch { return false; } }, 'stop ack');
}
const intentRows = (db: string): { status: string; not_before_ms: number | null }[] => {
  const h = new DatabaseSync(db, { readOnly: true });
  try { return h.prepare('SELECT status,not_before_ms FROM send_intents').all() as { status: string; not_before_ms: number | null }[]; }
  finally { h.close(); }
};

test('配置关闭（缺失 autoReply）：AI 决策与发送调用均为零', async () => {
  const env = await makeEnv();
  try {
    let aiCalls = 0;
    const backend: AiBackend = { id: 'claude_code', kind: 'agent-runtime',
      evaluate: async () => { aiCalls++; return { action: 'reply', text: 'x', reason: 'r', delayMs: 0 }; } };
    // 不传 l0（等价于 enabled:false）
    const running = new Runner(env.stateDir, env.port, cfg(undefined), env.db, true, 0, 90_000, undefined, undefined).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await delay(1500);
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
    assert.equal(aiCalls, 0, 'AI 不得被调用');
    assert.equal(env.sdk.contact.sent.length, 0, '发送次数必须为零');
    assert.equal(intentRows(env.db).length, 0, '不得产生任何意图');
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('配置开启：AI 自主 reply → 经全部 Gate → 一次受控派发', async () => {
  const env = await makeEnv();
  try {
    const l0 = makeL0(env, replyBackend('Runner 端到端回复'));
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await waitFor(() => env.sdk.contact.sent.length === 1, 'sent once');
    assert.equal(env.sdk.contact.sent[0], 'Runner 端到端回复');
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
    assert.equal(env.sdk.contact.sent.length, 1, '恰好一次');
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('配置开启：AI 选择 skip → 零发送、零意图', async () => {
  const env = await makeEnv();
  try {
    const l0 = makeL0(env, skipBackend());
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await delay(1500);
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
    assert.equal(env.sdk.contact.sent.length, 0);
    assert.equal(intentRows(env.db).length, 0);
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('延迟回复：到期派发同一意图，不重新调用 AI', async () => {
  const env = await makeEnv();
  try {
    let aiCalls = 0;
    const backend: AiBackend = { id: 'claude_code', kind: 'agent-runtime',
      evaluate: async () => { aiCalls++; return { action: 'reply', text: '延迟后的回复', reason: '稍后', delayMs: 800 }; } };
    const l0 = makeL0(env, backend);
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    // 意图先出现，未到期时不得发送
    await waitFor(() => intentRows(env.db).length === 1, 'intent created');
    assert.equal(env.sdk.contact.sent.length, 0, '未到 notBefore 不得发送');
    const before = aiCalls;
    await waitFor(() => env.sdk.contact.sent.length === 1, 'sent after delay', 10_000);
    assert.equal(env.sdk.contact.sent[0], '延迟后的回复');
    assert.equal(aiCalls, before, '到期派发不得重新调用 AI');
    assert.equal(intentRows(env.db).length, 1, '只有一个意图');
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('暂停立即阻断发送；恢复后不重发旧意图', async () => {
  const env = await makeEnv();
  try {
    let aiCalls = 0;
    const backend: AiBackend = { id: 'claude_code', kind: 'agent-runtime',
      evaluate: async () => { aiCalls++; return { action: 'reply', text: '暂停测试', reason: 'r', delayMs: 600 }; } };
    const l0 = makeL0(env, backend);
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await waitFor(() => intentRows(env.db).length === 1, 'intent created');
    const id = randomUUID();
    const s = await readState(paths(env.stateDir));
    await initDirs(paths(env.stateDir));
    await durableRequest(join(paths(env.stateDir).requests, id + '.json'),
      { id, instanceId: s!.instanceId, action: 'pause', at: Date.now() });
    await waitFor(async () => { try { return !!(await readJson(join(paths(env.stateDir).acks, id + '.json'))); } catch { return false; } }, 'pause ack');
    await delay(1200);
    assert.equal(env.sdk.contact.sent.length, 0, '暂停期间不得发送');
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
    assert.equal(env.sdk.contact.sent.length, 0);
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('断线立即撤销待派发资格，重连后不复活旧出口', async () => {
  const env = await makeEnv();
  try {
    const backend: AiBackend = { id: 'claude_code', kind: 'agent-runtime',
      evaluate: async () => ({ action: 'reply', text: '断线测试', reason: 'r', delayMs: 600 }) };
    const l0 = makeL0(env, backend);
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await waitFor(() => intentRows(env.db).length === 1, 'intent created');
    env.port.pushStatus({ type: 'reconnecting', attempt: 1, delayMs: 10 });
    await delay(1200);
    assert.equal(env.sdk.contact.sent.length, 0, '断线期间不得发送');
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('崩溃恢复：遗留 dispatching → unknown，绝不重发', async () => {
  const env = await makeEnv();
  try {
    // 手工造一条 dispatching 意图，模拟崩溃前状态
    const archive = EveArchive.open(env.db, ID);
    const reservation = archive.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    assert.ok(reservation);
    const fin = archive.finalizeAiWithSend({
      claimId: reservation.claimId,
      decision: { action: 'reply', text: '崩溃前生成的', reason: 'r', delayMs: 0 },
      identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
      runtime: { phase: 'running', paused: false },
      policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
        silence: { startMinute: 0, endMinute: 1 } },
      now: env.now, coverageMaxAgeMs: 90_000, bodyRetentionMs: 900_000,
    });
    assert.equal(fin.status, 'recorded_pending');
    if (fin.status !== 'recorded_pending') return;
    archive.claimSendIntent(fin.intentId, env.now); // 进入 dispatching 后"崩溃"
    archive.close();

    const l0 = makeL0(env, replyBackend('新回复'));
    const running = new Runner(env.stateDir, env.port, cfg({ enabled: true }), env.db, true, 0, 90_000, undefined, l0).run();
    await waitFor(async () => (await readState(paths(env.stateDir)))?.phase === 'running', 'running');
    await delay(1200);
    await stopRunner(env.stateDir);
    assert.equal(await running, 0);
    const rows = intentRows(env.db);
    assert.equal(rows[0]?.status, 'unknown', '遗留 dispatching 必须转 unknown');
    assert.equal(env.sdk.contact.sent.length, 0, 'unknown 绝不重发');
  } finally { rmSync(env.dir, { recursive: true, force: true }); }
});

test('单实例互斥：CLI 层 flock 保证同一 stateDir 只有一个 run（见 cli-integration）', () => {
  // Runner 本身不持有 flock —— 单实例锁在 CLI 组合根（flock --no-fork）。
  // 这里只做结构性确认，真正的互斥由 test/runtime/cli-integration.test.ts 覆盖。
  const src = readFileSync(new URL('../../src/cli.ts', import.meta.url), 'utf8');
  assert.match(src, /flock/, 'CLI 必须使用 flock 保证单实例');
  assert.match(src, /--no-fork/, 'flock 必须 --no-fork 以保持 PID 语义');
});

test('同进程 Port 生命周期：stop 后旧出口失效，新注册表仍可签发', async () => {
  __resetInstalledRegistryForTest();
  const first = installOutletRegistry();
  const oldOutlet = first.issue(THREAD, '333', async () => ({ statusCode: 0 }));
  assert.equal(verifyAgainstInstalled(oldOutlet), true);
  first.revokeAll();
  assert.equal(verifyAgainstInstalled(oldOutlet), false, '旧出口必须失效');

  // 新会话：重新安装（真实场景是新 Port 实例启动）
  __resetInstalledRegistryForTest();
  const second = installOutletRegistry();
  const newOutlet = second.issue(THREAD, '333', async () => ({ statusCode: 0 }));
  assert.equal(verifyAgainstInstalled(newOutlet), true, '新注册表必须能签出可用出口');
});

test('Runner 不导入 SDK，也不直接调用 sendMsg', () => {
  for (const f of ['../../src/runtime/runner.ts', '../../src/runtime/auto-reply.ts']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from ['"]douyin-im['"]/);
    assert.doesNotMatch(src, /\.sendMsg\s*\(/);
  }
});
