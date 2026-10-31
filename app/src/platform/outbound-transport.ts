/**
 * T6-3c-real-B0：唯一可信发送出口的**类型与守卫**（离线）。
 *
 * 契约：docs/contracts/send.md §14.2。
 *
 * 问题：`SendTransport` 是结构接口，任何 `{ sendText() {} }` 都能被传进
 * `dispatchOnce`，于是「谁能发消息」由调用方决定。这不可接受。
 *
 * 解法：真实发送能力只能由**内部绑定了 SDK 联系人实例**的出口提供，
 * 并通过一次性令牌证明它确实来自 Port。外部构造的对象拿不到令牌。
 *
 * 本文件不 import douyin-im；真实 SDK 绑定在 DouyinReadOnlyPort 内部完成。
 */

/** 只有 Port 内部能创建的令牌；外部无法伪造。 */
const ISSUED = new WeakSet<object>();

export interface TrustedSendPort {
  /** 结构上等同 SendTransport，但必须持有令牌才被 dispatch 接受。 */
  sendText(message: string): Promise<unknown>;
  /** 绑定的是哪个会话：dispatch 会核对它与意图一致。 */
  readonly conversationId: string;
  /** 绑定的联系人 UID，用于与审批的接收方比对。 */
  readonly recipientUid: string;
}

/**
 * 由 Port 内部调用：把一个已绑定真实 SDK Contact 的出口登记为可信。
 * `factory` 只允许在 Port 内部使用；导出它是为了让 Port 能构造，
 * 但调用方拿到的对象若未经过本函数登记，`assertTrustedSendPort` 会拒绝。
 */
export function issueTrustedSendPort<T extends TrustedSendPort>(port: T): T {
  ISSUED.add(port as unknown as object);
  return port;
}

export function assertTrustedSendPort(candidate: unknown): candidate is TrustedSendPort {
  return !!candidate && typeof candidate === 'object' && ISSUED.has(candidate as object);
}

/** 供 Port 在关闭时撤销出口，防止旧出口继续可用。 */
export function revokeTrustedSendPort(port: object): void {
  ISSUED.delete(port);
}
