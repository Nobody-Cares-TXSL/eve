import { readFile } from 'node:fs/promises';

export interface RuntimeConfig {
  readonly version: 1;
  readonly selfUid: string;
  readonly targetUid: string;
  readonly queueCapacity: number;
  readonly pollMs: number;
  readonly allowLocalVerification: boolean;
  /**
   * L0 自动回复总开关。**默认 false**。
   * 未启用时 Runner 既不触发 AI 决策，也不创建发送意图或发送出口。
   */
  readonly autoReply: AutoReplyConfig;
}

export interface AutoReplyConfig {
  readonly enabled: boolean;
  /** 每条消息至少间隔多久才触发一次 AI（毫秒）。 */
  readonly quietPeriodMs: number;
  /** AI 单次决策超时。 */
  readonly timeoutMs: number;
  /** 单次决策可合并的事件数上限。 */
  readonly maxBatchEvents: number;
  /** 待发正文保留期。 */
  readonly bodyRetentionMs: number;
  /** 发送频率与静默策略。 */
  readonly policy: {
    readonly minIntervalMs: number;
    readonly maxPerHour: number;
    readonly maxPerDay: number;
    readonly maxTextLength: number;
    readonly silence: { readonly startMinute: number; readonly endMinute: number };
  };
}

const fields = new Set(['version','selfUid','targetUid','queueCapacity','pollMs','allowLocalVerification','autoReply']);
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function parseConfig(v: unknown): RuntimeConfig {
  if (!record(v)) throw new Error('config: 必须是 JSON object');
  const unknown = Object.keys(v).filter(k => !fields.has(k));
  if (unknown.length) throw new Error('config: 未知字段 ' + unknown.join(','));
  if (v['version'] !== 1) throw new Error('config.version: 必须为 1');
  const selfUid = v['selfUid'];
  const targetUid = v['targetUid'];
  if (typeof selfUid !== 'string' || !/^\d+$/.test(selfUid)) throw new Error('config.selfUid: 必须是数字字符串');
  if (typeof targetUid !== 'string' || !/^\d+$/.test(targetUid)) throw new Error('config.targetUid: 必须是数字字符串');
  if (selfUid === targetUid) throw new Error('config: selfUid 和 targetUid 不得相同');
  const queueCapacity = v['queueCapacity'] ?? 32;
  const pollMs = v['pollMs'] ?? 150;
  const allowLocalVerification = v['allowLocalVerification'] ?? false;
  if (!Number.isSafeInteger(queueCapacity) || Number(queueCapacity) < 1 || Number(queueCapacity) > 4096)
    throw new Error('config.queueCapacity: 必须在 1~4096');
  if (!Number.isSafeInteger(pollMs) || Number(pollMs) < 50 || Number(pollMs) > 2000)
    throw new Error('config.pollMs: 必须在 50~2000');
  if (typeof allowLocalVerification !== 'boolean') throw new Error('config.allowLocalVerification: 必须是 boolean');
  const autoReply = parseAutoReply(v['autoReply']);
  return { version:1, selfUid, targetUid, queueCapacity:Number(queueCapacity), pollMs:Number(pollMs),
    allowLocalVerification, autoReply };
}

/**
 * autoReply 门控解析。**缺失即视为关闭**（不是错误，也不是默认开启）。
 * 一旦 enabled=true，则必须给出完整合法参数——任何字段非法都拒绝启动，
 * 绝不静默降级。
 */
function parseAutoReply(v: unknown): AutoReplyConfig {
  const off: AutoReplyConfig = {
    enabled: false, quietPeriodMs: 3000, timeoutMs: 20_000, maxBatchEvents: 1,
    bodyRetentionMs: 900_000,
    policy: { minIntervalMs: 60_000, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
      silence: { startMinute: 23 * 60, endMinute: 8 * 60 } },
  };
  if (v === undefined) return off;
  if (!record(v)) throw new Error('config.autoReply: 必须是 JSON object');
  const known = new Set(['enabled','quietPeriodMs','timeoutMs','maxBatchEvents','bodyRetentionMs','policy']);
  const unknown = Object.keys(v).filter(k => !known.has(k));
  if (unknown.length) throw new Error('config.autoReply: 未知字段 ' + unknown.join(','));
  if (typeof v['enabled'] !== 'boolean') throw new Error('config.autoReply.enabled: 必须是 boolean');
  if (v['enabled'] === false) return off;

  const num = (key: string, min: number, max: number): number => {
    const raw = v[key] ?? off[key as keyof AutoReplyConfig];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)
      throw new Error(`config.autoReply.${key}: 必须在 ${min}~${max}`);
    return raw;
  };
  const quietPeriodMs = num('quietPeriodMs', 0, 60_000);
  const timeoutMs = num('timeoutMs', 1, 30_000);
  const maxBatchEvents = num('maxBatchEvents', 1, 3);
  const bodyRetentionMs = num('bodyRetentionMs', 1, 3_600_000);

  const pol = v['policy'] ?? off.policy;
  if (!record(pol)) throw new Error('config.autoReply.policy: 必须是 JSON object');
  const pKnown = new Set(['minIntervalMs','maxPerHour','maxPerDay','maxTextLength','silence']);
  const pUnknown = Object.keys(pol).filter(k => !pKnown.has(k));
  if (pUnknown.length) throw new Error('config.autoReply.policy: 未知字段 ' + pUnknown.join(','));
  const pnum = (key: string, min: number, max: number): number => {
    const raw = pol[key] ?? off.policy[key as keyof AutoReplyConfig['policy']];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)
      throw new Error(`config.autoReply.policy.${key}: 必须在 ${min}~${max}`);
    return raw;
  };
  const minIntervalMs = pnum('minIntervalMs', 0, 3_600_000);
  const maxPerHour = pnum('maxPerHour', 1, 100);
  const maxPerDay = pnum('maxPerDay', 1, 500);
  const maxTextLength = pnum('maxTextLength', 1, 500);
  const sil = pol['silence'] ?? off.policy.silence;
  if (!record(sil)) throw new Error('config.autoReply.policy.silence: 必须是 JSON object');
  const sKnown = new Set(['startMinute','endMinute']);
  const sUnknown = Object.keys(sil).filter(k => !sKnown.has(k));
  if (sUnknown.length) throw new Error('config.autoReply.policy.silence: 未知字段 ' + sUnknown.join(','));
  const minute = (key: 'startMinute' | 'endMinute'): number => {
    const raw = sil[key];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 1439)
      throw new Error(`config.autoReply.policy.silence.${key}: 必须在 0~1439`);
    return raw;
  };
  const startMinute = minute('startMinute');
  const endMinute = minute('endMinute');
  if (startMinute === endMinute) throw new Error('config.autoReply.policy.silence: 起止不得相同');

  return { enabled: true, quietPeriodMs, timeoutMs, maxBatchEvents, bodyRetentionMs,
    policy: { minIntervalMs, maxPerHour, maxPerDay, maxTextLength,
      silence: { startMinute, endMinute } } };
}
export async function loadConfig(path: string): Promise<RuntimeConfig> {
  let text: string;
  try { text = await readFile(path,'utf8'); }
  catch { throw new Error('config: 文件不可读取（路径或权限错误）'); }
  try { return parseConfig(JSON.parse(text) as unknown); }
  catch(e) { if (e instanceof SyntaxError) throw new Error('config: JSON 格式错误'); throw e; }
}
