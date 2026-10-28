import { resolve } from 'node:path';
import { DouyinReadOnlyPort } from '../src/platform/douyin.ts';

const selfUid = process.env['EVE_SELF_UID'];
const targetUid = process.env['EVE_TARGET_UID'];
if (!selfUid || !targetUid) {
  console.error('请在本机设置 EVE_SELF_UID 和 EVE_TARGET_UID 数字平台 UID；未连接平台');
  process.exitCode = 2;
} else {
  const port = new DouyinReadOnlyPort({
    dataDir: resolve('data'), selfUid, targetUid,
    allowLocalVerification: process.env['EVE_LOCAL_VERIFY'] === '1',
    notifyQrPath: path => console.log('扫码二维码路径：' + path),
  });
  port.subscribe({
    onStatus: s => console.log('[只读]', s.type),
    onMessage: m => console.log('[只读] 方向=' + (m.fromSelf ? 'self' : 'target'), '类型=' + m.kind, '长度=' + m.text.length),
  });
  const stop = () => { void port.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { await port.start(); console.log('真实只读连接已上线；Ctrl+C 停止'); }
  catch { console.error('只读登录未通过（详细状态已脱敏）'); process.exitCode = 1; }
}
