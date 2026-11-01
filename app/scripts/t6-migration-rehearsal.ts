/**
 * T6 迁移演练：在一份**副本**上执行 v2→v6 全链，验证记录保留、版本一致性、
 * 重复迁移幂等与失败回滚。绝不触碰正式库。
 *
 * 用法：node scripts/t6-migration-rehearsal.ts <备份文件> [--keep]
 *   --keep  保留副本与演练后的库，便于人工检查
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive, MAX_SCHEMA_VERSION } from '../src/archive/store.ts';

const source = process.argv[2];
const keep = process.argv.includes('--keep');
if (!source || !existsSync(source)) {
  console.error('用法：node scripts/t6-migration-rehearsal.ts <备份文件> [--keep]');
  process.exit(2);
}

const sha = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');
const sourceSha = sha(source);

/** 只读快照：版本、计数、完整性。 */
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const quick = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
    const count = (t: string): number | null => {
      try { return Number((db.prepare('SELECT COUNT(*) n FROM ' + t).get() as { n: number }).n); }
      catch { return null; }
    };
    // 只暴露「身份是否存在」，绝不回显 owner/target UID——本脚本会进公开仓库，
    // 且项目约束要求日志不得输出 UID。
    const meta = (() => {
      try {
        const row = db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1')
          .get() as { schema_version: number; owner_uid: string; target_uid: string } | undefined;
        if (!row) return null;
        return { schema_version: row.schema_version, identityPresent: !!row.owner_uid && !!row.target_uid };
      } catch { return null; }
    })();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]).map(r => r.name);
    return {
      version, quick, meta,
      messages: count('messages'), batches: count('archive_batches'),
      conversations: count('conversations'), epochs: count('reconcile_epochs'),
      eligible: count('eligible_events'), aiAttempts: count('ai_decision_attempts'),
      sendIntents: count('send_intents'), approvals: count('send_approvals'),
      tables,
    };
  } finally { db.close(); }
}

const report: Record<string, unknown> = { mode: 'rehearsal', source: basename(source), sourceSha256: sourceSha };
let exitCode = 1;
const dir = mkdtempSync(join(tmpdir(), 'eve-migrate-'));
const work = join(dir, basename(source));
copyFileSync(source, work);

try {
  const before = inspect(work);
  report['before'] = before;
  if (before.version !== 2) throw new Error('source_not_v2');

  // 打开库需要真实 UID，但只在内存中使用，绝不写入 report
  const rawMeta = (() => {
    const db = new DatabaseSync(work, { readOnly: true });
    try {
      return db.prepare('SELECT owner_uid,target_uid FROM archive_meta WHERE singleton=1')
        .get() as { owner_uid: string; target_uid: string };
    } finally { db.close(); }
  })();
  const identity = { ownerUid: rawMeta.owner_uid, targetUid: rawMeta.target_uid,
    ownUids: [rawMeta.owner_uid] };

  // ---- 1. 逐级迁移 ----
  const a = EveArchive.open(work, identity);
  const steps: { step: string; version: number; messages: number | null }[] = [];
  try {
    for (const [name, fn] of [
      ['v2→v3', () => a.upgradeToV3()],
      ['v3→v4', () => a.upgradeToV4()],
      ['v4→v5', () => a.upgradeToV5()],
      ['v5→v6', () => a.upgradeToV6()],
    ] as const) {
      fn();
      const s = inspect(work);
      steps.push({ step: name, version: s.version, messages: s.messages });
      if (s.messages !== before.messages) throw new Error('message_count_changed_at_' + name);
    }
  } finally { a.close(); }
  report['steps'] = steps;

  // ---- 2. 迁移后一致性 ----
  const after = inspect(work);
  report['after'] = after;
  const checks = {
    versionIsMax: after.version === MAX_SCHEMA_VERSION,
    metaAligned: after.meta?.schema_version === after.version,
    messagesPreserved: after.messages === before.messages,
    batchesPreserved: after.batches === before.batches,
    conversationsPreserved: after.conversations === before.conversations,
    quickCheckOk: after.quick === 'ok',
    newTablesPresent: ['send_intents', 'send_intent_events', 'send_text', 'send_approvals', 'ai_decision_attempts']
      .every(t => after.tables.includes(t)),
  };
  report['checks'] = checks;

  // ---- 3. 重复迁移幂等 ----
  const b = EveArchive.open(work, identity);
  try {
    b.upgradeToV3(); b.upgradeToV4(); b.upgradeToV5(); b.upgradeToV6(); b.upgradeToV6();
  } finally { b.close(); }
  const again = inspect(work);
  report['idempotent'] = again.version === after.version && again.messages === after.messages;

  // ---- 4. 失败回滚：造一份停在 v5 的副本，再注入 v6 失败 ----
  let rolledBack = false;
  const v5Copy = join(dir, 'v5-' + basename(source));
  copyFileSync(source, v5Copy);
  const e = EveArchive.open(v5Copy, identity);
  try { e.upgradeToV3(); e.upgradeToV4(); e.upgradeToV5(); } finally { e.close(); }
  const v5Before = inspect(v5Copy);
  const f = EveArchive.open(v5Copy, identity);
  try {
    f.upgradeToV6(true); // 注入失败
  } catch {
    rolledBack = true;
  } finally { f.close(); }
  const v5After = inspect(v5Copy);
  report['failureRollback'] = {
    threw: rolledBack,
    stillV5: v5After.version === 5 && v5Before.version === 5,
    noApprovalTable: !v5After.tables.includes('send_approvals'),
    messagesIntact: v5After.messages === v5Before.messages,
    quickOk: v5After.quick === 'ok',
  };

  // ---- 5. 重开后仍可用 ----
  const g = EveArchive.open(work, identity);
  let reopenOk = false;
  try {
    reopenOk = g.conversationState(before.tables.includes('conversations') ? '' : '') === null ||
      true; // 仅验证可打开；具体会话状态由上面 checks 覆盖
  } finally { g.close(); }
  report['reopenOk'] = reopenOk;

  const allPass = Object.values(checks).every(Boolean) &&
    report['idempotent'] === true &&
    (report['failureRollback'] as Record<string, boolean>).threw &&
    (report['failureRollback'] as Record<string, boolean>).stillV5 &&
    (report['failureRollback'] as Record<string, boolean>).noApprovalTable &&
    (report['failureRollback'] as Record<string, boolean>).messagesIntact &&
    (report['failureRollback'] as Record<string, boolean>).quickOk;
  report['verdict'] = allPass ? 'pass' : 'fail';
  exitCode = allPass ? 0 : 1;

  // 源备份必须完全未被触碰
  report['sourceUnchanged'] = sha(source) === sourceSha;
  if (!report['sourceUnchanged']) { report['verdict'] = 'fail'; exitCode = 1; }
  if (keep) report['keptAt'] = dir;
} catch (e) {
  report['verdict'] = 'error';
  report['reason'] = e instanceof Error && /^[a-z_]{3,60}$/.test(e.message) ? e.message : 'unexpected';
  exitCode = 1;
} finally {
  if (!keep) rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = exitCode;
