/**
 * T6 L0 自动回复编排（D-019）。
 *
 * 一条消息的完整链路：
 *   入站事件 → 可信会话校验 → AI 决策（durableDecisionWithSend）
 *   → reply 才产生 pending 意图 → 程序 Gate（dispatchOnce）
 *   → 受控出口发送 → 三态结算
 *
 * 正常路径**没有人工确认**。`l1_review` 只是可选测试模式。
 *
 * 本模块不 import douyin-im：SDK 出口由调用方通过 `TrustedSendPort` 注入，
 * 且必须由 DouyinReadOnlyPort 内部登记过。测试用 fake 出口。
 */
import type { EveArchive } from '../archive/store.ts';
import type { AiBackend } from '../ai/contracts.ts';
import { durableDecisionWithSend, type SendHandoffOptions } from '../ai/engine.ts';
import { dispatchOnce, type DispatchResult, type DispatchSession } from './dispatch.ts';
import type { TrustedSendPort } from '../platform/outbound-transport.ts';
import type { LiveAccountRef, LiveClientRef, LiveContactRef } from '../platform/outbound-session.ts';

export type L0Outcome =
  | { readonly kind: 'no_pending_event' }
  | { readonly kind: 'skipped'; readonly reasonCode: string }
  | { readonly kind: 'deferred'; readonly reasonCode: string }
  | { readonly kind: 'decision_blocked'; readonly reasonCode: string }
  | { readonly kind: 'send_blocked'; readonly reasonCode: string }
  | { readonly kind: 'sent'; readonly intentId: string; readonly evidence: string }
  | { readonly kind: 'failed'; readonly intentId: string; readonly reasonCode: string }
  | { readonly kind: 'unknown'; readonly intentId: string; readonly reasonCode: string };

export interface L0LoopInput {
  readonly archive: EveArchive;
  readonly backend: AiBackend;
  /** 来自真实入站事件的会话与身份，不接受人工拼装。 */
  readonly live: { client: LiveClientRef; account: LiveAccountRef; contact: LiveContactRef };
  readonly expected: SendHandoffOptions['identity'] & { conversationId: string };
  readonly transport: TrustedSendPort;
  readonly handoff: Omit<SendHandoffOptions, 'conversationId' | 'identity'>;
  readonly dispatch: {
    nowMs: number;
    coverageMaxAgeMs: number;
    maxTextLength: number;
    timeoutMs: number;
  };
}

/**
 * 处理一条已通过 T4 门控的待处理事件。
 *
 * 调用方（Runner）负责：单实例锁、Coverage 可用性、运行态为 running、
 * 以及「本事件确实来自白名单会话」的前置判定。
 */
export async function runL0Once(input: L0LoopInput): Promise<L0Outcome> {
  const { archive, backend, live, expected, transport } = input;

  // 1. AI 决策 + 交接：reply 才产生 pending 意图与受限正文
  const handoff = await durableDecisionWithSend(archive, backend, {
    ...input.handoff,
    conversationId: expected.conversationId,
    identity: { ownerUid: expected.ownerUid, targetUid: expected.targetUid, ...(expected.ownImUid === undefined ? {} : { ownImUid: expected.ownImUid }) },
  });

  if (handoff.status === 'blocked') {
    return handoff.reasonCode === 'no_pending_event'
      ? { kind: 'no_pending_event' }
      : { kind: 'decision_blocked', reasonCode: handoff.reasonCode };
  }
  if (handoff.status === 'recorded_no_intent') {
    // skip / defer / 策略拒绝：不发送，是合法结果
    return handoff.action === 'defer'
      ? { kind: 'deferred', reasonCode: handoff.reasonCode }
      : { kind: 'skipped', reasonCode: handoff.reasonCode };
  }

  // 2. 程序 Gate + 受控派发（L0 无人工确认）
  const result: DispatchResult = await dispatchOnce(archive, {
    intentId: handoff.intentId,
    expected: {
      ownerUid: expected.ownerUid,
      ownImUid: expected.ownImUid ?? '',
      targetUid: expected.targetUid,
      conversationId: expected.conversationId,
    },
    live,
    trustedPort: transport,
    mode: 'l0_auto',
    nowMs: input.dispatch.nowMs,
    coverageMaxAgeMs: input.dispatch.coverageMaxAgeMs,
    maxTextLength: input.dispatch.maxTextLength,
    timeoutMs: input.dispatch.timeoutMs,
  });

  switch (result.status) {
    case 'sent': return { kind: 'sent', intentId: result.intentId, evidence: result.evidence };
    case 'failed': return { kind: 'failed', intentId: result.intentId, reasonCode: result.reasonCode };
    case 'unknown': return { kind: 'unknown', intentId: result.intentId, reasonCode: result.reasonCode };
    default: return { kind: 'send_blocked', reasonCode: result.reasonCode };
  }
}

/** 供调用方判断：该会话当前是否允许自动回复（不替代 dispatchOnce 内的复查）。 */
export function sessionEligible(session: DispatchSession | null): boolean {
  if (!session) return false;
  if (!session.verified || !session.online || session.accountCount !== 1) return false;
  const c = session.contact;
  if (!c || (c.kind !== 'friend' && c.kind !== 'stranger')) return false;
  if (c.conversationType !== 1 || c.blocked !== false) return false;
  return true;
}
