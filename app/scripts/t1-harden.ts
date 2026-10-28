/**
 * T1 安全 Gate 补项：SDK 自建目录/缓存的权限加固（一次性维护脚本，不进业务代码）。
 * 背景：douyin-im account-store 的 mkdirSync 不带 mode（跟随 umask，实测 0775），
 * im-state.sqlite 由 SQLite 默认创建（0644）。凭证目录必须仅本人可访问。
 * 前提：**SDK 进程已停止**，不改动文件归属与内容，只收紧权限。
 * 安全边界：全部用 lstat 判定并拒绝符号链接——绝不通过链接改写 data/ 之外的文件。
 */
import { chmod, lstat, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'data');

async function tighten(path: string, mode: number): Promise<void> {
  const before = (await lstat(path)).mode & 0o777;
  await chmod(path, mode);
  console.log(`${path}: ${before.toString(8)} → ${mode.toString(8)}`);
}

/** 拒绝符号链接：chmod 跟随链接，会把权限改到 data/ 之外的目标上。 */
function checkReal(path: string, isLink: boolean): void {
  if (isLink) throw new Error(`拒绝处理符号链接：${path}`);
}

if (!(await stat(root)).isDirectory()) throw new Error(`data 目录不存在：${root}`);
await tighten(root, 0o700);
const accounts = join(root, 'accounts');
const accountsStat = await lstat(accounts);
checkReal(accounts, accountsStat.isSymbolicLink());
await tighten(accounts, 0o700);
for (const entry of await readdir(accounts, { withFileTypes: true })) {
  checkReal(join(accounts, entry.name), entry.isSymbolicLink());
  const dir = join(accounts, entry.name);
  if (!entry.isDirectory()) {
    // SDK 正常只在 accounts/ 下建目录；若出现散落文件，按凭据处理为 600
    await tighten(dir, 0o600);
    continue;
  }
  await tighten(dir, 0o700);
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, file.name);
    checkReal(path, file.isSymbolicLink());
    // 凭据（*.json）与缓存（*.sqlite*）一律 600；其余文件不动，只报告
    if (file.name.endsWith('.json') || file.name.includes('.sqlite')) await tighten(path, 0o600);
    else console.log(`跳过（非凭据/缓存）：${path}`);
  }
}
