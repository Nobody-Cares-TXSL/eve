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
/**
 * SDK 用 -3 表示「缺 serverMessageId、结果无法确认」（content.js:326），
 * 10502 表示「已提交但可能审核中」，两者都不是确定未发送。
 */
const AMBIGUOUS_STATUS = new Set<number>([-3]);
const AMBIGUOUS_CHECK_CODES = new Set<number>([10502]);
/**
 * 确认属于「平台确定拒绝」的状态码白名单。
 * 目前为空：没有经过实测证据的码不得进入 failed，一律按 unknown 处理。
 * 新增码必须有对应实测证据并更新契约。
 */
const CONFIRMED_REJECTION_CODES = new Set<number>();

export function classifySendResponse(r: SendResponseLike):
  | { readonly status: 'sent'; readonly evidence: string }
  | { readonly status: 'failed'; readonly reasonCode: 'platform_rejected' | 'risk_controlled' }
  | { readonly status: 'unknown'; readonly reasonCode: 'ambiguous_result' } {
  if (!r || !Number.isSafeInteger(r.statusCode)) return { status: 'unknown', reasonCode: 'ambiguous_result' };
  // 8610：SDK 明确「内容安全检查未通过，消息未投递」——确定未发送
  if (r.checkCode === 8610) return { status: 'failed', reasonCode: 'risk_controlled' };
  if (r.checkCode !== undefined && AMBIGUOUS_CHECK_CODES.has(r.checkCode)) {
    return { status: 'unknown', reasonCode: 'ambiguous_result' };
  }
  if (AMBIGUOUS_STATUS.has(r.statusCode)) return { status: 'unknown', reasonCode: 'ambiguous_result' };
  if (r.statusCode === 0) {
    const id = r.serverMessageId;
    if (typeof id === 'string' && id.length > 0 && id !== '0') return { status: 'sent', evidence: id };
    return { status: 'unknown', reasonCode: 'ambiguous_result' };
  }
  if (CONFIRMED_REJECTION_CODES.has(r.statusCode)) return { status: 'failed', reasonCode: 'platform_rejected' };
  // 未经确认的非零码：可能是超时/内部错误/未知状态，不能判为「确定未发送」
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

/** Proof 是否仍是签发该意图时的 epoch（抽成函数以便单测）。 */
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

  // 正文完整性：必须与账本保存的原始摘要比对。
  // 不能用当前正文重算的摘要去喂构造器——那是自证正确。
  if (sha256(b.text) !== b.textDigest) return rejected('content_digest_mismatch');

  // 4. 复用 T6-3b 的纯构造器复核会话/联系人/内容/时间
  const draft = prepareSdkTextDraft({
    intent: {
      intentId: input.intentId, aiClaimId: b.aiClaimId,
      conversationId: b.conversationId, sourceEventId: b.sourceEventId,
      status: b.status, attempt: b.attempt,
      notBeforeMs: b.notBeforeMs, expiresAtMs: b.expiresAtMs,
      textDigest: b.textDigest, body: b.text,
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
      after.textDigest !== b.textDigest ||
      after.decisionDigest !== b.decisionDigest || after.eventIds.join(',') !== b.eventIds.join(',') ||
      !proofStillValid(archive, after.conversationId, input.coverageMaxAgeMs, after.claimProofEpoch)) {
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
    // SDK 会抛出 SendMessageError，其 response 携带真实状态——先受控分类，
    // 只有拿不到结构化响应时才退化为 timeout/transport_error。
    const fromError = responseFromError(e);
    if (fromError) {
      const v = classifySendResponse(fromError);
      if (v.status === 'failed') {
        archive.settleSendIntent(input.intentId, { status: 'failed', reasonCode: v.reasonCode }, input.nowMs);
        return { status: 'failed', intentId: input.intentId, reasonCode: v.reasonCode };
      }
      // 异常路径即使看起来像成功也不能判 sent
      archive.settleSendIntent(input.intentId, { status: 'unknown', reasonCode: 'ambiguous_result' }, input.nowMs);
      return { status: 'unknown', intentId: input.intentId, reasonCode: 'ambiguous_result' };
    }
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
