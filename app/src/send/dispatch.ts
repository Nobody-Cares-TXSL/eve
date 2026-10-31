/**
 * T6-3c：受控发送执行与回执分类（离线）。
 *
 * 契约：docs/contracts/send.md §12。
 * 本模块不 import douyin-im、不创建 SDK 实例、不调用 sendMsg——
 * 发送通道由调用方注入；本阶段只接受 fake，真实首次发送另行授权。
 */
import { createHash } from 'node:crypto';
import type { EveArchive } from '../archive/store.ts';
import { prepareSdkTextDraft, type TextDraftReject } from '../platform/outbound-request.ts';

export interface SendResponseLike {
  readonly statusCode: number;
  readonly statusMsg?: string;
  readonly serverMessageId?: string;
  readonly clientMessageId?: string;
  readonly checkCode?: number;
}

/** 由适配器绑定到「已验证联系人」的发送通道。测试注入 fake。 */
export interface SendTransport {
  sendText(message: string): Promise<SendResponseLike>;
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
    /** 直接来自真实实例的 .blocked；undefined 表示未知，必须拒绝。 */
    readonly blocked: boolean | undefined;
  } | null;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly intentId: string;
  readonly approvedAtMs: number;
  readonly expiresAtMs: number;
}

export type DispatchReject =
  | TextDraftReject
  | 'ledger_unavailable'
  | 'intent_not_pending'
  | 'already_claimed'
  | 'proof_changed'
  | 'approval_missing'
  | 'approval_scope_mismatch'
  | 'approval_expired';

export type DispatchResult =
  | { readonly status: 'sent'; readonly intentId: string; readonly evidence: string }
  | { readonly status: 'failed'; readonly intentId: string; readonly reasonCode: string }
  | { readonly status: 'unknown'; readonly intentId: string; readonly reasonCode: string }
  | { readonly status: 'rejected'; readonly reasonCode: DispatchReject };

export interface DispatchInput {
  readonly intentId: string;
  readonly expected: { readonly ownerUid: string; readonly ownImUid: string; readonly targetUid: string };
  readonly session: DispatchSession;
  readonly transport: SendTransport;
  readonly approval: ApprovalRecord | null;
  readonly nowMs: number;
  readonly coverageMaxAgeMs: number;
  readonly maxTextLength: number;
  readonly timeoutMs: number;
}

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');
const rejected = (reasonCode: DispatchReject): DispatchResult => ({ status: 'rejected', reasonCode });

/**
 * 回执分类：字段存在不等于送达。
 * sent 只代表服务端回执，不代表对方已显示或已读。
 */
export function classifySendResponse(r: SendResponseLike):
  | { readonly status: 'sent'; readonly evidence: string }
  | { readonly status: 'failed'; readonly reasonCode: 'platform_rejected' | 'risk_controlled' }
  | { readonly status: 'unknown'; readonly reasonCode: 'ambiguous_result' } {
  if (!r || !Number.isSafeInteger(r.statusCode)) return { status: 'unknown', reasonCode: 'ambiguous_result' };
  if (r.statusCode !== 0) return { status: 'failed', reasonCode: 'platform_rejected' };
  // 8610：平台风控拦截，未送达
  if (r.checkCode === 8610) return { status: 'failed', reasonCode: 'risk_controlled' };
  const id = r.serverMessageId;
  if (typeof id === 'string' && id.length > 0 && id !== '0') return { status: 'sent', evidence: id };
  return { status: 'unknown', reasonCode: 'ambiguous_result' };
}

export async function dispatchOnce(archive: EveArchive, input: DispatchInput): Promise<DispatchResult> {
  if (!Number.isSafeInteger(input.nowMs) || !Number.isSafeInteger(input.coverageMaxAgeMs) ||
      input.coverageMaxAgeMs < 1 || !Number.isSafeInteger(input.maxTextLength) ||
      input.maxTextLength < 1 || input.maxTextLength > 500 ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 30_000)
    return rejected('invalid_input');

  // 1-2. 账本为准：意图、绑定、T5 claim 全部从数据库读取
  const b = archive.sendDispatchBinding(input.intentId);
  if (!b) return rejected('ledger_unavailable');
  if (b.status !== 'pending' || b.attempt !== 0) return rejected('intent_not_pending');
  if (b.aiClaimId === null || b.notBeforeMs === null || b.text === null || b.expiresAtMs === null)
    return rejected('source_unverified');
  if (b.claimState !== 'recorded' || b.claimDecisionDigest !== b.decisionDigest)
    return rejected('source_unverified');
  if (b.claimProofEpoch === null ||
      archive.coverageEpoch(b.conversationId, input.coverageMaxAgeMs) !== b.claimProofEpoch)
    return rejected('proof_changed');
  if (b.claimReplyLength !== null && b.claimReplyLength !== b.text.length)
    return rejected('source_unverified');

  // 3. L1 审批：作用域与时效
  const a = input.approval;
  if (!a) return rejected('approval_missing');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(a.approvalId) ||
      !Number.isSafeInteger(a.approvedAtMs) || !Number.isSafeInteger(a.expiresAtMs) ||
      a.expiresAtMs <= a.approvedAtMs) return rejected('approval_missing');
  if (a.intentId !== input.intentId) return rejected('approval_scope_mismatch');
  if (input.nowMs < a.approvedAtMs || input.nowMs >= a.expiresAtMs) return rejected('approval_expired');

  // 4. 复用 T6-3b 的纯构造器复核会话/联系人/内容/时间
  const draft = prepareSdkTextDraft({
    intent: {
      intentId: input.intentId, aiClaimId: b.aiClaimId,
      conversationId: b.conversationId, sourceEventId: b.sourceEventId,
      status: b.status, attempt: b.attempt,
      notBeforeMs: b.notBeforeMs, expiresAtMs: b.expiresAtMs,
      textDigest: sha256(b.text), body: b.text,
    },
    expected: input.expected,
    session: input.session,
    contact: input.session.contact ?? {
      kind: 'group', uid: '', accountUid: '', threadId: '', conversationType: 0, blocked: undefined,
    },
    nowMs: input.nowMs,
    maxTextLength: input.maxTextLength,
  });
  if (!draft.ok) return rejected(draft.code);

  // 5. 原子认领
  if (!archive.claimSendIntent(input.intentId, input.nowMs)) return rejected('already_claimed');

  // 6. claim 之后复核，堵住 await 窗口
  const after = archive.sendDispatchBinding(input.intentId);
  if (!after || after.status !== 'dispatching' || after.text !== b.text ||
      after.decisionDigest !== b.decisionDigest || after.eventIds.join(',') !== b.eventIds.join(',')) {
    archive.settleSendIntent(input.intentId, { status: 'failed', reasonCode: 'rejected_before_dispatch' }, input.nowMs);
    return { status: 'failed', intentId: input.intentId, reasonCode: 'rejected_before_dispatch' };
  }

  // 7. 发送（带超时）
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: SendResponseLike;
  try {
    const timed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('dispatch_timeout')), input.timeoutMs);
    });
    response = await Promise.race([input.transport.sendText(draft.draft.message), timed]);
  } catch (e) {
    const reason = e instanceof Error && e.message === 'dispatch_timeout' ? 'timeout' : 'transport_error';
    archive.settleSendIntent(input.intentId, { status: 'unknown', reasonCode: reason }, input.nowMs);
    return { status: 'unknown', intentId: input.intentId, reasonCode: reason };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  // 8. 分类并结算
  const verdict = classifySendResponse(response);
  if (verdict.status === 'sent') {
    archive.settleSendIntent(input.intentId, { status: 'sent', evidence: verdict.evidence }, input.nowMs);
    return { status: 'sent', intentId: input.intentId, evidence: verdict.evidence };
  }
  archive.settleSendIntent(input.intentId, { status: verdict.status, reasonCode: verdict.reasonCode }, input.nowMs);
  return { status: verdict.status, intentId: input.intentId, reasonCode: verdict.reasonCode };
}
