import { readFile } from 'node:fs/promises';

export interface RuntimeConfig {
  readonly version: 1;
  readonly selfUid: string;
  readonly targetUid: string;
  readonly queueCapacity: number;
  readonly pollMs: number;
  readonly allowLocalVerification: boolean;
}

const fields = new Set(['version','selfUid','targetUid','queueCapacity','pollMs','allowLocalVerification']);
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
  return { version:1, selfUid, targetUid, queueCapacity:Number(queueCapacity), pollMs:Number(pollMs), allowLocalVerification };
}
export async function loadConfig(path: string): Promise<RuntimeConfig> {
  let text: string;
  try { text = await readFile(path,'utf8'); }
  catch { throw new Error('config: 文件不可读取（路径或权限错误）'); }
  try { return parseConfig(JSON.parse(text) as unknown); }
  catch(e) { if (e instanceof SyntaxError) throw new Error('config: JSON 格式错误'); throw e; }
}
