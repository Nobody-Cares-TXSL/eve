/**
 * T6-L0 Runtime：两阶段自动回复调度。
 *
 * 阶段 1（决策）：AI 只生成**一次** pending 意图，不发送。
 * 阶段 2（派发）：按 `not_before_ms` 到期后再派发该意图——**绝不重新调用 AI**。
 *
 * 契约：docs/contracts/send.md §19 / §23。
 * 本模块不 import douyin-im；发送能力由 Runner 通过 Port 的注册表注入。
 */
import type { EveArchive } from '../archive/store.ts';
import type { AiBackend } from '../ai/contracts.ts';
import { durableDecisionWithSend, type SendHandoffOptions } from '../ai/engine.ts';
import { dispatchOnce, type DispatchResult } from '../send/dispatch.ts';
import type { TrustedSendPort } from '../platform/outbound-transport.ts';
import type { LiveAccountRef, LiveClientRef, LiveContactRef } from '../platform/outbound-session.ts';

export interface AutoReplyIdentity {
  readonly ownerUid: string;
  readonly ownImUid: string;
  readonly targetUid: string;
  readonly conversationId: string;
}

export interface AutoReplyDeps {
  readonly archive: EveArchive;
  readonly backend: AiBackend;
  readonly identity: AutoReplyIdentity;
  readonly live: { client: LiveClientRef; account: LiveAccountRef; contact: LiveContactRef };
  /** 每轮重新取：断线/暂停后 Runner 会撤销旧出口，这里拿到的必须是最新的。 */
  getOutlet: () => TrustedSendPort | null;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly maxBatchEvents: number;
  readonly bodyRetentionMs: number;
  readonly policy: SendHandoffOptions['sendPolicy'];
  readonly coverageMaxAgeMs: number;
  /** 每次 await 之后调用：返回 false 表示运行态已失效（暂停/停止/断线）。 */
  readonly stillAuthorized: () => boolean;
}

export type DecisionOutcome =
  | { readonly kind: 'no_pending_event' }
  | { readonly kind: 'decided_no_intent'; readonly action: string; readonly reasonCode: string }
  | { readonly kind: 'decided_pending'; readonly intentId: string; readonly notBeforeMs: number }
  | { readonly kind: 'blocked'; readonly reasonCode: string };

export type DispatchOutcome =
  | { readonly kind: 'not_due' }
  | { readonly kind: 'expired'; readonly intentId: string }
  | { readonly kind: 'no_pending' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'sent'; readonly intentId: string; readonly evidence: string }
  | { readonly kind: 'failed'; readonly intentId: string; readonly reasonCode: string }
  | { readonly kind: 'unknown'; readonly intentId: string; readonly reasonCode: string }
  | { readonly kind: 'rejected'; readonly reasonCode: string };

/** 阶段 1：只做一次决策，产生（或不产生）pending 意图。不发送。 */
export async function decideOnce(deps: AutoReplyDeps): Promise<DecisionOutcome> {
  if (!deps.stillAuthorized()) return { kind: 'blocked', reasonCode: 'runtime_not_running' };
  const handoff = await durableDecisionWithSend(deps.archive, deps.backend, {
    conversationId: deps.identity.conversationId,
    identity: { ownerUid: deps.identity.ownerUid, targetUid: deps.identity.targetUid,
      ownImUid: deps.identity.ownImUid },
    runtime: { phase: 'running', paused: false },
    maxAgeMs: deps.coverageMaxAgeMs,
    timeoutMs: deps.timeoutMs,
    maxBatchEvents: deps.maxBatchEvents,
    bodyRetentionMs: deps.bodyRetentionMs,
    sendPolicy: deps.policy,
    nowMs: deps.now(),
  });
  // AI 已生成不等于必须发送：await 之后必须重新确认运行态
  if (handoff.status === 'recorded_pending' && !deps.stillAuthorized()) {
    return { kind: 'blocked', reasonCode: 'runtime_lost_after_decision' };
  }
  if (handoff.status === 'blocked') {
    return handoff.reasonCode === 'no_pending_event'
      ? { kind: 'no_pending_event' }
      : { kind: 'blocked', reasonCode: handoff.reasonCode };
  }
  if (handoff.status === 'recorded_no_intent') {
    return { kind: 'decided_no_intent', action: handoff.action, reasonCode: handoff.reasonCode };
  }
  return { kind: 'decided_pending', intentId: handoff.intentId, notBeforeMs: handoff.notBeforeMs };
}

/**
 * 阶段 2：派发一条**已存在**的 pending 意图。
 *
 * 到期前返回 `not_due`，由 Runner 稍后再调；**不重新生成内容**。
 */
export async function dispatchPendingOnce(deps: AutoReplyDeps, intentId: string): Promise<DispatchOutcome> {
  if (!deps.stillAuthorized()) return { kind: 'unauthorized' };
  const binding = deps.archive.sendDispatchBinding(intentId);
  if (!binding) return { kind: 'no_pending' };
  if (binding.status !== 'pending') return { kind: 'no_pending' };
  // 正文过期：安全终结，不发送、不延长保留
  if (binding.expiresAtMs !== null && deps.now() >= binding.expiresAtMs) {
    deps.archive.terminateSendIntent(intentId, 'content_expired', deps.now());
    return { kind: 'expired', intentId };
  }
  if (binding.notBeforeMs !== null && deps.now() < binding.notBeforeMs) return { kind: 'not_due' };

  // 出口必须在派发时重新获取：断线/暂停后 Runner 会撤销旧出口
  const outlet = deps.getOutlet();
  if (!outlet) return { kind: 'unauthorized' };

  const result: DispatchResult = await dispatchOnce(deps.archive, {
    intentId,
    expected: { ownerUid: deps.identity.ownerUid, ownImUid: deps.identity.ownImUid,
      targetUid: deps.identity.targetUid, conversationId: deps.identity.conversationId },
    live: deps.live,
    trustedPort: outlet,
    mode: 'l0_auto',
    nowMs: deps.now(),
    coverageMaxAgeMs: deps.coverageMaxAgeMs,
    maxTextLength: deps.policy.maxTextLength,
    timeoutMs: deps.timeoutMs,
  });
  switch (result.status) {
    case 'sent': return { kind: 'sent', intentId: result.intentId, evidence: result.evidence };
    case 'failed': return { kind: 'failed', intentId: result.intentId, reasonCode: result.reasonCode };
    case 'unknown': return { kind: 'unknown', intentId: result.intentId, reasonCode: result.reasonCode };
    default: {
      // rejected 分两类：
      //  - 证明/身份已失效（proof_changed、contact_unverified、foreign_conversation、
      //    content_digest_mismatch、session 相关）：意图永远不可能再合法发送，
      //    必须安全终结，否则会永久遗留一条 pending。
      //  - 运行态暂时不可用（runtime_not_running 等）：保留 pending 等恢复。
      const terminal = new Set([
        'proof_changed', 'contact_unverified', 'foreign_conversation',
        'content_digest_mismatch', 'approval_missing', 'approval_expired',
        'approval_consumed', 'approval_binding_mismatch', 'ledger_unavailable',
        'content_empty', 'content_too_long', 'content_control_chars',
        'source_unverified', 'intent_not_pending', 'already_claimed',
        'untrusted_transport', 'invalid_input', 'not_due',
      ]);
      if (terminal.has(result.reasonCode)) {
        deps.archive.terminateSendIntent(intentId, 'coverage_lost', deps.now());
        return { kind: 'expired', intentId };
      }
      return { kind: 'rejected', reasonCode: result.reasonCode };
    }
  }
}
