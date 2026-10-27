/**
 * MockPlatformPort —— 测试替身（docs/contracts/migration.md §2 规则 3 的用武之地）。
 *
 * core/ 与 platform/ 的测试只依赖 PlatformPort 接口；本 mock 让 T0~T1 的测试
 * 完全不触碰网络与 SDK 运行时。真实实现（DouyinPlatformPort）在 T1 提供。
 */
import type { InboundMessage, PlatformPort, PlatformSink, PlatformStatus, HistoryPage } from './types.ts';

export class MockPlatformPort implements PlatformPort {
  readonly delivered: InboundMessage[] = [];
  readonly statuses: PlatformStatus[] = [];
  startCount = 0;
  stopCount = 0;
  /** 由测试手动投喂（模拟 SDK 推送） */
  private sinks: PlatformSink[] = [];

  subscribe(sink: PlatformSink): void {
    this.sinks.push(sink);
  }

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  async readHistory(conversationId: string, cursor?: string | null): Promise<HistoryPage> {
    const messages = this.delivered.filter((m) => m.conversationId === conversationId);
    const start = cursor == null ? messages.length : Math.min(Number(cursor), messages.length);
    if (!Number.isSafeInteger(start) || start < 0) throw new Error('invalid mock cursor');
    const end = Math.max(0, start - 2);
    return { statusCode: 0, direction: 'older', cursor: String(end), hasMore: end > 0, messages: messages.slice(end, start) };
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
