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
import { installOutletRegistry, __resetInstalledRegistryForTest, verifyAgainstInstalled, type TrustedSendPort } from '../../src/platform/outbound-transport.ts';

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
  // 每个用例独占进程级槽位：先清空，Port 构造时会重新安装
  __resetInstalledRegistryForTest();
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
    assert.equal(port.outletView.verify(outlet), true, '必须由本 Port 注册表认可');
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
    assert.equal(port.outletView.verify(outlet), true);
    await port.stop();
    assert.equal(port.outletView.verify(outlet), false, 'stop 后必须失效');
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

test('P0-1：进程级唯一槽位——只能安装一次，不可替换', () => {
  __resetInstalledRegistryForTest();
  const first = installOutletRegistry();
  // 第二次安装必须失败（fail-closed，绝不静默替换信任根）
  assert.throws(() => installOutletRegistry(), /outlet_registry_already_installed/);
  // 已安装的注册表仍然有效
  const outlet = first.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.equal(verifyAgainstInstalled(outlet), true);
});

test('P0-1：手写同形对象不被认可', () => {
  __resetInstalledRegistryForTest();
  const registry = installOutletRegistry();
  const outlet = registry.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.equal(verifyAgainstInstalled({ conversationId: '0:1:222:333', recipientUid: '333',
    sendText: async () => ({}) }), false);
  assert.equal(verifyAgainstInstalled(null), false);
  assert.equal(verifyAgainstInstalled({}), false);
  assert.equal(verifyAgainstInstalled(outlet), true);
});

test('P0-1：未安装时任何出口都不被认可（fail-closed）', () => {
  __resetInstalledRegistryForTest();
  const fake = { conversationId: '0:1:222:333', recipientUid: '333', sendText: async () => ({}) };
  assert.equal(verifyAgainstInstalled(fake), false, '槽位为空时一律拒绝');
});

test('P0-1：revokeAll 后出口失效且不可再签发', () => {
  __resetInstalledRegistryForTest();
  const registry = installOutletRegistry();
  const outlet = registry.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.equal(registry.verify(outlet), true);
  registry.revokeAll();
  assert.equal(registry.verify(outlet), false);
  assert.throws(() => registry.issue('0:1:222:333', '333', async () => ({ statusCode: 0 })),
    /outlet_registry_revoked/);
  __resetInstalledRegistryForTest();
});

test('P0-1：签出的出口被冻结，无法改写会话或收件人', () => {
  __resetInstalledRegistryForTest();
  const registry = installOutletRegistry();
  const port = registry.issue('0:1:222:333', '333', async () => ({ statusCode: 0 }));
  assert.throws(() => { (port as { conversationId: string }).conversationId = '0:1:222:999'; }, TypeError);
  assert.equal(port.conversationId, '0:1:222:333');
  __resetInstalledRegistryForTest();
});

test('P0-1：Port 签出的出口通过校验，stop 后失效', async () => {
  __resetInstalledRegistryForTest();
  await withPort(async ({ port }) => {
    await port.start();
    const outlet = port.createTrustedSendPort(THREAD);
    assert.ok(outlet);
    assert.equal(port.outletView.verify(outlet), true);
    assert.equal(verifyAgainstInstalled(outlet), true, '进程级槽位也必须认可它');
    await port.stop();
    assert.equal(port.outletView.verify(outlet), false);
  });
});

test('P0-1 复检：导出面不包含任何全局签发入口', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/platform/outbound-transport.ts', import.meta.url), 'utf8');
  for (const banned of ['issueTrustedSendPort', 'claimPortIdentity', 'registerSendPortIssuer',
    'assertTrustedSendPort', 'createOutletRegistry']) {
    assert.doesNotMatch(src, new RegExp('export function ' + banned), banned + ' 不得导出');
  }
  // 测试专用重置函数在生产路径中必须不可达（源码扫描另测）
  assert.match(src, /export function __resetInstalledRegistryForTest/);
});

test('P0-1 复检：攻击者自建注册表 + 自签出口 + 伪造参数 → 真实出口零调用', async () => {
  // 攻击者没有安装权（槽位已被真实 Port 或测试占用），只能自建一个
  __resetInstalledRegistryForTest();
  const realRegistry = installOutletRegistry();   // 模拟真实 Port 抢先安装
  const realOutlet = realRegistry.issue('0:1:222:333', '333', async () => {
    throw new Error('真实出口不应被攻击者触发');
  });
  // 攻击者自建的注册表（无法安装到槽位）
  assert.throws(() => installOutletRegistry(), /outlet_registry_already_installed/);
  // 攻击者伪造一个「看起来合法」的出口
  const forged = { conversationId: '0:1:222:333', recipientUid: '333',
    calls: 0, async sendText() { forged.calls++; return { statusCode: 0, serverMessageId: '1' }; } };
  assert.equal(verifyAgainstInstalled(forged), false, '伪造出口必须被拒绝');
  assert.equal(verifyAgainstInstalled(realOutlet), true, '真实出口仍被认可');
  __resetInstalledRegistryForTest();
});

test('P0-1：platform 之外不得直接调用 SDK 发送接口（静态审查）', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const srcRoot = new URL('../../src/', import.meta.url).pathname;
  const offenders: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full, prefix + name + '/'); continue; }
      if (!name.endsWith('.ts')) continue;
      if (prefix.startsWith('platform/')) continue;
      if (/\bsendMsg\s*\(/.test(readFileSync(full, 'utf8'))) offenders.push(prefix + name);
    }
  };
  walk(srcRoot, '');
  assert.deepEqual(offenders, [], 'platform/ 之外不得出现 sendMsg 调用');
});
