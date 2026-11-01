/**
 * 唯一可信发送出口 —— 进程级信任根。
 *
 * 契约：docs/contracts/send.md §21 / §22。
 *
 * 修复历史：
 *   §20 用 WeakSet + 全局签发函数 → 任何模块都能自签（漏洞）。
 *   §21 改成注册表实例，但 `createOutletRegistry()` 仍公开、Port 还暴露了
 *        带 `issue()` 的完整注册表 → 调用方可「自建证件 + 自建验证器」（漏洞）。
 *   §22（本版）改为**进程级唯一槽位**：
 *        - 全进程只有一个注册表槽位，`installOutletRegistry()` 只能成功一次；
 *        - `dispatchOnce` **不再接受调用方传入的注册表**，只查内部槽位；
 *        - Port 不再对外暴露带签发能力的对象，只暴露只读的 `SendOutletView`。
 *
 * 诚实边界：单进程 TypeScript 无法防御「业务模块直接 import douyin-im、
 * 拿到 Account 后自行 sendMsg」。本机制防的是**误用与越权接线**；
 * 真正的隔离依赖「platform/ 之外禁止 import SDK」+ doctor D10。
 */

/** 出口对象：冻结、不可改写。 */
export interface TrustedSendPort {
  readonly conversationId: string;
  readonly recipientUid: string;
  sendText(message: string): Promise<unknown>;
}

/** 只读视图：外部只能校验，不能签发。Port 对外暴露的就是这个。 */
export interface SendOutletView {
  verify(candidate: unknown): candidate is TrustedSendPort;
}

/** 完整注册表：只在 Port 内部持有，不对外暴露。 */
interface OutletRegistry extends SendOutletView {
  issue(conversationId: string, recipientUid: string,
    send: (message: string) => Promise<unknown>): TrustedSendPort;
  revoke(port: TrustedSendPort): void;
  revokeAll(): void;
}

/** 冻结的出口：构造函数私有，实例 Object.freeze。 */
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
 * 进程级唯一槽位。安装一次后不可替换——这是信任根。
 * 业务模块即便自建注册表，也无法让 dispatch 认可它。
 */
let installedRegistry: OutletRegistry | null = null;

/**
 * 由 `DouyinReadOnlyPort` 在构造时调用，安装本进程的注册表。
 *
 * 只能成功一次：已安装则抛错（fail-closed，绝不静默替换）。
 * 若业务模块抢先安装，真实 Port 会构造失败——系统起不来，而不是错误授权。
 */
export function installOutletRegistry(): OutletRegistry {
  if (installedRegistry !== null) throw new Error('outlet_registry_already_installed');
  const issued = new WeakSet<object>();
  let revoked = false;
  const registry: OutletRegistry = {
    issue(conversationId, recipientUid, send) {
      if (revoked) throw new Error('outlet_registry_revoked');
      if (!/^[0-9:]{5,80}$/.test(conversationId) || !/^\d{1,64}$/.test(recipientUid) ||
          typeof send !== 'function') throw new Error('invalid_send_outlet');
      const outlet = new FrozenOutlet(conversationId, recipientUid, send);
      issued.add(outlet as unknown as object);
      return outlet;
    },
    verify(candidate): candidate is TrustedSendPort {
      if (revoked || !candidate || typeof candidate !== 'object') return false;
      if (!issued.has(candidate as object)) return false;
      const p = candidate as TrustedSendPort;
      return typeof p.sendText === 'function' &&
        typeof p.conversationId === 'string' && typeof p.recipientUid === 'string';
    },
    revoke(port) { issued.delete(port as unknown as object); },
    revokeAll() { revoked = true; },
  };
  installedRegistry = registry;
  return registry;
}

/**
 * 取得进程级注册表：已安装则复用，未安装则安装。
 *
 * 生产环境通常只有一个 Port 实例；测试里会有多个，复用同一个信任根
 * 更贴近真实语义（信任根是**进程**级的，不是实例级的）。
 */
export function acquireOutletRegistry(): { readonly registry: OutletRegistry; readonly owner: boolean } {
  if (installedRegistry !== null) return { registry: installedRegistry, owner: false };
  return { registry: installOutletRegistry(), owner: true };
}

/** 只读视图：Port 用它对外提供校验能力，但不泄露签发。 */
export function viewOf(registry: OutletRegistry): SendOutletView {
  return { verify: (candidate) => registry.verify(candidate) };
}

/**
 * dispatch 的唯一信任来源：进程级已安装的注册表。
 * 调用方无法传入自己的注册表——参数里根本没有这个位置。
 */
export function verifyAgainstInstalled(candidate: unknown): candidate is TrustedSendPort {
  if (installedRegistry === null) return false;
  return installedRegistry.verify(candidate);
}

/** 仅供测试隔离：清空槽位。生产路径不应调用（源码扫描禁止）。 */
export function __resetInstalledRegistryForTest(): void {
  installedRegistry = null;
}
