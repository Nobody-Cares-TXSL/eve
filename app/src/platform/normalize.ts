/**
 * SDK 原始事件 → Eve 内部 InboundMessage 的归一化（docs/contracts/migration.md §2 规则 2）。
 *
 * 这是唯一允许「看见」SDK 形状的转换点。输入是**结构化类型**（非 class 实例），
 * 因此测试可传 plain object，不构造任何真实 SDK 对象。
 */
import type { InboundMessage } from './types.ts';

/**
 * SDK MessageEvent 中本模块实际读取的字段子集（结构性，非 nominal）。
 * 显式 `| undefined`：normalize 必须处理「字段存在但为 undefined」的输入，
 * 且这让测试能在 exactOptionalPropertyTypes 下构造缺字段的 raw。
 */
export interface RawMessageLike {
  /** 权威会话键，形如 "0:1:{uidA}:{uidB}"（jumpbyte 私信格式，mappers.ts 确认） */
  readonly threadId?: string | undefined;
  /** 数字短 ID，与 threadId **不同命名空间**（实测两者值不同）；不得用作会话键的替代 */
  readonly conversationShortId?: string | number | undefined;
  /** SDK parsed event.content.kind; absent/unknown must not be classified as text. */
  readonly content?: { readonly kind: string } | undefined;
  readonly serverMessageId?: string | undefined;
  readonly clientMessageId?: string | undefined;
  readonly senderUid?: string | undefined;
  readonly text?: string | undefined;
  readonly messageType?: number | undefined;
  readonly createTime?: string | undefined;
  readonly indexInConversation?: string | undefined;
  readonly indexInConversationV2?: string | undefined;
}

export interface NormalizeError {
  readonly ok: false;
  readonly reason: string;
}

export type NormalizeResult = { readonly ok: true; readonly message: InboundMessage } | NormalizeError;

/**
 * ID 一律按字符串搬运，绝不做数字转换：
 * serverMessageId 实测达 19 位（7701260499833538097），超过 Number.MAX_SAFE_INTEGER，
 * 转 number 会静默丢精度并破坏幂等键。
 */
function asId(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * @param raw      SDK 事件对象的字段快照
 * @param selfUids 本账号（AI 小号）的 UID 集合。SDK 判定"自己发的"同时看 imUid 与 uid
 *                 （src/sdk/events/message.ts:78），单传一个会漏判 fromSelf，故收集合。
 */
export function normalizeInboundMessage(
  raw: RawMessageLike,
  selfUids: ReadonlySet<string>,
): NormalizeResult {
  // 只接受权威 threadId；shortId 属另一命名空间，不可用作业务主键
  const conversationId = asId(raw.threadId);
  if (conversationId === null) {
    return { ok: false, reason: '缺少 threadId，不能用 shortId 冒充会话主键' };
  }

  const senderUid = asId(raw.senderUid);
  if (senderUid === null) {
    return { ok: false, reason: '缺少 senderUid，无法判定消息方向' };
  }

  const text = typeof raw.text === 'string' ? raw.text : '';
  const messageType = typeof raw.messageType === 'number' ? raw.messageType : -1;

  return {
    ok: true,
    message: {
      conversationId,
      // 可选字段：缺省即 null，交由归档层走 no_id_mode 保守兜底（不猜 ID）
      serverMessageId: asId(raw.serverMessageId),
      clientMessageId: asId(raw.clientMessageId),
      senderUid,
      fromSelf: selfUids.has(senderUid),
      text,
      // 文本身份只认 SDK 解析结论（content.kind==='text' 且有正文）；
      // 缺 kind、kind 未知、或仅带标题/描述的富媒体，一律 non_text——
      // 宁可对真实文本沉默，也不让 AI 误回非文本消息（保守方向的不对称性）
      kind: raw.content?.kind === 'text' && text.length > 0 ? 'text' : 'non_text',
      messageType,
      createTime: asId(raw.createTime),
      // 序号只是顺序线索，不做「步长固定」推断（TODO T4-2）
      indexInConversation: asId(raw.indexInConversationV2) ?? asId(raw.indexInConversation),
    },
  };
}
