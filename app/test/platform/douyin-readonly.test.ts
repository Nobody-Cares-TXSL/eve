import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'douyin-im';
import { DouyinReadOnlyPort, belongsToTarget } from '../../src/platform/douyin.ts';
import { LocalQrFile } from '../../src/platform/qr.ts';
import { normalizeHistoryMessage } from '../../src/platform/history.ts';
import type { InboundMessage, PlatformStatus } from '../../src/platform/types.ts';

class FakeClient extends EventEmitter {
  readonly account = { uid: '111', imUid: '222', online: true, pickFriend: () => undefined, pickStranger: () => undefined };
  readonly accounts = [this.account];
  loginCalls = 0;
  logoutCalls = 0;
  async login() { this.loginCalls++; this.emit('system.online', {account: this.account, platformUid: this.account.uid, screenName: 'mock'}); }
  async logout() { this.logoutCalls++; }
}
function make(client: FakeClient, dir: string, allowLocalVerification = false) {
  const statuses: PlatformStatus[] = [];
  const messages: InboundMessage[] = [];
  const port = new DouyinReadOnlyPort({ dataDir: dir, selfUid: '111', targetUid: '333', client: client as unknown as Client, allowLocalVerification });
  port.subscribe({ onStatus: x => statuses.push(x), onMessage: x => messages.push(x) });
  return {port, statuses, messages};
}
test('会话必须同时绑定已确认自己的 UID 与唯一目标，子串不算匹配', () => {
  const own = new Set(['111', '222']);
  assert.equal(belongsToTarget('0:1:222:333', own, '333'), true);
  for (const id of ['0:1:222:3334', '0:2:222:333', '0:1:444:333', '0:1:333:444', '0:1:222:333:extra']) {
    assert.equal(belongsToTarget(id, own, '333'), false);
  }
});
test('仅认证自己账号后上线；错误账号拒绝且不泄露消息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t1-'));
  try {
    const client = new FakeClient();
    client.account.uid = '999';
    const {port, statuses} = make(client,dir);
    await assert.rejects(port.start(), /只读登录失败/);
    assert.ok(statuses.some(s => s.type === 'session_rejected'));
    assert.equal(client.logoutCalls,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('正常只读登录；不做消息发送或其他操作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t1-'));
  try {
    const client = new FakeClient();
    const {port, statuses, messages} = make(client,dir);
    await port.start();
    assert.equal(statuses.at(-1)?.type,'online');
    assert.equal(messages.length,0);
    await assert.rejects(port.readHistory('0:1:222:444'), /白名单/);
    await port.stop();
    assert.equal(client.loginCalls,1);
    assert.equal(client.logoutCalls,1);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('登录已失效时状态转移并封锁只读查询', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t1-'));
  try {
    const client = new FakeClient();
    const {port,statuses} = make(client,dir);
    await port.start();
    client.emit('system.login.session', {account: client.account, status:'expired', reason:'credential'});
    assert.equal(statuses.at(-1)?.type,'session_rejected');
    await assert.rejects(port.readHistory('0:1:222:333'), /未验证上线/);
    await port.stop();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('历史消息仅明确文本可变为 text，分享标题不得冒充', () => {
  const base = {threadId:'0:1:222:333',msgId:'99',senderUid:'333',content:'{"text":"hello"}',msgType:7,createTime:123456,status:0};
  assert.equal(normalizeHistoryMessage(base,new Set(['111','222']))?.kind,'text');
  assert.equal(normalizeHistoryMessage({...base,msgType:8,content:'{"text":"分享标题"}'},new Set(['111','222']))?.kind,'non_text');
  assert.equal(normalizeHistoryMessage({...base,deleted:true},new Set(['111','222'])),null);
  assert.equal(normalizeHistoryMessage({...base,conversationType:2},new Set(['111','222'])),null);
});
test('二维码写入到临时目录，仅 600 可读，remove 可幂等执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t1-'));
  try {
    const qr = new LocalQrFile(dir);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEklEQVQI12P4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
    assert.equal(await qr.save(png),qr.path);
    assert.equal((await stat(qr.path)).mode & 0o777,0o600);
    assert.ok((await readFile(qr.path)).subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')));
    await qr.remove(); await qr.remove();
    await assert.rejects(stat(qr.path),{code:'ENOENT'});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('本机验证默认禁用；显式允许后才调用 SDK 的人工验证页', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t1-'));
  try {
    const client = new FakeClient();
    const {port,statuses} = make(client, dir);
    await port.start();
    let cancelled = false;
    let opened = false;
    client.emit('system.login.verification', {
      account: client.account,
      verification: { methods: ['captcha'], cancel: () => { cancelled = true; }, open: () => { opened = true; return Promise.resolve(); } },
    });
    assert.equal(cancelled, true);
    assert.equal(opened, false);
    assert.equal(statuses.at(-1)?.type, 'verification_required');
    await port.stop();

    const client2 = new FakeClient();
    const {port: interactive} = make(client2, dir, true);
    await interactive.start();
    cancelled = false;
    opened = false;
    client2.emit('system.login.verification', {
      account: client2.account,
      verification: { methods: ['captcha'], cancel: () => { cancelled = true; }, open: (opts: {openBrowser: boolean; timeoutMs: number}) => {
        assert.equal(opts.openBrowser,true);
        assert.equal(opts.timeoutMs,300_000);
        opened = true;
        return Promise.resolve();
      } },
    });
    assert.equal(cancelled, false);
    assert.equal(opened, true);
    await interactive.stop();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
