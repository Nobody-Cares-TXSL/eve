/**
 * T6-3c-real-B0：本机交互式 L1 审批。
 *
 * 契约：docs/contracts/send.md §14。
 * 目的：让「批准」成为**一个人在本机终端看到接收方与完整正文后做出的明确动作**，
 * 而不是任何代码路径可以自己调 `createSendApproval()` 生成的记录。
 *
 * 本模块只负责收集确认与登记；它不发送、不认领、不读取 SDK。
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { createHash } from 'node:crypto';
import type { EveArchive } from '../archive/store.ts';

export interface ApprovalPrompt {
  readonly intentId: string;
  readonly recipientUid: string;
  readonly textDigest: string;
  /** 完整待发正文——只在本机终端显示，不写日志、不进返回值。 */
  readonly body: string;
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
}

export type ApprovalOutcome =
  | { readonly status: 'approved'; readonly approvalId: string }
  | { readonly status: 'declined' }
  | { readonly status: 'unavailable'; readonly reason: 'intent_not_pending' | 'digest_mismatch' | 'recipient_mismatch' | 'invalid_ttl' };

/**
 * 供人类阅读的确认文本。刻意把接收方与完整正文放在同一屏，
 * 并要求输入精确短语——防止「随手回车」。
 */
export function formatApprovalPrompt(p: ApprovalPrompt): string {
  const lines = [
    '──────── L1 发送审批 ────────',
    '接收方 UID：' + p.recipientUid,
    '意图 ID：' + p.intentId,
    '正文摘要：' + p.textDigest.slice(0, 16) + '…',
    '',
    '完整待发正文：',
    '┌────────────────────────────',
    ...p.body.split('\n').map(line => '│ ' + line),
    '└────────────────────────────',
    '',
    '最早发送时间：' + new Date(p.notBeforeMs).toISOString(),
    '审批有效期至：' + new Date(p.expiresAtMs).toISOString(),
    '',
    '确认发送请输入 CONFIRM，其它任意输入即取消：',
  ];
  return lines.join('\n');
}

/** 只在交互终端可用；非 TTY 一律拒绝（防止被脚本静默批准）。 */
export function canPromptInteractively(): boolean {
  return output.isTTY === true && input.isTTY === true;
}

export interface ApprovalDeps {
  readonly archive: EveArchive;
  readonly promptText: (text: string) => Promise<string>;
  readonly now: number;
  readonly ttlMs: number;
  readonly approvalId: string;
}

/**
 * 交互式审批。任何一步不满足都返回 declined/unavailable，不产生审批记录。
 *
 * 注意：这里**必须**先读账本确认意图仍 pending 且摘要匹配，
 * 再把正文展示给人；人确认后才调用 createSendApproval。
 */
export async function runInteractiveApproval(
  deps: ApprovalDeps,
  intentId: string,
): Promise<ApprovalOutcome> {
  if (!Number.isSafeInteger(deps.now) || !Number.isSafeInteger(deps.ttlMs) || deps.ttlMs < 1)
    return { status: 'unavailable', reason: 'invalid_ttl' };
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(deps.approvalId))
    return { status: 'unavailable', reason: 'invalid_ttl' };

  const binding = deps.archive.sendDispatchBinding(intentId);
  if (!binding || binding.status !== 'pending' || binding.text === null)
    return { status: 'unavailable', reason: 'intent_not_pending' };

  const prompt: ApprovalPrompt = {
    intentId,
    recipientUid: binding.conversationId.split(':')[3] ?? '',
    textDigest: binding.textDigest,
    body: binding.text,
    notBeforeMs: binding.notBeforeMs ?? deps.now,
    expiresAtMs: deps.now + deps.ttlMs,
  };
  // 精确匹配：不做 trim。带空格/大小写变体都不算确认，防止误触与粘贴。
  const answer = await deps.promptText(formatApprovalPrompt(prompt));
  if (answer !== 'CONFIRM') return { status: 'declined' };

  // 登记前再核对一次：正文/摘要可能在展示期间被改写。
  // 关键：用**当前正文重算的摘要**与账本保存的摘要比对——只比「两次读到的账本值
  // 相同」是不够的，账本被整体改写时那样仍会通过。
  const after = deps.archive.sendDispatchBinding(intentId);
  if (!after || after.text === null) return { status: 'unavailable', reason: 'intent_not_pending' };
  if (after.status !== 'pending') return { status: 'unavailable', reason: 'intent_not_pending' };
  if (after.text !== binding.text ||
      createHash('sha256').update(after.text).digest('hex') !== after.textDigest)
    return { status: 'unavailable', reason: 'digest_mismatch' };

  try {
    deps.archive.createSendApproval({
      approvalId: deps.approvalId,
      intentId,
      recipientUid: prompt.recipientUid,
      textDigest: after.textDigest,
      approvedAtMs: deps.now,
      expiresAtMs: deps.now + deps.ttlMs,
    });
  } catch {
    return { status: 'unavailable', reason: 'recipient_mismatch' };
  }
  return { status: 'approved', approvalId: deps.approvalId };
}

/** 默认实现：真实终端读取。测试注入 promptText。 */
export async function promptOnTerminal(text: string): Promise<string> {
  const rl = createInterface({ input, output });
  try { return await rl.question(text + '\n> '); }
  finally { rl.close(); }
}
