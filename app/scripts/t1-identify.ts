/** 不发送消息的 T1 身份辅助命令。 */
import { resolve } from 'node:path';
import { identifyByDouyinId } from '../src/platform/identify.ts';

const handle = process.env['EVE_TARGET_DOUYIN_ID']?.trim();
if (!handle) {
  console.error('用法：EVE_TARGET_DOUYIN_ID="目标抖音号" pnpm t1:identify');
  process.exitCode = 2;
} else {
  try {
    const result = await identifyByDouyinId({
      dataDir: resolve('data'),
      targetDouyinId: handle,
      allowLocalVerification: process.env['EVE_LOCAL_VERIFY'] === '1',
      notifyQrPath: path => console.log('请用小号扫码，并在手机上确认登录：' + path),
      onStage: stage => {
        const labels: Record<string, string> = {
          logging_in: '正在恢复会话或启动扫码',
          qr_generated: '登录二维码已生成',
          qr_scanned: '已检测到扫码，等待手机确认',
          qr_confirmed: '手机已确认，等待账号上线',
          qr_expired: '二维码过期',
          qr_login_failed: '二维码续接失败',
          qr_file_failed: '二维码文件写入失败',
          account_online: '账号已上线',
          login_error: 'SDK 登录失败',
          verification_required: '平台要求人工安全验证',
          local_verification_opening: '正在本机浏览器打开平台官方验证组件（不会输出验证链接）',
          local_verification_finished: '平台安全验证完成，正在继续登录',
          local_verification_failed: '本地验证未完成或已超时',
          session_valid: 'Session 验证通过',
          session_expired: 'Session 已过期',
          session_unverified: 'Session 尚未验证',
          searching: '已登录，正在搜索目标抖音号',
          search_finished: '搜索请求执行完成',
        };
        console.log('[登录诊断]', labels[stage] ?? '状态未知');
      },
    });
    console.log('当前登录小号 UID：', result.selfUid);
    console.log('小号昵称：', result.nickname);
    if (result.matches.length === 1) {
      console.log('唯一精确匹配的目标 UID：', result.matches[0]!.uid);
      console.log('目标昵称：', result.matches[0]!.nickname);
      console.log('请在抖音中核对两个账号身份后，再运行 t1:readonly。');
    } else {
      console.log('精确匹配账号数量：', result.matches.length);
      console.log('不能根据相似昵称或首个搜索结果自动绑定目标。');
      for (const item of result.matches) console.log('候选 UID：', item.uid, '昵称：', item.nickname);
    }
  } catch (error) {
    // 不打印包含 cookie/token/URL 的原始错误字符串；只展示可控类别。
    const message = error instanceof Error ? error.message : '';
    const known = /^搜索接口返回失败，状态码=(-?\d+)$/.exec(message);
    console.error(known
      ? '身份查询失败：搜索接口错误，状态码 ' + known[1]
      : '身份查询失败：登录/会话/搜索流程异常；请看上面的最后一个诊断阶段。');
    process.exitCode = 1;
  }
}
