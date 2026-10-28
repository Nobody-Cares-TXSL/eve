/**
 * MockPlatformPort —— 测试替身（docs/contracts/migration.md §2 规则 3 的用武之地）。
 *
 * core/ 与 platform/ 的测试只依赖 PlatformPort 接口；本 mock 让 T0~T1 的测试
 * 完全不触碰网络与 SDK 运行时。真实实现（DouyinPlatformPort）在 T1 提供。
 */
import type { InboundMessage, PlatformPort, PlatformSink, PlatformStatus, HistoryPage } from './types.ts';

export class MockPlatformPort implements PlatformPort {
  private readonly loginIdentity: { uid:string; imUid:string } | undefined;
  constructor(loginIdentity?: { uid:string; imUid:string }) {this.loginIdentity=loginIdentity;}
  readonly delivered: InboundMessage[] = [];
  readonly statuses: PlatformStatus[] = [];
  startCount = 0;
  stopCount = 0;
  /** 测试驱动：置 true 后 readHistory 抛错，用于模拟「SDK 静默失联」——
   *  没有 offline 事件，但对账实际无法成功。 */
  failHistory = false;
  /** 由测试手动投喂（模拟 SDK 推送） */
  private sinks: PlatformSink[] = [];

  subscribe(sink: PlatformSink): void {
    this.sinks.push(sink);
  }

  async start(): Promise<void> {
    this.startCount += 1;
    if(this.loginIdentity)this.pushStatus({type:'online',uid:this.loginIdentity.uid,imUid:this.loginIdentity.imUid,nickname:'mock'});
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  async readHistory(conversationId: string, cursor?: string | null): Promise<HistoryPage> {
    if (this.failHistory) throw new Error('mock_history_unavailable');
    const messages = this.delivered.filter((m) => m.conversationId === conversationId);
    const start = cursor == null ? messages.length : Math.min(Number(cursor), messages.length);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('invalid mock cursor');
    const end = Math.max(0, start - 2);
    const page = messages.slice(end,start);
    return {
      statusCode:0, direction:'older', requestedDirection:'older',
      requestedCursor:cursor??null, cursor:String(end), hasMore:end>0,
      rawCount:page.length,acceptedCount:page.length,excludedCount:0,
      exclusions:{foreignConversation:0,foreignSender:0,deleted:0,unrepresentable:0},
      missingIdCount:page.filter(m=>m.serverMessageId===null).length,messages:page,
    };
  }

  // ── 测试驱动接口 ──
  pushMessage(message: InboundMessage): void {
    this.delivered.push(message);
    for (const sink of this.sinks) sink.onMessage(message);
  }

  pushStatus(status: PlatformStatus): void {
    this.statuses.push(status);
    for (const sink of this.sinks) sink.onStatus(status);
  }
}
