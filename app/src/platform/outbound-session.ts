/**
 * T6-3c-real-A：从**真实 SDK 实例**派生发送会话快照。
 *
 * 契约：docs/contracts/send.md §13。
 * 目的：调用方不能再自行拼一个 session/contact 对象冒充身份。快照只能由
 * 活的 Account/Contact 派生，且发送前必须再核验一次仍然成立。
 *
 * 只使用结构性类型，不 import douyin-im 运行时——因此本模块无法自己发消息。
 */
import type { DispatchSession } from '../send/dispatch.ts';

export interface LiveAccountRef {
  readonly uid: string | undefined;
  readonly imUid: string | undefined;
  readonly online: boolean;
  pickFriend(uid: string): unknown;
  pickStranger(uid: string): unknown;
}
export interface LiveClientRef {
  readonly accounts: readonly unknown[];
}
export interface LiveContactRef {
  readonly account: unknown;
  readonly uid: string;
  readonly threadId: string;
  readonly conversationType: number;
  readonly blocked: boolean | undefined;
}
export interface SessionExpectation {
  readonly ownerUid: string;
  readonly ownImUid: string;
  readonly targetUid: string;
  readonly conversationId: string;
}
export type SessionBindReject =
  | 'invalid_input'
  | 'identity_invalid'
  | 'session_unverified'
  | 'contact_unverified'
  | 'foreign_conversation'
  | 'contact_blocked';

const digits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

/**
 * 线程必须是 ownerUid/ownImUid 与 targetUid 组成的私信地址。
 * 这里只做形状核对；身份真实性由下面的实例比对保证。
 */
function threadMatches(threadId: string, e: SessionExpectation): boolean {
  const p = threadId.split(':');
  if (p.length !== 4 || p[0] !== '0' || p[1] !== '1') return false;
  const [, , a, b] = p as [string, string, string, string];
  const own = new Set([e.ownerUid, e.ownImUid]);
  return (own.has(a) && b === e.targetUid) || (own.has(b) && a === e.targetUid);
}

function bindOnce(
  input: {
    client: LiveClientRef;
    account: LiveAccountRef;
    contact: LiveContactRef;
    expected: SessionExpectation;
  },
): { ok: true; session: DispatchSession } | { ok: false; code: SessionBindReject } {
  const { client, account, contact, expected: e } = input;
  if (!client || !account || !contact || !e) return { ok: false, code: 'invalid_input' };
  if (!digits(e.ownerUid) || !digits(e.ownImUid) || !digits(e.targetUid) ||
      e.ownerUid === e.targetUid || e.ownImUid === e.targetUid)
    return { ok: false, code: 'identity_invalid' };

  // 单账号：多账号时无法确定「本实例属于哪个号」
  if (!Array.isArray(client.accounts) || client.accounts.length !== 1 ||
      client.accounts[0] !== account)
    return { ok: false, code: 'session_unverified' };
  if (account.online !== true || account.uid !== e.ownerUid || account.imUid !== e.ownImUid)
    return { ok: false, code: 'session_unverified' };

  // 联系人必须真的挂在这个账号上（同一对象引用），不能是凭空构造的替身
  if (contact.account !== account) return { ok: false, code: 'contact_unverified' };
  const registered = account.pickFriend(e.targetUid) === contact
    ? 'friend' as const
    : account.pickStranger(e.targetUid) === contact
      ? 'stranger' as const
      : null;
  if (registered === null) return { ok: false, code: 'contact_unverified' };
  if (contact.uid !== e.targetUid) return { ok: false, code: 'contact_unverified' };
  if (contact.conversationType !== 1) return { ok: false, code: 'contact_unverified' };
  if (!threadMatches(contact.threadId, e) || contact.threadId !== e.conversationId)
    return { ok: false, code: 'foreign_conversation' };
  // 直接读真实属性；undefined 表示 SDK 未给出拉黑状态，保守拒绝
  if (contact.blocked !== false) return { ok: false, code: 'contact_blocked' };

  return {
    ok: true,
    session: {
      accountCount: 1,
      uid: e.ownerUid,
      imUid: e.ownImUid,
      verified: true,
      online: true,
      contact: {
        kind: registered,
        uid: contact.uid,
        accountUid: e.ownerUid,
        threadId: contact.threadId,
        conversationType: contact.conversationType,
        blocked: contact.blocked,
      },
    },
  };
}

/** 由真实实例派生快照。任何一步不成立即拒绝，不返回部分结果。 */
export function deriveSendSession(input: Parameters<typeof bindOnce>[0]):
  { ok: true; session: DispatchSession } | { ok: false; code: SessionBindReject } {
  return bindOnce(input);
}

/**
 * 发送前的存活复核：重新从同一批实例派生，并与之前的快照比对。
 *
 * 关键：**必须同时校验对象引用**。字段完全相同的「新实例」不是同一个会话，
 * 只比字段会漏掉「联系人被替换成另一个同 UID 对象」这类漂移。
 */
export function sessionStillLive(
  snapshot: DispatchSession,
  input: Parameters<typeof bindOnce>[0],
  baseline: { account: unknown; contact: unknown },
): boolean {
  // 引用漂移：账号或联系人已不是当初派生快照时的那两个对象
  if (input.account !== baseline.account || input.contact !== baseline.contact) return false;
  const again = bindOnce(input);
  if (!again.ok) return false;
  const a = again.session, b = snapshot;
  return a.uid === b.uid && a.imUid === b.imUid && a.verified === b.verified &&
    a.online === b.online && a.accountCount === b.accountCount &&
    !!a.contact && !!b.contact &&
    a.contact.kind === b.contact.kind && a.contact.uid === b.contact.uid &&
    a.contact.accountUid === b.contact.accountUid &&
    a.contact.threadId === b.contact.threadId &&
    a.contact.conversationType === b.contact.conversationType &&
    a.contact.blocked === b.contact.blocked;
}
