/**
 * T6-3c-real-B1：真实 T5→T6 交接（离线）。
 * 验证合法决策会带着**原始正文**落入 send_text，且全程不发送。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import { durableDecisionWithSend, type SendHandoffOptions } from '../../src/ai/engine.ts';
import type { AiBackend } from '../../src/ai/contracts.ts';
import type { InboundMessage } from '../../src/platform/types.ts';

const thread = '0:1:222:333';
const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const msg = (i: number): InboundMessage => ({
  conversationId: thread, serverMessageId: String(7701260499833538097n + BigInt(i)),
  clientMessageId: null, senderUid: '333', fromSelf: false, text: 'mock-' + i,
  kind: 'text', messageType: 7, createTime: String(1793089447000 + i * 1000), indexInConversation: String(i),
});

const fake = (fn: AiBackend['evaluate']): AiBackend => ({ id: 'claude_code', kind: 'agent-runtime', evaluate: fn });
const reply = (text = '这是模型生成的回复正文') => ({ action: 'reply', text, reason: '测试', delayMs: 0 });
const skip = () => ({ action: 'skip', reason: '无需回复' });

interface Ctx { a: EveArchive; file: string; now: number; opts: SendHandoffOptions; }

async function fixture(
  fn: (c: Ctx) => Promise<void>,
  opts: { version?: number; runtime?: { phase: string; paused: boolean } } = {},
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-handoff-eng-'));
  const file = join(dir, 'eve.sqlite');
  const a = EveArchive.open(file, identity);
  const port = new MockPlatformPort({ uid: '111', imUid: '222' });
  try {
    a.upgradeToV2(); a.upgradeToV3();
    const version = opts.version ?? 6;
    if (version >= 4) a.upgradeToV4();
    if (version >= 5) a.upgradeToV5();
    if (version >= 6) a.upgradeToV6();
    port.delivered.push(msg(0));
    assert.equal((await reconcileOnce({ archive: a, port, conversationId: thread, instanceId: 'b', imUid: '222', isSafe: () => true })).state, 'verified');
    port.delivered.push(msg(1));
    const next = await reconcileOnce({ archive: a, port, conversationId: thread, instanceId: 'n', imUid: '222', isSafe: () => true });
    assert.equal(next.state, 'verified');
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const silenceStart = (minute + 180) % 1440;
    const o: SendHandoffOptions = {
      conversationId: thread, maxAgeMs: 90_000, timeoutMs: 1000, nowMs: now,
      identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
      runtime: opts.runtime ?? { phase: 'running', paused: false },
      sendPolicy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
        silence: { startMinute: silenceStart, endMinute: (silenceStart + 60) % 1440 } },
      bodyRetentionMs: 900_000,
    };
    await fn({ a, file, now, opts: o });
  } finally {
    a.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const count = (file: string, table: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Number((db.prepare('SELECT COUNT(*) n FROM ' + table).get() as { n: number }).n); }
  finally { db.close(); }
};

test('合法 reply → recorded_pending，正文由模型产生并落入 send_text', () => fixture(async ({ a, file, opts }) => {
  const modelText = '模型生成的正文，不是固定测试串';
  const r = await durableDecisionWithSend(a, fake(async () => reply(modelText)), opts);
  assert.equal(r.status, 'recorded_pending');
  if (r.status !== 'recorded_pending') return;
  assert.equal(count(file, 'send_intents'), 1);
  assert.equal(count(file, 'send_text'), 1);
  assert.equal(a.getSendText(r.intentId, opts.nowMs!), modelText, '正文必须来自模型决策');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const claim = db.prepare('SELECT state,action,reply_length FROM ai_decision_attempts WHERE claim_id=?')
      .get(r.claimId) as { state: string; action: string; reply_length: number };
    assert.equal(claim.state, 'recorded');
    assert.equal(claim.action, 'reply');
    assert.equal(claim.reply_length, modelText.length);
    const intent = db.prepare('SELECT status,ai_claim_id,not_before_ms FROM send_intents WHERE intent_id=?')
      .get(r.intentId) as { status: string; ai_claim_id: string; not_before_ms: number };
    assert.equal(intent.status, 'pending');
    assert.equal(intent.ai_claim_id, r.claimId, '意图必须绑定产生它的 T5 claim');
    assert.equal(intent.not_before_ms, opts.nowMs);
  } finally { db.close(); }
}));

test('skip → 只记 recorded，不产生意图与正文', () => fixture(async ({ a, file, opts }) => {
  const r = await durableDecisionWithSend(a, fake(async () => skip()), opts);
  assert.equal(r.status, 'recorded_no_intent');
  if (r.status !== 'recorded_no_intent') return;
  assert.equal(r.reasonCode, 'not_reply');
  assert.equal(count(file, 'send_intents'), 0);
  assert.equal(count(file, 'send_text'), 0);
}));

test('运行态非 running → 仍记 recorded，但不产生意图', () => fixture(async ({ a, file, opts }) => {
  const r = await durableDecisionWithSend(a, fake(async () => reply()), opts);
  assert.equal(r.status, 'recorded_no_intent');
  if (r.status !== 'recorded_no_intent') return;
  assert.equal(r.reasonCode, 'runtime_not_running');
  assert.equal(count(file, 'send_intents'), 0);
  assert.equal(count(file, 'send_text'), 0);
}, { runtime: { phase: 'paused_manual', paused: true } }));

test('后端异常 → blocked，claim 记为 blocked，无意图', () => fixture(async ({ a, file, opts }) => {
  const r = await durableDecisionWithSend(a, fake(async () => { throw new Error('boom'); }), opts);
  assert.equal(r.status, 'blocked');
  if (r.status !== 'blocked') return;
  assert.equal(r.reasonCode, 'backend_failed');
  assert.equal(count(file, 'send_intents'), 0);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT state FROM ai_decision_attempts WHERE claim_id=?').get(r.claimId) as { state: string }).state, 'blocked');
  } finally { db.close(); }
}));

test('非法决策 → blocked/invalid_decision，不产生意图', () => fixture(async ({ a, file, opts }) => {
  const r = await durableDecisionWithSend(a, fake(async () => ({ action: 'reply' })), opts);
  assert.equal(r.status, 'blocked');
  if (r.status !== 'blocked') return;
  assert.equal(r.reasonCode, 'invalid_decision');
  assert.equal(count(file, 'send_intents'), 0);
}));

test('推理期间 Proof 换代 → blocked，且不落意图', () => fixture(async ({ a, file, opts }) => {
  // 后端执行时把 coverage 置为过期，模拟推理窗口内 proof 失效
  const b = fake(async () => {
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE conversations SET sync_state='unverified'").run(); } finally { db.close(); }
    return reply();
  });
  const r = await durableDecisionWithSend(a, b, opts);
  assert.equal(r.status, 'blocked');
  if (r.status !== 'blocked') return;
  assert.equal(r.reasonCode, 'coverage_lost_after_inference');
  assert.equal(count(file, 'send_intents'), 0);
}));

test('v4 库不支持交接 → blocked/storage_unavailable', () => fixture(async ({ a, opts }) => {
  const r = await durableDecisionWithSend(a, fake(async () => reply()), opts);
  assert.equal(r.status, 'blocked');
  if (r.status !== 'blocked') return;
  assert.equal(r.reasonCode, 'storage_unavailable');
}, { version: 4 }));

test('同一事件只交接一次：第二次无待处理事件', () => fixture(async ({ a, opts }) => {
  const first = await durableDecisionWithSend(a, fake(async () => reply()), opts);
  assert.equal(first.status, 'recorded_pending');
  const second = await durableDecisionWithSend(a, fake(async () => reply()), opts);
  assert.equal(second.status, 'blocked');
  if (second.status !== 'blocked') return;
  assert.equal(second.reasonCode, 'no_pending_event');
}));

test('engine 不导入任何发送模块', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/ai/engine.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]douyin-im['"]/);
  assert.doesNotMatch(src, /\.sendMsg\s*\(/);
  assert.doesNotMatch(src, /from '\.\.\/send\//);
});
