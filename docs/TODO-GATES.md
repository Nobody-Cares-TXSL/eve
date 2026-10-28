# Slice Gate 记录

> 判定标准：`CLAUDE.md`「Understanding Gate」——执行链、异常分支、测试证据三件事说清。
> 一个 Slice 一份，完成即追加，不回头改旧条目。

---

## T0 — TypeScript 骨架与 SDK 接入（2026-10-28）

对应 AC：`docs/AC-TS.md` AC-T0.1～T0.6。四问在开工时已回答（见会话记录，摘要在下）。

### 1. 执行链

```
pnpm test
  → node --test "test/**/*.test.ts"（Node 24 原生 type-stripping 加载 .ts）
  → normalize.test.ts：构造 RawMessageLike（plain object，非 SDK 实例）
      → normalizeInboundMessage(raw, selfUids)
      → 断言 InboundMessage 各字段（会话键、ID 字符串化、null 缺省、non_text、序号回退链）
  → adapter-port.test.ts：MockPlatformPort implements PlatformPort
      → subscribe → pushMessage/pushStatus → 断言 sink 收到、readHistory 会话隔离
  → sdk-public-api.test.ts：import('douyin-im')
      → 断言 createClient/configureLogger/getLogger 为 function
      → createClient({dataDir: 临时目录}) 可构造即弃（不 login、不发信、不联网）
```

**关键设计**：core 与 normalize 只依赖结构类型（`RawMessageLike`），src/ 中
**零** `import 'douyin-im'`（实测 grep 只命中测试冒烟）——依赖倒置从 T0 生效。

### 2. 异常分支（归一化的拒绝路径）

| 分支 | 行为 | 测试 |
|---|---|---|
| threadId 与 conversationShortId 都缺 | `{ok:false}`，**不猜归属** | 「两者都缺 → 拒绝」 |
| senderUid 缺 | `{ok:false}`，方向不可判 | 「缺少 senderUid → 拒绝」 |
| serverMessageId 缺 | 归 `null`（归档走 no_id_mode），不造假 ID | 「可选 ID 缺失 → null」 |
| text 空/缺 | `kind:'non_text'`，正文空串不伪造 | 「无文本事件归为 non_text」 |
| 19 位 ID | 字符串全程保留；反向断言 `String(Number(id)) !== id` | 「19 位 ID 字符串保留」 |
| selfUids 只含主 UID | imUid 的自发回显判 false → 测试固化「imUid 也要进集合」（SDK message.ts:78 双 ID 判归属） | 「imUid 也要进 selfUids」 |

### 3. 测试证据（2026-10-28 实际输出）

| 检查 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` | ✅（douyin-im@1.1.0，integrity 与验证版同发布） |
| `pnpm typecheck` | ✅ exit 0 |
| `pnpm test` | ✅ **17 pass / 0 fail**（normalize 11 + port 4 + SDK 冒烟 2） |
| 无代理环境变量跑测试 | ✅ 17 pass（全 mock，无网络） |
| `git check-ignore` 六类敏感路径 | ✅ 全部命中（node_modules/state/data/二维码/sqlite/verify-out） |
| `rg 'douyin-im' app/src` import | ✅ 零命中（仅测试冒烟 import） |
| `rg 'sendMsg' app/src app/test` | ✅ 零命中（只读边界） |
| `import.meta.resolve('douyin-im')` | ✅ 解析至 `app/node_modules/.pnpm/douyin-im@1.1.0/...`（不依赖本地目录） |
| R-01 结论 | **npm 固定版本路径成立**，不触发 git/vendoring 降级 |

### 4. 过程中修正的问题（如实记录）

1. **会话键用错字段**：初版 normalize 用 `conversationShortId`；查 SDK 源码后确认
   权威键是 `threadId`（`0:1:uidA:uidB`，`mappers.ts:143`），shortId 可能为空串。已改主用
   threadId、回退 shortId，并补「两者都缺→拒绝」测试。
2. **fromSelf 单 UID 漏判**：SDK 判归属同时看 `imUid` 与 `uid`（`message.ts:78`），
   归一化签名从 `selfUid: string` 改为 `selfUids: ReadonlySet<string>`，测试含对照。
3. **测试文件两次写坏又重写**：`ok.call(null, ...)` 占位、`notEqual(..., 'force-check')`
   恒真断言——均为无意义测试，已全部重写为可失败的真实断言。
4. **`node --test test/`（目录带斜杠）被当模块路径**：改为 glob `"test/**/*.test.ts"`。
5. **tsconfig 补 `allowImportingTsExtensions`**；`RawMessageLike` 字段显式 `| undefined`
   以兼容 `exactOptionalPropertyTypes`。
6. **根 `.gitignore` 原本不忽略 `node_modules`**：T0 检查时发现并补（连同 state/data/二维码/sqlite）。

### 5. 遗留（不阻塞 T0，归 T1/T2）

- doctor 的 TS 版具体检查项（AC-T2.x）在 T2 前定义（AC-TS 继承映射表已登记）。
- 真实 `DouyinPlatformPort`（T1）：登录/事件订阅/归一化接线、只读运行验证。
- lint 强制「`platform/` 之外禁 import douyin-im」——当前靠约定 + grep，T2 落检查。

**判定：T0 通过 Understanding Gate。**

## T1 — 只读 Platform Adapter（离线 Gate；真实连接待人工验证）

- 实现：`app/src/platform/douyin.ts`、`history.ts`、`qr.ts` 和 `app/scripts/t1-readonly.ts`。
- 限制：只读、白名单目标与单账号身份核验、Session/扫码事件、历史单页查询；暂不具备 T2 控制 CLI、T3 归档或 T4 完整历史对账。
- 离线证据：`pnpm typecheck` 通过；最新 `pnpm test` **29/29**（错误登录 UID、Session 过期、越权查询、白名单线程、历史文本、PNG 权限及本机人工验证显式开关）。
- 真实 Gate（操作者 2026-10-28 终端输出）：`t1:identify` 经扫码及 SDK 的本机人工验证成功上线，目标抖音号得到唯一 UID 且操作者核对双账号；`t1:readonly` 输出 `[只读] online`、`方向=target 类型=text 长度=2`，证明**真实连接和一条指定目标入站文本消息接收成功**。日志未输出私信正文，业务源文件未找到 `sendMsg` 或 `reply` 调用。
- **尚未证实，不得写为通过**：真实其他会话消息的运行时隔离、实际群消息负例、显式重启后的 Session 恢复、验证关闭后的 QR 清理、真实断线重连及历史对账；这些需要独立现场测试。T1 当前标记为**核心只读通路现场通过，完整 Gate 待补**。
- 权限注意：`app/data` 当前为 `0700`，但 SDK 自建 `accounts/` 与账号子目录为 `0775`，SQLite 及 WAL/SHM 为 `0644`。由于父目录限制，其他普通账号当前无法遍历，但应在**停止 SDK 进程后**对目录与缓存执行最小权限加固，作为 T1 安全 Gate 补项，避免未来父目录放宽后泄露。
- 限制：本次不调用 AI、不发送消息；T2/T3/T4 的控制、归档、完整对账尚未实现。

## T1 补充验收（2026-10-28，追加，不回改上条历史）

上条「尚未证实」清单中的三项本轮处理完毕，其余如实保留。

### 已补证

1. **SDK 缓存权限加固**（`pnpm t1:harden`，进程停止后执行，可重复运行）
   - 实测结果：`data/`、`accounts/`、账号子目录、`_pending/` = **0700**；`account.json`、`desktop-settings.json`、`im-state.sqlite` = **0600**。
   - 重启一次 SDK 后新建的 `im-state.sqlite-wal` / `-shm` 实测也是 0600。
   - **归因注意**：新文件的创建权限由 SDK/SQLite 打开方式与进程 umask 共同决定，不把「父目录收紧」当作 WAL/SHM 变 600 的唯一原因；因此加固做成**可重复执行的脚本**，每次现场运行后复查，而非声称一次修复永久生效。
   - 安全边界：脚本全程 `lstat` 判定并**拒绝符号链接**，不会跟随链接改写 `data/` 之外的文件。

2. **Session 跨进程恢复**（dac 自身 `DouyinReadOnlyPort` 路径，非 SDK 层复测）
   - 链路：第一次 `t1:readonly` 启动直接 `[只读] online`（**未出现 qr_required、未扫码**）→ SIGINT 优雅退出（打印 `offline`）→ 第二次启动仍免扫码直接 `online` → 第三次启动同样恢复。
   - 结论：Session 持久化跨进程重启有效，恢复路径走的是 dac 的事件接线（`system.online` → 身份核验），不是只验证过 SDK 单点。

3. **QR 现场残留检查（部分，按区分记录）**
   - 本轮三次启动全部走 Session 恢复，**未生成二维码**，现场仅证明「恢复期间 `data/login-qr.png` 不存在」。
   - **「扫码成功后二维码被删除」仍无独立现场证据**：只有 `douyin-readonly.test.ts` 的离线断言（online / 登录失败 / 停止路径调用 `qr.remove()`）。需要一次真实扫码现场才能补全，登记在下条遗留。

### 新发现：优雅退出码异常 → 正式登记 T2-4 待修复

- 现象：第二次 SIGINT 关停时 `port.stop()` 内 `client.logout()` reject，脚本把 `process.exitCode` 置 1；但连接实际已正常下线。即**优雅退出可能报出语义为「不可恢复」的码 1**，会与 systemd Restart 策略冲突（误判为崩溃）。
- 证据口径说明：第三次运行经 `| tee` 管道观察到的 `EXIT=0` 是 tee 的退出码，**不作为 Node 退出码证据**；异常结论只依据脚本源码中的 `catch(() => { process.exitCode = 1 })` 分支与第二次运行的实际退出码 1。
- 未区分项：本轮只测了 SIGINT；**SIGTERM 关停路径未单独验证**（第二次误 `kill -INT` 到外层 zsh 后对 node 补发，进程组行为未观测）。
- 归属：T2-4「验证 SIGTERM 优雅停机和退出码」必须包含此修复——下线成功的关停不得报不可恢复码。T1 不改 `t1-readonly.ts` 行为。

### T1 最终状态：核心功能验收通过，遗留风险已登记

- 已证实：真实连接抖音、目标账号私信接收（含白名单前过滤）、Session 跨进程恢复、只读运行（零 `sendMsg`）、缓存目录最小权限。
- **未通过/未完成，不得视为关闭**：
  - 非目标会话与群消息的**真实现场负例** —— 操作者决定不安排第二账号现场测试，**转入 T9 运维手册前补做**；判定逻辑本身有 mock 覆盖（`belongsToTarget` 解析、chatType/conversationType 拦截）。
  - 扫码成功后 QR 文件删除的现场证据（见上）。
  - T2-4 退出码异常修复（见上）。
  - 真实断线重连与 `getHistory` 分页对账 —— 属 T4，T1 未做。

## T2 — 第一轮代码与 mock 子进程验证（未完成，2026-10-28）

- 实现范围：`app/src/runtime/{config,state,queue,doctor,runner}.ts`、`app/src/cli.ts`、`app/test/runtime/*`；`app/package.json` 新增 `pnpm dac`；`docs/contracts/t2-runtime.md` 与 `docs/AC-TS.md` 新增 Contract/AC。
- 本轮验证：`pnpm typecheck` 通过；`pnpm test` **38/38**（含真实进程的锁、pause/resume 同 PID、stop、doctor JSON、业务阻塞）。独立子进程现场：第二个 `run --mock` 返回 `4`；`pause`、`resume`、`stop` 均得到 ack；stop 主进程退出码 `0`。
- 独立信号验收：SIGINT → 退出码 0/stopped；SIGTERM → 退出码 0/stopped；SIGKILL → 保留 running，status 返回 stale=true。退出码来自子进程 `wait()`，不是 tee 管道码。
- 只读安全：T2 runner 只调用 T1 只读 Port，队列消费者仅计数；未接 AI、未接 sendMsg，未运行真实抖音连接或发送。
- 已发现并修复：原 `BoundedQueue` 和 `Runner` 参数属性不兼容 TS erasableSyntaxOnly；定时器 `unref` 会让 mock run 在无其他句柄时自行退出；unblock 必须检查真实进程身份而非仅靠心跳；停机时有未消费队列须保守进入 paused_env；T1 Port 已离线但 SDK logout reject 的处理现在仅在账号确实 offline 时视为正常。
- **未通过的 Gate，不得勾选 T2 全部完成**：①控制请求重放、并发竞争与 stop 优先级压力测试；②队列溢出→持久化 paused_env→进程码 3 的完整子进程链；③真实 SDK logout 异常前后状态的故障注入测试；④ SIGKILL 后复跑和持久状态人工解除的更完整场景；⑤ doctor 全部 D1~D11 的强诊断实义检查（本版部分为阶段性提示，不得称完成）；⑥文件系统不可信符号链接和状态文件篡改测试；⑦真实运行只读配置与连接的回归验证。
- **状态**：T2 已开始，基础实现与核心 mock 链路可复现；未提交 Git，暂不进入 T3。

## T2 第二轮补强（2026-10-28，追加，不回改上条历史）

上条 7 项未通过 Gate 的处置结果。

### 已补证（可重复自动化）

| Gate | 覆盖 | 证据 |
|---|---|---|
| ①控制重放/竞争/stop 优先级 | `test/runtime/controls.test.ts` 6 条 | 重放不二次执行、stop 与 pause 同轮 stop 优先且 pause 得 `stopping`、`old_instance` 拒绝、伪造文件名拒绝 |
| ②队列溢出→paused_env→码 3 | 同上 | capacity=1 推 3 条 → `paused_env` + reason 含 overflow + 退出码 3 |
| ③SDK logout 异常故障注入 | controls 1 条 + `douyin-readonly.test.ts` 1 条 | Port 侧：已 offline 时 reject 视为正常停机；仍 online 时抛出交上层判码 1；Runner 侧：reject → `error/shutdown_unconfirmed` + 码 1 |
| ⑤doctor 强诊断 | `test/runtime/doctor.test.ts` 4 条 | D10 因 `sendMsg` 转 fail、D9 因 0755 转 warn、D3 因 `.py` 转 fail、D4/D8 缺配置 fail、输出不回显 UID |
| ⑥不可信文件系统 | `test/runtime/fs-untrusted.test.ts` 4 条 | 请求符号链接不被执行且外部文件不变、状态文件被换成链接时不写穿、文件名与 id 不一致拒绝、非法 JSON 丢弃不阻塞 |
| ⑦真实只读回归 | 人工执行一次 | `run --config <真实配置>` 进入 `running alive`；SIGTERM 后 `wait` 得**真实退出码 0**、状态 `stopped/normal_stop`；全程 SDK 静默无正文日志；`sendMsg` 仅出现在注释与检查器模式中 |

### 本轮修复的真实缺陷（如实记录）

1. **故障落盘竞态**：`block()` 的落盘是异步的，`run()` 可能在 phase 仍是 `starting` 时就返回码 3。改为 `blockPending` promise 并在退出前 join。
2. **doctor 自指误报**：D10 扫描 `src/` 会把 `doctor.ts` 自身的检测正则扫进去。检查器现在跳过自身文件。
3. **测试孤儿进程**：CLI 集成用例只 SIGKILL wrapper，留下 flock 派生的 `--locked` 孙进程（实测残留 2 个）。改为 SIGTERM → 等 3s → SIGKILL，再按 `--state-dir` 兜底清理。
4. **时间敏感断言不稳定**：固定 `delay` 在高负载下偶发失败（实测 1/4）。全部改为轮询等待，`spawnSync` 预算 7s→20s、等待预算 3.6s→9s。

### 验证结果（本阶段中间态）

- `pnpm typecheck` 0 错；`pnpm test` **53/53**，连续 4 次并行运行全部通过，无孤儿进程残留。
- 本轮新增测试（controls 6 / fs-untrusted 4 / doctor 4 / readonly +1），总数 38→53。

### 第二轮后半：④ 与 ② 的子进程级补证

| 项 | 做法 | 结果 |
|---|---|---|
| ② 队列溢出子进程链 | 新增 `app/scripts/fixtures/overflow-runner.ts`（capacity=1 推 3 条），由 `cli-integration.test.ts` 起真实子进程 | 退出码 **3**、`runtime.json` 为 `paused_env` 且 reason 含 `overflow` |
| ④ SIGKILL 全链 | `SIGKILL → 状态保留 running → status 判 stale → 复跑接管 → pause → unblock 被拒（进程存活）→ stop → 码 0` | 全链通过（3.3s） |

### 补证过程中又修掉的两个真实缺陷

5. **`pgrep` 清理空转**：`spawnSync('pgrep', ['-f', '--state-dir '+dir])` 的 pattern 以 `--` 开头，被 pgrep 当作选项直接报错退出（status 2），**孤儿清理代码从未生效**。改用不带前导 `--` 的 pattern，并加 `ps` 复核只杀 `cli.ts run`，避免误伤测试自身。
6. **SIGKILL 复跑误读旧状态**：新实例接管前，旧的 `running` 状态文件仍在，`waitForState('running')` 会立即返回旧值，导致随后的 `pause` 打到死实例上返回 2。改为等待 `instanceId` 变化。

### 验证结果（第二轮终态）

- `pnpm typecheck` 0 错；`pnpm test` **55/55**，连续 3 次并行运行全部通过，无孤儿进程残留。
- 测试总数 38 → 55（controls 6、fs-untrusted 4、doctor 4、readonly +1、cli-integration +2）。

**判定：T2 的七项 Gate 全部有可重复证据；④与②的子进程链已补。T2 可标记完成，进入 T3 前由操作者确认。**
