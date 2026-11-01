/**
 * T6-3c-real-A：受控发送执行与回执分类（离线）。
 * 契约：docs/contracts/send.md §12–§13。不接真实 SDK、不调用 sendMsg。
 *
 * 与上一版的差异：会话必须由活实例派生；L1 审批来自 v6 账本且只能消费一次。
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
import { issueTrustedSendPort, revokeTrustedSendPort } from '../../src/platform/outbound-transport.ts';
import {
  classifySendResponse, dispatchOnce, proofStillValid, responseFromError,
  type DispatchInput, type SendResponseLike, type SendTransport,
} from '../../src/send/dispatch.ts';

const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const TEXT = '这是一条只供离线测试的回复';
const APPROVAL = 'appr-abcdef12';

const message = (id: string): InboundMessage => ({
  conversationId: THREAD, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: '今晚聊聊？', kind: 'text', messageType: 7,
  createTime: String(Date.now() - 2000 + Number(BigInt(id) % 10n)),
  indexInConversation: String(BigInt(id) % 10n),
});

/** 真实 SDK 实例的替身：对象引用关系与 SDK 一致（contact.account === account）。 */
function liveRefs(opts: {
  online?: boolean; imUid?: string; kind?: 'friend' | 'stranger' | 'none';
  blocked?: boolean | undefined; threadId?: string; uid?: string; extraAccount?: boolean;
} = {}) {
  const contact = {
    account: null as unknown, uid: opts.uid ?? '333', threadId: opts.threadId ?? THREAD,
    // 不能用 ?? false：undefined 必须保持「未知」，否则测试无法覆盖保守拒绝
    conversationType: 1, blocked: 'blocked' in opts ? opts.blocked : false,
  };
  const account = {
    uid: '111', imUid: opts.imUid ?? '222', online: opts.online ?? true,
    pickFriend: (uid: string) => (opts.kind === 'friend' && uid === '333' ? contact : undefined),
    pickStranger: (uid: string) => (opts.kind === 'stranger' && uid === '333' ? contact : undefined),
  };
  contact.account = account;
  if (opts.kind === 'none') {
    account.pickFriend = () => undefined;
    account.pickStranger = () => undefined;
  }
  const client = { accounts: opts.extraAccount ? [account, { uid: '999' }] : [account] };
  return { client, account, contact };
}

interface Ctx { a: EveArchive; file: string; intentId: string; now: number; textDigest: string; }

async function withPendingIntent(
  fn: (c: Ctx) => void | Promise<void>,
  opts: { version?: number; approve?: boolean } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-real-a-'));
  const file = join(dir, 'demo.sqlite');
  const a = EveArchive.open(file, ID);
  const p = new MockPlatformPort({ uid: '111', imUid: '222' });
  try {
    a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5();
    const version = opts.version ?? 6;
    if (version >= 6) a.upgradeToV6();
    p.delivered.push(message('9000000000000000000'));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'b', isSafe: () => true })).state, 'verified');
    p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'n', isSafe: () => true })).state, 'verified');
    const reservation = a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    assert.ok(reservation);
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    // 静默区间必须离当前时刻足够远：只留 1 分钟宽时，并行负载下跨分钟边界
    // 会偶发撞进静默期（曾出现 fixture 返回 blocked）。
    const silenceStart = (minute + 180) % 1440;
    const silenceEnd = (silenceStart + 60) % 1440;
    const r = a.finalizeAiWithSend({
      claimId: reservation.claimId,
      decision: { action: 'reply', text: TEXT, reason: '测试', delayMs: 0 },
      identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
      runtime: { phase: 'running', paused: false },
      policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
        silence: { startMinute: silenceStart, endMinute: silenceEnd } },
      now, coverageMaxAgeMs: 90_000, bodyRetentionMs: 900_000,
    });
    assert.equal(r.status, 'recorded_pending', 'fixture 必须成功创建意图，实际：' +
      JSON.stringify(r.status === 'blocked' ? { blocked: r.reasonCode } : r.status === 'recorded_no_intent' ? { noIntent: r.reasonCode } : {}));
    if (r.status !== 'recorded_pending') return;
    const binding = a.sendDispatchBinding(r.intentId);
    assert.ok(binding);
    if (version >= 6 && (opts.approve ?? true)) {
      a.createSendApproval({
        approvalId: APPROVAL, intentId: r.intentId, recipientUid: '333',
        textDigest: binding.textDigest, approvedAtMs: now - 1_000, expiresAtMs: now + 300_000,
      });
    }
    await fn({ a, file, intentId: r.intentId, now, textDigest: binding.textDigest });
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const transport = (r: SendResponseLike | (() => Promise<SendResponseLike>)): SendTransport & { calls: number } => {
  const t = {
    calls: 0,
    conversationId: THREAD,
    recipientUid: '333',
    async sendText() { t.calls++; return typeof r === 'function' ? r() : r; },
  };
  // 测试扮演「Port 内部」：显式登记为可信出口
  return issueTrustedSendPort(t);
};

const base = (c: Ctx, over: Partial<DispatchInput> = {}): DispatchInput => ({
  intentId: c.intentId,
  expected: { ownerUid: '111', ownImUid: '222', targetUid: '333', conversationId: THREAD },
  live: liveRefs({ kind: 'friend' }),
  transport: transport({ statusCode: 0, serverMessageId: '7701260499833538097' }),
  trustedPort: undefined as unknown,
  mode: 'l1_review' as const,
  approvalId: APPROVAL,
  nowMs: c.now, coverageMaxAgeMs: 90_000, maxTextLength: 500, timeoutMs: 1_000,
  ...over,
});

/** 让 trustedPort 默认跟随 transport，除非用例显式覆盖。 */
function withTrusted(input: DispatchInput): DispatchInput {
  return { ...input, trustedPort: input.trustedPort ?? input.transport };
}

const state = (file: string, intentId: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT status,reason_code,evidence FROM send_intents WHERE intent_id=?').get(intentId) as
      { status: string; reason_code: string | null; evidence: string | null };
    const text = db.prepare('SELECT COUNT(*) n FROM send_text WHERE intent_id=?').get(intentId) as { n: number };
    const appr = db.prepare('SELECT consumed_at_ms FROM send_approvals WHERE intent_id=?').get(intentId) as
      { consumed_at_ms: number | null } | undefined;
    return { ...row, textRows: Number(text.n), approvalConsumed: appr?.consumed_at_ms != null };
  } finally { db.close(); }
};

test('回执分类：只有数字形式的 serverMessageId 才算 sent', () => {
  assert.deepEqual(classifySendResponse({ statusCode: 0, serverMessageId: '7701260499833538097' }),
    { status: 'sent', evidence: '7701260499833538097' });
  for (const bad of ['abc', '0', '', '0123', '-1', '7701260499833538097x']) {
    assert.deepEqual(classifySendResponse({ statusCode: 0, serverMessageId: bad }),
      { status: 'unknown', reasonCode: 'ambiguous_result' }, bad + ' 不得判 sent');
  }
  assert.deepEqual(classifySendResponse({ statusCode: -3 }), { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 0, checkCode: 10502, serverMessageId: '123' }),
    { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 400 }), { status: 'unknown', reasonCode: 'ambiguous_result' });
  assert.deepEqual(classifySendResponse({ statusCode: 0, checkCode: 8610 }), { status: 'failed', reasonCode: 'risk_controlled' });
  assert.deepEqual(classifySendResponse({ statusCode: 1.5 } as SendResponseLike), { status: 'unknown', reasonCode: 'ambiguous_result' });
});

test('responseFromError 结构化提取，异常也可分类', () => {
  assert.equal(responseFromError(new Error('plain')), null);
  assert.equal(responseFromError({ response: 'nope' }), null);
  assert.deepEqual(responseFromError({ response: { statusCode: 0, checkCode: 8610 } }),
    { statusCode: 0, checkCode: 8610 });
});

test('正常回执 → sent，证据为服务端 ID，正文删除、审批已消费', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.deepEqual(r, { status: 'sent', intentId: c.intentId, evidence: '7701260499833538097' });
  assert.equal(t.calls, 1);
  const s = state(c.file, c.intentId);
  assert.equal(s.status, 'sent');
  assert.equal(s.evidence, '7701260499833538097');
  assert.equal(s.textRows, 0);
  assert.equal(s.approvalConsumed, true);
}));

test('SDK -3 → unknown，绝不判 failed', () => withPendingIntent(async (c) => {
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: transport({ statusCode: -3 }) })));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'ambiguous_result' });
  assert.equal(state(c.file, c.intentId).status, 'unknown');
}));

test('SendMessageError.response 8610 → failed/risk_controlled', () => withPendingIntent(async (c) => {
  const err = transport(() => Promise.reject(Object.assign(new Error('send failed'), {
    response: { statusCode: 0, checkCode: 8610 } })));
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: err })));
  assert.deepEqual(r, { status: 'failed', intentId: c.intentId, reasonCode: 'risk_controlled' });
}));

test('异常 response 为 -3 → unknown', () => withPendingIntent(async (c) => {
  const t = transport(() => Promise.reject(Object.assign(new Error('x'), { response: { statusCode: -3 } })));
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'ambiguous_result' });
}));

test('异常携带成功 response 仍判 unknown', () => withPendingIntent(async (c) => {
  const t = transport(() => Promise.reject(Object.assign(new Error('odd'), {
    response: { statusCode: 0, serverMessageId: '7701260499833538097' } })));
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.equal(r.status, 'unknown');
}));

test('超时 → unknown/timeout', () => withPendingIntent(async (c) => {
  const hang = transport(() => new Promise<SendResponseLike>(() => undefined));
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: hang, timeoutMs: 50 })));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'timeout' });
}));

test('传输无结构化异常 → unknown/transport_error', () => withPendingIntent(async (c) => {
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: transport(() => Promise.reject(new Error('boom'))) })));
  assert.deepEqual(r, { status: 'unknown', intentId: c.intentId, reasonCode: 'transport_error' });
}));

test('审批未在 v6 登记 → rejected，零副作用', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'approval_missing' });
  assert.equal(t.calls, 0);
  assert.equal(state(c.file, c.intentId).status, 'pending');
}, { approve: false }));

test('审批只能消费一次：第二次调用被拒且零调用', () => withPendingIntent(async (c) => {
  const t1 = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const first = await dispatchOnce(c.a, withTrusted(base(c, { transport: t1 })));
  assert.equal(first.status, 'sent');
  const t2 = transport({ statusCode: 0, serverMessageId: '7701260499833538098' });
  const second = await dispatchOnce(c.a, withTrusted(base(c, { transport: t2 })));
  assert.equal(second.status, 'rejected');
  assert.equal(t2.calls, 0);
  assert.equal(state(c.file, c.intentId).approvalConsumed, true);
}));

test('审批 approvalId 不符 → rejected approval_binding_mismatch', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { approvalId: 'appr-other999', transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'approval_binding_mismatch' });
  assert.equal(t.calls, 0);
}));

test('审批过期 → rejected approval_expired', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { nowMs: c.now + 400_000, transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'approval_expired' });
  assert.equal(t.calls, 0);
}));

test('会话必须来自活实例：伪造/漂移一律拒绝', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const cases: [string, ReturnType<typeof liveRefs>][] = [
    ['contact_unverified', liveRefs({ kind: 'none' })],
    ['session_unverified', liveRefs({ online: false })],
    ['session_unverified', liveRefs({ imUid: '999' })],
    ['session_unverified', liveRefs({ extraAccount: true })],
    ['contact_blocked', liveRefs({ kind: 'friend', blocked: undefined })],
    ['contact_blocked', liveRefs({ kind: 'friend', blocked: true })],
    ['contact_unverified', liveRefs({ kind: 'friend', uid: '444' })],
    ['foreign_conversation', liveRefs({ kind: 'friend', threadId: '0:1:222:444' })],
  ];
  for (const [code, live] of cases) {
    const r = await dispatchOnce(c.a, withTrusted(base(c, { live, transport: t })));
    assert.deepEqual(r, { status: 'rejected', reasonCode: code });
  }
  assert.equal(t.calls, 0);
  assert.equal(state(c.file, c.intentId).status, 'pending');
}));

test('陌生人联系人同样可发送', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { live: liveRefs({ kind: 'stranger' }), transport: t })));
  assert.equal(r.status, 'sent');
}));

test('正文等长篡改 → rejected content_digest_mismatch，传输层零调用', () => withPendingIntent(async (c) => {
  const tampered = '这是一条只供离线测试的答复';
  assert.equal(tampered.length, TEXT.length);
  const db = new DatabaseSync(c.file);
  try { db.prepare('UPDATE send_text SET body=? WHERE intent_id=?').run(tampered, c.intentId); }
  finally { db.close(); }
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'content_digest_mismatch' });
  assert.equal(t.calls, 0);
  assert.equal(state(c.file, c.intentId).status, 'pending');
}));

test('Proof 换代 → rejected proof_changed，传输层零调用', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { nowMs: c.now + 5_000, coverageMaxAgeMs: 1, transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'proof_changed' });
  assert.equal(t.calls, 0);
}));

test('proofStillValid 三态', () => withPendingIntent((c) => {
  const b = c.a.sendDispatchBinding(c.intentId);
  assert.ok(b && b.claimProofEpoch);
  assert.equal(proofStillValid(c.a, b.conversationId, 90_000, b.claimProofEpoch), true);
  assert.equal(proofStillValid(c.a, b.conversationId, 90_000, 'other'), false);
  assert.equal(proofStillValid(c.a, b.conversationId, 90_000, null), false);
}));

test('v5 库无审批表 → approval_missing（fail closed）', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'approval_missing' });
  assert.equal(t.calls, 0);
}, { version: 5 }));

test('未到 not_before → rejected not_due', () => withPendingIntent(async (c) => {
  const b = c.a.sendDispatchBinding(c.intentId);
  assert.ok(b && b.notBeforeMs !== null);
  const r = await dispatchOnce(c.a, withTrusted(base(c, { nowMs: b.notBeforeMs - 1 })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'not_due' });
}));

test('未登记的出口一律拒绝：外部构造 { sendText } 拿不到发送能力', () => withPendingIntent(async (c) => {
  // 结构与 SendTransport 完全相同，但没有 Port 令牌
  const forged = { conversationId: THREAD, recipientUid: '333',
    calls: 0, async sendText() { forged.calls++; return { statusCode: 0, serverMessageId: '1' }; } };
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: forged, trustedPort: forged })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'untrusted_transport' });
  assert.equal(forged.calls, 0, '伪造出口绝不能收到消息');
  assert.equal(state(c.file, c.intentId).status, 'pending');
}));

test('出口绑定的会话/收件人与意图不符 → untrusted_transport', () => withPendingIntent(async (c) => {
  const wrongThread = issueTrustedSendPort({ conversationId: '0:1:222:444', recipientUid: '333',
    calls: 0, async sendText() { wrongThread.calls++; return { statusCode: 0, serverMessageId: '1' }; } });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: wrongThread, trustedPort: wrongThread })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'untrusted_transport' });
  assert.equal(wrongThread.calls, 0);

  const wrongRecipient = issueTrustedSendPort({ conversationId: THREAD, recipientUid: '444',
    calls: 0, async sendText() { wrongRecipient.calls++; return { statusCode: 0, serverMessageId: '1' }; } });
  const r2 = await dispatchOnce(c.a, withTrusted(base(c, { transport: wrongRecipient, trustedPort: wrongRecipient })));
  assert.deepEqual(r2, { status: 'rejected', reasonCode: 'untrusted_transport' });
  assert.equal(wrongRecipient.calls, 0);
}));

test('出口被撤销后不可再用', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  revokeTrustedSendPort(t);
  const r = await dispatchOnce(c.a, withTrusted(base(c, { transport: t, trustedPort: t })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'untrusted_transport' });
  assert.equal(t.calls, 0);
}));

test('L0 自动模式：无审批记录也能发送（D-019）', () => withPendingIntent(async (c) => {
  // 本用例的 fixture 默认会登记审批；这里先确认 L0 根本不看它
  const t = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, transport: t,
  })));
  assert.deepEqual(r, { status: 'sent', intentId: c.intentId, evidence: '7701260499833538097' });
  assert.equal(t.calls, 1);
  const s = state(c.file, c.intentId);
  assert.equal(s.status, 'sent');
  assert.equal(s.approvalConsumed, false, 'L0 不得消费审批记录');
}));

test('L0 无审批时仍受全部程序 Gate 约束：Proof 过期即拒发', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, nowMs: c.now + 5_000, coverageMaxAgeMs: 1, transport: t,
  })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'proof_changed' });
  assert.equal(t.calls, 0);
}));

test('L0 无审批时仍受身份约束：会话漂移即拒发', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, live: liveRefs({ kind: 'none' }), transport: t,
  })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'contact_unverified' });
  assert.equal(t.calls, 0);
}));

test('L0 无审批时仍受内容约束：正文被篡改即拒发', () => withPendingIntent(async (c) => {
  const tampered = '这是一条只供离线测试的答复';
  assert.equal(tampered.length, TEXT.length);
  const db = new DatabaseSync(c.file);
  try { db.prepare('UPDATE send_text SET body=? WHERE intent_id=?').run(tampered, c.intentId); }
  finally { db.close(); }
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, transport: t,
  })));
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'content_digest_mismatch' });
  assert.equal(t.calls, 0);
}));

test('L0 幂等：同一意图第二次派发被拒', () => withPendingIntent(async (c) => {
  const t1 = transport({ statusCode: 0, serverMessageId: '7701260499833538097' });
  const first = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, transport: t1,
  })));
  assert.equal(first.status, 'sent');
  const t2 = transport({ statusCode: 0, serverMessageId: '7701260499833538098' });
  const second = await dispatchOnce(c.a, withTrusted(base(c, {
    mode: 'l0_auto', approvalId: undefined, transport: t2,
  })));
  assert.equal(second.status, 'rejected');
  assert.equal(t2.calls, 0);
}));

test('L1 模式仍要求真实审批记录（保留为可选测试模式）', () => withPendingIntent(async (c) => {
  const t = transport({ statusCode: 0, serverMessageId: '1' });
  const r = await dispatchOnce(c.a, withTrusted(base(c, { mode: 'l1_review', approvalId: 'appr-wrong001', transport: t })));
  // 该 fixture 未登记审批 → 先命中 approval_missing（而不是绑定不符）
  assert.deepEqual(r, { status: 'rejected', reasonCode: 'approval_missing' });
  assert.equal(t.calls, 0);
}, { approve: false }));

test('dispatch.ts 无运行时 SDK 依赖、无 sendMsg', () => {
  const source = readFileSync(new URL('../../src/send/dispatch.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]douyin-im['"]/);
  assert.doesNotMatch(source, /\.sendMsg\s*\(/);
});
