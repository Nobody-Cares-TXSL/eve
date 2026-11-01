/**
 * 正式库 v2→v6 逐级迁移（受控、可审计）。
 *
 * 契约：docs/contracts/send.md §16。
 *
 * 重要：**这不是一个事务**。v2→v3→v4→v5→v6 是四次独立的显式升级，
 * 每步各自提交。任一步失败时数据库会合法地停在中间版本，**不会**整体
 * 回滚到 v2；此时必须按恢复流程用迁移前备份还原，不得尝试降级函数。
 *
 * 用法：
 *   node scripts/t6-migrate-prod.ts --confirm --backup-dir <dir> [--db <path>]
 *
 * 本脚本不启动 Runner、不发送消息、不调用任何发送接口。
 */
import { existsSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive, MAX_SCHEMA_VERSION } from '../src/archive/store.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
if (!args.includes('--confirm')) {
  console.error('拒绝执行：必须显式传入 --confirm（这是修改正式数据的操作）');
  process.exit(2);
}
const dbPath = resolve(opt('--db') ?? join('data', 'eve.sqlite'));
const backupDir = resolve(opt('--backup-dir') ?? '/home/duan/tmp/eve-backups');
if (!existsSync(dbPath)) { console.error('正式库不存在：' + dbPath); process.exit(2); }

const report: Record<string, unknown> = { mode: 'prod_migration', db: basename(dbPath) };
const fail = (reason: string, extra: Record<string, unknown> = {}): never => {
  report['verdict'] = 'failed';
  report['reason'] = reason;
  Object.assign(report, extra);
  console.log(JSON.stringify(report, null, 2));
  process.exit(1);
};

/** 只读检查：版本、meta、完整性、外键、计数。不输出任何 UID。 */
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const quick = (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check;
    const fk = (db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length;
    const count = (t: string): number | null => {
      try { return Number((db.prepare('SELECT COUNT(*) n FROM ' + t).get() as { n: number }).n); }
      catch { return null; }
    };
    const meta = (() => {
      try {
        const r = db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1')
          .get() as { schema_version: number; owner_uid: string; target_uid: string } | undefined;
        return r ? { schema_version: r.schema_version, identityPresent: !!r.owner_uid && !!r.target_uid } : null;
      } catch { return null; }
    })();
    return {
      version, quick, foreignKeyViolations: fk, meta,
      messages: count('messages'), batches: count('archive_batches'),
      conversations: count('conversations'), epochs: count('reconcile_epochs'),
    };
  } finally { db.close(); }
}

const sha256 = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex');

// ---------- Gate 1：确认无人占用 ----------
const holders = spawnSync('lsof', [dbPath, dbPath + '-wal', dbPath + '-shm'], { encoding: 'utf8' });
if (holders.status === 0 && holders.stdout.trim().split('\n').length > 1) {
  fail('database_in_use', { holders: holders.stdout.trim().split('\n').length - 1 });
}
const runners = spawnSync('pgrep', ['-af', 'cli.ts run'], { encoding: 'utf8' });
if (runners.status === 0 && runners.stdout.split('\n').filter(l => l && !l.includes('pgrep')).length > 0) {
  fail('runner_running');
}
report['gate1_no_holders'] = true;

// ---------- Gate 2：一致性备份并校验 ----------
const before = inspect(dbPath);
report['before'] = before;
if (before.version !== 2) fail('source_not_v2', { actualVersion: before.version });

mkdirSync(backupDir, { recursive: true, mode: 0o700 });
chmodSync(backupDir, 0o700);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = join(backupDir, `eve-prod-pre-migrate-v2-${stamp}.sqlite`);
{
  // VACUUM INTO：读事务内导出一致快照，包含 WAL 中已提交内容
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try { src.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`); }
  finally { src.close(); }
}
chmodSync(backup, 0o600);
const backupCheck = inspect(backup);
if (backupCheck.quick !== 'ok' || backupCheck.version !== 2 ||
    backupCheck.messages !== before.messages || backupCheck.batches !== before.batches) {
  fail('backup_verification_failed', { backupCheck });
}
const backupSha = sha256(backup);
writeFileSync(backup + '.json', JSON.stringify({
  created_utc: new Date().toISOString(), source: dbPath, backup,
  source_version: before.version, quick_check: backupCheck.quick,
  messages: backupCheck.messages, batches: backupCheck.batches,
  bytes: statSync(backup).size, sha256: backupSha,
  method: 'VACUUM INTO from read-only connection',
}, null, 2) + '\n', { mode: 0o600 });
report['gate2_backup'] = {
  file: basename(backup), sha256: backupSha, bytes: statSync(backup).size,
  openable: true, messages: backupCheck.messages, batches: backupCheck.batches,
};

// ---------- Gate 3：逐级迁移，每步校验 ----------
const identity = (() => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT owner_uid,target_uid FROM archive_meta WHERE singleton=1')
      .get() as { owner_uid: string; target_uid: string };
  } finally { db.close(); }
})();

const steps: { step: string; version: number; metaVersion: number | null; messages: number | null; quick: string }[] = [];
const a = EveArchive.open(dbPath, {
  ownerUid: identity.owner_uid, targetUid: identity.target_uid, ownUids: [identity.owner_uid],
});
try {
  const plan: [string, number, () => void][] = [
    ['v2→v3', 3, () => a.upgradeToV3()],
    ['v3→v4', 4, () => a.upgradeToV4()],
    ['v4→v5', 5, () => a.upgradeToV5()],
    ['v5→v6', 6, () => a.upgradeToV6()],
  ];
  for (const [name, expect, run] of plan) {
    run();
    const s = inspect(dbPath);
    steps.push({ step: name, version: s.version, metaVersion: s.meta?.schema_version ?? null,
      messages: s.messages, quick: s.quick });
    if (s.version !== expect) throw new Error('version_mismatch_after_' + name);
    if (s.meta?.schema_version !== expect) throw new Error('meta_mismatch_after_' + name);
    if (s.messages !== before.messages) throw new Error('message_count_changed_after_' + name);
    if (s.quick !== 'ok') throw new Error('quick_check_failed_after_' + name);
  }
} catch (e) {
  a.close();
  // 关键：不尝试降级；停在哪个版本就报告哪个版本，并给出恢复指引
  const now = inspect(dbPath);
  fail('migration_step_failed', {
    stoppedAtVersion: now.version,
    steps,
    restore: '确认无数据库连接后，用 gate2_backup 覆盖 ' + dbPath +
      '（并删除 -wal/-shm），不要调用任何降级函数',
    error: e instanceof Error && /^[a-z_0-9→]{3,60}$/.test(e.message) ? e.message : 'unexpected',
  });
} finally {
  try { a.close(); } catch { /* 已关闭 */ }
}
report['gate3_steps'] = steps;

// ---------- Gate 4：最终核验 ----------
const after = inspect(dbPath);
report['after'] = after;
const checks = {
  versionIsMax: after.version === MAX_SCHEMA_VERSION,
  metaAligned: after.meta?.schema_version === after.version,
  identityPresent: after.meta?.identityPresent === true,
  quickCheckOk: after.quick === 'ok',
  foreignKeysClean: after.foreignKeyViolations === 0,
  messagesPreserved: after.messages === before.messages,
  batchesPreserved: after.batches === before.batches,
  conversationsPreserved: after.conversations === before.conversations,
  epochsPreserved: after.epochs === before.epochs,
};
report['gate4_checks'] = checks;
if (!Object.values(checks).every(Boolean)) {
  fail('post_migration_verification_failed', {
    checks,
    restore: '用 gate2_backup 覆盖 ' + dbPath + '（并删除 -wal/-shm）',
  });
}

// ---------- Gate 5/6：无真实发送、无 Runner ----------
const runnersAfter = spawnSync('pgrep', ['-af', 'cli.ts run'], { encoding: 'utf8' });
report['gate5_no_runner'] = !(runnersAfter.status === 0 &&
  runnersAfter.stdout.split('\n').filter(l => l && !l.includes('pgrep')).length > 0);
report['gate6_no_real_send'] = true; // 本脚本不导入任何发送模块

report['verdict'] = 'pass';
console.log(JSON.stringify(report, null, 2));
