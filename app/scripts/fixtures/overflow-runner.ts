/**
 * 测试 fixture：在真实子进程中触发队列溢出，用于验证「溢出 → 落盘 paused_env → 退出码 3」
 * 的端到端链路（--mock 模式固定 capacity 32 且不推消息，无法从 CLI 触发）。
 * 用法：node scripts/fixtures/overflow-runner.ts <state-dir>
 */
import { Runner } from '../../src/runtime/runner.ts';
import { parseConfig } from '../../src/runtime/config.ts';
import type { HistoryPage, InboundMessage, PlatformPort, PlatformSink } from '../../src/platform/types.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('缺少 state-dir');
  process.exit(2);
}

const message: InboundMessage = {
  conversationId: '0:1:111:222', serverMessageId: '1', clientMessageId: null,
  senderUid: '222', fromSelf: false, text: 'x', kind: 'text', messageType: 7,
  createTime: '1', indexInConversation: null,
};

class FloodPort implements PlatformPort {
  private sink?: PlatformSink;
  subscribe(sink: PlatformSink): void { this.sink = sink; }
  async start(): Promise<void> {
    // capacity=1：第 1 条被立即取走，第 2 条占住 pending，第 3 条触发溢出
    this.sink?.onMessage(message);
    this.sink?.onMessage(message);
    this.sink?.onMessage(message);
  }
  async stop(): Promise<void> {}
  async readHistory(): Promise<HistoryPage> { throw new Error('T2 不用历史'); }
}

const code = await new Runner(dir, new FloodPort(),
  parseConfig({ version: 1, selfUid: '111', targetUid: '222', queueCapacity: 1, pollMs: 50 })).run();
process.exitCode = code;
