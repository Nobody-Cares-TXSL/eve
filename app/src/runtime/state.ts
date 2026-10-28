import { mkdir, open, readFile, rename, readdir, stat, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Phase = 'stopped'|'starting'|'running'|'paused_manual'|'stopping'|
  'paused_auth'|'paused_risk'|'paused_env'|'paused_unknown'|'error';
export type Blocked = Extract<Phase,'paused_auth'|'paused_risk'|'paused_env'|'paused_unknown'>;
export const BLOCKED: readonly Phase[] = ['paused_auth','paused_risk','paused_env','paused_unknown'];
export interface RuntimeState {
  readonly phase: Phase;
  readonly pid: number;
  readonly processStart: string;
  readonly instanceId: string;
  readonly updatedAt: number;
  readonly reason: string;
}
const allPhases = new Set<string>(['stopped','starting','running','paused_manual','stopping',
  'paused_auth','paused_risk','paused_env','paused_unknown','error']);
export interface Paths {
  readonly root: string;
  readonly state: string;
  readonly lock: string;
  readonly requests: string;
  readonly acks: string;
}
export function paths(root: string): Paths {
  return { root, state: join(root,'runtime.json'), lock: join(root,'instance.lock'),
    requests:join(root,'control','requests'), acks:join(root,'control','acks') };
}
export async function initDirs(p: Paths): Promise<void> {
  for (const dir of [p.root,join(p.root,'control'),p.requests,p.acks]) {
    await mkdir(dir,{recursive:true,mode:0o700});
    await chmod(dir,0o700);
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const tmp = path + '.' + randomUUID() + '.tmp';
  const f = await open(tmp,'wx',0o600);
  try {
    await f.writeFile(JSON.stringify(value) + '\n');
    await f.sync();
  } finally { await f.close(); }
  try { await rename(tmp,path); await chmod(path,0o600); }
  finally { await unlink(tmp).catch(()=>undefined); }
}
function decodeState(v: unknown): RuntimeState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('状态结构损坏');
  const x = v as Record<string, unknown>;
  if (typeof x['phase'] !== 'string' || !allPhases.has(x['phase']) ||
      !Number.isSafeInteger(x['pid']) || typeof x['instanceId'] !== 'string' ||
      typeof x['updatedAt'] !== 'number' || typeof x['reason'] !== 'string' ||
      typeof x['processStart'] !== 'string') throw new Error('状态字段损坏');
  return x as unknown as RuntimeState;
}
export async function readState(p: Paths): Promise<RuntimeState|null> {
  let raw:string;
  try { raw = await readFile(p.state,'utf8'); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try { return decodeState(JSON.parse(raw) as unknown); }
  catch { throw new Error('运行状态文件损坏：禁止自动覆盖'); }
}
export function processStart(pid: number): string {
  try {
    // Linux /proc/<pid>/stat 的第二列 comm 可包含空格和括号；先截掉最后一个 ") "。
    const s = requireProc(pid);
    const idx = s.lastIndexOf(') ');
    return idx < 0 ? '' : s.slice(idx+2).split(' ')[19] ?? '';
  } catch { return ''; }
}
import { readFileSync } from 'node:fs';
function requireProc(pid: number): string { return readFileSync('/proc/'+pid+'/stat','utf8'); }
export function isAlive(s: RuntimeState): boolean {
  if (!s.pid || !s.processStart || processStart(s.pid) !== s.processStart) return false;
  try { process.kill(s.pid,0); return true; }
  catch { return false; }
}
export async function runtimeSnapshot(p: Paths): Promise<{state:RuntimeState|null; alive:boolean; stale:boolean}> {
  const state = await readState(p);
  if (!state) return {state:null,alive:false,stale:false};
  const alive = isAlive(state) && Date.now()-state.updatedAt < 12000;
  return {state,alive,stale: !alive && ['running','starting','paused_manual','stopping'].includes(state.phase)};
}
export async function writeState(p: Paths, state: RuntimeState): Promise<void> {
  await atomicJson(p.state,state);
}
export async function listRequests(p: Paths): Promise<string[]> {
  try { return (await readdir(p.requests)).filter(x=>/^[a-f0-9-]{36}\.json$/.test(x)); }
  catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export async function readJson(path:string):Promise<unknown> { return JSON.parse(await readFile(path,'utf8')) as unknown; }
export async function durableRequest(path:string,req:unknown):Promise<void> {
  const f=await open(path,'wx',0o600);
  try { await f.writeFile(JSON.stringify(req)+'\n'); await f.sync(); }
  finally {await f.close();}
}
export async function removeFile(path:string):Promise<void> {
  await unlink(path).catch(e=>{if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;});
}
export async function ensureFile(path: string):Promise<void> {
  const f=await open(path,'a',0o600);await f.close();await chmod(path,0o600);
}
