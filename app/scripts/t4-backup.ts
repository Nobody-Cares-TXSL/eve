/**
 * T4 正式库一致性备份与回滚工具（迁移 v1→v2 前必做）。
 *
 * 用 SQLite `VACUUM INTO` 生成一致性快照：它在一个读事务内导出，
 * 会把 WAL 中已提交的内容一并写入，因此**不是**裸复制 .sqlite 文件
 * （裸复制在 WAL 模式下可能得到缺数据或半写的副本）。
 *
 * 用法：
 *   node scripts/t4-backup.ts backup    [--src data/eve.sqlite] [--out data/backups]
 *   node scripts/t4-backup.ts verify    <backup-file>
 *   node scripts/t4-backup.ts rollback  <backup-file> [--dest data/eve.sqlite]
 *
 * 所有产物 0600；备份目录 0700。只读源库，不改动源库内容。
 */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const command = args[0];
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const positional = (i: number): string | undefined => {
  const value = args[i];
  return value && !value.startsWith('--') ? value : undefined;
};

function assertNoSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`拒绝符号链接：${path}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * 只覆盖主库文件的指纹。
 * 不包含 -wal/-shm：即使以 readOnly 打开，SQLite 也可能创建/更新 shm 共享内存文件，
 * 把它算进「源库是否被改动」会产生假警报（曾实测误报 source_changed_during_backup）。
 * 主库内容是否改变由 VACUUM INTO 的读事务语义保证。
 */
function fingerprint(path: string): string {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'absent';
}

/** 校验备份是完整可用的 SQLite 库，且结构与源库身份一致。 */
function verifyBackup(file: string): { ok: boolean; detail: string } {
  if (!existsSync(file)) return { ok: false, detail: 'backup_missing' };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (integrity !== 'ok') return { ok: false, detail: 'integrity_failed' };
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version !== 1 && version !== 2 && version !== 3) return { ok: false, detail: 'unexpected_schema_version' };
    const meta = db.prepare('SELECT schema_version,owner_uid,target_uid FROM archive_meta WHERE singleton=1')
      .get() as { schema_version: number; owner_uid: string; target_uid: string } | undefined;
    if (!meta) return { ok: false, detail: 'archive_meta_missing' };
    if (meta.schema_version !== version) return { ok: false, detail: 'schema_meta_mismatch' };
    if (version === 3) {
      const ledger = db.prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('ai_decision_attempts','ai_batch_items')"
      ).get() as { n: number };
      if (ledger.n !== 2) return { ok: false, detail: 'ai_ledger_missing' };
    }
    const messages = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
    return { ok: true, detail: `v${version} messages=${messages} meta=v${meta.schema_version}` };
  } finally { db.close(); }
}

if (command === 'backup') {
  const src = resolve(opt('--src', join('data', 'eve.sqlite')));
  const outDir = resolve(opt('--out', join('data', 'backups')));
  if (!existsSync(src)) { console.error('backup_failed: source_missing'); process.exit(2); }
  assertNoSymlink(src);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  chmodSync(outDir, 0o700);
  const before = fingerprint(src);
  const versionDb = new DatabaseSync(src, { readOnly: true });
  let sourceVersion: number;
  try {
    sourceVersion = (versionDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally { versionDb.close(); }
  if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== 3) {
    console.error('backup_failed: schema_unsupported');
    process.exit(2);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(outDir, `eve-v${sourceVersion}-${stamp}.sqlite`);
  const temp = target + '.tmp';
  // 只读打开源库：备份过程不得改写源库。
  const source = new DatabaseSync(src, { readOnly: true });
  try {
    // VACUUM INTO 要求目标不存在
    if (existsSync(temp)) unlinkSync(temp);
    source.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  } finally { source.close(); }
  chmodSync(temp, 0o600);
  const check = verifyBackup(temp);
  if (!check.ok) { unlinkSync(temp); console.error('backup_failed: ' + check.detail); process.exit(1); }
  renameSync(temp, target);
  const after = fingerprint(src);
  if (after !== before) {
    // 只读连接不应改变源库；若变了必须如实报错而不是当作成功
    console.error('backup_failed: source_changed_during_backup');
    process.exit(1);
  }
  const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
  console.log(JSON.stringify({ mode: 'backup', file: target, bytes: statSync(target).size,
    sha256: hash, verify: check.detail, sourceUnchanged: true }));
} else if (command === 'verify') {
  const file = positional(1);
  if (!file) { console.error('用法：verify <backup-file>'); process.exit(2); }
  const result = verifyBackup(resolve(file));
  console.log(JSON.stringify({ mode: 'verify', file: resolve(file), ...result }));
  if (!result.ok) process.exit(1);
} else if (command === 'rollback') {
  const backup = positional(1);
  const dest = resolve(opt('--dest', join('data', 'eve.sqlite')));
  if (!backup) { console.error('用法：rollback <backup-file> [--dest ...]'); process.exit(2); }
  const check = verifyBackup(resolve(backup));
  if (!check.ok) { console.error('rollback_failed: ' + check.detail); process.exit(1); }
  // 回滚前先把当前库另存，避免回滚本身造成不可逆丢失
  if (existsSync(dest)) {
    const safety = dest + '.pre-rollback-' + new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(dest, safety);
    for (const side of ['-wal', '-shm']) if (existsSync(dest + side)) unlinkSync(dest + side);
    console.error('已保留当前库：' + safety);
  }
  const temp = dest + '.restore.tmp';
  const source = new DatabaseSync(resolve(backup), { readOnly: true });
  try {
    if (existsSync(temp)) unlinkSync(temp);
    source.exec(`VACUUM INTO '${temp.replace(/'/g, "''")}'`);
  } finally { source.close(); }
  chmodSync(temp, 0o600);
  const restored = verifyBackup(temp);
  if (!restored.ok) { unlinkSync(temp); console.error('rollback_failed: restore_invalid'); process.exit(1); }
  renameSync(temp, dest);
  chmodSync(dest, 0o600);
  chmodSync(dirname(dest), 0o700);
  console.log(JSON.stringify({ mode: 'rollback', dest, verify: restored.detail }));
} else {
  console.error('用法：t4-backup.ts backup|verify|rollback');
  process.exit(2);
}
