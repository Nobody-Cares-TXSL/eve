import type {AiDecision} from './contracts.ts';

/** Local authoritative bounds. Claude Schema cannot enforce unsupported ranges. */
export const DECISION_LIMITS = Object.freeze({
 reasonMax:120,
 replyTextMax:500,
 replyDelayMin:0,
 replyDelayMax:600_000,
 deferDelayMin:1000,
 deferDelayMax:86_400_000,
});

export class DecisionContractError extends Error {
  constructor() { super('invalid_decision'); }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysExactly(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    Object.keys(value).every(key => expected.includes(key));
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
}

export function validateDecision(value: unknown): AiDecision {
  if (!object(value) || !boundedText(value['reason'], DECISION_LIMITS.reasonMax)) throw new DecisionContractError();
  const reason = value['reason'].trim();
  switch (value['action']) {
    case 'reply':
      if (!keysExactly(value, ['action', 'text', 'reason', 'delayMs']) ||
        !boundedText(value['text'], DECISION_LIMITS.replyTextMax) ||
        !Number.isSafeInteger(value['delayMs']) ||
        Number(value['delayMs']) < DECISION_LIMITS.replyDelayMin || Number(value['delayMs']) > DECISION_LIMITS.replyDelayMax)
        throw new DecisionContractError();
      return {action: 'reply', text: value['text'].trim(), reason, delayMs: Number(value['delayMs'])};
    case 'skip':
      if (!keysExactly(value, ['action', 'reason'])) throw new DecisionContractError();
      return {action: 'skip', reason};
    case 'defer':
      if (!keysExactly(value, ['action', 'reason', 'delayMs']) ||
        !Number.isSafeInteger(value['delayMs']) ||
        Number(value['delayMs']) < DECISION_LIMITS.deferDelayMin || Number(value['delayMs']) > DECISION_LIMITS.deferDelayMax)
        throw new DecisionContractError();
      return {action: 'defer', reason, delayMs: Number(value['delayMs'])};
    default:
      throw new DecisionContractError();
  }
}
