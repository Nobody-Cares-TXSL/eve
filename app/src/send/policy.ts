/**
 * T6-1：发送意图生成与安全校验（纯函数，完全离线）。
 *
 * 契约：docs/contracts/send.md。
 * 本模块不调用 SDK、不写库、不发消息、不读系统时钟——`now` 由调用方注入。
 * 这样「什么情况下允许发」可以脱离运行时被逐条测透。
 */
import { createHash } from 'node:crypto';
import type { AiDecision } from '../ai/contracts.ts';

export type SendRejectCode =
  | 'invalid_policy'
  | 'identity_invalid'
  | 'coverage_unusable'
  | 'runtime_not_running'
  | 'not_reply'
  | 'content_empty'
  | 'content_too_long'
  | 'content_control_chars'
  | 'duplicate_event'
  | 'min_interval'
  | 'rate_limited'
  | 'silence_window';

export interface SendPolicy {
  readonly minIntervalMs: number;
  readonly maxPerHour: number;
  readonly maxPerDay: number;
  /** 本地分钟数，区间语义 [start, end)；start > end 时跨午夜。 */
  readonly silence: { readonly startMinute: number; readonly endMinute: number };
  readonly maxTextLength: number;
  readonly recentSends: readonly number[];
}

export interface SendCandidate {
  readonly decision: AiDecision;
  readonly conversationId: string;
  readonly sourceEventId: string;
  readonly identity: { readonly ownerUid: string; readonly targetUid: string; readonly ownImUid?: string };
  readonly coverage: { readonly usable: boolean; readonly state: string | null };
  readonly runtime: { readonly phase: string; readonly paused: boolean };
  readonly policy: SendPolicy;
  readonly now: number;
  readonly priorIntents: readonly { readonly conversationId: string; readonly sourceEventId: string }[];
}

export interface SendIntent {
  readonly intentId: string;
  readonly conversationId: string;
  readonly sourceEventId: string;
  /** 正文：发送必需内容，属敏感数据。日志与审计只用 textDigest。 */
  readonly text: string;
  readonly textDigest: string;
  readonly decisionDigest: string;
  readonly status: 'pending';
  readonly createdAt: number;
}

export type SendEvaluation =
  | { readonly ok: true; readonly intent: SendIntent }
  | { readonly ok: false; readonly code: SendRejectCode };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isMinute(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1439;
}

/** 策略是前置条件：配置错误优先于任何业务判断返回，绝不静默降级。 */
function policyValid(p: SendPolicy): boolean {
  return Number.isSafeInteger(p.minIntervalMs) && p.minIntervalMs >= 0 &&
    Number.isSafeInteger(p.maxPerHour) && p.maxPerHour >= 1 &&
    Number.isSafeInteger(p.maxPerDay) && p.maxPerDay >= 1 &&
    Number.isSafeInteger(p.maxTextLength) && p.maxTextLength >= 1 &&
    isMinute(p.silence?.startMinute) && isMinute(p.silence?.endMinute) &&
    p.silence.startMinute !== p.silence.endMinute &&
    Array.isArray(p.recentSends) && p.recentSends.every(t => Number.isFinite(t));
}

/** 会话必须是 owner 与 target 组成的私信线程，不接受其他形式。 */
function identityValid(c: SendCandidate): boolean {
  const { ownerUid, targetUid, ownImUid } = c.identity;
  if (!/^\d+$/.test(ownerUid) || !/^\d+$/.test(targetUid) || ownerUid === targetUid) return false;
  if (ownImUid !== undefined && (!/^\d+$/.test(ownImUid) || ownImUid === targetUid)) return false;
  const parts = c.conversationId.split(':');
  if (parts.length !== 4 || parts[0] !== '0' || parts[1] !== '1') return false;
  const [, , a, b] = parts as [string, string, string, string];
  // The trusted IM UID is authenticated from system.online. Do not infer it
  // from the thread itself, nor permit arbitrary other account UIDs.
  const own = new Set([ownerUid,...(ownImUid === undefined ? [] : [ownImUid])]);
  return (own.has(a) && b === targetUid) || (own.has(b) && a === targetUid);
}

function inSilence(p: SendPolicy, now: number): boolean {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  const { startMinute: start, endMinute: end } = p.silence;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function countWithin(sends: readonly number[], now: number, windowMs: number): number {
  let n = 0;
  for (const t of sends) {
    const age = now - t;
    if (age >= 0 && age < windowMs) n++;
  }
  return n;
}

/**
 * 校验顺序固定（契约 §5.3），保证同一输入稳定返回同一拒绝码：
 * 策略 → 身份 → 证明 → 运行态 → 决策类型 → 内容 → 幂等 → 频率 → 静默
 */
export function evaluateSendIntent(c: SendCandidate): SendEvaluation {
  const { policy: p } = c;
  if (!policyValid(p)) return { ok: false, code: 'invalid_policy' };
  if (!identityValid(c)) return { ok: false, code: 'identity_invalid' };
  if (!c.coverage.usable || c.coverage.state !== 'verified') {
    return { ok: false, code: 'coverage_unusable' };
  }
  if (c.runtime.phase !== 'running' || c.runtime.paused) {
    return { ok: false, code: 'runtime_not_running' };
  }
  if (c.decision.action !== 'reply') return { ok: false, code: 'not_reply' };

  const text = c.decision.text;
  if (text.trim().length === 0) return { ok: false, code: 'content_empty' };
  if (text.length > p.maxTextLength) return { ok: false, code: 'content_too_long' };
  if (CONTROL_CHARS.test(text)) return { ok: false, code: 'content_control_chars' };

  const duplicated = c.priorIntents.some(
    x => x.conversationId === c.conversationId && x.sourceEventId === c.sourceEventId);
  if (duplicated) return { ok: false, code: 'duplicate_event' };

  // 最小间隔优先于频率上限报告，便于定位是「太频繁」还是「额度用尽」
  for (const t of p.recentSends) {
    const age = c.now - t;
    if (age >= 0 && age < p.minIntervalMs) return { ok: false, code: 'min_interval' };
  }
  if (countWithin(p.recentSends, c.now, HOUR_MS) >= p.maxPerHour) {
    return { ok: false, code: 'rate_limited' };
  }
  if (countWithin(p.recentSends, c.now, DAY_MS) >= p.maxPerDay) {
    return { ok: false, code: 'rate_limited' };
  }
  if (inSilence(p, c.now)) return { ok: false, code: 'silence_window' };

  return {
    ok: true,
    intent: {
      intentId: sha256(`${c.conversationId}\u0000${c.sourceEventId}`),
      conversationId: c.conversationId,
      sourceEventId: c.sourceEventId,
      text,
      textDigest: sha256(text),
      decisionDigest: sha256(JSON.stringify(c.decision)),
      status: 'pending',
      createdAt: c.now,
    },
  };
}
