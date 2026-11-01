/**
 * T6 L0 自动回复端到端（Fake SDK，离线）。
 * 契约：docs/contracts/send.md §19 + D-019。
 * 验证：AI 生成合法 reply 后无需人工审批即可经全部安全 Gate 完成一次受控派发。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import { createOutletRegistry, type OutletRegistry, type TrustedSendPort } from '../../src/platform/outbound-transport.ts';
import { runL0Once, sessionEligible, type L0LoopInput } from '../../src/send/l0-loop.ts';
import type { AiBackend } from '../../src/ai/contracts.ts';
import type { InboundMessage } from '../../src/platform/types.ts';
import type { SendResponseLike } from '../../src/send/dispatch.ts';

const THREAD = '0:1:222:333';
const IDENTITY = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const msg = (i: number): InboundMessage => ({
  conversationId: THREAD, serverMessageId: String(7701260499833538097n + BigInt(i)),
  clientMessageId: null, senderUid: '333', fromSelf: false, text: 'mock-' + i,
  kind: 'text', messageType: 7, createTime: String(1793089447000 + i * 1000), indexInConversation: String(i),
});

/** Fake SDK：对象引用关系与真实 SDK 一致（contact.account === account）。 */
function fakeSdk(opts: { online?: boolean; blocked?: boolean; kind?: 'friend' | 'stranger' | 'none' } = {}) {
  const contact: { account: unknown; uid: string; threadId: string; conversationType: number;
    blocked: boolean; sent: string[]; sendMsg: (t: string) => Promise<SendResponseLike> } = {
    account: null, uid: '333', threadId: THREAD, conversationType: 1,
    blocked: opts.blocked ?? false, sent: [],
    sendMsg: async (text: string) => {
      contact.sent.push(text);
      return { statusCode: 0, statusMsg: 'OK', serverMessageId: '7701260499833538098' };
    },
  };
  const account = {
    uid: '111', imUid: '222', online: opts.online ?? true,
    pickFriend: (uid: string) => (opts.kind === 'friend' && uid === '333' ? contact : undefined),
    pickStranger: (uid: string) => (opts.kind === 'stranger' && uid === '333' ? contact : undefined),
  };
  contact.account = account;
  if (opts.kind === 'none') {
    account.pickFriend = () => undefined;
    account.pickStranger = () => undefined;
  }
  return { client: { accounts: [account] }, account, contact };
}

/** 测试扮演 Port：自建注册表并签出绑定 fake contact 的出口。 */
const testRegistry: OutletRegistry = createOutletRegistry();
function fakeOutlet(contact: { sent: string[]; sendMsg: (t: string) => Promise<SendResponseLike> }) {
  return testRegistry.issue(THREAD, '333', async (message: string) => contact.sendMsg(message));
}

const fakeBackend = (fn: AiBackend['evaluate']): AiBackend =>
  ({ id: 'claude_code', kind: 'agent-runtime', evaluate: fn });
const reply = (text = '模型自己写的回复') => ({ action: 'reply', text, reason: '自然回应', delayMs: 0 });

interface Ctx { a: EveArchive; file: string; base: Omit<L0LoopInput, 'backend'>;
  sdk: ReturnType<typeof fakeSdk>; now: number; }

async function fixture(
  fn: (c: Ctx) => Promise<void>,
  opts: { sdk?: ReturnType<typeof fakeSdk>; runtime?: { phase: string; paused: boolean } } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-l0-'));
  const file = join(dir, 'eve.sqlite');
  const a = EveArchive.open(file, IDENTITY);
  const port = new MockPlatformPort({ uid: '111', imUid: '222' });
  const sdk = opts.sdk ?? fakeSdk({ kind: 'friend' });
  try {
    a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5(); a.upgradeToV6();
    port.delivered.push(msg(0));
    assert.equal((await reconcileOnce({ archive: a, port, conversationId: THREAD, instanceId: 'b', imUid: '222', isSafe: () => true })).state, 'verified');
    port.delivered.push(msg(1));
    assert.equal((await reconcileOnce({ archive: a, port, conversationId: THREAD, instanceId: 'n', imUid: '222', isSafe: () => true })).state, 'verified');
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const silenceStart = (minute + 180) % 1440;
    const base: Omit<L0LoopInput, 'backend'> = {
      archive: a,
      live: sdk,
      expected: { ownerUid: '111', ownImUid: '222', targetUid: '333', conversationId: THREAD },
      transport: fakeOutlet(sdk.contact),
      outlets: testRegistry,
      handoff: {
        maxAgeMs: 90_000, timeoutMs: 1000, nowMs: now,
        runtime: opts.runtime ?? { phase: 'running', paused: false },
        sendPolicy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
          silence: { startMinute: silenceStart, endMinute: (silenceStart + 60) % 1440 } },
        bodyRetentionMs: 900_000,
      },
      dispatch: { nowMs: now, coverageMaxAgeMs: 90_000, maxTextLength: 500, timeoutMs: 1000 },
    };
    await fn({ a, file, base, sdk, now });
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (file: string, t: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare('SELECT COUNT(*) n FROM ' + t).get() as { n: number }).n); }
  finally { db.close(); }
};

test('L0 全链路：AI 生成 reply → 无人工审批 → 经全部 Gate → 一次受控派发', () => fixture(async ({ a, base, file, sdk }) => {
  const modelText = 'Eve 自己写的回复，没有人审批';
  const out = await runL0Once({ ...base, backend: fakeBackend(async () => reply(modelText)) });
  assert.deepEqual(out, { kind: 'sent', intentId: out.kind === 'sent' ? out.intentId : '', evidence: '7701260499833538098' });
  assert.equal(sdk.contact.sent.length, 1, '必须恰好发送一次');
  assert.equal(sdk.contact.sent[0], modelText, '发出的就是模型生成的正文');
  assert.equal(count(file, 'send_intents'), 1);
  assert.equal(count(file, 'send_text'), 0, '终态后正文已清理');
  assert.equal(count(file, 'send_approvals'), 0, 'L0 不产生任何审批记录');
}));

test('L0：skip 不发送', () => fixture(async ({ base, file, sdk }) => {
  const out = await runL0Once({ ...base, backend: fakeBackend(async () => ({ action: 'skip', reason: '无需回复' })) });
  assert.equal(out.kind, 'skipped');
  assert.equal(sdk.contact.sent.length, 0, 'skip 绝不能发送');
  assert.equal(count(file, 'send_intents'), 0);
}));

test('L0：defer 不发送', () => fixture(async ({ base, file, sdk }) => {
  const out = await runL0Once({ ...base, backend: fakeBackend(async () => ({ action: 'defer', reason: '稍后', delayMs: 60_000 })) });
  assert.equal(out.kind, 'deferred');
  assert.equal(sdk.contact.sent.length, 0);
  assert.equal(count(file, 'send_intents'), 0);
}));

test('L0 幂等：同一事件第二次不重复发送', () => fixture(async ({ base, file, sdk }) => {
  const first = await runL0Once({ ...base, backend: fakeBackend(async () => reply()) });
  assert.equal(first.kind, 'sent');
  const second = await runL0Once({ ...base, backend: fakeBackend(async () => reply()) });
  assert.equal(second.kind, 'no_pending_event');
  assert.equal(sdk.contact.sent.length, 1, '绝不能发出第二条');
}));

test('L0：Proof 过期立即阻断，零发送', () => fixture(async ({ base, sdk }) => {
  const expired = { ...base, dispatch: { ...base.dispatch, coverageMaxAgeMs: 1, nowMs: base.dispatch.nowMs + 5_000 } };
  const out = await runL0Once({ ...expired, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'send_blocked');
  assert.equal(sdk.contact.sent.length, 0);
}));

test('L0：身份漂移立即阻断，零发送', () => fixture(async ({ base, sdk }) => {
  const drifted = fakeSdk({ kind: 'none' });
  const out = await runL0Once({ ...base, live: drifted, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'send_blocked');
  if (out.kind === 'send_blocked') assert.equal(out.reasonCode, 'contact_unverified');
  assert.equal(drifted.contact.sent.length, 0);
}));

test('L0：被拉黑立即阻断', () => fixture(async ({ base, sdk }) => {
  const blocked = fakeSdk({ kind: 'friend', blocked: true });
  const out = await runL0Once({ ...base, live: blocked, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'send_blocked');
  assert.equal(blocked.contact.sent.length, 0);
}));

test('L0：unknown 结果不自动重试', () => fixture(async ({ base, file, sdk }) => {
  const ambiguous = testRegistry.issue(THREAD, '333', async () => ({ statusCode: -3 } as SendResponseLike));
  const out = await runL0Once({ ...base, transport: ambiguous, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'unknown');
  if (out.kind === 'unknown') assert.equal(out.reasonCode, 'ambiguous_result');
  const s = (() => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT status FROM send_intents').get() as { status: string }; }
    finally { db.close(); }
  })();
  assert.equal(s.status, 'unknown');
  // 再次调用不得重发
  const again = await runL0Once({ ...base, transport: ambiguous, backend: fakeBackend(async () => reply()) });
  assert.equal(again.kind, 'no_pending_event');
}));

test('L0：运行态暂停时不产生意图', () => fixture(async ({ base, file, sdk }) => {
  const paused = { ...base, handoff: { ...base.handoff, runtime: { phase: 'paused_manual', paused: true } } };
  const out = await runL0Once({ ...paused, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'skipped');
  assert.equal(sdk.contact.sent.length, 0);
  assert.equal(count(file, 'send_intents'), 0);
}, { runtime: { phase: 'paused_manual', paused: true } }));

test('L0：后端失败不发送、不产生意图', () => fixture(async ({ base, file, sdk }) => {
  const out = await runL0Once({ ...base, backend: fakeBackend(async () => { throw new Error('boom'); }) });
  assert.equal(out.kind, 'decision_blocked');
  assert.equal(sdk.contact.sent.length, 0);
  assert.equal(count(file, 'send_intents'), 0);
}));

test('L0：出口必须经 Port 登记；伪造出口零发送', () => fixture(async ({ base, sdk }) => {
  const forged = { conversationId: THREAD, recipientUid: '333',
    sent: [] as string[], sendText: async (m: string) => { forged.sent.push(m); return { statusCode: 0, serverMessageId: '1' }; } };
  const out = await runL0Once({ ...base, transport: forged as never, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'send_blocked');
  if (out.kind === 'send_blocked') assert.equal(out.reasonCode, 'untrusted_transport');
  assert.equal(forged.sent.length, 0);
}));

test('L0：出口被撤销后零发送', () => fixture(async ({ base, sdk }) => {
  testRegistry.revoke(base.transport);
  const out = await runL0Once({ ...base, backend: fakeBackend(async () => reply()) });
  assert.equal(out.kind, 'send_blocked');
  assert.equal(sdk.contact.sent.length, 0);
}));

test('sessionEligible 判定', () => {
  const good = { accountCount: 1, uid: '111', imUid: '222', verified: true, online: true,
    contact: { kind: 'friend' as const, uid: '333', accountUid: '111', threadId: THREAD,
      conversationType: 1, blocked: false } };
  assert.equal(sessionEligible(good), true);
  assert.equal(sessionEligible({ ...good, online: false }), false);
  assert.equal(sessionEligible({ ...good, contact: { ...good.contact, blocked: true } }), false);
  assert.equal(sessionEligible({ ...good, contact: { ...good.contact, kind: 'group' } }), false);
  assert.equal(sessionEligible(null), false);
});

test('l0-loop 不导入 SDK、不直接调用 sendMsg', () => {
  const src = readFileSync(new URL('../../src/send/l0-loop.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]douyin-im['"]/);
  assert.doesNotMatch(src, /\.sendMsg\s*\(/);
  assert.doesNotMatch(src, /createSendApproval/);
});
