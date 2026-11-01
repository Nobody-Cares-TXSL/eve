/**
 * 唯一可信发送出口的类型与校验。
 *
 * 契约：docs/contracts/send.md §20 / §21。
 *
 * 本轮修正（操作者指出 P0-1 未真正封住）：
 *   原先导出的 `claimPortIdentity()` 无条件接受任意对象，普通模块只需
 *   `claimPortIdentity({})` + `registerSendPortIssuer()` 就能自签出口。
 *   现在**不再导出任何全局签发函数**：签发能力被封装进 `createOutletRegistry()`
 *   返回的注册表实例，注册表本身即能力凭证，由 `DouyinReadOnlyPort` 私有持有。
 *
 * 诚实边界：单进程 TypeScript 无法防御「业务模块直接 import douyin-im 并拿到
 * Account 后自行 sendMsg」。本机制防的是**误用与越权接线**，真正的隔离靠
 * `platform/` 之外禁止 import SDK 的架构约束。
 */

/** 出口对象：冻结、不可改写。 */
export interface TrustedSendPort {
  readonly conversationId: string;
  readonly recipientUid: string;
  sendText(message: string): Promise<unknown>;
}

export interface OutletRegistry {
  /** 创建一个绑定到具体会话/收件人的出口；只有持有注册表的模块能调用。 */
  issue(conversationId: string, recipientUid: string,
    send: (message: string) => Promise<unknown>): TrustedSendPort;
  /** 校验对象是否由**本注册表**签出且未被撤销。 */
  verify(candidate: unknown): candidate is TrustedSendPort;
  /** 撤销单个出口。 */
  revoke(port: TrustedSendPort): void;
  /** 撤销全部出口并作废注册表本身。 */
  revokeAll(): void;
}

/** 冻结的出口：构造函数私有，实例 Object.freeze，字段不可改写。 */
class FrozenOutlet implements TrustedSendPort {
  readonly conversationId: string;
  readonly recipientUid: string;
  readonly #send: (message: string) => Promise<unknown>;
  constructor(conversationId: string, recipientUid: string, send: (m: string) => Promise<unknown>) {
    this.conversationId = conversationId;
    this.recipientUid = recipientUid;
    this.#send = send;
    Object.freeze(this);
  }
  sendText(message: string): Promise<unknown> { return this.#send(message); }
}

/**
 * 创建注册表。返回的注册表即能力凭证：
 * 谁持有它，谁就能签出被 `registry.verify` 认可的出口。
 *
 * `DouyinReadOnlyPort` 在实例内私有持有；dispatch 只接受由该注册表
 * `verify` 通过的出口。
 */
export function createOutletRegistry(): OutletRegistry {
  const issued = new WeakSet<object>();
  let revoked = false;
  return {
    issue(conversationId, recipientUid, send) {
      if (revoked) throw new Error('outlet_registry_revoked');
      if (!/^[0-9:]{5,80}$/.test(conversationId) || !/^\d{1,64}$/.test(recipientUid) ||
          typeof send !== 'function') throw new Error('invalid_send_outlet');
      const outlet = new FrozenOutlet(conversationId, recipientUid, send);
      issued.add(outlet as unknown as object);
      return outlet;
    },
    verify(candidate: unknown): candidate is TrustedSendPort {
      if (revoked || !candidate || typeof candidate !== 'object') return false;
      if (!issued.has(candidate as object)) return false;
      const p = candidate as TrustedSendPort;
      return typeof p.sendText === 'function' &&
        typeof p.conversationId === 'string' && typeof p.recipientUid === 'string';
    },
    revoke(port) { issued.delete(port as unknown as object); },
    revokeAll() { revoked = true; },
  };
}
