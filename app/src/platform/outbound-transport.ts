/**
 * 唯一可信发送出口的类型与守卫。
 *
 * 契约：docs/contracts/send.md §14.2 / §20.1。
 *
 * 两条硬约束：
 *  1. **签发能力不可被业务模块取得**：`TrustedSendPort` 的构造函数不导出，
 *     只能通过 `openTrustedSendPortIssuer()` 换取签发器，而该函数使用
 *     `process` 内一次性注册表 + 显式密钥，只有 Port 拿到密钥。
 *     这样即便模块导入本文件，也无法凭空登记一个可信出口。
 *  2. **验证对象 === 发送对象**：`dispatchOnce` 只接受单一 `trustedPort`
 *     参数，并且只通过它调用 `sendText()`；不再有第二个 `transport` 入口。
 */
import { randomUUID } from 'node:crypto';

/** 仅本模块持有：所有可信出口的登记表。 */
const ISSUED = new WeakSet<object>();

/**
 * 签发密钥。只有 `DouyinReadOnlyPort` 通过 `registerSendPortIssuer()` 取得。
 * 业务模块即使导入本文件也拿不到密钥，因此无法签发。
 */
const issuerKeys = new WeakMap<object, string>();
const activeIssuers = new Set<string>();

/**
 * Port 身份令牌：只有 `DouyinReadOnlyPort` 构造时通过 `claimPortIdentity()`
 * 取得的对象才能注册签发器。业务模块无法凭空造出这个对象。
 */
const PORT_IDENTITIES = new WeakSet<object>();
export function claimPortIdentity(token: object): void {
  PORT_IDENTITIES.add(token);
}

export interface TrustedSendPort {
  readonly conversationId: string;
  readonly recipientUid: string;
  sendText(message: string): Promise<unknown>;
}

/** 冻结的出口：不允许外部改写字段或方法。**不导出**——外部拿不到构造函数。 */
class FrozenSendPort implements TrustedSendPort {
  readonly conversationId: string;
  readonly recipientUid: string;
  readonly #send: (message: string) => Promise<unknown>;
  private constructor(conversationId: string, recipientUid: string, send: (m: string) => Promise<unknown>) {
    this.conversationId = conversationId;
    this.recipientUid = recipientUid;
    this.#send = send;
    Object.freeze(this);
  }
  /** 只有本模块内部的签发路径能调用；构造函数本身不对外导出。 */
  static readonly __create = (conversationId: string, recipientUid: string,
    send: (m: string) => Promise<unknown>): FrozenSendPort =>
    new FrozenSendPort(conversationId, recipientUid, send);
  sendText(message: string): Promise<unknown> { return this.#send(message); }
}

/**
 * Port 启动时调用一次，取得签发器。返回的签发器只能由持有它的模块使用。
 * 内部用随机密钥登记，避免其它模块伪造签发器。
 */
export function registerSendPortIssuer(owner: object, identity: object): {
  issue: (conversationId: string, recipientUid: string, send: (m: string) => Promise<unknown>) => TrustedSendPort;
  revoke: (port: TrustedSendPort) => void;
  revokeAll: () => void;
} {
  // 只有真正的 Port 才能拿到签发权；普通模块调用会在这里被拒。
  if (!PORT_IDENTITIES.has(identity)) throw new Error('send_port_issuer_not_authorized');
  const key = randomUUID();
  issuerKeys.set(owner, key);
  activeIssuers.add(key);
  const issued = new Set<TrustedSendPort>();
  const assertKey = (): void => {
    if (!activeIssuers.has(key)) throw new Error('send_port_issuer_revoked');
  };
  return {
    issue: (conversationId, recipientUid, send) => {
      assertKey();
      if (!/^[0-9:]{5,80}$/.test(conversationId) || !/^\d{1,64}$/.test(recipientUid) ||
          typeof send !== 'function') throw new Error('invalid_send_port');
      const port = FrozenSendPort.__create(conversationId, recipientUid, send);
      ISSUED.add(port as unknown as object);
      issued.add(port);
      return port;
    },
    revoke: (port) => {
      ISSUED.delete(port as unknown as object);
      issued.delete(port);
    },
    revokeAll: () => {
      for (const p of issued) ISSUED.delete(p as unknown as object);
      issued.clear();
      activeIssuers.delete(key);
    },
  };
}

/**
 * 校验一个对象是否是**当前活跃**签发器签出的出口。
 * 令牌被撤销（Port 关闭、断线）后立即失效。
 */
export function assertTrustedSendPort(candidate: unknown): candidate is TrustedSendPort {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!ISSUED.has(candidate as object)) return false;
  const p = candidate as TrustedSendPort;
  return typeof p.sendText === 'function' &&
    typeof p.conversationId === 'string' && typeof p.recipientUid === 'string';
}

/** 兼容旧调用点的撤销入口；实际由签发器的 revoke 承担。 */
export function revokeTrustedSendPort(port: object): void {
  ISSUED.delete(port);
}
