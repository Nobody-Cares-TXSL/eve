/** T3 崩溃恢复：真实子进程 SIGKILL 后，已提交批次必须完整存活、未提交事务必须消失。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EveArchive } from '../../src/archive/store.ts';
import type { InboundMessage } from '../../src/platform/types.ts';

const identity = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const thread = '0:1:222:333';
const msg = (id: string, over: Partial<InboundMessage> = {}): InboundMessage => ({
  conversationId: thread, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: 'crash-fixture', kind: 'text', messageType: 7,
  createTime: '1793089447000', indexInConversation: null, ...over,
});

/** 子进程：写两批后 SIGKILL 自己（模拟断电/强杀，不走 close）。 */
const writer = `
import { EveArchive } from ${JSON.stringify(resolve('src/archive/store.ts'))};
const a = EveArchive.open(process.env.EVE_CRASH_DB, ${JSON.stringify(identity)});
a.archiveBatch({ batchId: 'b1', conversationId: ${JSON.stringify(thread)}, source: 'live',
  messages: [{ conversationId: ${JSON.stringify(thread)}, serverMessageId: '9000000000000000001',
    clientMessageId: null, senderUid: '333', fromSelf: false, text: 'committed',
    kind: 'text', messageType: 7, createTime: '1', indexInConversation: null }] });
process.kill(process.pid, 'SIGKILL');
`;

test('SIGKILL 后已提交批次存活，重开可继续写入且不重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t3-crash-'));
  const file = join(dir, 'eve.sqlite');
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', writer],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', EVE_CRASH_DB: file } });
    // SIGKILL 无退出码，signal 必须是 SIGKILL：证明是强杀而非正常关闭
    assert.equal(child.signal, 'SIGKILL', '子进程必须被 SIGKILL 终止，实际 signal=' + child.signal);

    const after = EveArchive.open(file, identity);
    try {
      assert.equal(after.counts().messages, 1, '已提交事务必须存活');
      assert.equal(after.counts().batches, 1);
      // 同一事件再来一次：必须 matched，不得因崩溃产生重复行
      assert.deepEqual(
        after.archiveBatch({ batchId: 'b2', conversationId: thread, source: 'live', messages: [msg('9000000000000000001', { text: 'committed', createTime: '1' })] }).outcomes,
        ['matched']);
      assert.equal(after.counts().messages, 1, '崩溃恢复后不得重复插入');
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SIGKILL 中断未提交事务：半写批次不得留下任何行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t3-crash-mid-'));
  const file = join(dir, 'eve.sqlite');
  try {
    // 先正常建库，确保 v1 已固化
    const init = EveArchive.open(file, identity); init.close();

    // 子进程在 BEGIN IMMEDIATE 之后、COMMIT 之前被 SIGKILL
    const midway = `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.EVE_CRASH_DB);
db.exec('BEGIN IMMEDIATE');
db.exec("INSERT INTO conversations(conversation_id,updated_at_ms) VALUES('0:1:222:333',1)");
db.exec("INSERT INTO messages(conversation_id,server_message_id,sender_uid,from_self,text,kind,message_type,first_source,archived_at_ms) VALUES('0:1:222:333','777','333',0,'half','text',7,'live',1)");
process.kill(process.pid, 'SIGKILL');
`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', midway],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', EVE_CRASH_DB: file } });
    assert.equal(child.signal, 'SIGKILL');

    const after = EveArchive.open(file, identity);
    try {
      assert.deepEqual(after.counts(), { messages: 0, uncertain: 0, gaps: 0, batches: 0 },
        '未提交事务必须整体消失，不得半提交');
    } finally { after.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WAL 文件在崩溃后仍被正确重放（journal_mode 确实是 WAL）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eve-t3-wal-'));
  const file = join(dir, 'eve.sqlite');
  try {
    const init = EveArchive.open(file, identity); init.close();
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.EVE_CRASH_DB);
process.stdout.write(String(db.prepare('PRAGMA journal_mode').get().journal_mode));
db.close();
`], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', EVE_CRASH_DB: file } });
    assert.equal(check.stdout.trim(), 'wal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
