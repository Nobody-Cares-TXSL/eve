/**
 * T4 断线注入诊断工具（**不构成有效断线证明**）。
 *
 * 结论先行：`ss -K` 无法可靠模拟 SDK 的网络断线。
 * 实测（2026-10-29）：关闭本进程 6 个真实抖音 443 连接后，SDK 在 90 秒内
 * 未发出任何 offline/reconnecting 事件，且仍保有其他连接继续工作。
 * 因此本脚本**只用于诊断**，其输出不得作为「真实网络断线 Gate 通过」的证据。
 *
 * 它能提供的信息：
 *   - 本进程有哪些到抖音的 TCP 连接（数量级）；
 *   - 断开部分连接后 SDK 是否产生状态事件（目前：否）；
 *   - DB 的 sync_state 是否变化（目前：否）。
 *
 * 真正的断线保护由**证明有效期门控**承担（见 Runner.COVERAGE_MAX_AGE_MS 与
 * archive.coverageStatus）：即使 SDK 从不报告断线，过期证明也不可用。
 *
 * 全程不调用 sendMsg、不调用 AI、不改远端已读状态。
 * 用法：EVE_T4_RECONNECT=1 node scripts/t4-live-reconnect.ts
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/runtime/config.ts';
import { DouyinReadOnlyPort } from '../src/platform/douyin.ts';

if (process.env['EVE_T4_RECONNECT'] !== '1') {
  console.error('reconnect_probe_disabled');
  process.exit(2);
}

const app = process.cwd();
const dbFile = join(app, 'data', 'eve.sqlite');
const config = await loadConfig(join(app, 'data', 'config.json'));
if (!existsSync(dbFile)) { console.error('production_archive_missing'); process.exit(2); }

/** 只读快照：只取状态与计数，不输出正文或 UID。 */
function snapshot(): { version: number; messages: number; state: string | null; hasAnchor: boolean } {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const messages = (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n;
    const row = db.prepare('SELECT sync_state,verified_anchor_id FROM conversations').get() as
      { sync_state: string; verified_anchor_id: string | null } | undefined;
    return { version, messages, state: row?.sync_state ?? null, hasAnchor: row?.verified_anchor_id != null };
  } finally { db.close(); }
}

/** 本进程到抖音的已建立 TCP 连接数（不含对端地址，避免日志泄露网络细节）。 */
function establishedCount(pid: number): number {
  const out = spawnSync('ss', ['-tanp'], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(l => l.includes('ESTAB') && l.includes(`pid=${pid},`)).length;
}

const stateDir = join(app, '.t4-reconnect-state');
const port = new DouyinReadOnlyPort({
  dataDir: resolve(app, 'data'), selfUid: config.selfUid, targetUid: config.targetUid,
  allowLocalVerification: false, notifyQrPath: () => undefined,
});
const events: string[] = [];
port.subscribe({
  onMessage: () => undefined,
  onStatus: s => { events.push(s.type); },
});

const report: Record<string, unknown> = { mode: 'diagnostic_only', verdict: 'not_a_valid_disconnect_proof' };
let exitCode = 0;
try {
  await port.start();
  await delay(3000);
  report['establishedBefore'] = establishedCount(process.pid);
  report['dbBefore'] = snapshot();
  report['eventsBefore'] = [...events];

  // 只关闭**本进程**的连接；ss -K dst 会按对端匹配所有进程，
  // 这里先取本进程的对端地址，再限定目标——但仍无法排除同对端的其他进程，
  // 因此本步骤只在测试机、且操作者知情时使用。
  const listing = spawnSync('ss', ['-tanp'], { encoding: 'utf8' }).stdout;
  const peers = listing.split('\n')
    .filter(l => l.includes('ESTAB') && l.includes(`pid=${process.pid},`))
    .map(l => l.trim().split(/\s+/)[4] ?? '')
    .filter(Boolean);
  for (const peer of peers) spawnSync('ss', ['-K', '-tan', 'dst', peer], { encoding: 'utf8' });
  report['establishedAfterKill'] = establishedCount(process.pid);

  await delay(20000);
  report['eventsAfterKill'] = [...events];
  report['dbAfter'] = snapshot();
  report['sdkReportedDisconnect'] = events.includes('offline') || events.includes('reconnecting');
  report['note'] = 'SDK 未报告断线时，本脚本无法证明断线保护有效；该保护由证明有效期门控承担。';
} catch (e) {
  report['probe'] = 'failed';
  // 只输出固定类别码，不输出原始异常文本（可能含内部地址/凭据）
  report['reason'] = e instanceof Error && /^[a-z_]{3,60}$/.test(e.message) ? e.message : 'probe_failure';
  exitCode = 3;
} finally {
  try { await port.stop(); } catch { exitCode = exitCode || 3; }
  report['dbFinal'] = snapshot();
  console.log(JSON.stringify(report));
}
process.exitCode = exitCode;
