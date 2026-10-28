/** SDK 的历史结果是 PrivateMessage 而不是 MessageEvent；单独保守解析。 */
import type { InboundMessage } from './types.ts';
import { normalizeInboundMessage } from './normalize.ts';

export interface HistoryMessageLike {
  readonly threadId: string;
  readonly msgId: string;
  readonly senderUid: string;
  readonly content: string;
  readonly msgType: number;
  readonly createTime: number;
  readonly clientMessageId?: string | undefined;
  readonly indexInConversation?: string | undefined;
  readonly indexInConversationV2?: string | undefined;
  readonly conversationType?: number | undefined;
  readonly deleted?: boolean | undefined;
}

/** 只认 SDK 文本 wire 类型 (7) 且确实存在文字的 JSON；不把分享标题当文本。 */
export function normalizeHistoryMessage(
  raw: HistoryMessageLike,
  ownUids: ReadonlySet<string>,
): InboundMessage | null {
  if (raw.deleted || raw.conversationType === 2) return null;
  let text = '';
  let kind = 'unknown';
  if (raw.msgType === 7) {
    try {
      const value: unknown = JSON.parse(raw.content);
      if (typeof value === 'object' && value !== null && 'text' in value &&
          typeof value.text === 'string') {
        text = value.text;
        kind = 'text';
      }
    } catch {
      // JSON 解析不明时不猜测文本身份。
    }
  }
  const result = normalizeInboundMessage({
    threadId: raw.threadId,
    senderUid: raw.senderUid,
    serverMessageId: raw.msgId,
    clientMessageId: raw.clientMessageId,
    text,
    content: { kind },
    messageType: raw.msgType,
    createTime: String(raw.createTime),
    indexInConversation: raw.indexInConversation,
    indexInConversationV2: raw.indexInConversationV2,
  }, ownUids);
  return result.ok ? result.message : null;
}

/** T4-1: retain evidence about discarded rows; never log raw messages. */
export function projectHistoryPage(
  rawMessages: readonly HistoryMessageLike[],
  meta: {
    conversationId: string;
    targetUid: string;
    ownUids: ReadonlySet<string>;
    statusCode: number;
    hasMore: boolean;
    cursor: string;
    direction: 'older' | 'newer';
    requestedCursor: string | null;
    requestedDirection: 'older' | 'newer';
  },
): import('./types.ts').HistoryPage {
  const exclusions = {
    foreignConversation: 0, foreignSender: 0, deleted: 0, unrepresentable: 0,
  };
  const messages: InboundMessage[] = [];
  let missingIdCount = 0;
  for (const raw of rawMessages) {
    if (raw.threadId !== meta.conversationId || raw.conversationType === 2) {
      exclusions.foreignConversation++; continue;
    }
    if (raw.senderUid !== meta.targetUid && !meta.ownUids.has(raw.senderUid)) {
      exclusions.foreignSender++; continue;
    }
    if (raw.deleted) { exclusions.deleted++; continue; }
    const message = normalizeHistoryMessage(raw, meta.ownUids);
    if (message === null) { exclusions.unrepresentable++; continue; }
    if (message.serverMessageId === null) missingIdCount++;
    messages.push(message);
  }
  const excludedCount = Object.values(exclusions).reduce((sum, count) => sum + count, 0);
  return {
    statusCode: meta.statusCode, hasMore: meta.hasMore,
    cursor: meta.cursor, direction: meta.direction,
    requestedCursor: meta.requestedCursor, requestedDirection: meta.requestedDirection,
    rawCount: rawMessages.length, acceptedCount: messages.length,
    excludedCount, exclusions, missingIdCount, messages,
  };
}
