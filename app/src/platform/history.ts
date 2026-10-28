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
