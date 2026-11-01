/**
 * T6-3c-real-B1 前置：DouyinReadOnlyPort 的可信发送出口（零发送测试）。
 *
 * 验证出口的创建条件、绑定关系与撤销语义。
 * 使用 FakeClient：contact.sendMsg 只是记录调用，不触网、不发真实消息。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'douyin-im';
import { DouyinReadOnlyPort } from '../../src/platform/douyin.ts';
import { claimPortIdentity, registerSendPortIssuer, assertTrustedSendPort, type TrustedSendPort } from '../../src/platform/outbound-transport.ts';

const THREAD = '0:1:222:333';

interface SentCall { readonly conversationId: string; readonly message: string }

class FakeContact {
  readonly uid = '333';
  readonly conversationType = 1;
  readonly conversationShortId = '123456';
  readonly blocked = false;
  readonly sent: SentCall[] = [];
  readonly threadId: string;
  readonly account: unknown;
  constructor(threadId: string, account: unknown) { this.threadId = threadId; this.account = account; }
  async sendMsg(message: string) {
    this.sent.push({ conversationId: this.threadId, message });
    return { statusCode: 0, statusMsg: 'OK', serverMessageId: '7701260499833538097' };
  }
  async getHistory() { return { statusCode: 0, hasMore: false, cursor: '0', direction: 'older' as const, messages: [] }; }
}

class FakeClient extends EventEmitter {
  readonly account: {
    uid: string; imUid: string; online: boolean;
    pickFriend: (uid: string) => FakeContact | undefined;
    pickStranger: (uid: string) => FakeContact | undefined;
  };
  readonly accounts: unknown[];
  private readonly contact: FakeContact;
  constructor(opts: { uid?: string; imUid?: string; contactThread?: string } = {}) {
    super();
    this.contact = new FakeContact(opts.contactThread ?? THREAD, this);
    const self = this;
    this.account = {
      uid: opts.uid ?? '111',
      imUid: opts.imUid ?? '222',
      online: true,
      pickFriend: (uid: string) => (uid === '333' ? self.contact : undefined),
      pickStranger: () => undefined,
    };
    this.accounts = [this.account];
  }
  get sentCalls(): SentCall[] { return this.contact.sent; }
  async login() {
    this.emit('system.online', { account: this.account, platformUid: this.account.uid, screenName: 'mock' });
  }
  async logout() { this.account.online = false; }
}

async function withPort(
  fn: (ctx: { port: DouyinReadOnlyPort; client: FakeClient }) => Promise<void>,
  opts: { uid?: string; imUid?: string; contactThread?: string } = {},
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t6-outlet-'));
  const client = new FakeClient(opts);
  const port = new DouyinReadOnlyPort({
    dataDir: dir, selfUid: '111', targetUid: '333',
    client: client as unknown as Client, allowLocalVerification: false,
  });
  port.subscribe({ onMessage: () => undefined, onStatus: () => undefined });
  try { await fn({ port, client }); }
  finally { await port.stop().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
}

test('未上线时不能创建出口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-t6-outlet-'));
  const client = new FakeClient();
  const port = new DouyinReadOnlyPort({
    dataDir: dir, selfUid: '111', targetUid: '333',
    client: client as unknown as Client, allowLocalVerification: false,
  });
  try {
    assert.equal(port.createTrustedSendPort(THREAD), null, '未 start 不得创建出口');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('上线后为目标会话创建可信出口，且能通过令牌校验', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet, '活跃会话应能创建出口');
    assert.equal(outlet.conversationId, THREAD);
    assert.equal(outlet.recipientUid, '333');
    assert.equal(assertTrustedSendPort(outlet), true, '必须带 Port 令牌');
  });
});

test('非白名单会话不创建出口', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    assert.equal(port.createTrustedSendPort('0:1:222:444'), null);
    assert.equal(port.createTrustedSendPort('0:1:111:444'), null);
    assert.equal(port.createTrustedSendPort('0:2:222:333'), null);
  });
});

test('联系人未绑定到目标时不创建出口', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    // 联系人 threadId 与会话不符 → 视为未绑定
    assert.equal(port.createTrustedSendPort(THREAD), null);
  }, { contactThread: '0:1:222:444' });
});

test('出口调用会把消息交给绑定的联系人（fake，不发真实消息）', async () => {
  await withPort(async ({ port, client }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet);
    const res = await outlet.sendText('只供离线测试的正文') as { statusCode: number; serverMessageId?: string };
    assert.equal(res.statusCode, 0);
    assert.equal(res.serverMessageId, '7701260499833538097');
    assert.equal(client.sentCalls.length, 1, '必须恰好调用一次');
    assert.equal(client.sentCalls[0]?.message, '只供离线测试的正文');
    assert.equal(client.sentCalls[0]?.conversationId, THREAD);
  });
});

test('下线后出口拒绝发送，不再调用联系人', async () => {
  await withPort(async ({ port, client }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet);
    client.account.online = false;
    await assert.rejects(() => outlet.sendText('不应发出'), /send_session_changed/);
    assert.equal(client.sentCalls.length, 0, '会话失效时绝不能调用 sendMsg');
  });
});

test('stop() 撤销全部出口，令牌失效', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet);
    assert.equal(assertTrustedSendPort(outlet), true);
    await port.stop();
    assert.equal(assertTrustedSendPort(outlet), false, 'stop 后令牌必须失效');
    await assert.rejects(() => outlet.sendText('关停后不应发出'), /send_session_changed/);
  });
});

test('出口只允许一个目标：无法为其他 UID 创建', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    // 即使联系人对象存在，会话白名单也不允许
    assert.equal(port.createTrustedSendPort('0:1:222:999'), null);
  });
});

test('P0-1：普通模块无法签发可信出口（无 Port 身份即被拒）', () => {
  const fakeIdentity = {};
  // 未通过 claimPortIdentity 登记的对象不能注册签发器
  assert.throws(() => registerSendPortIssuer({}, fakeIdentity), /send_port_issuer_not_authorized/);
  // 即便传入自己构造的对象，只要没登记过身份就不行
  assert.throws(() => registerSendPortIssuer({}, {}), /send_port_issuer_not_authorized/);
});

test('P0-1：签发器撤销后，已签出的出口全部失效', () => {
  const identity = {};
  claimPortIdentity(identity);
  const issuer = registerSendPortIssuer({}, identity);
  const port = issuer.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.equal(assertTrustedSendPort(port), true);
  issuer.revokeAll();
  assert.equal(assertTrustedSendPort(port), false, 'revokeAll 后必须失效');
  // 撤销后签发器也不能再签发
  assert.throws(() => issuer.issue('0:1:222:333', '333', async () => ({ statusCode: 0 })),
    /send_port_issuer_revoked/);
});

test('P0-1：签出的出口被冻结，无法改写会话或收件人', () => {
  const identity = {};
  claimPortIdentity(identity);
  const issuer = registerSendPortIssuer({}, identity);
  const port = issuer.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.throws(() => { (port as { conversationId: string }).conversationId = '0:1:222:999'; }, TypeError);
  assert.equal(port.conversationId, '0:1:222:333');
});

test('P0-1：Port 通过签发器签出的出口可通过校验，且 stop 后失效', async () => {
  await withPort(async ({ port }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet);
    assert.equal(assertTrustedSendPort(outlet), true);
    await port.stop();
    assert.equal(assertTrustedSendPort(outlet), false);
  });
});
