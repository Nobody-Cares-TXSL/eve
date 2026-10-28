/** T1: douyin-im 的只读接入边界。只能在本模块导入 SDK；绝不调用 sendMsg。 */
import { createClient, configureLogger, type Client, type Account, type MessageEvent,
  type Friend, type Stranger, PrivateMessageEvent, StrangerMessageEvent } from 'douyin-im';
import { LocalQrFile } from './qr.ts';
import { normalizeInboundMessage } from './normalize.ts';
import { normalizeHistoryMessage } from './history.ts';
import type { HistoryPage, PlatformPort, PlatformSink, PlatformStatus } from './types.ts';

type Contact = Friend | Stranger;

export interface ReadOnlyOptions {
  readonly dataDir: string;
  /** 登录平台 UID，严禁把可见的抖音号/昵称当作平台 UID。 */
  readonly selfUid: string;
  /** 唯一允许的目标平台 IM UID。 */
  readonly targetUid: string;
  /** 只用于离线测试注入；正式运行不传。 */
  readonly client?: Client;
  readonly notifyQrPath?: (path: string) => void;
  /** 仅由本机交互式验收显式开启；不自动完成挑战。 */
  readonly allowLocalVerification?: boolean;
}

function validUid(uid: string): boolean { return /^\d+$/.test(uid); }

/** 私信线程形如 0:1:uidA:uidB；必须同时属于自己和目标，不能用字符串 includes。 */
export function belongsToTarget(threadId: string, ownUids: ReadonlySet<string>, targetUid: string): boolean {
  const p = threadId.split(':');
  return p.length === 4 && p[0] === '0' && p[1] === '1' &&
    ((ownUids.has(p[2] ?? '') && p[3] === targetUid) ||
     (ownUids.has(p[3] ?? '') && p[2] === targetUid)) && !ownUids.has(targetUid);
}

export class DouyinReadOnlyPort implements PlatformPort {
  private readonly client: Client;
  private readonly qr: LocalQrFile;
  private readonly targetUid: string;
  private readonly selfUid: string;
  private readonly notifyQrPath: (path: string) => void;
  private readonly allowLocalVerification: boolean;
  private sink?: PlatformSink;
  private active: Account | undefined;
  private verified = false;
  private blocked = false;
  private started = false;
  private readonly contacts = new Map<string, Contact>();
  private readonly recentIds = new Set<string>();
  private readonly recentQueue: string[] = [];

  constructor(options: ReadOnlyOptions) {
    if (!validUid(options.selfUid) || !validUid(options.targetUid) ||
        options.selfUid === options.targetUid) throw new Error('必须提供不同的数字平台 selfUid/targetUid');
    this.selfUid = options.selfUid;
    this.targetUid = options.targetUid;
    this.qr = new LocalQrFile(options.dataDir);
    this.notifyQrPath = options.notifyQrPath ?? (() => {});
    this.allowLocalVerification = options.allowLocalVerification === true;
    // SDK 默认 silent；不得允许 SDK 将原始事件或挑战 token 打到日志。
    configureLogger({ level: 'silent', maskSensitive: true, color: false });
    this.client = options.client ?? createClient({ dataDir: options.dataDir, autoLoad: true });
    this.bind();
  }

  subscribe(sink: PlatformSink): void {
    if (this.started || this.sink) throw new Error('必须在 start 前单次订阅');
    this.sink = sink;
  }

  private status(s: PlatformStatus): void { this.sink?.onStatus(s); }

  private identities(account: Account): ReadonlySet<string> {
    return new Set([account.uid, account.imUid].filter((x): x is string => !!x));
  }

  private checkAccount(account: Account, platformUid: string): boolean {
    return this.client.accounts.length === 1 &&
      account === this.client.accounts[0] &&
      platformUid === this.selfUid &&
      account.uid === this.selfUid &&
      !!account.imUid;
  }

  private bind(): void {
    this.client.on('system.online', ({ account, platformUid, screenName }) => {
      if (this.blocked || !this.checkAccount(account, platformUid)) {
        this.blocked = true;
        this.verified = false;
        this.status({ type: 'session_rejected', reason: '登录账号身份不匹配或缺少 IM UID' });
        void this.qr.remove();
        return;
      }
      this.active = account;
      this.verified = true;
      void this.qr.remove();
      this.status({ type: 'online', uid: platformUid, nickname: screenName ?? '' });
    });
    this.client.on('system.login.session', ({ status }) => {
      if (status === 'expired' || status === 'unverified') {
        this.verified = false;
        this.status({ type: 'session_rejected', reason: 'Session 未验证或过期' });
      }
    });
    this.client.on('system.login.qrcode', ({ account, qrcodeBase64 }) => {
      if (this.blocked) return;
      void this.qr.save(qrcodeBase64).then(path => {
        if (this.blocked) return this.qr.remove();
        this.status({ type: 'qr_required', qrPath: path });
        this.notifyQrPath(path);
        // 扫码续接是 SDK 官方登录接口。不要 await 它阻塞事件处理器。
        void account.continueLogin().catch(() => {
          this.status({ type: 'session_rejected', reason: '扫码登录续接失败' });
          void this.qr.remove();
        });
      }).catch(() => {
        this.status({ type: 'session_rejected', reason: '二维码写入失败' });
        void this.qr.remove();
      });
    });
    this.client.on('system.login.qrcode.status', ({ status }) => {
      if (status === 'expired') {
        this.status({ type: 'session_rejected', reason: '二维码已过期' });
        void this.qr.remove();
      }
    });
    this.client.on('system.login.verification', ({ verification }) => {
      this.verified = false;
      this.status({ type: 'verification_required', methods: [...verification.methods] });
      if (!this.allowLocalVerification) {
        verification.cancel('未启用本机人工验证');
        void this.qr.remove();
        return;
      }
      // SDK 自带的回环验证页，仅当操作者显式启用时打开。
      // 页面由 SDK 回调自动处理，人必须自己完成平台挑战；不得输出 token URL。
      void verification.open({ openBrowser: true, timeoutMs: 300_000 }).catch(() => {
        this.status({ type: 'session_rejected', reason: '本地人工安全验证未完成' });
        void this.qr.remove();
      });
    });
    this.client.on('system.login.sms', () => {
      this.verified = false;
      this.status({ type: 'verification_required', methods: ['mobile-sms'] });
    });
    this.client.on('system.login.voice', () => {
      this.verified = false;
      this.status({ type: 'verification_required', methods: ['voice-sms'] });
    });
    this.client.on('system.login.error', () => {
      this.verified = false;
      this.status({ type: 'session_rejected', reason: '登录失败' });
      void this.qr.remove();
    });
    this.client.on('system.reconnecting', ({ account, attempt, delayMs }) => {
      if (account !== this.active) return;
      this.verified = false;
      this.status({ type: 'reconnecting', attempt, delayMs });
    });
    this.client.on('system.offline', ({ account }) => {
      if (account !== this.active) return;
      this.verified = false;
      this.status({ type: 'offline' });
    });
    this.client.on('message', (event) => this.receive(event));
  }

  private receive(event: MessageEvent): void {
    if (!this.verified || this.blocked || !this.active || event.account !== this.active) return;
    if (event.chatType !== 'private' && event.chatType !== 'stranger') return;
    if (event.conversationType !== 1) return;
    const ownUids = this.identities(this.active);
    if (!belongsToTarget(event.threadId, ownUids, this.targetUid)) return;
    // 不读取无关会话的正文；方向与账号均验证通过之后才读取。
    if (event.senderUid !== this.targetUid && !ownUids.has(event.senderUid)) return;
    const normalized = normalizeInboundMessage(event, ownUids);
    if (!normalized.ok) return;
    const id = normalized.message.serverMessageId;
    if (id) {
      const key = normalized.message.conversationId + '\0' + id;
      if (this.recentIds.has(key)) return;
      this.recentIds.add(key);
      this.recentQueue.push(key);
      if (this.recentQueue.length > 2048) {
        const removed = this.recentQueue.shift();
        if (removed) this.recentIds.delete(removed);
      }
    }
    const contact = event instanceof PrivateMessageEvent ? event.friend : event instanceof StrangerMessageEvent ? event.stranger : undefined;
    if (contact && contact.uid === this.targetUid && contact.threadId === event.threadId) {
      this.contacts.set(event.threadId, contact);
    }
    this.sink?.onMessage(normalized.message);
  }

  async start(): Promise<void> {
    if (!this.sink) throw new Error('请先订阅 PlatformSink');
    if (this.started) throw new Error('只读端口已启动');
    if (this.client.accounts.length > 1) throw new Error('拒绝加载多个 SDK 账号');
    this.started = true;
    try {
      await this.client.login();
      if (this.blocked || !this.verified || !this.active) throw new Error('SDK 已登录但身份未通过验证');
    } catch {
      this.verified = false;
      await this.client.logout().catch(() => undefined);
      await this.qr.remove();
      this.started = false;
      throw new Error('只读登录失败或被身份核验拦截（原始错误已脱敏）');
    }
  }

  async stop(): Promise<void> {
    this.verified = false;
    this.started = false;
    this.contacts.clear();
    this.recentIds.clear();
    this.recentQueue.length = 0;
    try {
      await this.client.logout();
    } finally {
      this.active = undefined;
      await this.qr.remove();
    }
  }

  async readHistory(conversationId: string, cursor?: string | null): Promise<HistoryPage> {
    if (!this.started || !this.verified || !this.active) throw new Error('平台未验证上线');
    const ownUids = this.identities(this.active);
    if (!belongsToTarget(conversationId, ownUids, this.targetUid)) throw new Error('拒绝查询非白名单会话');
    const contact = this.contacts.get(conversationId) ??
      [this.active.pickFriend(this.targetUid), this.active.pickStranger(this.targetUid)]
        .find((c): c is Contact => !!c && c.threadId === conversationId);
    if (!contact) throw new Error('目标会话尚未由 SDK 绑定，不允许手工拼接地址');
    const page = await contact.getHistory({ ...(cursor != null ? { cursor } : {}), count: 50, direction: 'older' });
    if (page.statusCode !== 0) throw new Error('历史查询返回非成功状态');
    const messages = page.messages.flatMap(raw => {
      if (raw.threadId !== conversationId || raw.senderUid !== this.targetUid &&
          !ownUids.has(raw.senderUid)) return [];
      const m = normalizeHistoryMessage(raw, ownUids);
      return m ? [m] : [];
    });
    return {
      statusCode: page.statusCode, hasMore: page.hasMore,
      cursor: page.cursor, direction: page.direction, messages,
    };
  }
}
