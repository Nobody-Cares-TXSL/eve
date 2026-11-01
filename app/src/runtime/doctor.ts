import {access,readdir,readFile,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {loadConfig} from './config.ts';
import {readState,paths,isAlive} from './state.ts';
type Level='ok'|'warn'|'fail';
export interface Check {id:string;level:Level;detail:string;fix?:string;}
/**
 * 发送调用的白名单位置：T6-3c-real-B1 起，全项目唯一允许出现 `sendMsg` 的文件。
 * 其余任何文件出现发送调用都视为边界破坏。
 */
const SEND_CALL_ALLOWED = ['douyin.ts'];

/** 收集出现发送调用的文件（相对 srcDir 的路径）。
 *  跳过本文件自身——检查器的检测模式本身就在源码里，自指会误报。 */
async function findSendCalls(dir:string, root=dir):Promise<string[]>{
  const found:string[]=[];
  for(const name of await readdir(dir)){
    if(name==='doctor.ts') continue;
    const full=join(dir,name);
    const st=await stat(full);
    if(st.isDirectory()){ found.push(...await findSendCalls(full, root)); continue; }
    if(!name.endsWith('.ts')) continue;
    if(/\bsendMsg\s*\(/.test(await readFile(full,'utf8')))
      found.push(full.slice(root.length).replace(/^[/\\]/,''));
  }
  return found;
}
export async function doctor(configFile:string,stateDir:string,dataDir:string,srcDir:string):Promise<{checks:Check[];summary:{ok:number;warn:number;fail:number}}> {
  const c:Check[]=[];
  function add(id:string,level:Level,detail:string){c.push({id,level,detail});}
  add('D1',Number(process.versions.node.split('.')[0])>=24?'ok':'fail','Node 24+');
  try { import.meta.resolve('douyin-im'); add('D2','ok','SDK 公开入口可解析'); }
  catch {add('D2','fail','SDK 公开入口不可解析');}
  // D3：只读阶段不得残留 Python 运行时依赖（迁移前的 src/dac 已冻结在仓库外）
  try {
    const files=await readdir(srcDir);
    add('D3',files.some(f=>f.endsWith('.py'))?'fail':'ok',
      files.some(f=>f.endsWith('.py'))?'src 下发现 .py 文件':'Node ESM 源码，无 Python 运行时文件');
  } catch {add('D3','warn','无法读取源码目录');}
  let config=false;
  try {await loadConfig(configFile);config=true;add('D4','ok','配置结构有效');}
  catch{add('D4','fail','配置不存在或不合法');}
  try {await access(stateDir,constants.R_OK|constants.W_OK);add('D5','ok','状态目录可读写');}
  catch{add('D5','warn','状态目录尚未创建或无权限');}
  try {await access(configFile,constants.R_OK);add('D6','ok','配置可读');}
  catch{add('D6','warn','配置文件不可读');}
  try {const state=await readState(paths(stateDir));add('D7',state && isAlive(state)?'warn':'ok',state && isAlive(state)?'运行实例存在':'没有运行实例');}
  catch{add('D7','fail','状态文件损坏');}
  // D8：目标账号可用性——只报告是否已配置，绝不输出 UID 本身
  add('D8',config?'ok':'fail',config?'目标账号配置已就绪（值不回显）':'目标账号配置缺失');
  // D9：Session 凭据目录存在且仅本人可访问（0700）
  try {
    const accounts=join(dataDir,'accounts');
    const st=await stat(accounts);
    const mode=st.mode&0o777;
    add('D9',mode===0o700?'ok':'warn',mode===0o700?'凭据目录权限 0700':'凭据目录权限非 0700，需 t1:harden');
  } catch {add('D9','warn','尚无本机登录凭据（需先完成扫码登录）');}
  // D10：发送能力必须收敛到唯一出口，不能散落在任意模块
  try {
    const calls=await findSendCalls(srcDir);
    const stray=calls.filter(f=>!SEND_CALL_ALLOWED.some(a=>f.endsWith(a)));
    if(stray.length>0) add('D10','fail','发送调用出现在白名单之外：'+stray.join(', '));
    else if(calls.length===0) add('D10','ok','源码无 sendMsg 调用');
    else add('D10','ok','sendMsg 仅出现在唯一受控出口（'+calls.join(', ')+'）');
  } catch {add('D10','warn','无法扫描源码中的发送调用');}
  // D11 无法自动化：平台使用风险只能由人确认
  add('D11','warn','平台使用风险需人工确认（无法自动判定）');
  const summary={ok:0,warn:0,fail:0};
  for(const x of c) summary[x.level]++;
  return {checks:c,summary};
}
