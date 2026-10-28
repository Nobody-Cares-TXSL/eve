/** T2 Gate ⑤：doctor 必须是强诊断（能因真实缺陷变 fail），不是固定文案。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../../src/runtime/doctor.ts';

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'eve-doctor-'));
  await mkdir(join(dir, 'data'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'state'), { recursive: true });
  return dir;
}
const goodConfig = { version: 1, selfUid: '111', targetUid: '222' };

test('健康环境：D4/D8 通过、D10 无发送调用、D9 无凭据时 warn', async () => {
  const dir = await sandbox();
  try {
    const configFile = join(dir, 'data', 'config.json');
    await writeFile(configFile, JSON.stringify(goodConfig));
    await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
    const r = await doctor(configFile, join(dir, 'state'), join(dir, 'data'), join(dir, 'src'));
    const by = Object.fromEntries(r.checks.map(c => [c.id, c.level]));
    assert.equal(by['D4'], 'ok');
    assert.equal(by['D8'], 'ok');
    assert.equal(by['D10'], 'ok');
    assert.equal(by['D9'], 'warn', '无凭据目录时必须 warn，不能假装 ok');
    assert.equal(r.summary.ok + r.summary.warn + r.summary.fail, 11);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('源码出现 sendMsg 调用 → D10 必须 fail（只读边界可被独立证伪）', async () => {
  const dir = await sandbox();
  try {
    const configFile = join(dir, 'data', 'config.json');
    await writeFile(configFile, JSON.stringify(goodConfig));
    await writeFile(join(dir, 'src', 'sender.ts'), 'export async function f(c: any) { await c.sendMsg("x"); }\n');
    const r = await doctor(configFile, join(dir, 'state'), join(dir, 'data'), join(dir, 'src'));
    assert.equal(r.checks.find(c => c.id === 'D10')?.level, 'fail');
    assert.ok(r.summary.fail > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('凭据目录 0755 → D9 必须 warn；0700 → ok', async () => {
  const dir = await sandbox();
  try {
    const configFile = join(dir, 'data', 'config.json');
    await writeFile(configFile, JSON.stringify(goodConfig));
    const accounts = join(dir, 'data', 'accounts');
    await mkdir(accounts, { recursive: true });
    await chmod(accounts, 0o755);
    let r = await doctor(configFile, join(dir, 'state'), join(dir, 'data'), join(dir, 'src'));
    assert.equal(r.checks.find(c => c.id === 'D9')?.level, 'warn');
    await chmod(accounts, 0o700);
    r = await doctor(configFile, join(dir, 'state'), join(dir, 'data'), join(dir, 'src'));
    assert.equal(r.checks.find(c => c.id === 'D9')?.level, 'ok');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('src 下出现 .py → D3 fail；配置缺失 → D4/D8 fail 且不回显 UID', async () => {
  const dir = await sandbox();
  try {
    await writeFile(join(dir, 'src', 'legacy.py'), 'print(1)\n');
    const r = await doctor(join(dir, 'data', 'config.json'), join(dir, 'state'), join(dir, 'data'), join(dir, 'src'));
    assert.equal(r.checks.find(c => c.id === 'D3')?.level, 'fail');
    assert.equal(r.checks.find(c => c.id === 'D4')?.level, 'fail');
    assert.equal(r.checks.find(c => c.id === 'D8')?.level, 'fail');
    const text = JSON.stringify(r);
    assert.ok(!text.includes('111') && !text.includes('222'), 'doctor 输出不得回显账号 UID');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
