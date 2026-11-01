/**
 * T6-3c-real-A：受控发送执行与回执分类（离线，不真实发送）。
 *
 * 契约：docs/contracts/send.md §12–§13。
 * 不 import douyin-im、不调用 sendMsg：发送通道由调用方注入。
 *
 * 与上一版的实质区别：
 *   1. 会话快照由**活实例**派生（deriveSendSession），调用方不再自带 session；
 *   2. L1 审批必须来自 v6 账本且只能消费一次，不再是随调用传入的对象；
 *   3. `sent` 证据必须是数字字符串形式的 serverMessageId，不接受任意非空串。
 */
import { createHash } from 'node:crypto';
import type { EveArchive } from '../archive/store.ts';
import { prepareSdkTextDraft, type TextDraftReject } from '../platform/outbound-request.ts';
import { assertTrustedSendPort } from '../platform/outbound-transport.ts';
import {
  deriveSendSession, sessionStillLive,
  type LiveAccountRef, type LiveClientRef, type LiveContactRef, type SessionExpectation,
} from '../platform/outbound-session.ts';

export interface SendResponseLike {
  readonly statusCode: number;
  readonly statusMsg?: string;
  readonly serverMessageId?: string;
  readonly clientMessageId?: string;
  readonly checkCode?: number;
}

/**
 * 发送通道。**只有**由 DouyinReadOnlyPort 内部绑定真实 SDK 联系人、
 * 并经过 issueTrustedSendPort 登记的出口才会被 dispatchOnce 接受；
 * 外部构造的任意 { sendText } 对象一律拒绝。
 * 测试可用 issueTrustedSendPort 显式登记 fake（测试即「内部」）。
 */
export interface SendTransport {
  sendText(message: string): Promise<SendResponseLike>;
  readonly conversationId?: string;
  readonly recipientUid?: string;
}

export interface DispatchLiveRefs {
  readonly client: LiveClientRef;
  readonly account: LiveAccountRef;
  readonly contact: LiveContactRef;
}

export interface DispatchSession {
  readonly accountCount: number;
  readonly uid: string;
  readonly imUid: string;
  readonly verified: boolean;
  readonly online: boolean;
  readonly contact: {
    readonly kind: 'friend' | 'stranger' | 'group';
    readonly uid: string;
    readonly accountUid: string;
    readonly threadId: string;
    readonly conversationType: number;
    readonly blocked: boolean | undefined;
  } | null;
}

export type DispatchReject =
  | TextDraftReject
  | 'invalid_input'
  | 'ledger_unavailable'
  | 'intent_not_pending'
  | 'already_claimed'
  | 'proof_changed'
  | 'approval_missing'
  | 'approval_consumed'
  | 'approval_expired'
  | 'approval_binding_mismatch'
  | 'session_changed'
  | 'receipt_unusable'
  | 'untrusted_transport';

export type DispatchResult =
  | { readonly status: 'sent'; readonly intentId: string; readonly evidence: string }
  | { readonly status: 'failed'; readonly intentId: string; readonly reasonCode: string }
  | { readonly status: 'unknown'; readonly intentId: string; readonly reasonCode: string }
  | { readonly status: 'rejected'; readonly reasonCode: DispatchReject };

export interface DispatchInput {
  readonly intentId: string;
  readonly expected: SessionExpectation;
  readonly live: DispatchLiveRefs;
  readonly transport: SendTransport;
  /** 只有持有 Port 令牌的出口才能通过；见 outbound-transport.ts。 */
  readonly trustedPort?: unknown;
  /**
   * 发送模式：
   *   'l0_auto'   —— 正常自动回复（D-019）。不要求审批记录，完全由程序 Gate 决定。
   *   'l1_review' —— 可选人工旁观的测试模式：必须有**真实登记**的审批记录。
   * 任何模式都不允许代码自动调用 createSendApproval 伪造审批。
   */
  readonly mode: 'l0_auto' | 'l1_review';
  /** 仅 l1_review 模式需要；L0 传 undefined。 */
  readonly approvalId?: string | undefined;
  readonly nowMs: number;
  readonly coverageMaxAgeMs: number;
  readonly maxTextLength: number;
  readonly timeoutMs: number;
}

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
const rejected = (reasonCode: DispatchReject): DispatchResult => ({ status: 'rejected', reasonCode });

/** SDK 的 serverMessageId 来自 protobuf Long：数字字符串，无符号、无前导零。 */
const SERVER_ID = /^[1-9][0-9]{0,63}$/;

/**
 * SDK 用 -3 表示「缺 serverMessageId、结果无法确认」（content.js:326），
 * 10502 表示「已提交但可能审核中」，两者都不是确定未发送。
 */
const AMBIGUOUS_STATUS = new Set<number>([-3]);
const AMBIGUOUS_CHECK_CODES = new Set<number>([10502]);
/**
 * 确认属于「平台确定拒绝」的状态码白名单。
 * 当前为空：没有实测证据的码一律按 unknown 处理，不得凭猜测判 failed。
 */
const CONFIRMED_REJECTION_CODES = new Set<number>();

export function classifySendResponse(r: SendResponseLike):
  | { readonly status: 'sent'; readonly evidence: string }
  | { readonly status: 'failed'; readonly reasonCode: 'platform_rejected' | 'risk_controlled' }
  | { readonly status: 'unknown'; readonly reasonCode: 'ambiguous_result' } {
  if (!r || !Number.isSafeInteger(r.statusCode)) return { status: 'unknown', reasonCode: 'ambiguous_result' };
  if (r.checkCode === 8610) return { status: 'failed', reasonCode: 'risk_controlled' };
  if (r.checkCode !== undefined && AMBIGUOUS_CHECK_CODES.has(r.checkCode)) {
    return { status: 'unknown', reasonCode: 'ambiguous_result' };
  }
  if (AMBIGUOUS_STATUS.has(r.statusCode)) return { status: 'unknown', reasonCode: 'ambiguous_result' };
  if (r.statusCode === 0) {
    const id = r.serverMessageId;
    // 只接受形如 protobuf Long 的数字串；任意非空字符串不构成送达证据
    if (typeof id === 'string' && SERVER_ID.test(id)) return { status: 'sent', evidence: id };
    return { status: 'unknown', reasonCode: 'ambiguous_result' };
  }
  if (CONFIRMED_REJECTION_CODES.has(r.statusCode)) return { status: 'failed', reasonCode: 'platform_rejected' };
  return { status: 'unknown', reasonCode: 'ambiguous_result' };
}

/** 从 SDK 抛出的 SendMessageError.response 结构性提取响应，不依赖 SDK 运行时类型。 */
export function responseFromError(e: unknown): SendResponseLike | null {
  if (!e || typeof e !== 'object') return null;
  const raw = (e as { response?: unknown }).response;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(o['statusCode'])) return null;
  const out: { statusCode: number; statusMsg?: string; serverMessageId?: string; clientMessageId?: string; checkCode?: number } =
    { statusCode: o['statusCode'] as number };
  if (typeof o['statusMsg'] === 'string') out.statusMsg = o['statusMsg'];
  if (typeof o['serverMessageId'] === 'string') out.serverMessageId = o['serverMessageId'];
  if (typeof o['clientMessageId'] === 'string') out.clientMessageId = o['clientMessageId'];
  if (Number.isSafeInteger(o['checkCode'])) out.checkCode = o['checkCode'] as number;
  return out;
}

export function proofStillValid(
  archive: EveArchive, conversationId: string, maxAgeMs: number, expectedEpoch: string | null,
): boolean {
  if (expectedEpoch === null) return false;
  try { return archive.coverageEpoch(conversationId, maxAgeMs) === expectedEpoch; }
  catch { return false; }
}

export async function dispatchOnce(archive: EveArchive, input: DispatchInput): Promise<DispatchResult> {
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.coverageMaxAgeMs) ||
      input.coverageMaxAgeMs < 1 || !Number.isSafeInteger(input.maxTextLength) ||
      input.maxTextLength < 1 || input.maxTextLength > 500 ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000 ||
      (input.mode !== 'l0_auto' && input.mode !== 'l1_review') ||
      !input.live || !input.transport || typeof input.transport.sendText !== 'function')
    return rejected('invalid_input');
  if (input.mode === 'l1_review' && !/^[A-Za-z0-9_-]{8,64}$/.test(input.approvalId ?? ''))
    return rejected('invalid_input');
  // 发送能力必须来自 Port 内部绑定的出口，不能由调用方随意构造
  if (!assertTrustedSendPort(input.trustedPort)) return rejected('untrusted_transport');
  const port = input.trustedPort;
  if (port.conversationId !== input.expected.conversationId ||
      port.recipientUid !== input.expected.targetUid)
    return rejected('untrusted_transport');

  // 1. 账本为准
  const b = archive.sendDispatchBinding(input.intentId);
  if (!b) return rejected('ledger_unavailable');
  if (b.status !== 'pending' || b.attempt !== 0) return rejected('intent_not_pending');
  if (b.aiClaimId === null || b.notBeforeMs === null || b.text === null || b.expiresAtMs === null)
    return rejected('source_unverified');
  if (b.claimState !== 'recorded' || b.claimDecisionDigest !== b.decisionDigest)
    return rejected('source_unverified');
  // 正文必须与账本保存的原始摘要一致（不能自证）
  if (sha256(b.text) !== b.textDigest) return rejected('content_digest_mismatch');
  if (b.claimReplyLength !== null && b.claimReplyLength !== b.text.length)
    return rejected('source_unverified');
  if (!proofStillValid(archive, b.conversationId, input.coverageMaxAgeMs, b.claimProofEpoch))
    return rejected('proof_changed');

  // 2. 会话快照只能由活实例派生
  const refs = { client: input.live.client, account: input.live.account,
    contact: input.live.contact, expected: input.expected };
  const derived = deriveSendSession(refs);
  if (!derived.ok) return rejected(derived.code);
  if (b.conversationId !== input.expected.conversationId) return rejected('foreign_conversation');

  // 3. L1 审批必须来自 v6 账本，且绑定意图/收件人/正文摘要
  // 审批仅在 l1_review 模式下是必要条件；L0 不要求审批记录。
  // 若账本里恰好存在审批记录（例如之前跑过 L1），L0 仍然不消费它，
  // 以免把「有人批准过」误当成发送前提。
  if (input.mode === 'l1_review') {
    let approval;
    try { approval = archive.sendApprovalState(input.intentId); }
    catch { return rejected('approval_missing'); }
    if (!approval) return rejected('approval_missing');
    if (approval.approvalId !== input.approvalId) return rejected('approval_binding_mismatch');
    if (approval.textDigest !== b.textDigest || approval.recipientUid !== input.expected.targetUid)
      return rejected('approval_binding_mismatch');
    if (approval.consumed) return rejected('approval_consumed');
    if (input.nowMs < approval.approvedAtMs || input.nowMs >= approval.expiresAtMs)
      return rejected('approval_expired');
  }

  // 4. T6-3b 构造器复核
  const draft = prepareSdkTextDraft({
    intent: {
      intentId: input.intentId, aiClaimId: b.aiClaimId,
      conversationId: b.conversationId, sourceEventId: b.sourceEventId,
      status: b.status, attempt: b.attempt,
      notBeforeMs: b.notBeforeMs, expiresAtMs: b.expiresAtMs,
      textDigest: b.textDigest, body: b.text,
    },
    expected: { ownerUid: input.expected.ownerUid, ownImUid: input.expected.ownImUid, targetUid: input.expected.targetUid },
    session: derived.session,
    contact: derived.session.contact ?? {
      kind: 'group', uid: '', accountUid: '', threadId: '', conversationType: 0, blocked: undefined,
    },
    nowMs: input.nowMs,
    maxTextLength: input.maxTextLength,
  });
  if (!draft.ok) return rejected(draft.code);
  if (draft.draft.recipientUid !== input.expected.targetUid) return rejected('contact_unverified');

  // 5. 原子认领
  if (!archive.claimSendIntent(input.intentId, input.nowMs)) return rejected('already_claimed');

  // 6. l1_review 才消费审批（条件更新保证只能成功一次）；L0 无审批可消费
  if (input.mode === 'l1_review') {
    const state = archive.sendApprovalState(input.intentId);
    const consumed = archive.consumeSendApproval({
      approvalId: input.approvalId!, intentId: input.intentId,
      recipientUid: input.expected.targetUid, textDigest: b.textDigest, nowMs: input.nowMs,
    });
    if (!consumed || !state) {
      archive.settleSendIntent(input.intentId, { status: 'failed', reasonCode: 'rejected_before_dispatch' }, input.nowMs);
      return { status: 'failed', intentId: input.intentId, reasonCode: 'rejected_before_dispatch' };
    }
  }

  // 7. 发送前最后一次复核：绑定、正文、事件、Proof、实例存活
  const after = archive.sendDispatchBinding(input.intentId);
  if (!after || after.status !== 'dispatching' || after.text !== b.text ||
      after.textDigest !== b.textDigest || after.decisionDigest !== b.decisionDigest ||
      after.eventIds.join(',') !== b.eventIds.join(',') ||
      !proofStillValid(archive, after.conversationId, input.coverageMaxAgeMs, after.claimProofEpoch) ||
      !sessionStillLive(derived.session, refs, { account: input.live.account, contact: input.live.contact })) {
    archive.settleSendIntent(input.intentId, { status: 'failed', reasonCode: 'identity_changed' }, input.nowMs);
    return { status: 'failed', intentId: input.intentId, reasonCode: 'identity_changed' };
  }

  // 8. 发送（带超时）
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: SendResponseLike;
  try {
    const timed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('dispatch_timeout')), input.timeoutMs);
    });
    response = await Promise.race([input.transport.sendText(draft.draft.message), timed]);
  } catch (e) {
    const fromError = responseFromError(e);
    if (fromError) {
      const v = classifySendResponse(fromError);
      if (v.status === 'failed') {
        archive.settleSendIntent(input.intentId, { status: 'failed', reasonCode: v.reasonCode }, input.nowMs);
        return { status: 'failed', intentId: input.intentId, reasonCode: v.reasonCode };
      }
      archive.settleSendIntent(input.intentId, { status: 'unknown', reasonCode: 'ambiguous_result' }, input.nowMs);
      return { status: 'unknown', intentId: input.intentId, reasonCode: 'ambiguous_result' };
    }
    const reason = e instanceof Error && e.message === 'dispatch_timeout' ? 'timeout' : 'transport_error';
    archive.settleSendIntent(input.intentId, { status: 'unknown', reasonCode: reason }, input.nowMs);
    return { status: 'unknown', intentId: input.intentId, reasonCode: reason };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // 9. 分类并结算
  const verdict = classifySendResponse(response);
  if (verdict.status === 'sent') {
    archive.settleSendIntent(input.intentId, { status: 'sent', evidence: verdict.evidence }, input.nowMs);
    return { status: 'sent', intentId: input.intentId, evidence: verdict.evidence };
  }
  archive.settleSendIntent(input.intentId, { status: verdict.status, reasonCode: verdict.reasonCode }, input.nowMs);
  return { status: verdict.status, intentId: input.intentId, reasonCode: verdict.reasonCode };
}
