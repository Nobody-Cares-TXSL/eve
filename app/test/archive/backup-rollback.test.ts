/** T4 正式库迁移前的备份与回滚（脚本级，真实子进程 + 临时目录）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EveArchive } from '../../src/archive/store.ts';
import type { InboundMessage } from '../../src/platform/types.ts';

const script = resolve('scripts/t4-backup.ts');
const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const thread = '0:1:222:333';
const msg: InboundMessage = {
  conversationId: thread, serverMessageId: '1000000000000000001', clientMessageId: null,
  senderUid: '333', fromSelf: false, text: 'backup-fixture', kind: 'text',
  messageType: 7, createTime: '1', indexInConversation: null,
};

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script, ...args],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function seed(dir: string): string {
  const file = join(dir, 'eve.sqlite');
  const a = EveArchive.open(file, identity);
  try { a.archiveBatch({ batchId: 'seed', conversationId: thread, source: 'live', messages: [msg] }); }
  finally { a.close(); }
  return file;
}

test('备份生成一致性快照，源库不被改动，产物 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t4-backup-'));
  try {
    const src = seed(dir);
    const out = join(dir, 'backups');
    const before = statSync(src).size;
    const r = run(['backup', '--src', src, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout) as { file: string; verify: string; sourceUnchanged: boolean; sha256: string };
    assert.equal(report.sourceUnchanged, true, '只读备份不得改写源库');
    assert.match(report.verify, /v1 messages=1/);
    assert.match(report.sha256, /^[0-9a-f]{64}$/);
    assert.ok(existsSync(report.file));
    assert.equal(statSync(report.file).mode & 0o777, 0o600, '备份文件必须 0600');
    assert.equal(statSync(out).mode & 0o777, 0o700, '备份目录必须 0700');
    // 源库仍可读且数据未变
    const db = new DatabaseSync(src, { readOnly: true });
    try { assert.equal((db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1); }
    finally { db.close(); }
    assert.equal(statSync(src).size, before, '源库大小不得因备份改变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verify 能识别损坏与缺失的备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t4-verify-'));
  try {
    const missing = run(['verify', join(dir, 'nope.sqlite')]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /backup_missing/);

    // 非 SQLite 内容：integrity_check 或读取必然失败，必须拒绝而非当作可用备份
    const junk = join(dir, 'junk.sqlite');
    writeFileSync(junk, 'not a sqlite file at all');
    const bad = run(['verify', junk]);
    assert.equal(bad.status, 1, '损坏文件不得通过校验');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('回滚往返：v2 迁移后可回到 v1 且消息数不变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t4-rollback-'));
  try {
    const src = seed(dir);
    const out = join(dir, 'backups');
    const backup = run(['backup', '--src', src, '--out', out]);
    assert.equal(backup.status, 0, backup.stderr);
    const file = (JSON.parse(backup.stdout) as { file: string }).file;

    // 迁移到 v2
    const a = EveArchive.open(src, identity);
    try { a.upgradeToV2(); } finally { a.close(); }
    const v2 = new DatabaseSync(src, { readOnly: true });
    try { assert.equal((v2.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2); }
    finally { v2.close(); }

    // 回滚
    const rb = run(['rollback', file, '--dest', src]);
    assert.equal(rb.status, 0, rb.stderr);
    const report = JSON.parse(rb.stdout) as { verify: string };
    assert.match(report.verify, /v1 messages=1/);
    const after = new DatabaseSync(src, { readOnly: true });
    try {
      assert.equal((after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
      assert.equal((after.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n, 1);
      const v2Tables = (after.prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('reconcile_epochs','reconcile_pages','eligible_events')").get() as { n: number }).n;
      assert.equal(v2Tables, 0, '回滚后 v2 表必须完全消失');
    } finally { after.close(); }
    // 回滚前的当前库被另存，不静默丢弃
    const kept = readdirSync(dir).filter(n => n.includes('pre-rollback'));
    assert.equal(kept.length, 1, '回滚必须保留原库副本');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('拒绝符号链接的源库路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t4-link-'));
  try {
    const real = seed(dir);
    const link = join(dir, 'link.sqlite');
    symlinkSync(real, link);
    const r = run(['backup', '--src', link, '--out', join(dir, 'backups')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /拒绝符号链接/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('v2 备份按实际版本命名并保留对账表',()=>{
 const dir=mkdtempSync(join(tmpdir(),'eve-t4-v2-backup-'));
 try{
  const src=seed(dir),out=join(dir,'backups');
  const a=EveArchive.open(src,identity);
  try{a.upgradeToV2();}finally{a.close();}
  const result=run(['backup','--src',src,'--out',out]);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout) as {file:string;verify:string;sourceUnchanged:boolean};
  assert.match(report.file,/eve-v2-.*\.sqlite$/);
  assert.match(report.verify,/v2 messages=1 meta=v2/);
  assert.equal(report.sourceUnchanged,true);
  const copy=new DatabaseSync(report.file,{readOnly:true});
  try{
   assert.equal((copy.prepare('PRAGMA user_version').get() as {user_version:number}).user_version,2);
   assert.equal((copy.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n,1);
   assert.equal((copy.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('reconcile_epochs','reconcile_pages','eligible_events')").get() as {n:number}).n,3);
  }finally{copy.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
