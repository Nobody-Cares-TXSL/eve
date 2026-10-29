import type {AgentTransportCode} from './agent-transport.ts';
export type AiBackendKind = 'model-api' | 'agent-runtime';

export interface AiTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface AiRequest {
  readonly instructions: string;
  readonly turns: readonly AiTurn[];
}

/** Untrusted extension boundary. Backends get no platform SDK, database, or sending capability. */
export interface AiBackend {
  readonly id: string;
  readonly kind: AiBackendKind;
  evaluate(request: AiRequest, signal: AbortSignal): Promise<unknown>;
}

export type AiDecision =
  | { readonly action: 'reply'; readonly text: string; readonly reason: string; readonly delayMs: number }
  | { readonly action: 'skip'; readonly reason: string }
  | { readonly action: 'defer'; readonly reason: string; readonly delayMs: number };

export type DryRunFailure = AgentTransportCode
  | 'coverage_unusable'
  | 'no_pending_event'
  | 'backend_failed'
  | 'backend_timeout'
  | 'invalid_decision'
  | 'coverage_lost_after_inference'
  | 'ledger_unavailable'
  | 'audit_persist_failed'
  | 'ai_budget_hourly'
  | 'ai_budget_daily'
  | 'ai_cooldown';

export type DryRunAudit =
  | { readonly status: 'dry_run'; readonly backendId: string; readonly backendKind: AiBackendKind;
      readonly eventDigest: string; readonly action: AiDecision['action'];
      readonly replyLength: number; readonly decisionDigest: string; readonly elapsedMs: number }
  | { readonly status: 'blocked'; readonly backendId: string; readonly backendKind: AiBackendKind;
      readonly reasonCode: DryRunFailure; readonly elapsedMs: number };
