/**
 * AC-T0.6：锁定版 SDK 可被 Node 24 原生加载，关键公开导出形状符合预期。
 * 只 import 主入口，不登录、不发消息、不建网络连接。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('douyin-im 主入口可加载且关键导出为函数', async () => {
  const sdk = await import('douyin-im');
  for (const name of ['createClient', 'configureLogger', 'getLogger'] as const) {
    assert.equal(typeof sdk[name], 'function', `${name} 应为函数`);
  }
});

test('createClient 可构造与释放，不触发登录', async () => {
  const { createClient } = await import('douyin-im');
  const dir = mkdtempSync(join(tmpdir(), 'dac-smoke-'));
  try {
    const client = createClient({ dataDir: dir });
    assert.ok(client);
    // 不 login；仅验证对象图能建立（登录/发信在 T1 真实 Adapter 验证）
    assert.equal(typeof client.on, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
