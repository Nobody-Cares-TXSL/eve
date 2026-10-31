/**
 * T6-3c-real-B0：本机交互式 L1 审批。
 * 契约：docs/contracts/send.md §14。不发送、不读 SDK。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EveArchive } from '../../src/archive/store.ts';
import { MockPlatformPort } from '../../src/platform/mock.ts';
import { reconcileOnce } from '../../src/runtime/reconcile.ts';
import type { InboundMessage } from '../../src/platform/types.ts';
import { formatApprovalPrompt, runInteractiveApproval } from '../../src/send/approval-cli.ts';

const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const TEXT = '这是一条只供离线测试的回复';
const message = (id: string): InboundMessage => ({
  conversationId: THREAD, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: '今晚聊聊？', kind: 'text', messageType: 7,
  createTime: String(Date.now() - 2000 + Number(BigInt(id) % 10n)),
  indexInConversation: String(BigInt(id) % 10n),
});

interface Ctx { a: EveArchive; file: string; intentId: string; now: number; }

async function withPendingIntent(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-approval-'));
  const file = join(dir, 'demo.sqlite');
  const a = EveArchive.open(file, ID);
  const p = new MockPlatformPort({ uid: '111', imUid: '222' });
  try {
    a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5(); a.upgradeToV6();
    p.delivered.push(message('9000000000000000000'));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'b', isSafe: () => true })).state, 'verified');
    p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
    assert.equal((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'n', isSafe: () => true })).state, 'verified');
    const reservation = a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
    assert.ok(reservation);
    const now = Date.now();
    const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const silenceStart = (minute + 180) % 1440;
    const r = a.finalizeAiWithSend({
      claimId: reservation.claimId,
      decision: { action: 'reply', text: TEXT, reason: '测试', delayMs: 0 },
      identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
      runtime: { phase: 'running', paused: false },
      policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
        silence: { startMinute: silenceStart, endMinute: (silenceStart + 60) % 1440 } },
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

const deps = (c: Ctx, answer: string, over: Record<string, unknown> = {}) => ({
  archive: c.a, promptText: async () => answer, now: c.now, ttlMs: 300_000,
  approvalId: 'appr-human01', ...over,
});

test('确认文本必须同时展示接收方与完整正文', () => {
  const text = formatApprovalPrompt({
    intentId: 'i1', recipientUid: '333', textDigest: 'a'.repeat(64),
    body: TEXT, notBeforeMs: 1, expiresAtMs: 2,
  });
  assert.match(text, /接收方 UID：333/);
  assert.ok(text.includes(TEXT), '必须展示完整正文');
  assert.match(text, /CONFIRM/, '必须要求明确确认短语');
});

test('输入 CONFIRM 才登记审批', () => withPendingIntent(async (c) => {
  const r = await runInteractiveApproval(deps(c, 'CONFIRM'), c.intentId);
  assert.deepEqual(r, { status: 'approved', approvalId: 'appr-human01' });
  const s = c.a.sendApprovalState(c.intentId);
  assert.ok(s && !s.consumed, '刚批准尚未消费');
  assert.equal(s.recipientUid, '333');
}));

test('任意其它输入（含空回车）一律拒绝且不产生记录', () => withPendingIntent(async (c) => {
  // 每次用不同的合法 approvalId，确保不是被 id 格式校验挡掉
  let n = 0;
  for (const answer of ['', '  ', 'yes', 'confirm', 'CONFIRM ', 'Y']) {
    n++;
    const r = await runInteractiveApproval(
      deps(c, answer, { approvalId: 'appr-decline' + String(n).padStart(2, '0') }), c.intentId);
    assert.equal(r.status, 'declined', JSON.stringify(answer) + ' 不得批准');
  }
  assert.equal(c.a.sendApprovalState(c.intentId), null, '未确认时不得留下任何审批记录');
}));

test('非 pending 意图不能批准', () => withPendingIntent(async (c) => {
  c.a.claimSendIntent(c.intentId, c.now);
  const r = await runInteractiveApproval(deps(c, 'CONFIRM'), c.intentId);
  assert.deepEqual(r, { status: 'unavailable', reason: 'intent_not_pending' });
}));

test('登记时摘要必须与账本一致：篡改后无法登记', () => withPendingIntent(async (c) => {
  const db = new DatabaseSync(c.file);
  try {
    db.prepare('UPDATE send_intents SET text_digest=? WHERE intent_id=?').run('f'.repeat(64), c.intentId);
  } finally { db.close(); }
  const r = await runInteractiveApproval(deps(c, 'CONFIRM'), c.intentId);
  assert.equal(r.status, 'unavailable', '摘要被改写后不得批准');
  assert.equal(c.a.sendApprovalState(c.intentId), null, '不得留下审批记录');
}));

test('非法 TTL 或 approvalId → unavailable', () => withPendingIntent(async (c) => {
  assert.deepEqual(await runInteractiveApproval(deps(c, 'CONFIRM', { ttlMs: 0 }), c.intentId),
    { status: 'unavailable', reason: 'invalid_ttl' });
  assert.deepEqual(await runInteractiveApproval(deps(c, 'CONFIRM', { approvalId: 'x' }), c.intentId),
    { status: 'unavailable', reason: 'invalid_ttl' });
}));

test('同一意图不能重复批准', () => withPendingIntent(async (c) => {
  assert.equal((await runInteractiveApproval(deps(c, 'CONFIRM'), c.intentId)).status, 'approved');
  const second = await runInteractiveApproval(deps(c, 'CONFIRM', { approvalId: 'appr-human02' }), c.intentId);
  assert.equal(second.status, 'unavailable', '已存在审批时不得再次登记');
}));
