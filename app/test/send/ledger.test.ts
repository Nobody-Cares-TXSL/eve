/**
 * T6-1b：发送意图持久化与状态机（SQLite v4，离线）。
 * 契约：docs/contracts/send.md §8。不接平台、不发消息、不迁移正式库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';

const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const NOW = 1_793_000_000_000;

function withV4(fn: (a: EveArchive, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-'));
  const file = join(dir, 'eve.sqlite');
  try {
    const a = EveArchive.open(file, identity);
    try { a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); fn(a, file); }
    finally { a.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const intent = (over: Partial<Parameters<EveArchive['saveSendIntent']>[0]> = {}) => ({
  intentId: 'intent-1',
  conversationId: THREAD,
  sourceEventId: '9000000000000000001',
  text: '今晚一起散步？',
  textDigest: 'a'.repeat(64),
  decisionDigest: 'b'.repeat(64),
  eventIds: ['9000000000000000001'],
  now: NOW,
  retentionMs: 86_400_000,
  ...over,
});

test('v4 迁移：版本与 meta 同步，重复迁移幂等', () => withV4((a, file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
    assert.equal((db.prepare('SELECT schema_version FROM archive_meta').get() as { schema_version: number }).schema_version, 4);
    const tables = (db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('send_intents','send_intent_events','send_text')").get() as { n: number }).n;
    assert.equal(tables, 3);
  } finally { db.close(); }
  a.upgradeToV4(); // 幂等
}));

test('保存意图：正文进独立表，账本只留摘要', () => withV4((a, file) => {
  const r = a.saveSendIntent(intent());
  assert.equal(r.created, true);
  assert.equal(a.getSendText('intent-1', NOW), '今晚一起散步？');
  assert.equal(a.sendIntentEvents('intent-1').join(','), '9000000000000000001');
  assert.equal(a.getSendIntent('intent-1')?.status, 'pending');

  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM send_intents WHERE intent_id=?').get('intent-1') as Record<string, unknown>;
    assert.equal(Object.values(row).some(v => typeof v === 'string' && v.includes('散步')), false,
      '账本行内不得出现正文');
  } finally { db.close(); }
}));

test('幂等：同 intentId 或同 sourceEventId 重复提交只创建一次', () => withV4((a) => {
  assert.equal(a.saveSendIntent(intent()).created, true);
  const again = a.saveSendIntent(intent());
  assert.equal(again.created, false);
  assert.equal(again.conflict, 'duplicate_intent');
  assert.equal(again.existingStatus, 'pending');
  // 换 intentId 但同事件：仍被视为重复
  const other = a.saveSendIntent(intent({ intentId: 'intent-2' }));
  assert.equal(other.created, false);
  assert.equal(other.conflict, 'duplicate_intent', '同事件同会话命中唯一键');
}));

test('一批合并消息只属于一个意图，不能被拆成多个', () => withV4((a) => {
  const first = a.saveSendIntent(intent({ eventIds: ['e1', 'e2', 'e3'], sourceEventId: 'e3' }));
  assert.equal(first.created, true);
  // 换新意图但复用其中任一事件 → 必须拒绝
  const split = a.saveSendIntent(intent({ intentId: 'intent-split', sourceEventId: 'e9', eventIds: ['e9', 'e2'] }));
  assert.equal(split.created, false);
  assert.equal(split.conflict, 'duplicate_event');
  assert.equal(split.intentId, 'intent-1', '必须指向已存在的意图');
  assert.deepEqual(a.sendIntentEvents('intent-1'), ['e1', 'e2', 'e3']);
}));

test('并发认领：同一意图只有一次 claim 成功', () => withV4((a) => {
  a.saveSendIntent(intent());
  assert.equal(a.claimSendIntent('intent-1', NOW + 1), true);
  assert.equal(a.claimSendIntent('intent-1', NOW + 2), false, '第二次认领必须失败');
  assert.equal(a.getSendIntent('intent-1')?.status, 'dispatching');
  assert.equal(a.getSendIntent('intent-1')?.attempt, 1);
}));

test('非法状态转换一律拒绝', () => withV4((a) => {
  a.saveSendIntent(intent());
  // pending 不能直接结算
  assert.equal(a.settleSendIntent('intent-1', { status: 'unknown', reasonCode: 'timeout' }, NOW + 1), false);
  a.claimSendIntent('intent-1', NOW + 2);
  assert.equal(a.settleSendIntent('intent-1', { status: 'sent', evidence: 'mid-1' }, NOW + 3), true);
  // 终态不可再变
  assert.equal(a.settleSendIntent('intent-1', { status: 'failed', reasonCode: 'rejected_before_dispatch' }, NOW + 4), false);
  // 终态不能再认领
  assert.equal(a.claimSendIntent('intent-1', NOW + 5), false);
}));

test('结果判定：sent 必须有证据；failed/unknown 必须是封闭原因码', () => withV4((a) => {
  a.saveSendIntent(intent());
  a.claimSendIntent('intent-1', NOW + 1);
  assert.throws(() => a.settleSendIntent('intent-1', { status: 'sent', evidence: '  ' }, NOW + 2), /sent_requires_evidence/);
  assert.throws(() => a.settleSendIntent('intent-1', { status: 'failed', reasonCode: '随便写' }, NOW + 3), /invalid_reason_code/);
  assert.throws(() => a.settleSendIntent('intent-1', { status: 'unknown', reasonCode: 'rejected_before_dispatch' }, NOW + 4), /invalid_reason_code/,
    '失败原因不能冒充 unknown');
  // 合法失败
  assert.equal(a.settleSendIntent('intent-1', { status: 'failed', reasonCode: 'identity_changed' }, NOW + 5), true);
}));

test('崩溃恢复：遗留 dispatching 一律转 unknown 且永不自动重发', () => withV4((a, file) => {
  a.saveSendIntent(intent());
  a.claimSendIntent('intent-1', NOW + 1);
  assert.equal(a.getSendIntent('intent-1')?.status, 'dispatching');

  assert.equal(a.recoverInterruptedSends(NOW + 10), 1);
  const row = a.getSendIntent('intent-1');
  assert.equal(row?.status, 'unknown');
  assert.equal(row?.reasonCode, 'interrupted');
  assert.equal(row?.evidence, null);

  // 关键：恢复后不得再被认领
  assert.equal(a.claimSendIntent('intent-1', NOW + 11), false);
  // 重复恢复是幂等的（已无 dispatching）
  assert.equal(a.recoverInterruptedSends(NOW + 12), 0);

  // 重启后仍保持 unknown
  a.close();
  const reopened = EveArchive.open(file, identity);
  try {
    assert.equal(reopened.getSendIntent('intent-1')?.status, 'unknown');
    assert.equal(reopened.claimSendIntent('intent-1', NOW + 20), false);
  } finally { reopened.close(); }
}));

test('事务回滚：写入中断不留下意图、正文或事件关联', () => withV4((a) => {
  assert.throws(
    () => a.saveSendIntent(intent({ eventIds: ['e1', 'e2', 'e3'], failAtEvent: 1 })),
    /send_save_injected_failure/);
  assert.equal(a.getSendIntent('intent-1'), null, '意图不得残留');
  assert.equal(a.getSendText('intent-1', NOW), null, '正文不得残留');
  assert.deepEqual(a.sendIntentEvents('intent-1'), [], '事件关联不得残留');
  // 失败后同一意图仍可正常创建（不处于半写状态）
  assert.equal(a.saveSendIntent(intent({ eventIds: ['e1', 'e2', 'e3'] })).created, true);
}));

test('正文保留期：过期即不可取用，清理只删正文保留账本', () => withV4((a) => {
  a.saveSendIntent(intent({ retentionMs: 1000 }));
  assert.equal(a.getSendText('intent-1', NOW + 999), '今晚一起散步？');
  assert.equal(a.getSendText('intent-1', NOW + 1000), null, '到期时刻视为过期');
  assert.equal(a.purgeExpiredSendText(NOW + 1000), 1);
  assert.equal(a.getSendText('intent-1', NOW + 1), null);
  // 账本仍在，可审计
  assert.equal(a.getSendIntent('intent-1')?.status, 'pending');
}));

test('v4 之前不允许使用发送账本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t6-nov4-'));
  const file = join(dir, 'eve.sqlite');
  try {
    const a = EveArchive.open(file, identity);
    try {
      a.upgradeToV2(); a.upgradeToV3();
      assert.throws(() => a.saveSendIntent(intent()), /send_requires_v4/);
      assert.throws(() => a.claimSendIntent('intent-1', NOW), /send_requires_v4/);
    } finally { a.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
