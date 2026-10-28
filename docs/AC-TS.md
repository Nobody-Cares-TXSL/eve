# 验收条件 — TypeScript 迁移基线（AC-TS）

> 版本：v1.0（2026-10-28，随 TODO T0-4 建立）
> 状态：生效（T0 部分）；T2 起的条目随对应 Slice 启用
> 原则（AC.md 头部）：继承 Python 基线（AC-1.x）的**诊断思想**，
> 替换其**实现细节绑定**（Python/Playwright/.py 扫描 → Node/SDK/TS/凭据）。
> 已验收的 Python 证据保留在 AC.md 与 SLICE_1_GATE.md，不回改。

---

## T0：工程骨架与依赖接入（本轮启用）

### AC-T0.1 干净检出可复现

| 项 | 内容 |
|---|---|
| 条件 | 干净 clone 后，凭锁文件安装即得到与验证版一致的依赖；typecheck/test 零失败 |
| 证据 | `cd app && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` 退出码全 0；`pnpm test` 输出 `pass ≥ 15, fail 0` |
| 失败状态 | 安装或校验失败 → T0 未完成，不进入 T1 |
| 类型 | 自动测试 |

### AC-T0.2 SDK 接入方式与 Contract 一致（R-01）

| 项 | 内容 |
|---|---|
| 条件 | 依赖为 npm 固定版本 `douyin-im@1.1.0`；不引用 `src/` 私有路径；不依赖被忽略的本地 `douyin-im/` 目录 |
| 证据 | ① `app/package.json` 与锁文件版本一致；② `rg "douyin-im" app/src app/test` 的 import 仅出现包名主入口；③ 移动/删除本地 `douyin-im/` 目录后 typecheck+test 仍通过（证明零本地路径依赖） |
| 失败状态 | 任一不满足 → 按 Contract §4 降级路径（git 锁 commit → vendoring）并更新 Contract |
| 类型 | 自动测试 + 人工检查 |

### AC-T0.3 边界：凭据与产物不入库

| 项 | 内容 |
|---|---|
| 条件 | `node_modules/`、`state/`、`data/`、`*.sqlite*`、二维码、验证产物均不被 git 跟踪；测试全 mock，无网络与真实账号代码路径 |
| 证据 | ① `git check-ignore` 对六类路径逐一命中；② 创建含 fake 会话目录后 `git status` 不显示；③ `pnpm test` 在无网络环境变量下通过；④ `rg sendMsg app/test` 为空（只读阶段不发） |
| 失败状态 | 任何命中 → 立即修 `.gitignore` 并检查历史是否已泄露 |
| 类型 | 自动测试 |

### AC-T0.4 归一化层的字段不变量（normalize 已有测试，此处为契约登记）

| 项 | 内容 |
|---|---|
| 条件 | 会话键必须有 `threadId`，禁止用 shortId 回退；一切 ID 以字符串保留（19 位值超 double 安全整数，转 number 必损坏）；缺失字段归 `null`/`non_text`/`-1`，不猜测；文本事件必须由 SDK `content.kind=text` 明确确认 |
| 证据 | `pnpm test` 中 normalize 的 13 项断言（含反向断言：非文本带标题仍 `non_text`、缺 `content.kind` 不判 text、threadId 缺失即拒绝、`String(Number(id)) !== id`）；全套 ≥20 |
| 失败状态 | AC 失败 → T1 不得开始（幂等键建立在归一化正确之上） |
| 类型 | 自动测试 |

### AC-T0.5 复用账本先于复用（R-03 / D-018）

| 项 | 内容 |
|---|---|
| 条件 | `app/NOTICE.md` 存在且 N-01 登记 SDK 依赖；任何 MIT 片段进仓库前已有账本行 + 代码头注释指向 |
| 证据 | `app/NOTICE.md` 存在；对 `app/src`、`app/test` 全量 diff 审查无未登记的第三方来源 |
| 失败状态 | T3 前 NOTICE 缺失 → 阻断该 Slice 合码 |
| 类型 | 人工检查 |

### AC-T0.6 SDK 公开 API 形状冒烟（防「类型对、运行错」）

| 项 | 内容 |
|---|---|
| 条件 | 锁定版 SDK 可被 Node 24 原生加载，关键公开导出存在且为预期类型；SQLite 实验警告不视为失败 |
| 证据 | `test/platform/sdk-public-api.test.ts`：`import('douyin-im')` → `createClient/configureLogger/getLogger` 为 function；`createClient({dataDir: <临时目录>})` 可构造即释放，不登录不发信 |
| 失败状态 | 加载失败 → 依赖链问题，T0 未验收 |
| 类型 | 自动测试 |

---

## 继承映射（旧 → 新）

| Python 基线 | TS 继承者 | 变化 |
|---|---|---|
| AC-1.1 D1~D11（doctor） | AC-T2.x（T2 定义） | 检查对象换 Node/pnpm/SDK/凭据 |
| AC-1.2 缺字段必须指名 | AC-T2.x 配置校验 | 同一语义，TS 实现 |
| AC-1.3 stdlib 同名扫描 | **不再适用** | Node/TS 无同名劫持机制；教训转为「不依赖 SDK 私有路径」（AC-T0.2） |
| AC-1.6 单实例锁 | AC-T2.x | 语义保留，`flock` 规则不变 |
| AC-1.7 退出码 0~4 | AC-T2.x | 表原样迁移（CLI_SPEC §5） |
| AC-2.x 归档 | AC-T3.x（T3 前写） | Contract `docs/contracts/archive.md` 先行 |
| — | AC-T0.5 / D-018 | 迁移新增：复用账本 |

> 本文件条目同样受「不得为过测试改 AC」约束。

## T1 — 只读平台接入（离线 Gate 已实施，线上 Gate 待验证）

- AC-T1.1：仅允许一个已验证登录账户、一个目标 UID，匹配严格私信 `threadId`，拒绝群/他人；错误 UID 必须拒绝运行。
- AC-T1.2：SDK 事件不得越过 platform 边界，私信以服务端 ID 字符串化，分享/评论等不当作文本；历史查询保留游标、hasMore、状态码与方向。
- AC-T1.3：凭据/二维码不进入 Git/应用日志，二维码本地 0700 目录、0600 文件；失效/结束后清理；短信与验证挑战不得自动绕过。
- AC-T1.4：只读线上验收必须由人工填写两个平台 UID、真实登录或 Session 恢复、本人第二账号发来测试消息，确认目标可收到但绝不发送。线上 Gate 未执行前不得勾选 TODO T1 完成。

## T2 — 运行态与 CLI（新增的验收条件）

- **AC-T2.1 配置/doctor**：有效配置、缺配置、损坏 JSON、未知字段、相同 UID 五种情况；doctor --json 恒有 D1~D11、稳定顺序、计数汇总一致；不得输出敏感信息。
- **AC-T2.2 单实例/持久阻塞**：同目录并发 run 只有一个启动，冲突退出码 4；SIGKILL 后 runtime 为 stale 且保留证据，重启不得悄悄覆盖业务阻塞；paused_auth/risk/env/unknown 必须显式 unblock。
- **AC-T2.3 控制**：pause/resume/stop 命令经 UUID 请求/ack，暂停后不再开始处理，恢复保持同一个 PID；stop 可从暂停退出；旧实例请求不会被新进程执行。
- **AC-T2.4 事件队列**：固定上限、单消费者、暂停栅栏、异常转 paused_env、溢出不静默丢消息；mock 验证。
- **AC-T2.5 退出码**：测试 SIGINT/SIGTERM 的真实 Node 退出码为 0；已 offline 后 SDK logout reject 不得误报 1；真正没有确认关闭则报 1；锁 4、配置 2、阻塞 3。不得取 tee 管道 $? 充证据。
- **AC-T2.6 安全**：运行时无 sendMsg、业务日志无正文，state/control 目录 0700、文件 0600；无真实抖音网络连接的自动化测试。
- **AC-T2.7 文件系统不可信**：请求目录中的符号链接不得被当作控制指令，也不得写穿到链接目标；状态文件被替换为符号链接时，原子写必须替换路径本身而非写入外部目标；请求文件名与内部 id 不一致必须拒绝；非法 JSON 请求被丢弃且不阻塞后续合法请求。
- **AC-T2.8 doctor 强诊断**：doctor 的每项检查必须能因真实缺陷转为 fail/warn（可被证伪），不得是固定文案：源码出现 `sendMsg` → D10 fail；凭据目录非 0700 → D9 warn；src 下出现 `.py` → D3 fail；配置缺失 → D4/D8 fail。D11（平台风险）无法自动化，明确保留为人工确认项。doctor 输出不得回显账号 UID。
- **AC-T2.9 测试卫生**：子进程测试结束后不得留下孤儿进程（flock 派生的 `--locked` 孙进程）；时间敏感断言用轮询而非固定延迟，全套并行重复运行不得偶发失败。


## T3 — Eve SQLite 消息归档（实施前冻结的验收条件）

- **AC-T3.1 身份与白名单**：归档绑定配置的 owner/target；只接受平台已认证上线事件派生的 ownUid 集合（包含不同的主 UID 与 imUid），逐条检查 threadId、senderUid、fromSelf；跨会话、冒充自身或错目标整批拒绝，不落盘。
- **AC-T3.2 ID 幂等**：复合唯一键 (conversation_id,server_message_id)，19 位 ID 原样保留；相同文字不同 ID、双方相同文字、跨会话同 ID 都不能误合并。同键但关键字段冲突必须回滚，不能覆盖旧记录。
- **AC-T3.3 双模式及批次重放**：无 ID 进入 uncertain_messages/ambiguous；同 batchId 完全一致的请求重放不新增 uncertain；同 batchId 修改一条消息即 batch_conflict；不同 batchId 同文无 ID 仍必须保留待确认项，不靠内容哈希去重。请求 digest 覆盖完整有序输入，不得充当消息 ID。
- **AC-T3.4 原子写入、水位/gap**：一次事务提交消息、uncertain、gap、batch；中间异常完全回滚。live 新消息不得推动 verified_anchor_id，history 游标不等于可信覆盖证明；显式发现 gap 则保留未核实状态。
- **AC-T3.5 数据库生命周期**：Eve DB 与 SDK im-state.sqlite 分离；独占连接关闭后拒绝操作，重启持久化，用户/目标身份不符拒绝，future schema_version 拒绝且不覆写，WAL、外键及权限符合 Contract。
- **AC-T3.6 安全**：全 mock/临时库，不调用真实 SDK、AI 或发送；不在测试日志/仓库写真实 UID、账号凭据、聊天正文；源码无第三方代码复制，后续若直接复用则先在 NOTICE 逐片段登记。
- **AC-T3.7 崩溃恢复**：真实子进程 `SIGKILL`（非模拟异常）后，已提交批次完整存活、可继续写入且不重复；事务在 `COMMIT` 前被强杀时不得留下任何半提交行；`journal_mode` 实测为 `wal`。
- **AC-T3.8 回调边界**：`EveArchive.open()` 及其他同步 DB 调用不得出现在 SDK 事件回调栈内（Contract §1）；身份记录可为纯数据，但建库必须在 `await port.start()` 之后的主流程完成。
- **AC-T3.9 真实现场归档**：一次真实只读运行中，目标账号真实私信必须写入 `eve.sqlite`，`server_message_id` 保持 19 位字符串，`from_self` 方向正确，`sync_state` 保持 `unverified`（live 不得冒充 verified），库文件 0600，优雅退出后数据持久。真实现场不作为自动化测试，不得把真实 UID/正文写入仓库。

## T4 — 断线分页对账与可信恢复（Contract 草案阶段，AC 尚待冻结）

- **AC-T4.1 SDK 分页可观测性**：读取每页保留 rawCount / acceptedCount / excludedCount+分类、请求 cursor/方向、响应 cursor/方向、hasMore/statusCode；测试 SDK 的升序返回视图与 older 方向、自动排除当前 anchor、19 位 ID 与大游标均不丢精度。任何未解释的过滤都不得生成完整性证明。
- **AC-T4.2 真实多页补收**：以 mock >50 条（至少 51、120）跨页恢复，只有实际遇到旧持久锚点重叠，或首次完整扫描至 hasMore=false 终点，并通过头部闭合检查才可 verified；不足 50 条、单次空页、SDK 缓存命中和猜测游标均不能独立作为完成条件。
- **AC-T4.3 不前进与异常页**：hasMore=true 但 cursor 自循环/往返、空页连发、非零状态、错方向、相同 ID 冲突、被丢弃历史行/缺 ID、无法找到旧锚点时必须留下 gap/ambiguous，不能死循环，也不能继续 AI 处理。
- **AC-T4.4 实时与历史交错**：重连乱序、重复 WS 推送与分页重叠必须按 (conversation_id,server_message_id) 合并；分页期间新消息到达时头页需再次闭合，不能漏掉并发窗口；index 只作线索，不能按固定差值推断丢消息条数。
- **AC-T4.5 v1→v2 事务迁移**：新增 epoch/page/eligible 结构不破坏 T3 旧记录；schema_version/user_version 同步，升级中 SIGKILL/失败回滚，未来版本拒绝，备份保护且不得写入 Git。对账页数据+游标证据+最终水位与 eligible 同事务一致性可被故障注入验证。
- **AC-T4.6 Proof 与处理门控**：只有由同一有效 epoch、已提交分页链、旧锚点/初次终点、头页闭合和 pending gap/ambiguous 数为 0 共同支撑的 coverageProof 才可写 verified；伪造 proof、旧 PID proof、运行中 stop/reconnecting 不可放行；eligible 每服务器事件最多一条，T4 不调用模型和 send。
- **AC-T4.7 重启与进程崩溃**：在单页事务提交前、后分别 SIGKILL；不留半页/错误水位；新进程需重新验证 epoch，旧 cursor/旧证明不能直接推进 verified；所有已确定消息可通过 ID 匹配重放且不产生重复 eligible。
- **AC-T4.8 账号与安全**：SDK 登录 UID/IM UID、会话和目标白名单始终准确；历史不得接受群或非目标账号消息。日志不打印消息正文、真实 UID、挑战 URL；只读联调不得发送/标记已读；无法判定历史完整时明确呈现缺口而不声称“零丢失”。
- **AC-T4.9 有界资源**：页数/总消息/总耗时/重试次数均有明确上限和失败状态，持续新增消息、半开连接或慢响应不能无限持锁/无限扫描，不能因此放宽 verified 的条件。
