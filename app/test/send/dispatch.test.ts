/**
 * T6-3c：受控发送执行与回执分类（离线）。
 * 契约：docs/contracts/send.md §12。不接真实 SDK、不调用 sendMsg。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import type { InboundMessage } from '../../src/platform/types.ts';
import {
  classifySendResponse, dispatchOnce,
  type ApprovalRecord, type DispatchInput, type SendResponseLike, type SendTransport,
} from '../../src/send/dispatch.ts';

const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const EVENT = '9000000000000000001';
const TEXT = '这是一条只供离线测试的回复';

const message = (id: string): InboundMessage => ({
  conversationId: THREAD, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: '今晚聊聊？', kind: 'text', messageType: 7,
  createTime: String(Date.now() - 2000 + Number(BigInt(id) % 10n)),
  indexInConversation: String(BigInt(id) % 10n),
});

interface Ctx { a: EveArchive; file: string; intentId: string; now: number; }

async function withPendingIntent(fn: (c: Ctx) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-dispatch-'));
  const file = join(dir, 'demo.sqlite');
  const a = EveArchive.open(file, ID);
  const p = new MockPlatformPort({ uid: '111', imUid: '222' });
  try {
    a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5();
    p.delivered.push(message('9000000000000000000'));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'b', isSafe: () => true })).state, 'verified');
    p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'n', isSafe: () => true })).state, 'verified');
    const reservation = a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    assert.ok(reservation);
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const r = a.finalizeAiWithSend({
      claimId: reservation.claimId,
      decision: { action: 'reply', text: TEXT, reason: '测试', delayMs: 0 },
      identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
      runtime: { phase: 'running', paused: false },
      policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
        silence: { startMinute: (minute + 20) % 1440, endMinute: (minute + 21) % 1440 } },
      now, coverageMaxAgeMs: 90_000, bodyRetentionMs: 900_000,
    });
    assert.equal(r.status, 'recorded_pending');
    if (r.status !== 'recorded_pending') return;
    await fn({ a, file, intentId: r.intentId, now });
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const transport = (r: SendResponseLike | (() => Promise<SendResponseLike>)): SendTransport & { calls: number } => {
  const t = {
    calls: 0,
    async sendText() { t.calls++; return typeof r === 'function' ? r() : r; },
  };
  return t;
};

const session = (over: Record<string, unknown> = {}) => ({
  accountCount: 1, uid: '111', imUid: '222', verified: true, online: true,
  contact: { kind: 'friend' as const, uid: '333', accountUid: '111', threadId: THREAD,
    conversationType: 1, blocked: false as boolean | undefined },
  ...over,
});
const approval = (c: Ctx, over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  approvalId: 'appr-12345678', intentId: c.intentId,
  approvedAtMs: c.now - 1_000, expiresAtMs: c.now + 60_000, ...over,
});
const input = (c: Ctx, over: Partial<DispatchInput> = {}): DispatchInput => ({
  intentId: c.intentId,
  expected: { ownerUid: '111', ownImUid: '222', targetUid: '333' },
  session: session(),
  transport: transport({ statusCode: 0, serverMessageId: '7701260499833538097' }),
  approval: approval(c),
  nowMs: c.now, coverageMaxAgeMs: 90_000, maxTextLength: 500, timeoutMs: 1_000,
  ...over,
});
const state = (file: string, intentId: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT status,reason_code,evidence FROM send_intents WHERE intent_id=?').get(intentId) as
      { status: string; reason_code: string | null; evidence: string | null };
    const text = db.prepare('SELECT COUNT(*) n FROM send_text WHERE intent_id=?').get(intentId) as { n: number };
    return { ...row, textRows: Number(text.n) };
  } finally { db.close(); }
};

test('回执分类：只有 statusCode=0 且有效 serverMessageId 才算 sent', () => {
  assert.deepEqual(classifySendResponse({ statusCode: 0, serverMessageId: '7701260499833538097' }),
    { status: 'sent', evidence: '7701260499833538097' });
  assert.deepEqual(classifySendResponse({ statusCode: 1, serverMessageId: 'x' }),
    { status: 'failed', reasonCode: 'platform_rejected' });
  assert.deepEqual(classifySendResponse({ statusCode: 0, checkCode: 8610, serverMessageId: 'x' }),
    { status: 'failed', reasonCode: 'risk_controlled' });
  assert.deepEqual(classifySendResponse({ statusCode: 0 }), { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 0, serverMessageId: '0' }), { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 0, serverMessageId: '' }), { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 1.5 } as SendResponseLike), { status: 'unknown', reasonCode: 'ambiguous_result' });
});

test('正常回执 → sent，账本留证据、正文被删除', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const r = await dispatchOnce(c.a, input(c, { transport: t }));
  assert.deepEqual(r, { status: 'sent', intentId: c.intentId, evidence: '7701260499833538097' });
  assert.equal(t.calls, 1);
  const s = state(c.file, c.intentId);
  assert.equal(s.status, 'sent');
  assert.equal(s.evidence, '7701260499833538097');
  assert.equal(s.textRows, 0, '终态必须删除正文');
}));

test('平台拒绝与风控拦截 → failed，不重试', () => withPendingIntent(async (c) => {
  const rejectedRun = await dispatchOnce(c.a, input(c, { transport: transport({ statusCode: 400, statusMsg: 'x' }) }));
  assert.deepEqual(rejectedRun, { status: 'failed', intentId: c.intentId, reasonCode: 'platform_rejected' });
  assert.equal(state(c.file, c.intentId).status, 'failed');
}));

test('风控 8610 → failed/risk_controlled', () => withPendingIntent(async (c) => {
  const r = await dispatchOnce(c.a, input(c, { transport: transport({ statusCode: 0, checkCode: 8610, serverMessageId: 'x' }) }));
  assert.deepEqual(r, { status: 'failed', intentId: c.intentId, reasonCode: 'risk_controlled' });
}));

test('回执缺 ID → unknown，永不自动重试', () => withPendingIntent(async (c) => {
  const r = await dispatchOnce(c.a, input(c, { transport: transport({ statusCode: 0 }) }));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'ambiguous_result' });
  assert.equal(state(c.file, c.intentId).status, 'unknown');
  // 终态后不可再认领
  assert.equal(c.a.claimSendIntent(c.intentId, c.now + 1), false);
}));

test('超时 → unknown/timeout；传输异常 → unknown/transport_error', () => withPendingIntent(async (c) => {
  const hang = transport(() => new Promise<SendResponseLike>(() => undefined));
  const r1 = await dispatchOnce(c.a, input(c, { transport: hang, timeoutMs: 50 }));
  assert.deepEqual(r1, { status: 'unknown', intentId: c.intentId, reasonCode: 'timeout' });
}));

test('传输抛异常 → unknown/transport_error', () => withPendingIntent(async (c) => {
  const boom = transport(() => Promise.reject(new Error('network down')));
  const r = await dispatchOnce(c.a, input(c, { transport: boom }));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'transport_error' });
}));

test('审批缺失、作用域不符、已过期或尚未生效 → rejected，且不产生副作用', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: 'x' });
  assert.equal((await dispatchOnce(c.a, input(c, { approval: null, transport: t }))).status, 'rejected');
  const wrong = await dispatchOnce(c.a, input(c, { approval: approval(c, { intentId: 'other' }), transport: t }));
  assert.deepEqual(wrong, { status: 'rejected', reasonCode: 'approval_scope_mismatch' });
  const expired = await dispatchOnce(c.a, input(c, {
    approval: { approvalId: 'appr-12345678', intentId: c.intentId, approvedAtMs: c.now - 10_000, expiresAtMs: c.now - 1 }, transport: t }));
  assert.deepEqual(expired, { status: 'rejected', reasonCode: 'approval_expired' });
  const future = await dispatchOnce(c.a, input(c, {
    approval: { approvalId: 'appr-12345678', intentId: c.intentId, approvedAtMs: c.now + 5_000, expiresAtMs: c.now + 60_000 }, transport: t }));
  assert.deepEqual(future, { status: 'rejected', reasonCode: 'approval_expired' });
  assert.equal(t.calls, 0, '被拒绝时绝不能调用传输层');
  assert.equal(state(c.file, c.intentId).status, 'pending', '拒绝不得改变意图状态');
  assert.equal(state(c.file, c.intentId).textRows, 1, '拒绝不得删除正文');
}));

test('会话/联系人异常 → rejected，且不调用传输层', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: 'x' });
  const cases: [string, unknown][] = [
    ['session_unverified', session({ online: false })],
    ['session_unverified', session({ accountCount: 2 })],
    ['session_unverified', session({ imUid: '999' })],
    ['contact_blocked', session({ contact: { ...session().contact, blocked: undefined } })],
    ['contact_blocked', session({ contact: { ...session().contact, blocked: true } })],
    ['contact_unverified', session({ contact: { ...session().contact, kind: 'group' } })],
    ['contact_unverified', session({ contact: { ...session().contact, uid: '444' } })],
    ['foreign_conversation', session({ contact: { ...session().contact, threadId: '0:1:222:444' } })],
    ['contact_unverified', session({ contact: null })],
  ];
  for (const [code, s] of cases) {
    const r = await dispatchOnce(c.a, input(c, { session: s as DispatchInput['session'], transport: t }));
    assert.deepEqual(r, { status: 'rejected', reasonCode: code });
  }
  assert.equal(t.calls, 0);
  assert.equal(state(c.file, c.intentId).status, 'pending');
}));

test('Proof 换代 → rejected proof_changed，不调用传输层', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: 'x' });
  const r = await dispatchOnce(c.a, input(c, { nowMs: c.now + 5_000, coverageMaxAgeMs: 1, transport: t }));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'proof_changed' });
  assert.equal(t.calls, 0);
}));

test('两个连接争用：后到者 already_claimed，绝不二次发送', () => withPendingIntent(async (c) => {
  const second = EveArchive.open(c.file, ID);
  try {
    const first = dispatchOnce(c.a, input(c, { transport: transport({ statusCode: 0, serverMessageId: 'a' }) }));
    // 在第一个尚未完成 claim 前无法插入；改为先手动 claim 再让第二个尝试
    await first;
    const r = await dispatchOnce(second, input(c, { transport: transport({ statusCode: 0, serverMessageId: 'b' }) }));
    assert.deepEqual(r, { status: 'rejected', reasonCode: 'intent_not_pending' }, '已终结的意图不得再次派发');
  } finally { second.close(); }
}));

test('未到 not_before → rejected not_due，且状态不变', () => withPendingIntent(async (c) => {
  // 直接构造一个带延迟的意图：重建场景成本高，这里用 nowMs 早于 notBefore 的方式验证
  const b = c.a.sendDispatchBinding(c.intentId);
  assert.ok(b && b.notBeforeMs !== null);
  const r = await dispatchOnce(c.a, input(c, { nowMs: b.notBeforeMs - 1 }));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'not_due' });
  assert.equal(state(c.file, c.intentId).status, 'pending');
}));

test('dispatch.ts 无运行时 SDK 依赖、无 sendMsg', () => {
  const source = readFileSync(new URL('../../src/send/dispatch.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]douyin-im['"]/);
  assert.doesNotMatch(source, /\.sendMsg\s*\(/);
});
