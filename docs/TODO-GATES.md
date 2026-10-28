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

## T3 — SQLite Archive 第一轮离线实现（尚未过完整 Gate）

- 新增 `docs/contracts/archive.md`、`app/src/archive/{schema.sql,store.ts}`、`app/test/archive/store.test.ts`；T3 AC 已写入 `docs/AC-TS.md`。实现不依赖 SDK 内部缓存，不接 AI、不发送消息，不修改 T1/T2 运行入口。
- 身份二次校验由 ArchiveIdentity(ownerUid,targetUid,ownUids) 实施：测试主 UID 与 imUid 不同、消息方向匹配、跨会话整批拒绝。**仍待验证**：真实 Runner 上线事件如何安全提供经认证的 imUid；尚未把 T3 消费者接入 T2 Runner。
- 批次 SHA-256 仅用于同 batchId 重放一致性校验，不充当事件身份；保存逐项 outcomes_json，保证混合 new/matched/ambiguous 重放原顺序。跨批次无 ID 消息保守保留 ambiguous，避免内容哈希误去重。
- 当前 6 项专属离线测试：同文异 ID、双向同文、批次重放与冲突、跨会话拒绝、故障回滚、gap、重启身份与权限；尚未声称 T3 所有 Gate 通过。
- **未完成**：可信平台身份传递到 Runner、archiveBatch 业务队列接线及失败阻塞；schema 迁移与损坏/未来版本负例；生产路径的 SQLite WAL/SHM 符号链接处理与日志泄露审查；不同会话同服务端 ID 的受控隔离 fixture；并发及意外断电故障注入。T3 不进入 T4，以上补齐后再验收。

### T3 第二轮：可信身份、Runner 接线与安全负例（2026-10-28）

- T1 在线状态包含 SDK 核验的主 UID 和 IM UID。T2 Runner 核验二者后才可初始化 EveArchive，错账号身份进入 paused_auth（码 3），不建立数据库。
- 真实只读运行的 SDK 入站消息进入 T2 有界队列，消费者将消息写入独立 eve.sqlite；同服务器 ID 重放不重复插入；消费者异常转 paused_env。Mock CLI 保持无数据库副作用。
- 新增归档 Runner 集成测试：不同 imUid 的合法身份接收、队列保存和重复事件去重，以及错误身份阻断。新增未来 Schema 版本拒绝、SQLite/WAL/SHM 符号链接及悬空链接拒绝测试。
- **未证实**：真实抖音归档现场联调、T4 多页对账/覆盖证据、数据库整体断电/并发压力、迁移旧版本完整路径。T3 本轮暂不标记全部完成，不提交 Git。

### T3 第三轮：数据库预检/迁移与失败阻塞补证（2026-10-29）

- 调整 EveArchive.open 的执行顺序：先检查文件/侧车符号链接与数据库版本、账户绑定、完整性（quick_check），核对通过后才切换 WAL、开启事务。此举避免对不兼容版本或账号错配的库提前切换日志模式。
- 迁移策略明确：已知的 **空白 v0** 数据库可事务初始化为 v1；含未知旧表的 v0 结构拒绝，不做猜测式升级；未来版本拒绝，原版本保持不变。本轮并未实现任何已存在业务数据的历史旧版迁移（尚无正式 v0 业务 schema）。
- 新增安全/负例测试：空白 v0→v1、未知旧库拒绝、身份错配与未来版本预检、同一 serverMessageId 冲突后 Runner 持久 paused_env，且已写消息不被覆盖。专用 SQLite 测试使用临时目录和假 UID，不接真实平台、不发送私信。
- 仍未进行真实只读平台归档现场验收，真实崩溃/断电恢复与资源压力尚不等于自动测试通过；T4 的覆盖水位与历史对账不能在 T3 伪称已完成。代码保留未提交以便复查。

### T3 第四轮：真实归档现场验收 + 崩溃恢复 + 契约违规修复（2026-10-29）

#### 1. 真实只读归档现场验收（已通过）

真实账号、真实私信、真实 SQLite，全程未调用 AI、未发送任何消息。

| 检查项 | 实测结果 |
|---|---|
| 运行状态 | `running` → SIGTERM → **`stopped`/`normal_stop`**，进程干净退出 |
| 消息入库 | 1 条真实私信写入 `data/eve.sqlite` |
| `server_message_id` | **19 位且为字符串**（未转 number，精度未损） |
| 方向判定 | `from_self=0`，发送者为目标账号 |
| 类型判定 | `kind='text'`、`message_type=7` |
| 来源标记 | `first_source='live'` |
| **`sync_state`** | **`unverified`** —— 未冒充 `verified`（Contract §4 明确 live 不得推进水位） |
| 批次记账 | 1 batch：inserted 1 / matched 0 / ambiguous 0 |
| 文件权限 | `eve.sqlite`、`-wal`、`-shm` 全部 **0600** |
| 优雅退出后 | WAL 已 checkpoint（0B），数据持久（messages=1, batches=1） |

现场同时证实：身份绑定跨进程有效（新进程用同一 config 重开同一 DB，`account_mismatch` 预检通过）。

#### 2. 崩溃恢复（真实 SIGKILL，非模拟）

新增 `test/archive/crash-recovery.test.ts` 3 条，子进程真实 `SIGKILL` 自己：

| 场景 | 断言 |
|---|---|
| 已提交批次 + SIGKILL | 子进程 `signal==='SIGKILL'`；重开后 messages=1、batches=1 存活；同事件重放得 `matched`，**不重复插入** |
| 事务中途 SIGKILL | 子进程在 `BEGIN IMMEDIATE` 后、`COMMIT` 前被强杀；重开 counts 全 0，**无半提交** |
| journal_mode | 独立进程读回 `wal`，证明 WAL 确实生效 |

#### 3. 修复一处 Contract 违规（实现缺陷）

`Runner` 原先在 **SDK 事件回调** `onStatus('online')` 内调用 `EveArchive.open()`，而 `open()` 全是同步调用（`lstatSync`/`mkdirSync`/`DatabaseSync`）。Contract §1 明文禁止「把同步 DB 调用放入 SDK 回调」。

修法：`onStatus` 只记录纯数据身份（零 I/O、零阻塞）；建库移到 `run()` 中 `await port.start()` 之后——此时 `system.online` 已同步触发完毕，不在回调栈上。身份校验失败仍进 `paused_auth`，建库失败仍进 `paused_env`。

#### 4. 验证结果

- `pnpm typecheck` 0 错。
- `pnpm test` **71/71**（原 68 + 崩溃恢复 3），归档专项 16/16。
- 测试中修正了一处我自己写错的地方：崩溃用例的 `createTime` 与子进程写入值不一致，被 `message_conflict` 正确拦下——**是测试数据错误，不是实现缺陷**，已对齐。

#### 5. 仍未完成（不得视为 T3 关闭）

- **T4 范畴**：`getHistory` 多页对账、`coverageProof` 构造与审核、`verified` 水位的真正推进。T3 不实现、不声称。
- **资源压力**：未做长时间高频写入、磁盘满、DB 锁竞争（`busy_timeout` 实际触发）的量化验收。
- **并发**：本阶段单进程单写入者，多实例写同一 DB 不在 T3 范围（T2 锁已排除同 state-dir 双实例）。
- 真实账号与凭据不进入任何测试；现场只做了 1 条消息的单次验收，未做持续运行观察。

**判定：T3 核心归档能力（含真实现场）与崩溃恢复已验收；T4 对账能力尚未开始，不得混入。T3 可标记完成并提交。**

## T4 — 分页对账 Contract 草案（未冻结，尚未实现）

- 以 T3 提交 `c77425b` 为干净基线，已核对 SDK 的 `ChatContact.getHistory`：older/newer/cursor/count/includeCurrent 可用；返回消息经排序，指定 cursor 且未 includeCurrent 时可过滤掉锚点行。
- 新增 `docs/contracts/reconciliation.md`，定义：重连 epoch、旧锚点重叠或初次全量终点、头页闭合、分页无前进/过滤失败保守处理、SQLite v2 预期迁移、coverageProof 与持久 eligible 门控；`docs/AC-TS.md` 增加 AC-T4.1～T4.9 草案。
- 发现 T1 `readHistory()` 只返回过滤后的 messages，没有原始/排除计数；**必须先补可观测性**，否则不允许对账宣称 verified。
- **状态**：只完成 T4 Contract/AC 草案，未修改 T1/T2/T3 实现，没有真实历史分页联调、没有 T4 自动测试，没有 Git 提交。不得提前勾选 T4 或进入 T5。

### T4 实施增量：T4-1 历史页证据、T4-2 v2 schema（尚未完成 T4）

- 以 T3 提交 c77425b 为实现基线，仅更改 PlatformPort 历史页返回结构、mock 与 T1 只读 Adapter，不接触 SDK 内部缓存库、不发送消息。
- T4-1：新增 requestedCursor/requestedDirection、rawCount、acceptedCount、excludedCount、exclusions（foreignConversation/foreignSender/deleted/unrepresentable）与 missingIdCount。rawCount 以 SDK ChatHistory.messages 最终对外返回的列表为口径（SDK 已可能自行排除 cursor anchor），不宣称网络包原始条数。被排除行不能静默假装完整。
- T4-1 mock 负例覆盖：六条中四条过滤、群/删除被过滤但不等于空页、19 位消息 ID 与高位索引字符串精度、hasMore=true 空页保留以供恢复器判断。原只读权限与私信白名单不变。
- T4-2：新增独立 schema-v2.sql（reconcile_epochs/reconcile_pages/eligible_events）。EveArchive.upgradeToV2() 为显式调用、事务升级，保留 T3 原生 v1 默认开库行为；升级后 v2 可再次正常打开。迁移故障注入证明 DDL/版本号同时回滚，已有消息和归档批次不受损。
- **未完成**：T4-2 还未实现对账页与归档批次的同事务业务 API；T4-3 分页恢复器、头页闭合、有效 proof 复核/verified 更新、eligible 事务发布、断线 epoch 取消、T4-4 的 >50 条恢复和真实历史对账尚未进行。不得把 schema 和 page 原始计数当成 coverageProof；不得勾选 T4 全部完成。

### T4-3 第一轮：有界分页恢复器、页事务及可信门控

- 新增 runtime/reconcile.ts 与 archive/store.ts 的 epoch/page/eligible 原子业务 API，保留前期 T4-1/T4-2 的历史页证据和 SQLite v2 迁移。
- 专项 mock：首次 120 条、51 条重连增量、无旧锚点、过滤行、头部变化、游标循环、空历史、超时、旧 epoch、页事务失败，以及最终 head_close 与 verified/eligible 同事务回滚。
- Runner 的显式实验模式测试：可信会话完成初始对账并在重连后产生唯一资格；未知会话不会凭猜测 threadId 放行；没有发送或模型行为。
- **待补 Gate**：真实 SDK 多页历史现场、T4 页事务 SIGKILL 前后真实子进程恢复、异步请求超时/断开细节、长期压力及风险限制。仍不勾 T4 完成，不提交 Git。

### T4-4 补强：真实 SIGKILL、SDK 请求取消、恢复栅栏（2026-10-29）

- 真正由 `spawnSync` 启动 Node 子进程并向自己发 SIGKILL；三个新场景：页 COMMIT 后强杀 → 页及消息存活、旧 epoch 不能续签；页事务中途强杀 → 消息/批次/页证据全部回滚；verified COMMIT 后强杀 → 锚点、页及 eligible 唯一约束存活，重启重扫不重复。
- SDK 的 `readHistory` 没有可传入 AbortSignal 的真实取消接口。恢复器改为 `AbortSignal` 立即撤销 epoch 等待，但保留每个 Port 的 outstandingHistory 栅栏直到 SDK 请求实际 settle；新 epoch 在旧请求仍悬挂时返回 `history_request_still_pending`，绝不重叠拉历史，迟到响应只清空栅栏、不再写 SQLite。
- Runner 在 Session offline/reconnecting、pause、stop、SIGINT/SIGTERM 时 abort 当前 epoch；stop 测试证明即使 SDK 历史 Promise 永不 resolve，运行进程仍能有界停止，迟到返回无法写入已关闭的库。
- 头部闭合进一步要求 ID 序列、返回 cursor、hasMore 三者一致；同页重复 serverMessageId 拒绝 coverageProof。之前 Mock 集成测试把同一个事件重复塞进历史页，新的拒绝是正确行为；已修正 fixture，不降低 Contract。
- 增加 `EveArchive.invalidateCurrentCoverage()`：仅 T4 v2 模式下在启动、重连及停止时将当前 `verified/reconciling` 状态关闭为 `unverified`，取消未完成 epoch，同时保留历史已验证锚点及已归档消息；重启必须重新对账才能恢复当前放行。
- 自动测试新增 T4 SIGKILL 3、SDK 超时/停止 2、头部元数据/重复 ID 2、重启栅栏 1。全部只使用临时 SQLite、虚构 UID，不触及真实 SDK 账号，不发送私信。
- **剩余 Gate**：未执行真实平台 T4 多页历史现场验收；SDK 网络底层不可取消，悬挂请求可能需要平台连接断开或重启进程，需验证持续性/资源压力；首轮边界证明依赖 SDK 可检索历史，不能保证平台已删除或不可见消息绝对可恢复；正式启用前应备份真实业务库并检查 v2 升级影响。不宣布 T4 结束。

### T4-4 全量回归结果（2026-10-29）

- `cd app && pnpm typecheck`：0 错；`pnpm test`：**99/99 全绿，fail=0**（从上轮 91/91 增加 8 项故障/边界测试）；`git diff --check`：通过。
- 覆盖的三类本轮新增负例：真正 SIGKILL 的对账页提交前/后与 verified 后恢复（3）；SDK 悬挂请求 abort/旧请求拒重叠、Runner stop 后迟到响应（2）；头页返回 cursor/hasMore 变化、单页重复 ID、跨重启保留锚点但关闭当前 verified 栅栏（3）。
- 有一次集成测试失败源于旧 Mock 将同一 serverMessageId 同时放入两条历史行；新增唯一性检查拒绝该页是正确结果。已修正历史 fixture，保持历史页检查严格，完整回归全绿。
- **T4 仍未通过全部现场 Gate**：真实 SDK 多页历史联调及高负载/长期资源压力尚未量化；仍只提供实验开关，运行前需备份真实业务库；没有模型、没有发送。工作区未提交。

### T4-5：资源上限、SDK 本地会话回退与现场只读探针（2026-10-29）

- 新增 `app/test/archive/reconcile-load.test.ts` 4 项：600 条/12 个 older 页加头页闭合可完整归档，重扫消息不重复；`maxPages=3` 最多发 3 次请求且旧数据保留、gate=gap；`maxMessages=105` 在第三页入库前拒绝、只留下已提交的 100 条；`maxDurationMs` 超时不能推进水位。仅用 100% 虚构历史数据。
- 新增 `app/test/platform/douyin-readonly.test.ts` 两项：SDK `getStrangerList()` 本地联系人投影可恢复目标线程的 Contact；返回错误 thread 或非白名单线程必须拒绝，不调用其 getHistory。仅在 Contact 已由 SDK 提供且 UID/threadId 都匹配时读取；不拼造地址。
- 新增 `app/scripts/t4-live-history.ts`：默认禁用，须 `EVE_T4_READONLY_PROBE=1` 且在单实例 flock 与 26 秒超时保护下运行。只读打开原 Eve SQLite 获取唯一已归档会话；最多历史 3 页、页间隔 750ms、不输出 UID/游标/正文、不写 Eve 库，不执行消息发送、已读或 AI。
- 真实现场探针：账号登录/身份核验已通过，无 QR、session_rejected、verification_required；**readHistory 阶段失败**（脱敏为 `sdk_or_session_failure`/`Error`），未成功读到任何可证明的历史分页。加入 SDK 本地陌生人投影后再次现场检查仍在 history 阶段失败。根因尚不能确定：可能是目标 Contact 未绑定，或底层 SDK 会话地址 / 历史接口拒绝，**不把猜测写成证据**。已停止进一步真实网络重试。
- 复查官方运行数据目录：Eve 归档 schema 仍为 v1，唯一会话仍在；探针仅以 SQLite `readOnly:true` 读取业务库，未执行数据库 v2 升级或归档写入。
- 本轮 `pnpm typecheck` 0 错、`node --check scripts/t4-live-history.ts` 通过、`pnpm test` **105/105 全绿**（上轮 99，新增 6），`git diff --check` 通过。状态：**T4 离线负载与边界已通过，真实 SDK 历史分页验收仍未通过；不进入 T5，不提交 Git**。
- 后续定位：在本地授权会话内先分辨 SDK 是否存在准确的目标 Contact，再区分 `prepareAddress()` 与 `getMessages()` 的失败；诊断必须只打印稳定原因码，禁止回显 UID、会话标识、token、原始 SDK 错误或正文。需要真实 SDK 读取成功以及至少两页合法历史的现场证据才能关闭 T4-5 Gate。

### T4-5 追加诊断：真实失败点从通用 history 缩至 SDK Contact 缺失（2026-10-29）

- 只读现场探针已按顺序确认：登录身份通过、没有 QR/session_rejected/verification_required；异常前安全回调最后记录 `history_local_contact_missing`，即缓存/SDK 本地陌生人投影均**未提供 UID 和 threadId 双重匹配的 Contact**，因此尚未执行 `Contact.getHistory()`、没有发起真正的历史消息分页请求；不再笼统归类为“历史接口失败”。
- 新增 `onHistoryDiagnostic` 安全回调：仅允许固定阶段码，不暴露 SDK Contact、真实 UID、会话/短会话 ID、游标、原始异常、正文或凭据；探针输出 `historyDiagnostic` 和短 ID 提示缺失的布尔值。未知 SDK 异常统一转 `history_sdk_throw`，接口非零转 `history_sdk_nonzero`。调用方不会取得可能含私密信息的原始异常。
- 已核对 SDK 源码与当前已安装类型：目标 `getHistory` 依赖 SDK 绑定的 `Contact`，本地 `getStrangerList()` 仅投影已同步记录。SDK 提供 `refreshStrangerConversations()`，但会批量拉取其他会话与消息，不满足项目唯一白名单最小访问原则；**不自动调用**，也不以归档中的 threadId 手工构造联系人或短 ID。
- 新增两项离线测试：SDK 已绑定目标联系人可直接历史读取（不扫描其他联系人）；SDK 抛出含模拟敏感令牌的异常/非零状态仅返回稳定诊断码（测试日志中无模拟令牌）。另外现有本地投影 fixture 补充了 SDK 公开 Contact 必填字段，不放宽 thread/UID 规则。
- **现场 Gate 仍未过**：必须在 SDK 正式绑定已授权目标 Contact 后重新限页只读探测，观察多页 `hasMore/cursor` 的真实链路；除非真实页链符合 Contract，不能标记 verified，也不能进入 T5。无需再次盲目试历史接口或做非目标会话批量同步。

### T4-5 本轮诊断最终回归（2026-10-29）

- 完整测试：`cd app && pnpm typecheck` 0 错；`pnpm test` **107/107 通过**，fail=0；`node --check scripts/t4-live-history.ts` 通过；`git diff --check` 通过。较上一轮 105 项增加 2 个诊断安全测试。
- 真实登录已验证，历史仍是 **Contact 缺失**，未发起真正 getHistory 分页请求，故真实多页 Gate 不能关闭。
- 正式 Eve SQLite `PRAGMA user_version=1`（未迁移）、只读探针无剩余进程，所有新改动仍未提交。注意检查进程数时 `grep` 零匹配返回 1，会导致整个 shell 组合命令返回 1；这不影响上述 typecheck/test/diff 的独立通过结论。
- 本轮没有实际私信发送或 SDK 非目标历史批量读取。后续要从可信目标入站事件恢复 SDK Contact 后，才有资格进行真实历史分页验收；如果平台不再提供该 Contact，保持 gap/unverified 而不是制造 coverageProof。

### T4-6 真实阻塞已解开：缺陷在实现，不在 SDK（2026-10-29）

#### 根因（实现缺陷，非平台限制）

上一轮结论「SDK 无法提供目标 Contact」不成立。复查 `node_modules/douyin-im/lib/sdk/account.js` 确认 SDK **同时**提供 `getFriendList()`（含完整分页，`count:100` 循环到 `hasMore=false`）与 `getStrangerList()`。

而 `readHistory()` 的联系人回退路径**只刷新了陌生人列表**：目标若已是好友，`pickStranger()` 永远返回 undefined，于是必然落到 `history_local_contact_missing`。诊断码把它归因为「SDK 没有绑定」，实际是 dac 自己少查了一类。

#### 修复

`app/src/platform/douyin.ts` 的联系人回退改为：先 `getFriendList()` + `pickFriend()`，未命中再 `getStrangerList()` + `pickStranger()`。两类都查过仍无双重匹配才报 `history_local_contact_missing`。仍不构造会话地址、不调用 `refreshStrangerConversations()` 批量拉取其他会话。

#### 真实只读探针结果（`scripts/t4-live-history.ts`，3 页上限）

| 指标 | 实测 |
|---|---|
| 读取页数 | **3**（真实多页链路跑通） |
| 原始条数 | **132** |
| 排除条数 | **0**（无静默丢弃） |
| `hasMultiplePages` | **true** |
| `reachedHistoryEnd` | false（3 页上限内未到底，符合预期） |
| `coverageClaim` | **none**（未冒充 verified） |
| `sqliteModified` | **false** |
| 正式库状态 | `user_version=1`、messages=1、batches=1 —— **完全未被改动** |
| 残留进程 | 无 |

#### 测试

- 新增 2 条：目标为好友时经 `getFriendList` 绑定（并断言不再扫 stranger）、好友与陌生人皆无时才报 missing（并断言两类都查过）。
- 修正 2 条既有测试：它们原按「只查 stranger」写死调用序列，现按新行为对齐；其中一条的 fake 补上 `getFriendList`（原先缺失会被 catch 成 `history_local_lookup_failed`）。
- `pnpm typecheck` 0 错；`pnpm test` **109/109**。

#### 仍未完成

- 真实多页**未跑到历史末尾**（3 页上限），`coverageProof` 与 `verified` 水位的真实签发仍未验证。
- 实验模式 `--experimental-reconcile` 会在真实库上触发 v1→v2 迁移与历史网络查询，**正式库仍保持 v1**，未在真实账号上启用。
- 真实 SIGKILL 下的页事务恢复已在离线验证（子进程），但未在真实分页链上复测。

**判定：T4 的真实阻塞已解除，真实多页分页链首次跑通；完整覆盖证明与水位签发仍待验证，T4 不标记通过。**

### T4-7 真实历史终点 + 隔离影子库 coverageProof 现场验收（2026-10-29）

- 基线 Git `bb5f735`，起始工作区干净。将 `app/scripts/t4-live-history.ts` 增加受控参数：最多 30 页、最长 120 秒、页间间隔上限 4 秒；本次显式使用 **24 页、90 秒、间隔 1 秒**，仍在单实例 `flock` 与操作系统进程 `timeout` 保护下运行。
- **只读历史探针实测通过**：SDK 成功读取 4 页，原始消息 **132 条**、排除 **0**、`reachedHistoryEnd=true`、`hitPageLimit=false`、退出码 **0**；`coverageClaim=none`（仅探针，未尝试水位推进），Eve 正式数据库的 SQLite 文件及侧车文件前后 SHA-256 指纹未变化。这里的 `hasMore=false` 是 SDK 可检索范围的终点，不保证平台不可见/已删除消息不存在。
- **真实 coverageProof 隔离演练通过**：新增 `app/scripts/t4-shadow-proof.ts`，默认禁用，须显式 `EVE_T4_SHADOW_PROOF=1`；真实授权账号在线，使用内存文件系统优先的私有临时目录（权限受限）创建独立 v2 SQLite，从 SDK 实际拉取历史，连接 `reconcileOnce()` 与 `EveArchive` 的完整事务链，网络读取每次间隔 1 秒且带 `maxPages=20/maxMessages=900/maxDurationMs=80000/readTimeoutMs=15000` 上限。最终 **5 次真实历史请求，归档 132 条，5 页证据（older 4 + head_close 1）、`sync_state=verified`、epoch verified、eligible 0**；退出码 0。临时库正常清理、正式 SQLite 文件指纹没有变化、正式库未升级。该 `verified` 仅存在于已清理的影子库，不是生产运行状态。
- **保留的正式 Gate**：正式 Eve 数据库仍是 v1；未备份并在正式数据库执行 v1→v2 迁移；未在正式 Runner 实验模式下验收新实例的真实水位签发、断线/重启二次对账和停止后的门控关闭。正式 T4 仍不标记完成，不进入 T5，也没有发送消息、调用 AI 或修改远端已读状态。
- 本轮探针/影子代码不得自动启动；开展正式 v2 迁移前需生成一致性的 SQLite 私有备份、校验备份身份/完整性与恢复步骤，且明确实验模式会在停止后关闭当前 verified 状态（历史锚点保留）。

### T4-7 收束校验（2026-10-29）

- `pnpm typecheck` 0 错；`pnpm test` **109/109 通过**、fail=0；两个现场探针均通过 `node --check`；`git diff --check` 通过。未修改 T4 核心恢复器算法，新增/修改仅为限页真实探针、隔离影子 proof 脚本和验证文档。
- 正式 SQLite 在本轮之后再次只读核对：**user_version=1, messages=1, batches=1**，不受临时影子库 proof 的 v2 迁移影响；`SHADOW_TEMP_DIR_COUNT=0`、`LIVE_PROBE_ACTIVE=0`，没有遗留临时库或探针。
- **待正式 Gate**：一致性私有备份、明确回滚路径、正式 Runner 使用原库完成 v1→v2 迁移及真实 proof、停止/重启断线后的门控校验。真实影子 proof 成功不自动授权生产 DB 升级。T4 保持未正式完成，工作区有本轮未提交改动。

### T4-8 一致性备份与回滚方案（2026-10-29，本轮新增）

正式库升级前的安全网。新增 `app/scripts/t4-backup.ts`（`backup` / `verify` / `rollback` 三个子命令）。

#### 为什么用 `VACUUM INTO` 而不是复制文件

WAL 模式下，已提交但未 checkpoint 的事务只在 `-wal` 里。裸复制 `.sqlite` 会得到缺数据或半写的副本。`VACUUM INTO` 在一个读事务内导出完整逻辑数据库，天然包含 WAL 内容。

#### 正式库真实备份（已执行）

| 项 | 实测 |
|---|---|
| 产物 | `data/backups/eve-v1-<timestamp>.sqlite`，53248 字节 |
| 校验 | `v1 messages=1 meta=v1` |
| SHA-256 | `aab6593f…d6824c` |
| 权限 | 备份文件 0600、备份目录 0700 |
| 源库 | `sourceUnchanged: true`，仍为 v1 / 1 条消息 |

#### 完整往返演练（在副本上，不碰正式库）

`v1` → `upgradeToV2()` → `v2 / messages=1 / 3 张 v2 表` → `rollback` → `v1 / messages=1 / 0 张 v2 表`。回滚前的当前库被另存为 `*.pre-rollback-<timestamp>`，不静默丢弃。

#### 自动化测试（新增 4 条）

备份一致性快照与权限、损坏/缺失备份被拒、v2 迁移后回滚往返、源库符号链接拒绝。

#### 过程中修掉的脚本缺陷

`fingerprint()` 原先把 `-wal`/`-shm` 计入「源库是否被改动」，但 SQLite 即使以 `readOnly` 打开也可能创建 shm 文件，导致误报 `source_changed_during_backup`。改为只对主库文件取指纹，主库是否改变由 `VACUUM INTO` 的读事务语义保证。

#### 仍未完成

- 正式库**尚未**执行 v1→v2 迁移；备份已就绪但迁移未做。
- 正式 Runner 在实验模式下的真实水位签发、断线/重启二次对账、停止后门控关闭，均未在真实环境验收。
- 备份保留策略、异地副本、定期校验未做（T9 范畴）。

**判定：T4 正式升级的安全前置条件（备份 + 可验证回滚）已就绪；正式迁移与生产 Gate 仍未执行，T4 不标记完成。**

### T4-8 正式库迁移 + 真实 Runner 水位与门控验收（2026-10-29）

- 基线 Git `b998d28`，开始时工作区干净、Runner 无活动实例，正式库 v1/meta v1、messages=1、batches=1、integrity=ok。先在单实例锁下用 VACUUM INTO 再生成一份迁移前 v1 备份；迁移前分别校验源库和新备份六张表的内容摘要完全一致，账号绑定一致、文件 0600、`integrity_check=ok`。
- 在同一单实例锁下，正式 `EveArchive.upgradeToV2()` 事务升级成功：`user_version=2` 与 `archive_meta.schema_version=2` 同步，新增 reconcile_epochs/reconcile_pages/eligible_events 三表，原有 messages=1、batches=1 无损，完整性校验通过。未调用回滚；两份原 v1 备份均保留。
- 为减少实盘历史接口调用突发，`reconcileOnce()` 新增有界 pageGapMs；实验性真实 Runner CLI 使用 **850ms** 最小请求间隔（Mock 默认 0），先通过专项 Mock 和类型检查。
- **真实 Runner 首轮**：`run --experimental-reconcile` 经 SDK 读取完整历史、在正式 v2 库提交 **5 页历史证据**，新 epoch=verified，会话 `sync_state=verified`，锚点存在，eligible=0；停止退出码 0、状态 stopped，数据库 `sync_state=unverified`、锚点保留；正式库消息数 **132**，批次增至 6。
- **真实 Runner 第二次重启**：重新生成一个已验证 epoch（页面仅 2 页：旧锚点重叠＋头部闭合），eligible 仍为 0，停止后再次 unverified。不是继承旧 verified。
- **真实暂停门控发现并修复缺陷**：旧版本 pause ACK 只设置 paused_manual，数据库仍 verified；修复为在确认 pause 前调用 `invalidateCurrentCoverage()`，发生数据库错误则安全阻塞并拒绝成功 ACK。新增 mock 集成测试覆盖 pause → unverified、resume → 重新 verified、stop → unverified。
- **修复后的第三次真实运行**：重新签发 verified，pause ACK 后真实数据库立即 unverified 且锚点保留；resume 时先 reconciling，随后新 epoch verified；stop 后 unverified、Runner 正常退出。最新正式库 **Schema v2 / integrity=ok / messages=132 / batches=12 / eligible=0 / 4 个 verified epoch**。
- **迁移后防护**：备份脚本现在按实际 Schema 版本命名（eve-v1-* 或 eve-v2-*），并拒绝备份中 `schema_version` 与 `user_version` 不一致；新增 v2 备份回归测试。正式库再次 VACUUM INTO，产物 **v2 messages=132 meta=v2**、167936 字节、0600，源库不变。迁移前两份 v1 快照仍可校验。无真实 UID、消息正文或 token 写入 Gate。
- **未通过的现场 Gate**：本轮未主动制造真实网络链路中断/恢复；不把 Mock offline/reconnecting 或真实 pause/resume 冒充真实断线证据。T4 默认仍是只读实验模式，不能因此直接进入自动 AI 发送；本轮改动未提交 Git。

### T4-8 最终回归与交付状态

- `cd app && pnpm typecheck` **0 错**；`pnpm test` **115/115 通过**（相比 `b998d28` 的 113 项增加暂停门控与 v2 备份 2 项）；`git diff --check` 通过。
- 正式 Runner 确认 `phase=stopped, alive=false`，正式库 v2/`integrity_check=ok`/messages=132/batches=12/eligible=0；**当前** `sync_state=unverified`，锚点保留。验证过程没有发送任何私信或调用模型。
- 正式迁移与真实签发已通过；仍需真实网络断线/恢复的现场 Gate，T4 不自动声明全部完成。工作区包含本轮未提交变更，**未自动提交 Git**。

### T4-9 证明有效期门控与探针修正（2026-10-29）

#### 1. 断线探针的结论：`ss -K` 不构成有效断线注入

四种手段逐一实测，均无法可靠模拟 SDK 网络断线：

| 手段 | 实测结果 |
|---|---|
| `ss -K` 关闭本进程 TCP 连接 | 关闭 3~6 个真实抖音 443 连接后，SDK **90 秒内零状态事件** |
| 等待 ping timeout（90s 窗口） | 仍无 `reconnecting`；SDK 保有冗余连接继续工作 |
| `SIGSTOP` 冻结进程 | 冻结整个进程，无法观察事件 |
| 对象图查找 `frontierWs` | 两层搜索未命中，SDK 内部不暴露 |

**结论**：`ss -K` 断开后 DB 未退出 verified，**不能**证明「真实网络断线时门控失效」——因为当时 SDK 仍保有部分连接且未报告离线，无法确认发生了完整中断。但它揭示了一个真实缺口：**当 SDK 不发状态事件时，T4 缺乏独立判断连接是否仍可信的依据**。

探针脚本已改写为诊断工具，输出显式标注 `verdict: not_a_valid_disconnect_proof`，不作为 Gate 证据。

#### 2. 新增：证明有效期门控（T4 安全边界）

**原则**：verified 不是永久状态。无法持续证明其有效性时，必须拒绝继续使用这份证明。

- `EveArchive.coverageStatus(thread, maxAgeMs)` → `{state, verified, fresh, usable, ageMs}`；调用方以 `usable` 为准，不得只读 `sync_state`。
- `fresh` 要求时间戳存在、非未来（时钟回拨）、且 `ageMs <= maxAgeMs`；缺失或倒退一律不可用。
- `Runner.COVERAGE_MAX_AGE_MS` 默认 90s（SDK 心跳 15s 的整数倍）；轮询中发现 `verified && !usable` 即撤销门控并触发重新对账，历史锚点保留。
- 与断线事件的关系：`offline`/`reconnecting` 仍是更快的撤销路径，但**不再是唯一路径**。

#### 3. 新增测试（12 条）

`test/archive/coverage-expiry.test.ts`（7 条）：
- 新签发证明有效期内可用
- **过期证明即使 `sync_state` 仍为 verified 也不可用**（核心负例）
- Schema CHECK 约束本身禁止「verified 但缺时间戳」
- 非 verified 一律不可用、未来时间戳不可用
- 非白名单线程拒绝（不泄露存在性）
- 非法 `maxAge` 拒绝
- 撤销后立即不可用但锚点保留

`test/archive/coverage-expiry-runner.test.ts`（2 条）：
- **SDK 从不发 offline 时，过期证明仍被 Runner 撤销**（通过 `MockPlatformPort.failHistory` 模拟静默失联）
- 有效期内证明不被误撤销

#### 4. 探针脚本修正（按审查意见逐条）

| 问题 | 处理 |
|---|---|
| `socketsKilled` 统计命令成功次数而非实际断开数 | 改为 `establishedBefore/AfterKill` 前后计数对比 |
| `ss -K dst` 按对端匹配，可能影响其他进程 | 显式注释该限制，仅限测试机知情使用 |
| `reverifiedAfterReconnect` 假阳性 | 删除该指标（无法区分「从未失效」与「已恢复」） |
| `messagesNotDuplicated` 只看总数不减少 | 删除该指标（无法证明无重复插入） |
| 诊断日志输出对端地址与原始异常 | 只输出连接**计数**；异常只输出固定类别码 |
| `.t4-reconnect-state/` 未跟踪 | 已加入 `.gitignore` |

#### 5. 过程中修正的测试错误（如实记录）

1. 断言 `conversationState === 'unverified'` 过窄——对账失败路径实际落到 `gap`，两者都不可用。改为断言「不是 verified」+「`usable === false`」。
2. 断言「确实经过了有效期」是时序断言，撤销可能早于 100ms 完成。改为等待「过期或退出 verified」的条件。
3. 最初以为过期门控会触发，实测 `ageMs` 一直约 40ms——因为 Runner 持续对账会刷新 `last_verified_at_ms`。**这符合语义**（能持续证明即可用），门控针对的是「对账无法继续成功」的场景，测试需用 `failHistory` 模拟。

#### 6. 验证结果

- `pnpm typecheck` 0 错；`pnpm test` **124/124**（新增 12 条）。
- 诊断探针可运行，输出 `verdict: not_a_valid_disconnect_proof`、连接计数、DB 快照，无对端地址、无原始异常。

#### 7. 仍未完成

- **真实物理断网/系统级网络注入**：留给 T9 运维验收（需要 root 或物理断网）。这**不阻塞** T4 关闭安全门控缺口。
- 有效期 90s 的取值来自 SDK 心跳周期推算，未经长时间真实运行校准。
- T5 必须实现的义务已写入 Contract §16，但尚未有代码。

**判定：T4 的安全门控缺口已补齐（证明不再无限期有效）；真实网络注入留给 T9。**

### T4 收束：应用层 Gate 通过（2026-10-29，操作者确认）

**判定：T4 通过完整的应用层 Gate，正式标记完成。**

依据（操作者复核 e2fa6c2 后确认）：历史完整性（真实 132 条、多页、头部闭合、正式 SQLite verified 签发）、幂等与持久化（重复/强杀/回滚/迁移/备份）、运行状态保护（启动/暂停/恢复/停止不继承旧放行资格）、证明有效期（`usable` 独立判定，SDK 不发离线事件时过期仍拒绝）、失败保守（无法对账不伪造 verified）。

最终验证：`pnpm typecheck` 0 错；`pnpm test` **124/124**；工作区干净；提交 `e2fa6c2`。

#### 三项明确的后续约束（不得视为已关闭）

| 事项 | 处理决定 | 状态 |
|---|---|---|
| 真实物理断网及系统级网络注入 | 转入 **T9** | 明确保留为**未验证** |
| 90 秒证明有效期的长期校准 | 转入 **T9** 实测 | 当前值来自 SDK 心跳周期（15s）推算，**不等于 WebSocket 心跳确认**，未经长时间运行校准 |
| T5 领取消息前检查 `usable` | **T5 强制 Gate** | 未通过不得进入实际 AI 决策 |

#### 特别强调：eligible 存在 ≠ 可直接处理

`eligible_events` 有记录**不代表**可以处理。T5 必须在领取与执行决策前检查当前 `usable`：

- 证明过期 → 拒绝
- `sync_state` 为 `gap`/`ambiguous`/`unverified` → 拒绝
- 运行处于暂停或停止 → 拒绝

只有 `coverageStatus().usable === true` 才可放行。此义务已写入 `docs/contracts/reconciliation.md §16` 与 `docs/AC-TS.md AC-T4.10`。

**T4 状态：应用层 Gate 通过、已完成；T9 延期的两项与 T5 的 usable 检查为独立约束，不随 T4 关闭而消失。**
