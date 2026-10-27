/**
 * Platform Adapter 端口与 Eve 内部类型（docs/contracts/migration.md §2）。
 *
 * 本文件是 core/ 能看见的**全部**平台面：纯数据 + 接口。
 * 禁止在此 import 'douyin-im' 的运行时值（type-only 也仅限本目录内允许）。
 */

/** 归一化后的入站私信事件。字段全部为 Eve 拥有的类型，SDK 对象不越过 platform/ 边界。 */
export interface InboundMessage {
  /** 会话标识（SDK conversationShortId 字符串化；绝不转 number——超出安全整数范围） */
  readonly conversationId: string;
  /** 服务端消息 ID。缺省时为 null——由归档层走 no_id_mode 兜底（ARCHITECTURE §5.1） */
  readonly serverMessageId: string | null;
  readonly clientMessageId: string | null;
  /** 发送者抖音 UID（字符串，防溢出） */
  readonly senderUid: string;
  /** true = 本账号（AI 小号）自己发出的回显 */
  readonly fromSelf: boolean;
  /** 纯文本正文；非文本消息 text 可为空串，kind 标明来源类型 */
  readonly text: string;
  readonly kind: 'text' | 'non_text';
  /** SDK messageType 原样保留（数字枚举语义未穷举，仅透传不解释） */
  readonly messageType: number;
  /** 毫秒时间戳字符串（透传，不本地化） */
  readonly createTime: string | null;
  /** 会话内序号，仅作顺序线索（TODO T4-2），不做漏数推断 */
  readonly indexInConversation: string | null;
}

/** 登录/会话状态机所需的平台侧事件（T1 消费，T0 仅定义）。 */
export type PlatformStatus =
  | { type: 'online'; uid: string; nickname: string }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'qr_required'; qrPath: string | null }
  | { type: 'verification_required'; methods: readonly string[] }
  | { type: 'session_rejected'; reason: string }
  | { type: 'offline' };

/** core/ 注入 Adapter 的回调：入站消息与状态变化各一个。 */
export interface PlatformSink {
  onMessage(message: InboundMessage): void;
  onStatus(status: PlatformStatus): void;
}

/**
 * PlatformPort —— core/ 所见的全部平台能力（TODO T1-1 端口的 T0 子集）。
 * mock 与真实 SDK 实现同接口，测试由此不需要任何网络。
 */
export interface PlatformPort {
  /** 登录（含 Session 恢复）；resolve 代表上线完成或进入等待人工状态 */
  start(): Promise<void>;
  /** 优雅关闭：等价 SDK logout，Session 落盘（SOURCE_AUDIT §8.4 的教训） */
  stop(): Promise<void>;
  /** 订阅；必须在 start() 前注册，避免早期事件竞态 */
  subscribe(sink: PlatformSink): void;
  /** 只读拉取目标会话历史（T4 对账用）。T0 仅定义，不连接真实平台。 */
  readHistory(conversationId: string, cursor?: string | null): Promise<readonly InboundMessage[]>;
}
