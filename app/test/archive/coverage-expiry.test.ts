/**
 * T4 证明有效期门控：verified 不是永久状态。
 *
 * 关键负例：SDK 始终不发出 offline/reconnecting（静默失联），
 * 一份过期的 coverageProof 也绝不能继续放行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';

const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const thread = '0:1:222:333';

function withDb(fn: (a: EveArchive, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t4-expiry-'));
  const file = join(dir, 'eve.sqlite');
  try {
    const a = EveArchive.open(file, identity);
    try { a.upgradeToV2(); fn(a, file); } finally { a.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 直接把会话标为 verified 并写入指定时刻，模拟「曾经签发过证明」。 */
function markVerified(file: string, at: number): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`INSERT OR IGNORE INTO conversations(conversation_id,sync_state,updated_at_ms) VALUES('${thread}','unverified',1)`);
    db.prepare("UPDATE conversations SET sync_state='verified',verified_anchor_id=?,last_verified_at_ms=?,updated_at_ms=? WHERE conversation_id=?")
      .run('7701260499833538097', at, at, thread);
  } finally { db.close(); }
}

test('新签发的证明在有效期内可用', () => withDb((a, file) => {
  markVerified(file, Date.now());
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.state, 'verified');
  assert.equal(s.verified, true);
  assert.equal(s.fresh, true);
  assert.equal(s.usable, true);
  assert.ok(s.ageMs !== null && s.ageMs >= 0 && s.ageMs < 5_000);
}));

test('过期证明即使 sync_state 仍为 verified 也不可用', () => withDb((a, file) => {
  // 关键：sync_state 保持 verified —— 模拟 SDK 静默失联、从未发出 offline 事件
  markVerified(file, Date.now() - 120_000);
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.state, 'verified', 'sync_state 仍是 verified（这正是危险之处）');
  assert.equal(s.verified, true);
  assert.equal(s.fresh, false, '超过 90s 必须判为不新鲜');
  assert.equal(s.usable, false, '过期证明绝不能放行');
  assert.ok(s.ageMs !== null && s.ageMs >= 120_000);
}));

test('Schema 约束本身禁止「verified 但缺时间戳」这种危险状态', () => withDb((a, file) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`INSERT OR IGNORE INTO conversations(conversation_id,sync_state,updated_at_ms) VALUES('${thread}','unverified',1)`);
    // 数据库 CHECK 约束必须拒绝 verified + 无锚点/无时间戳
    assert.throws(() => {
      db.prepare("UPDATE conversations SET sync_state='verified',verified_anchor_id=NULL,last_verified_at_ms=NULL WHERE conversation_id=?")
        .run(thread);
    }, /CHECK constraint/, '缺锚点与时间戳的 verified 必须被 Schema 拒绝');
  } finally { db.close(); }

  // 时间戳在未来（时钟回拨）也必须判为不可用
  markVerified(file, Date.now() + 600_000);
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.fresh, false, '未来时间戳必须不可用');
  assert.equal(s.usable, false);
}));

test('非 verified 状态一律不可用，且不因有效期而放行', () => withDb((a, file) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`INSERT OR IGNORE INTO conversations(conversation_id,sync_state,updated_at_ms) VALUES('${thread}','unverified',1)`);
    db.prepare("UPDATE conversations SET sync_state='unverified',last_verified_at_ms=? WHERE conversation_id=?")
      .run(Date.now(), thread);
  } finally { db.close(); }
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.verified, false);
  assert.equal(s.usable, false);
}));

test('非白名单线程直接拒绝（不泄露会话是否存在）', () => withDb((a) => {
  // 999 既非自己（111/222）也非目标（333）→ 白名单校验先拒绝
  assert.throws(() => a.coverageStatus('0:1:222:999', 90_000), /rejected/);
  // 白名单内但尚未建档的线程：返回 null 状态且不可用
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.state, null);
  assert.equal(s.usable, false);
}));

test('非法 maxAge 与非白名单线程被拒绝', () => withDb((a) => {
  assert.throws(() => a.coverageStatus(thread, 0), /invalid_max_age/);
  assert.throws(() => a.coverageStatus(thread, -1), /invalid_max_age/);
  assert.throws(() => a.coverageStatus(thread, 1.5), /invalid_max_age/);
  assert.throws(() => a.coverageStatus('0:1:222:444', 90_000), /rejected/);
}));

test('撤销后立即不可用，但历史锚点保留', () => withDb((a, file) => {
  markVerified(file, Date.now());
  assert.equal(a.coverageStatus(thread, 90_000).usable, true);
  a.invalidateCurrentCoverage();
  const s = a.coverageStatus(thread, 90_000);
  assert.equal(s.state, 'unverified');
  assert.equal(s.usable, false);
  assert.equal(a.getVerifiedAnchor(thread), '7701260499833538097', '锚点必须保留以便重新对账');
}));
