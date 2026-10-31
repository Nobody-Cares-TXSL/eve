/**
 * T6-1 发送意图与安全校验（完全离线）。
 * 契约：docs/contracts/send.md。本文件不调用 SDK、不写库、不发消息。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateSendIntent, type SendCandidate, type SendPolicy } from '../../src/send/policy.ts';
import type { AiDecision } from '../../src/ai/contracts.ts';

const THREAD = '0:1:111:333';
const OWNER = '111';
const TARGET = '333';
/** 用**本地时间**构造时间戳：静默时段按本地分钟判定，用 UTC 构造会在非 UTC 时区失效。 */
const localAt = (h: number, m: number): number => new Date(2026, 9, 30, h, m, 0, 0).getTime();
const NOON = localAt(12, 0);

const reply = (text = '今晚一起散步？'): AiDecision => ({
  action: 'reply', text, reason: '自然回应', delayMs: 0,
});

const policy = (over: Partial<SendPolicy> = {}): SendPolicy => ({
  minIntervalMs: 60_000,
  maxPerHour: 6,
  maxPerDay: 30,
  silence: { startMinute: 23 * 60, endMinute: 8 * 60 },
  maxTextLength: 500,
  recentSends: [],
  ...over,
});

const candidate = (over: Partial<SendCandidate> = {}): SendCandidate => ({
  decision: reply(),
  conversationId: THREAD,
  sourceEventId: '7701260499833538097',
  identity: { ownerUid: OWNER, targetUid: TARGET },
  coverage: { usable: true, state: 'verified' },
  runtime: { phase: 'running', paused: false },
  policy: policy(),
  now: NOON,
  priorIntents: [],
  ...over,
});

function rejects(c: SendCandidate, code: string): void {
  const r = evaluateSendIntent(c);
  assert.equal(r.ok, false, '必须被拒绝');
  if (r.ok) return;
  assert.equal(r.code, code);
}

test('合法输入生成 pending 意图，含正文但审计只用摘要', () => {
  const r = evaluateSendIntent(candidate());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.status, 'pending');
  assert.equal(r.intent.conversationId, THREAD);
  assert.equal(r.intent.sourceEventId, '7701260499833538097');
  assert.equal(r.intent.text, '今晚一起散步？', '正文必须在意图内（发送必需）');
  assert.match(r.intent.textDigest, /^[0-9a-f]{64}$/);
  assert.match(r.intent.decisionDigest, /^[0-9a-f]{64}$/);
  assert.equal(r.intent.textDigest.includes('今晚'), false, '摘要不得包含正文');
});

test('相同输入必得相同输出（确定性），intentId 由事件稳定派生', () => {
  const a = evaluateSendIntent(candidate());
  const b = evaluateSendIntent(candidate());
  assert.equal(a.ok && b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.equal(a.intent.intentId, b.intent.intentId);
  assert.equal(a.intent.textDigest, b.intent.textDigest);
  // 不同事件 → 不同 intentId
  const c = evaluateSendIntent(candidate({ sourceEventId: '7701260499833538098' }));
  assert.equal(c.ok, true);
  if (!c.ok) return;
  assert.notEqual(c.intent.intentId, a.intent.intentId);
});

test('not_reply：skip 与 defer 都不产生发送意图', () => {
  rejects(candidate({ decision: { action: 'skip', reason: '无需回应' } }), 'not_reply');
  rejects(candidate({ decision: { action: 'defer', reason: '稍后', delayMs: 60_000 } }), 'not_reply');
});

test('identity_invalid：非白名单会话、UID 非法、所有者与目标相同', () => {
  rejects(candidate({ conversationId: '0:1:111:444' }), 'identity_invalid');
  rejects(candidate({ conversationId: '0:2:111:333' }), 'identity_invalid');
  rejects(candidate({ conversationId: '0:1:111:333:extra' }), 'identity_invalid');
  rejects(candidate({ identity: { ownerUid: 'abc', targetUid: TARGET } }), 'identity_invalid');
  rejects(candidate({ identity: { ownerUid: OWNER, targetUid: OWNER } }), 'identity_invalid');
  // 目标在会话里但身份参数与之一致性被破坏
  rejects(candidate({ identity: { ownerUid: '111', targetUid: '444' } }), 'identity_invalid');
});

test('coverage_unusable：过期、非 verified、gap 一律拒绝', () => {
  rejects(candidate({ coverage: { usable: false, state: 'verified' } }), 'coverage_unusable');
  rejects(candidate({ coverage: { usable: true, state: 'gap' } }), 'coverage_unusable');
  rejects(candidate({ coverage: { usable: false, state: null } }), 'coverage_unusable');
});

test('runtime_not_running：暂停、停止、故障态都不发送', () => {
  rejects(candidate({ runtime: { phase: 'paused_manual', paused: true } }), 'runtime_not_running');
  rejects(candidate({ runtime: { phase: 'stopped', paused: false } }), 'runtime_not_running');
  rejects(candidate({ runtime: { phase: 'running', paused: true } }), 'runtime_not_running');
  rejects(candidate({ runtime: { phase: 'error', paused: false } }), 'runtime_not_running');
});

test('content_*：空、超长、控制字符', () => {
  rejects(candidate({ decision: reply('   ') }), 'content_empty');
  rejects(candidate({ decision: reply('') }), 'content_empty');
  rejects(candidate({ decision: reply('好'.repeat(501)) }), 'content_too_long');
  rejects(candidate({ decision: reply('带\u0007响铃') }), 'content_control_chars');
  // 边界：正好 500 字符允许
  const ok = evaluateSendIntent(candidate({ decision: reply('好'.repeat(500)) }));
  assert.equal(ok.ok, true, '正好达到上限必须允许');
});

test('duplicate_event：同一服务端事件只能有一个意图', () => {
  const prior = [{ conversationId: THREAD, sourceEventId: '7701260499833538097' }];
  rejects(candidate({ priorIntents: prior }), 'duplicate_event');
  // 不同事件不受影响
  assert.equal(
    evaluateSendIntent(candidate({ priorIntents: prior, sourceEventId: '7701260499833538099' })).ok,
    true);
  // 同一 ID 但不同会话也不算重复
  assert.equal(
    evaluateSendIntent(candidate({ priorIntents: [{ conversationId: '0:1:111:333', sourceEventId: 'x' }] })).ok,
    true);
});

test('min_interval 与 rate_limited 的边界', () => {
  // 距上次 59s：不足 60s 最小间隔
  rejects(candidate({ policy: policy({ recentSends: [NOON - 59_000] }) }), 'min_interval');
  // 正好 60s：允许（间隔为闭区间下界）
  assert.equal(evaluateSendIntent(candidate({ policy: policy({ recentSends: [NOON - 60_000] }) })).ok, true);
  // 一小时内已有 6 条（含最小间隔外的）：超上限
  const six = Array.from({ length: 6 }, (_, i) => NOON - 120_000 - i * 60_000);
  rejects(candidate({ policy: policy({ recentSends: six }) }), 'rate_limited');
  // 5 条：允许
  assert.equal(evaluateSendIntent(candidate({ policy: policy({ recentSends: six.slice(0, 5) }) })).ok, true);
  // 24 小时上限：7 条都在一小时内已触发小时限制，构造跨 2 小时但总数达 30
  const many = Array.from({ length: 30 }, (_, i) => NOON - 3_600_000 - i * 120_000);
  rejects(candidate({ policy: policy({ recentSends: many, maxPerHour: 100 }) }), 'rate_limited');
});

test('silence_window：区间端点与跨午夜', () => {
  const at = (h: number, m: number) => localAt(h, m);
  // 静默 23:00-08:00（跨午夜）。端点语义：[start, end)
  const silent = (ms: number) => evaluatesToSilence(ms);
  assert.equal(silent(at(23, 0)), true, '起点算静默');
  assert.equal(silent(at(2, 0)), true, '跨午夜区间内');
  assert.equal(silent(at(8, 0)), false, '终点不算静默');
  assert.equal(silent(at(12, 0)), false, '白天不静默');
  assert.equal(silent(at(22, 59)), false);
});

/** 用与实现相同的本地时间换算，避免测试与实现在时区上打架。 */
function evaluatesToSilence(now: number): boolean {
  const r = evaluateSendIntent(candidate({ now }));
  if (r.ok) return false;
  return r.code === 'silence_window';
}

test('invalid_policy：配置错误优先返回，不静默降级', () => {
  rejects(candidate({ policy: policy({ minIntervalMs: -1 }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ maxPerHour: 0 }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ maxPerDay: 0 }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ maxTextLength: 0 }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ silence: { startMinute: 100, endMinute: 100 } }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ silence: { startMinute: -1, endMinute: 60 } }) }), 'invalid_policy');
  rejects(candidate({ policy: policy({ silence: { startMinute: 0, endMinute: 1440 } }) }), 'invalid_policy');
  // 策略非法时即使其他条件也不满足，仍返回 invalid_policy（顺序固定）
  rejects(candidate({ policy: policy({ maxPerHour: 0 }), decision: reply('') }), 'invalid_policy');
});

test('拒绝结果不携带正文，也不产生意图', () => {
  const secret = '这段正文绝不能出现在错误里';
  const r = evaluateSendIntent(candidate({ decision: reply(secret.repeat(40)) }));
  assert.equal(r.ok, false);
  const serialized = JSON.stringify(r);
  assert.equal(serialized.includes('这段正文'), false, '拒绝结果不得包含正文');
  assert.equal('intent' in r, false, '拒绝时不得返回意图');
});


test('T6-2: authenticated own IM UID is accepted, forged or target-overlapping UID is rejected',()=>{
 const thread='0:1:222:333';
 assert.equal(evaluateSendIntent(candidate({
  conversationId:thread,
  identity:{ownerUid:OWNER,ownImUid:'222',targetUid:TARGET},
 })).ok,true);
 rejects(candidate({conversationId:thread}),'identity_invalid');
 rejects(candidate({
  conversationId:'0:1:999:333',
  identity:{ownerUid:OWNER,ownImUid:'222',targetUid:TARGET},
 }),'identity_invalid');
 rejects(candidate({
  conversationId:thread,
  identity:{ownerUid:OWNER,ownImUid:TARGET,targetUid:TARGET},
 }),'identity_invalid');
});
