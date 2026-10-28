/** D-017: 二维码属于登录凭据。仅在本机受限目录保存，不输出 token 或 URL。 */
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LocalQrFile {
  readonly path: string;
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    this.path = join(dir, 'login-qr.png');
  }

  async save(base64: string): Promise<string> {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length > 4_000_000) {
      throw new Error('无效的二维码数据');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error('二维码不是 PNG');
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const tmp = join(this.dir, '.login-qr-' + randomUUID());
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(tmp).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
    return this.path;
  }

  async remove(): Promise<void> {
    await unlink(this.path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
