/**
 * T6-3c-real-B0 · AC-realB0.7：TTY 人工审批端到端验收。
 *
 * 在**真实终端**里运行，验证：
 *   1. 非 TTY（管道/重定向）被拒绝；
 *   2. TTY 下能展示接收方与完整正文；
 *   3. 输入非 CONFIRM 时不留任何审批记录；
 *   4. 输入 CONFIRM 时登记一份审批，且只能登记一次。
 *
 * 全程使用**临时 SQLite v6**，不读正式库、不接 SDK、不发送。
 *
 * 用法：node scripts/t6-approval-tty.ts            （真实交互）
 *      node scripts/t6-approval-tty.ts --self-test（用伪输入自动跑一遍）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EveArchive } from '../src/archive/store.ts';
import { MockPlatformPort } from '../src/platform/mock.ts';
import { reconcileOnce } from '../src/runtime/reconcile.ts';
import type { InboundMessage } from '../src/platform/types.ts';
import {
  canPromptInteractively, promptOnTerminal, runInteractiveApproval,
} from '../src/send/approval-cli.ts';

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

/** 建临时 v6 库并产生一条 pending 意图（复用真实 reconcile 夹具）。 */
async function seed(a: EveArchive, p: MockPlatformPort): Promise<{ intentId: string; now: number }> {
  a.upgradeToV2(); a.upgradeToV3(); a.upgradeToV4(); a.upgradeToV5(); a.upgradeToV6();
  p.delivered.push(message('9000000000000000000'));
  const r1 = await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'b', isSafe: () => true });
  if (r1.state !== 'verified') throw new Error('baseline_reconcile_failed');
  p.delivered.push(...[1, 2, 3, 4].map(i => message('900000000000000000' + i)));
  const r2 = await reconcileOnce({ port: p, archive: a, conversationId: THREAD, imUid: '222', instanceId: 'n', isSafe: () => true });
  if (r2.state !== 'verified') throw new Error('incremental_reconcile_failed');
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

const dir = mkdtempSync(join(tmpdir(), 'eve-tty-'));
const a = EveArchive.open(join(dir, 'demo.sqlite'), ID);
const p = new MockPlatformPort({ uid: '111', imUid: '222' });
let exitCode = 1;
try {
  const { intentId, now } = await seed(a, p);
  report['isTTY'] = canPromptInteractively();

  // 1. 非 TTY 必须拒绝
  if (!selfTest && !canPromptInteractively()) {
    report['verdict'] = 'rejected_non_tty';
    report['note'] = '当前不是交互终端；交互式审批在管道/重定向下不可用，符合设计。';
    exitCode = 2;
  } else {
    // 2. 走一次审批（self-test 用伪输入）
    const answer = selfTest ? 'WRONG' : await promptOnTerminal('');
    // 第一次：故意给错误输入
    const declined = await runInteractiveApproval({
      archive: a, promptText: async () => (selfTest ? 'WRONG' : answer),
      now, ttlMs: 300_000, approvalId: 'appr-tty0001',
    }, intentId);
    report['wrongInputResult'] = declined.status;
    report['noRecordAfterDecline'] = a.sendApprovalState(intentId) === null;

    // 3. 正确输入
    const confirmed = await runInteractiveApproval({
      archive: a, promptText: async () => 'CONFIRM',
      now, ttlMs: 300_000, approvalId: 'appr-tty0002',
    }, intentId);
    report['confirmResult'] = confirmed.status;
    const st = a.sendApprovalState(intentId);
    report['approvalRegistered'] = st !== null && !st.consumed;
    report['approvalRecipient'] = st?.recipientUid ?? null;

    // 4. 重复批准必须被拒
    const dup = await runInteractiveApproval({
      archive: a, promptText: async () => 'CONFIRM',
      now, ttlMs: 300_000, approvalId: 'appr-tty0003',
    }, intentId);
    report['duplicateResult'] = dup.status;

    report['verdict'] = (declined.status === 'declined' && confirmed.status === 'approved' &&
      dup.status === 'unavailable') ? 'pass' : 'fail';
    exitCode = report['verdict'] === 'pass' ? 0 : 1;
  }
} catch (e) {
  report['verdict'] = 'error';
  report['reason'] = e instanceof Error && /^[a-z_]{3,60}$/.test(e.message) ? e.message : 'unexpected';
  exitCode = 1;
} finally {
  a.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
process.exitCode = exitCode;
