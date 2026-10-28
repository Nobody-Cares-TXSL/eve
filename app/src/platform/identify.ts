/**
 * T1 只读身份查询：登录账户的 UID 由 SDK 验证，目标通过 uniqueId 精确查找。
 * 不关注、不创建会话、不发送私信，返回只读候选资料。
 */
import { configureLogger, createClient, type Client } from 'douyin-im';
import { LocalQrFile } from './qr.ts';

export interface IdentityCandidate {
  readonly uid: string;
  readonly uniqueId: string;
  readonly nickname: string;
  readonly secUid: string;
}

export interface IdentityResult {
  readonly selfUid: string;
  readonly nickname: string;
  readonly matches: readonly IdentityCandidate[];
}

/** 只匹配真实 uniqueId，不把昵称或搜索排名当做身份依据。 */
export function matchExactDouyinId(
  handle: string,
  entries: readonly { uid: string; uniqueId?: string; nickname: string; secUid: string }[],
): IdentityCandidate[] {
  return entries
    .filter(e => e.uniqueId === handle && /^\d+$/.test(e.uid) && e.secUid.length > 0)
    .map(e => ({ uid: e.uid, uniqueId: e.uniqueId!, nickname: e.nickname, secUid: e.secUid }));
}

export async function identifyByDouyinId(options: {
  readonly dataDir: string;
  readonly targetDouyinId: string;
  readonly notifyQrPath: (path: string) => void;
  readonly client?: Client;
  readonly onStage?: (stage: string) => void;
  /** 显式启用一次性的 SDK 本地人工验证页面；默认禁用。 */
  readonly allowLocalVerification?: boolean;
}): Promise<IdentityResult> {
  const handle = options.targetDouyinId.trim();
  if (!handle || handle.length > 80) throw new Error('请输入目标抖音号（不是昵称）');
  configureLogger({ level: 'silent', maskSensitive: true, color: false });
  const qr = new LocalQrFile(options.dataDir);
  const client = options.client ?? createClient({ dataDir: options.dataDir, autoLoad: true });
  if (client.accounts.length > 1) throw new Error('本地存在多个已保存账号，请使用独立数据目录');
  const stage = (value: string) => options.onStage?.(value);
  client.on('system.login.qrcode', ({ account, qrcodeBase64 }) => {
    stage('qr_generated');
    void qr.save(qrcodeBase64).then(path => {
      options.notifyQrPath(path);
      void account.continueLogin().catch(() => { stage('qr_login_failed'); });
    }).catch(() => { stage('qr_file_failed'); });
  });
  client.on('system.login.qrcode.status', ({ status }) => {
    if (status === 'scanned' || status === '2') stage('qr_scanned');
    else if (status === 'confirmed' || status === '3') stage('qr_confirmed');
    else if (status === 'expired') { stage('qr_expired'); void qr.remove(); }
    else if (status === 'verifying') stage('verification_required');
  });
  client.on('system.online', () => stage('account_online'));
  client.on('system.login.error', () => stage('login_error'));
  client.on('system.login.session', ({ status }) => stage('session_' + status));
  client.on('system.login.verification', ({ verification }) => {
    stage('verification_required');
    if (!options.allowLocalVerification) {
      verification.cancel('未启用本机人工安全验证');
      return;
    }
    stage('local_verification_opening');
    void verification.open({ openBrowser: true, timeoutMs: 300_000 }).then(
      () => stage('local_verification_finished'),
      () => stage('local_verification_failed'),
    );
  });
  try {
    stage('logging_in');
    await client.login();
    if (client.accounts.length !== 1) throw new Error('无法确认唯一登录账号');
    const account = client.accounts[0]!;
    if (!account.online || !account.uid || !/^\d+$/.test(account.uid)) {
      throw new Error('登录账号未通过在线 UID 验证');
    }
    stage('searching');
    const found: IdentityCandidate[] = [];
    let cursor = 0;
    for (let page = 0; page < 5; page++) {
      const result = await account.searchUsers(handle, cursor);
      if (result.statusCode !== 0) throw new Error('搜索接口返回失败，状态码=' + result.statusCode);
      found.push(...matchExactDouyinId(handle, result.users));
      if (!result.hasMore || result.nextCursor === undefined || result.nextCursor <= cursor) break;
      cursor = result.nextCursor;
    }
    stage('search_finished');
    return {
      selfUid: account.uid,
      nickname: account.nickname ?? '',
      matches: [...new Map(found.map(item => [item.uid, item])).values()],
    };
  } finally {
    await client.logout().catch(() => undefined);
    await qr.remove();
  }
}
