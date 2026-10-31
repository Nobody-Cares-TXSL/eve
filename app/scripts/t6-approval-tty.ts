/**
 * T6-3c-real-B0 · AC-realB0.7：TTY 人工审批端到端验收。
 *
 * 在**真实终端**里运行，验证人能看到接收方与完整正文、并做出明确确认。
 *
 * 行为：
 *   1. 先展示审批信息（接收方 + 完整正文 + 时间窗），再读一次输入；
 *   2. 输入非精确 CONFIRM → declined，且不留任何审批记录；
 *   3. 输入 CONFIRM → 登记审批；重复批准被拒；
 *   4. 非 TTY（管道/重定向）→ 直接拒绝，不进入交互。
 *
 * 全程使用**临时 SQLite v6**，不读正式库、不接 SDK、不发送。
 *
 * 用法：node scripts/t6-approval-tty.ts            （真实交互，跑两次）
 *      node scripts/t6-approval-tty.ts --self-test（用伪输入自动跑一遍）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { EveArchive } from '../src/archive/store.ts';
import { MockPlatformPort } from '../src/platform/mock.ts';
import { reconcileOnce } from '../src/runtime/reconcile.ts';
import type { InboundMessage } from '../src/platform/types.ts';
import { canPromptInteractively, formatApprovalPrompt, runInteractiveApproval } from '../src/send/approval-cli.ts';

const ID = { ownerUid: '111', targetUid: '333', ownUids: ['111', '222'] };
const THREAD = '0:1:222:333';
const TEXT = '这是一条只供 TTY 验收的虚构回复，不会真的发送。';
const selfTest = process.argv.includes('--self-test');

const message = (id: string): InboundMessage => ({
  conversationId: THREAD, serverMessageId: id, clientMessageId: null, senderUid: '333',
  fromSelf: false, text: '虚构消息', kind: 'text', messageType: 7,
  createTime: String(Date.now() - 2000 + Number(BigInt(id) % 10n)),
  indexInConversation: String(BigInt(id) % 10n),
});

const report: Record<string, unknown> = { mode: selfTest ? 'self_test' : 'interactive' };

async function seed(a: EveArchive, p: MockPlatformPort): Promise<{ intentId: string; now: number }> {
  a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5(); a.upgradeToV6();
  p.delivered.push(message('9000000000000000000'));
  if ((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'b', isSafe: () => true })).state !== 'verified')
    throw new Error('baseline_reconcile_failed');
  p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
  if ((await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'n', isSafe: () => true })).state !== 'verified')
    throw new Error('incremental_reconcile_failed');
  const reservation = a.claimAiDryRun({ conversationId: THREAD, maxAgeMs: 90_000, backendId: 'fake', backendKind: 'agent-runtime' });
  if (!reservation) throw new Error('claim_failed');
  const now = Date.now();
  const minute = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const silenceStart = (minute + 180) % 1440;
  const fin = a.finalizeAiWithSend({
    claimId: reservation.claimId,
    decision: { action: 'reply', text: TEXT, reason: 'TTY 验收', delayMs: 0 },
    identity: { ownerUid: '111', targetUid: '333', ownImUid: '222' },
    runtime: { phase: 'running', paused: false },
    policy: { minIntervalMs: 0, maxPerHour: 6, maxPerDay: 30, maxTextLength: 500,
      silence: { startMinute: silenceStart, endMinute: (silenceStart + 60) % 1440 } },
    now, coverageMaxAgeMs: 90_000, bodyRetentionMs: 900_000,
  });
  if (fin.status !== 'recorded_pending') throw new Error('finalize_failed:' + fin.status);
  return { intentId: fin.intentId, now };
}

/** 交互式读取：先打印完整审批信息，再读一行。 */
async function askOnce(promptBody: string): Promise<string> {
  stdout.write(promptBody + '\n');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return await rl.question('> '); }
  finally { rl.close(); }
}

const dir = mkdtempSync(join(tmpdir(), 'eve-tty-'));
const a = EveArchive.open(join(dir, 'demo.sqlite'), ID);
const p = new MockPlatformPort({ uid: '111', imUid: '222' });
let exitCode = 1;
try {
  const { intentId, now } = await seed(a, p);
  report['isTTY'] = canPromptInteractively();

  if (!selfTest && !canPromptInteractively()) {
    report['verdict'] = 'rejected_non_tty';
    report['note'] = '非交互终端：审批不可用（设计如此）。请在真实终端里直接运行。';
    exitCode = 2;
  } else {
    const ttl = 300_000;
    const binding = a.sendDispatchBinding(intentId);
    if (!binding || binding.text === null) throw new Error('binding_missing');
    const view = formatApprovalPrompt({
      intentId, recipientUid: THREAD.split(':')[3] ?? '',
      textDigest: binding.textDigest, body: binding.text,
      notBeforeMs: binding.notBeforeMs ?? now, expiresAtMs: now + ttl,
    });

    // 第 1 轮：展示完整信息后读一次输入。故意先给错误答案以验证「拒绝且零记录」。
    const firstAnswer = selfTest ? 'not confirm' : await askOnce(view);
    const declined = await runInteractiveApproval({
      archive: a, promptText: async () => firstAnswer,
      now, ttlMs: ttl, approvalId: 'appr-tty0001',
    }, intentId);
    report['firstAnswer'] = firstAnswer === 'CONFIRM' ? 'CONFIRM' : 'other';
    report['declinedResult'] = declined.status;
    report['noRecordAfterDecline'] = a.sendApprovalState(intentId) === null;

    // 第 2 轮：再展示一次并确认。真实终端里需要人再输一次 CONFIRM。
    const secondAnswer = selfTest ? 'CONFIRM' : await askOnce(view);
    const confirmed = await runInteractiveApproval({
      archive: a, promptText: async () => secondAnswer,
      now, ttlMs: ttl, approvalId: 'appr-tty0002',
    }, intentId);
    report['confirmResult'] = confirmed.status;
    const st = a.sendApprovalState(intentId);
    report['approvalRegistered'] = st !== null && !st.consumed;
    report['approvalRecipient'] = st?.recipientUid ?? null;

    // 第 3 轮：重复批准必须被拒（无需再问人）
    const dup = await runInteractiveApproval({
      archive: a, promptText: async () => 'CONFIRM',
      now, ttlMs: ttl, approvalId: 'appr-tty0003',
    }, intentId);
    report['duplicateResult'] = dup.status;

    const pass = declined.status === 'declined' && confirmed.status === 'approved' && dup.status === 'unavailable';
    report['verdict'] = pass ? 'pass' : 'fail';
    exitCode = pass ? 0 : 1;
  }
} catch (e) {
  report['verdict'] = 'error';
  report['reason'] = e instanceof Error && /^[a-z_]{3,60}$/.test(e.message) ? e.message : 'unexpected';
  exitCode = 1;
} finally {
  a.close();
  rmSync(dir, { recursive: true, force: true });
  console.log('\n' + JSON.stringify(report, null, 2));
}
process.exitCode = exitCode;
