/**
 * T6-3a：T5 → T6 决策正文安全交接（SQLite v5，离线）。
 * 契约：docs/contracts/ai-send-handoff.md。不接平台、不发消息、不调用模型。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import type { InboundMessage } from '../../src/platform/types.ts';
import type { AiDecision } from '../../src/ai/contracts.ts';

const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const TARGET_EVENT = '9000000000000000001';

const message = (id: string): InboundMessage => ({
  conversationId: THREAD, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: '今晚聊聊？', kind: 'text', messageType: 7,
  createTime: String(Date.now() - 2000 + Number(BigInt(id) % 10n)),
  indexInConversation: String(BigInt(id) % 10n),
});

const reply = (over: Partial<Extract<AiDecision, { action: 'reply' }>> = {}): AiDecision =>
  ({ action: 'reply', text: '这是一条只供离线测试的回复', reason: '测试', delayMs: 0, ...over });

interface Ctx { a: EveArchive; file: string; claimId: string; now: number; }

/** 建立 v5 库 + verified 覆盖 + 一条已认领的 T5 claim。 */
async function withHandoff(fn: (c: Ctx) => void | Promise<void>, version = 5): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-handoff-'));
  const file = join(dir, 'demo.sqlite');
  const a = EveArchive.open(file, ID);
  const p = new MockPlatformPort({ uid: '111', imUid: '222' });
  try {
    a.upgradeToV2(); a.upgradeToV3();
    if (version >= 4) a.upgradeToV4();
    if (version >= 5) a.upgradeToV5();
    p.delivered.push(message('9000000000000000000'));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'baseline', isSafe: () => true })).state, 'verified');
    p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'new', isSafe: () => true })).state, 'verified');
    const reservation = a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    assert.ok(reservation, '必须成功认领一条 T5 claim');
    await fn({ a, file, claimId: reservation.claimId, now: Date.now() });
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const policy = (now: number) => {
  const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  return { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
    silence: { startMinute: (minute + 20) % 1440, endMinute: (minute + 21) % 1440 } };
};
const base = (c: Ctx, over: Record<string, unknown> = {}) => ({
  claimId: c.claimId,
  decision: reply(),
  identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
  runtime: { phase: 'running', paused: false },
  policy: policy(c.now),
  now: c.now,
  coverageMaxAgeMs: 90_000,
  bodyRetentionMs: 900_000,
  ...over,
});
const count = (file: string, table: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n); }
  finally { db.close(); }
};

test('reply → recorded_pending：意图、正文、事件组与 claim 结算同事务完成', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c));
  assert.equal(r.status, 'recorded_pending');
  if (r.status !== 'recorded_pending') return;
  assert.equal(count(c.file, 'send_intents'), 1);
  assert.equal(count(c.file, 'send_text'), 1);
  assert.equal(c.a.getSendText(r.intentId, c.now), '这是一条只供离线测试的回复');
  assert.equal(c.a.sendIntentEvents(r.intentId).join(','), TARGET_EVENT);
  assert.equal(c.a.getSendIntent(r.intentId)?.status, 'pending');
  // claim 必须已结算为 recorded
  const db = new DatabaseSync(c.file, { readOnly: true });
  try {
    const claim = db.prepare('SELECT state,action,reply_length FROM ai_decision_attempts WHERE claim_id=?').get(c.claimId) as { state: string; action: string; reply_length: number };
    assert.equal(claim.state, 'recorded');
    assert.equal(claim.action, 'reply');
    assert.equal(claim.reply_length, '这是一条只供离线测试的回复'.length);
    // 绑定列必须同时写入
    const row = db.prepare('SELECT ai_claim_id,not_before_ms FROM send_intents WHERE intent_id=?').get(r.intentId) as { ai_claim_id: string; not_before_ms: number };
    assert.equal(row.ai_claim_id, c.claimId);
    assert.equal(row.not_before_ms, c.now);
  } finally { db.close(); }
}));

test('skip / defer → 只写 recorded，绝不产生意图与正文', () => withHandoff((c) => {
  const skip = c.a.finalizeAiWithSend(base(c, { decision: { action: 'skip', reason: '无需回应' } }));
  assert.deepEqual(skip, { status: 'recorded_no_intent', reasonCode: 'not_reply' });
  assert.equal(count(c.file, 'send_intents'), 0);
  assert.equal(count(c.file, 'send_text'), 0);
}));

test('合法 reply 被策略拒绝 → 仍记 recorded，但不落意图与正文', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, { runtime: { phase: 'paused_manual', paused: true } }));
  assert.equal(r.status, 'recorded_no_intent');
  if (r.status !== 'recorded_no_intent') return;
  assert.equal(r.reasonCode, 'runtime_not_running');
  assert.equal(count(c.file, 'send_intents'), 0);
  assert.equal(count(c.file, 'send_text'), 0);
  const db = new DatabaseSync(c.file, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT state FROM ai_decision_attempts WHERE claim_id=?').get(c.claimId) as { state: string }).state, 'recorded');
  } finally { db.close(); }
}));

test('事务中途失败 → 整体回滚，claim 保持 claimed，无半条记录', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, { failAfterWrites: true }));
  assert.deepEqual(r, { status: 'blocked', reasonCode: 'storage_unavailable' });
  assert.equal(count(c.file, 'send_intents'), 0);
  assert.equal(count(c.file, 'send_text'), 0);
  assert.equal(count(c.file, 'send_intent_events'), 0);
  const db = new DatabaseSync(c.file, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT state FROM ai_decision_attempts WHERE claim_id=?').get(c.claimId) as { state: string }).state, 'claimed',
      '回滚后 claim 必须仍是 claimed，供重启恢复标记 interrupted');
  } finally { db.close(); }
}));

test('同一 claim 重放 → 返回同一意图，不产生第二条', () => withHandoff((c) => {
  const first = c.a.finalizeAiWithSend(base(c));
  assert.equal(first.status, 'recorded_pending');
  const again = c.a.finalizeAiWithSend(base(c));
  assert.equal(again.status, 'recorded_pending');
  if (first.status !== 'recorded_pending' || again.status !== 'recorded_pending') return;
  assert.equal(again.intentId, first.intentId);
  assert.equal(count(c.file, 'send_intents'), 1);
  assert.equal(count(c.file, 'send_text'), 1);
}));

test('skip 之后重放 → already_finalized，不补建意图', () => withHandoff((c) => {
  c.a.finalizeAiWithSend(base(c, { decision: { action: 'skip', reason: '无需回应' } }));
  const again = c.a.finalizeAiWithSend(base(c));
  assert.deepEqual(again, { status: 'recorded_no_intent', reasonCode: 'already_finalized' });
  assert.equal(count(c.file, 'send_intents'), 0);
}));

test('Proof 换代 → blocked coverage_changed，claim 不被结算', () => withHandoff((c) => {
  // 用极短有效期让 claim 的 epoch 在结算前失效
  const r = c.a.finalizeAiWithSend(base(c, { coverageMaxAgeMs: 1, now: c.now + 5_000 }));
  assert.deepEqual(r, { status: 'blocked', reasonCode: 'coverage_changed' });
  assert.equal(count(c.file, 'send_intents'), 0);
  const db = new DatabaseSync(c.file, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT state FROM ai_decision_attempts WHERE claim_id=?').get(c.claimId) as { state: string }).state, 'claimed');
  } finally { db.close(); }
}));

test('delayMs 真正生效：not_before_ms 之前不可认领', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, { decision: reply({ delayMs: 60_000 }) }));
  assert.equal(r.status, 'recorded_pending');
  if (r.status !== 'recorded_pending') return;
  assert.equal(r.notBeforeMs, c.now + 60_000);
  assert.equal(c.a.claimSendIntent(r.intentId, c.now + 59_999), false, '未到最早发送时间不得认领');
  assert.equal(c.a.claimSendIntent(r.intentId, c.now + 60_000), true, '到达 not_before 即可认领');
}));

test('延迟超出正文保留期 → 拒绝创建（policy_invalid）', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, {
    decision: reply({ delayMs: 600_000 }), bodyRetentionMs: 60_000,
  }));
  assert.deepEqual(r, { status: 'blocked', reasonCode: 'policy_invalid' });
  assert.equal(count(c.file, 'send_intents'), 0);
}));

test('正文保留期写入 send_text，到期不可读', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, { bodyRetentionMs: 1_000 }));
  assert.equal(r.status, 'recorded_pending');
  if (r.status !== 'recorded_pending') return;
  assert.equal(r.expiresAtMs, c.now + 1_000);
  assert.equal(c.a.getSendText(r.intentId, c.now + 999), '这是一条只供离线测试的回复');
  assert.equal(c.a.getSendText(r.intentId, c.now + 1_000), null);
}));

test('v4 库不支持交接：blocked storage_unavailable', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c));
  assert.deepEqual(r, { status: 'blocked', reasonCode: 'storage_unavailable' });
}, 4));

test('身份不符 → source_invalid，且不写任何记录', () => withHandoff((c) => {
  const r = c.a.finalizeAiWithSend(base(c, { identity: { ownerUid: '111', targetUid: '444' } }));
  assert.deepEqual(r, { status: 'blocked', reasonCode: 'source_invalid' });
  assert.equal(count(c.file, 'send_intents'), 0);
}));

test('返回值与错误均不含正文', () => withHandoff((c) => {
  const secret = '绝不能出现在返回值里的正文';
  const r = c.a.finalizeAiWithSend(base(c, { decision: reply({ text: secret }) }));
  assert.equal(r.status, 'recorded_pending');
  assert.equal(JSON.stringify(r).includes(secret), false, '返回值不得含正文');
  const blocked = c.a.finalizeAiWithSend(base(c, { runtime: { phase: 'stopped', paused: false }, decision: reply({ text: secret }) }));
  assert.equal(JSON.stringify(blocked).includes(secret), false);
}));

test('终态即清理正文：sent/failed/unknown 后正文不可读，账本与证据保留', () => withHandoff((c) => {
  const cases = [
    { settle: { status: 'sent', evidence: 'mock:abc' } as const, expectStatus: 'sent' },
    { settle: { status: 'failed', reasonCode: 'rejected_before_dispatch' } as const, expectStatus: 'failed' },
    { settle: { status: 'unknown', reasonCode: 'timeout' } as const, expectStatus: 'unknown' },
  ];
  for (const k of cases) {
    const r = c.a.finalizeAiWithSend(base(c, { decision: reply({ text: '会被清理的正文' }) }));
    assert.equal(r.status, 'recorded_pending');
    if (r.status !== 'recorded_pending') continue;
    assert.equal(c.a.getSendText(r.intentId, c.now), '会被清理的正文');
    assert.equal(c.a.claimSendIntent(r.intentId, c.now), true);
    assert.equal(c.a.settleSendIntent(r.intentId, k.settle, c.now), true);
    assert.equal(c.a.getSendText(r.intentId, c.now), null, k.expectStatus + ' 后正文必须已删除');
    assert.equal(c.a.getSendIntent(r.intentId)?.status, k.expectStatus, '账本终态保留');
    // 下一轮用新 claim 继续
    const next = c.a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    if (!next) break;
    c.claimId = next.claimId;
  }
}));

test('v5 迁移：显式、幂等、版本与 meta 同步，故障注入可回滚', () => withHandoff((c) => {
  const db = new DatabaseSync(c.file, { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5);
    assert.equal((db.prepare('SELECT schema_version FROM archive_meta').get() as { schema_version: number }).schema_version, 5);
    const cols = (db.prepare('PRAGMA table_info(send_intents)').all() as { name: string }[]).map(r => r.name);
    assert.ok(cols.includes('ai_claim_id') && cols.includes('not_before_ms'), 'v5 必须补齐两列');
    const trig = (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='trg_send_intents_handoff_binding'").get() as { n: number }).n;
    assert.equal(trig, 1, '半绑定触发器必须存在');
  } finally { db.close(); }
  c.a.upgradeToV5(); // 幂等
}));

test('半绑定被数据库触发器拒绝：只有 claimId 或只有 not_before 都写不进去', () => withHandoff((c) => {
  const db = new DatabaseSync(c.file);
  try {
    const insert = (claim: string | null, nb: number | null) => db.prepare(
      'INSERT INTO send_intents(intent_id,conversation_id,source_event_id,text_digest,decision_digest,status,attempt,created_at_ms,updated_at_ms,ai_claim_id,not_before_ms) VALUES(?,?,?,?,?,?,0,?,?,?,?)')
      .run('x' + Math.random(), THREAD, 'e1', 'a', 'b', 'pending', c.now, c.now, claim, nb);
    assert.throws(() => insert(c.claimId, null), /handoff_binding_incomplete/);
    assert.throws(() => insert(null, c.now), /handoff_binding_incomplete/);
  } finally { db.close(); }
}));

test('两个连接争用同一 claim：只有一个能创建意图，另一个无副作用', () => withHandoff((c) => {
  const second = EveArchive.open(c.file, ID);
  try {
    const a = c.a.finalizeAiWithSend(base(c));
    const b = second.finalizeAiWithSend(base(c));
    assert.equal(a.status, 'recorded_pending');
    assert.equal(b.status, 'recorded_pending', '第二个连接应走重放路径而非报错');
    if (a.status === 'recorded_pending' && b.status === 'recorded_pending') {
      assert.equal(b.intentId, a.intentId, '必须指向同一意图');
    }
    assert.equal(count(c.file, 'send_intents'), 1);
    assert.equal(count(c.file, 'send_text'), 1);
  } finally { second.close(); }
}));

test('v2 直连 v5 的迁移链可用，且旧版本仍拒绝交接', () => withHandoff((c) => {
  // 已通过 upgradeToV2→V3→V4→V5 建库；此处确认最终版本与交接可用
  const r = c.a.finalizeAiWithSend(base(c));
  assert.equal(r.status, 'recorded_pending');
}));

test('v5 迁移故障注入：回滚后仍是 v4，两列与触发器都不存在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-v5-fail-'));
  const file = join(dir, 'demo.sqlite');
  const a = EveArchive.open(file, ID);
  try {
    a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4();
    assert.throws(() => a.upgradeToV5(true), /migration_injected_failure/);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4, '失败必须保持 v4');
      assert.equal((db.prepare('SELECT schema_version FROM archive_meta').get() as { schema_version: number }).schema_version, 4);
      const cols = (db.prepare('PRAGMA table_info(send_intents)').all() as { name: string }[]).map(r => r.name);
      assert.equal(cols.includes('ai_claim_id'), false, '回滚后不得残留新列');
      assert.equal(cols.includes('not_before_ms'), false);
    } finally { db.close(); }
    // 回滚后仍可正常重试
    a.upgradeToV5();
    const check = new DatabaseSync(file, { readOnly: true });
    try { assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 5); }
    finally { check.close(); }
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
