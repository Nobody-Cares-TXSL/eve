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

## T4 — 断线分页对账与可信恢复（应用层 Gate 已通过，2026-10-29）

> 状态：**AC-T4.1～T4.9 已验收**（124/124，证据见 `docs/TODO-GATES.md` T4-8/T4-9）。
> 真实物理断网与 90 秒有效期长期校准转入 T9，保留为未验证状态。
> **T5 强制义务**：领取消息前必须检查 `coverageStatus().usable`——`eligible_events` 存在不等于可直接处理。

- **AC-T4.1 SDK 分页可观测性**：读取每页保留 rawCount / acceptedCount / excludedCount+分类、请求 cursor/方向、响应 cursor/方向、hasMore/statusCode；测试 SDK 的升序返回视图与 older 方向、自动排除当前 anchor、19 位 ID 与大游标均不丢精度。任何未解释的过滤都不得生成完整性证明。
- **AC-T4.2 真实多页补收**：以 mock >50 条（至少 51、120）跨页恢复，只有实际遇到旧持久锚点重叠，或首次完整扫描至 hasMore=false 终点，并通过头部闭合检查才可 verified；不足 50 条、单次空页、SDK 缓存命中和猜测游标均不能独立作为完成条件。
- **AC-T4.3 不前进与异常页**：hasMore=true 但 cursor 自循环/往返、空页连发、非零状态、错方向、相同 ID 冲突、被丢弃历史行/缺 ID、无法找到旧锚点时必须留下 gap/ambiguous，不能死循环，也不能继续 AI 处理。
- **AC-T4.4 实时与历史交错**：重连乱序、重复 WS 推送与分页重叠必须按 (conversation_id,server_message_id) 合并；分页期间新消息到达时头页需再次闭合，不能漏掉并发窗口；index 只作线索，不能按固定差值推断丢消息条数。
- **AC-T4.5 v1→v2 事务迁移**：新增 epoch/page/eligible 结构不破坏 T3 旧记录；schema_version/user_version 同步，升级中 SIGKILL/失败回滚，未来版本拒绝，备份保护且不得写入 Git。对账页数据+游标证据+最终水位与 eligible 同事务一致性可被故障注入验证。
- **AC-T4.6 Proof 与处理门控**：只有由同一有效 epoch、已提交分页链、旧锚点/初次终点、头页闭合和 pending gap/ambiguous 数为 0 共同支撑的 coverageProof 才可写 verified；伪造 proof、旧 PID proof、运行中 stop/reconnecting 不可放行；eligible 每服务器事件最多一条，T4 不调用模型和 send。
- **AC-T4.7 重启与进程崩溃**：在单页事务提交前、后分别 SIGKILL；不留半页/错误水位；新进程需重新验证 epoch，旧 cursor/旧证明不能直接推进 verified；所有已确定消息可通过 ID 匹配重放且不产生重复 eligible。
- **AC-T4.8 账号与安全**：SDK 登录 UID/IM UID、会话和目标白名单始终准确；历史不得接受群或非目标账号消息。日志不打印消息正文、真实 UID、挑战 URL；只读联调不得发送/标记已读；无法判定历史完整时明确呈现缺口而不声称“零丢失”。
- **AC-T4.9 有界资源**：页数/总消息/总耗时/重试次数均有明确上限和失败状态，持续新增消息、半开连接或慢响应不能无限持锁/无限扫描，不能因此放宽 verified 的条件。
- **AC-T4.10 证明有效期**：`verified` 不是永久状态。`coverageStatus(thread, maxAgeMs)` 必须能独立判定 `usable`；时间戳缺失、未来时间（时钟回拨）、超过有效期一律不可用。**SDK 静默失联（从不发 offline/reconnecting）时，过期证明仍必须被撤销**。Schema 必须禁止「verified 但缺锚点/时间戳」的状态。撤销后历史锚点保留以便重新对账。

## T5 — AI 决策 dry-run（T5-1 本轮冻结，其他条目待实施）

- **AC-T5.1 统一决策 Contract**：reply/skip/defer 必须严格判别；reply 非空且 ≤500 字符、delayMs 0..600000；defer delayMs 1000..86400000；skip 无 text/delayMs；reason ≤120 字符；未知字段（包括工具和发送意图）拒绝。
- **AC-T5.2 统一 AI Backend 端口**：model-api 与 agent-runtime 共享只接收固定人格和有限历史 turns 的接口，不允许 Backend 获取平台发送端口、账号 UID、messageId、SQLite 路径或插件权限。Agent 子进程不在本轮实施。
- **AC-T5.3 资格和 Proof 门禁**：只有 v2 库目标线程中 pending 的 eligible、T4 coverage usable 且 proof epoch 存在时才允许把正文送往 Backend；推理后必须再次确认是**同一个** verified epoch（防暂停→重新验证 ABA），过期/gap/停止均拒绝。
- **AC-T5.4 严格边界与审计**：最多 5 条上下文，每条截断至 1200 字符，不查询未来消息或别的会话；dry-run 只输出 backend、action、内容长度、耗时、事件/决策摘要，不输出正文、UID 或凭据；本轮不标记 eligible processed、不发送私信。
- **AC-T5.5 Model API 适配器离线验收**：DeepSeek JSON 模式，显式 API Key，固定官方 HTTPS endpoint、无 tools、有限 max_tokens、请求计数上限、限频、拒绝非 stop/工具调用/超大输出/非法 JSON、脱敏 HTTP 错误；mock fetcher 验证，不向真实网络发请求。实际凭据、网络、重试/成本策略后续验收。
- **AC-T5.6 最终 Slice Gate（尚未完成）**：显式授权真实 API、人格和最小上下文、连续消息合并、后端失败退避、持久 claim/审计/恢复、端到端 100% dry-run；均未通过前不得勾选整体 T5。

### AC-T5.Agent.1 Claude 唯一启用、Agent 适配可扩展性（本轮）

- 只有 claude_code 出现在受信任 AgentRegistry；OpenCode、Codex 等未实现/未注册。重复、未知 Agent、任何宣称工具/文件/MCP/发送权限的定义拒绝。
- AgentRuntimeDef 仅声明可执行文件、args 构造、输入/输出解析与能力；通用 AgentProcessTransport 处理 stdin、临时 cwd、环境白名单、取消/超时、输出大小与非零退出。新增 Agent 不修改 dryRunOne/T4 Gate/Decision Contract。
- Claude Code 使用 --safe-mode、--tools 空、--disallowedTools 星号、--strict-mcp-config、--disable-slash-commands、--no-session-persistence，且 --max-turns=1、--max-budget-usd=0.10。模型输出只接受 success.structured_output，之后仍按 Decision Contract 验证。
- 不向 argv 放入真实消息正文，不自动运行 Claude CLI；默认 pnpm t5:demo 用 fake transport；真实 CLI 只允许 EVE_T5_CLAUDE_CALL=1 pnpm t5:claude，且仅虚构数据。缺少 opt-in 时直接退出，不建立临时库。
- Typecheck 与单测验收包括真实 fake 子进程、超时 SIGTERM/SIGKILL、进程拒绝重复并行、取消与输出截断；默认测试没有真实模型请求或抖音发送。
- 当前 CLI 不是 OS 沙箱，故禁止开放 Agent 模型工具或自动加载用户插件/MCP；插件 Gateway 和更强执行隔离为后续 AC，不能提前勾 T5 全部完成。

### AC-T5.Runner（受控内部接线）

- AI 工作槽必须是默认关闭的依赖注入，不能从未验证的外部字符串直接创建 Agent；不能修改原消息归档队列的 FIFO 或放宽 T4 门控。
- 合法的每次运行认领前验证 verified 同 epoch、可信白名单、队列空闲及已完成历史对账；新消息归档后先重新对账，不能拿旧证明直接运行 AI。
- 新私信 / 暂停 / 断线 / 账号重绑定 / 停止必须取消运行中的 Agent，且停止须 await Agent 结束后才能关闭 SQLite；审计失败不得视为成功。
- maxAttempts 有界但仅限本进程，后续还需要跨重启持久额度。自动模式尚无 CLI 授权，传 --experimental-ai-dry-run 必须拒绝，不能忽略参数或默默启动。
- v2 正式库必须保持 v2；没有正式备份、显式迁移和真人工审批前，Runner 不得隐式建 v3 或操作生产 eligible。

### AC-T5.Batch/Budget · T5-4 已实现部分

- [x] 连续消息认领必须在 SQLite 一事务中保留组内所有真实事件 ID，避免“AI 一次处理三条，剩余两条以后又处理”的重复调用；唯一键和重启恢复都可验证。
- [x] 历史页顺序不得以 local_id 冒充发生顺序；使用已验证毫秒时间戳选择候选与上下文。不可靠时间戳、自己回复、长间隔、非文本或无资格事件不得跨越合并。
- [x] Runner 可配置静默窗口，在对账完成且持续安静后才启动新的 AI；实时新消息仍 Abort 旧 Agent。
- [x] 认领事务内检查滚动 1 小时与 24 小时次数预算、最小间隔和失败冷却；进程重启不能清零，拒绝时不能调用 Claude。
- [ ] 真实 Claude API/CLI 费用测量、跨日期长期限额校准、真实网络异常退避、更多内容安全负例和人工审批仍需后续 Gate。

### AC-T5.ClaudeRealSmoke（真实模型 Gate 已通过，2026-10-29）

- [x] 登录状态只读检查通过且不会输出凭据；单次实盘测试输入为虚构账号消息，真实抖音库保持不变、0 发送。
- [x] 执行失败不得被 CLI 退出码 0 冒充成功；真实 CLI 模式 blocked 必须非零。
- [x] 错误可归类为固定 code 而不能回显 stdout/stderr 原文、Token、UID、真实对话；Runner 不能在 Agent 认证、网络、CLI 参数或协议失败后继续处理下一条 eligible。
- [x] 模拟 CLI 子进程成功与认证失败两种端到端路径通过、失败保持完整 SQLite blocked 审计。
- [x] **首次真实 Claude 结果成功校验**：根因已定位并修复（StructuredOutput 工具被 `--tools ''`/`--disallowedTools '*'` 禁用、`--max-turns` 截断工具回合、CLI 返回事件数组而解析器只接受单对象）。经 Eve 自身入口 `EVE_T5_CLAUDE_CALL=1 EVE_CLAUDE_MODEL=<环境模型> pnpm t5:claude` 取得 `status=dry_run`、`action=reply`、`aiLedger.recorded=1`、`messagesSent=0`、`eligibleConsumed=0`、退出码 0。证据见 docs/TODO-GATES.md T5-6。
- [ ] 服务侧可核验的 token / 费用及订阅额度检查，尚未完成。

### AC-T5.P0-P2 审查修复验收

- [x] 任意 AgentTransportCode 由统一类型定义向上贯穿到 DryRunFailure，所有 11 类异常均以自身固定码写入脱敏 dry-run 审计，不因引擎漏列而二次坍缩。
- [x] Claude 结构 Schema 对 reply/skip/defer 使用支持的 nested anyOf 严格 required/extra keys；本地校验器独立强制 reply 文本和延迟、defer 延迟、reason 边界；官方不支持的数字/字符串约束不得伪装成由远端执行。
- [x] Claude argv/预检帮助要求同源生成；--max-turns 文档支持但本机 help 隐藏，预检明确表达这一不可验边界；删去永远不会到达的 exitCode 分支。
- [x] 真实 CLI 组合、嵌套 Schema 与账号网络端到端验收已通过（见 AC-T5.ClaudeRealSmoke 与 T5-6）。仍保留：`--max-turns` 已移除，资源边界改由预算/超时/输出上限约束，长期费用测量未做。

## T6 — 安全发送（T6-1 已实施）

- **AC-T6.1 发送意图与安全校验（离线）**：输入 T5 的 `AiDecision` 与运行上下文，纯函数判定是否允许生成发送意图；不调用 SDK、不写正式库、不发消息、不读系统时钟（`now` 注入）。校验顺序固定为：身份 → 证明 → 运行态 → 决策类型 → 内容 → 幂等 → 频率 → 静默；相同输入必得相同输出。
- **AC-T6.2 拒绝码封闭**：仅允许契约 §4 列出的 12 个固定码，每个码至少一条负例，且拒绝时**不得**产生意图。
- **AC-T6.3 幂等键**：`(conversationId, sourceEventId)` 唯一；同一服务端事件重复调用返回 `duplicate_event` 而非第二个意图。
- **AC-T6.4 正文不出审计**：`SendIntent.text` 仅存在于意图对象内；日志、审计、错误码、测试断言一律只用 `textDigest`，不得打印或断言正文内容。
- **AC-T6.5 边界明确**：频率与静默时段的边界值（等于上限、区间端点、跨午夜）行为被测试固定；策略字段非法返回 `invalid_policy` 而非静默降级。
- **AC-T6.6 与后续 Slice 的边界**：T6-1 不持久化、不产生状态机、不接平台；`SendIntent` 仅在内存返回。真实发送仍需 T6-6 的 L1 人工确认门。
- **AC-T6.7 v4 迁移与账本隔离**：发送账本使用独立 SQLite v4，不修改 v3；迁移为显式操作且幂等；v4 之前调用发送账本 API 必须报 `send_requires_v4`。正式库不得自动迁移。
- **AC-T6.8 幂等与批次不可拆**：`UNIQUE(conversation_id, source_event_id)`；`send_intent_events` 以 `(conversation_id, server_message_id)` 为主键，任一事件已属于某意图时新意图被拒绝并返回既有 `intentId`。
- **AC-T6.9 原子认领**：`claim` 为条件更新（`WHERE status='pending'` 且检查 `changes===1`），同一意图并发认领只有一次成功。
- **AC-T6.10 崩溃恢复**：遗留 `dispatching` 在重启后一律转 `unknown`（`interrupted`），且此后不可再认领、不可重发；恢复操作幂等。
- **AC-T6.11 结果判定封闭**：`sent` 必须有非空平台证据；`failed` 仅接受确定未发送的原因码；`unknown` 仅接受超时/中断/歧义/传输错误码；跨集合原因码直接拒绝。终态不可再变。
- **AC-T6.12 正文保留期**：正文独立存储并带 `expires_at_ms`；过期即 `getSendText` 返回 `null`；清理只删正文，账本与摘要保留。账本行内不得出现正文。
- **AC-T6.13 事务回滚**：写入过程中断时不得残留意图、正文或事件关联，且失败后同一意图仍可正常创建。

### T6-2a 组合层 AC（2026-10-31）

- [x] 认证过的 own IM UID 在 Policy 与 Archive 双侧白名单通过；伪造 IM UID、非授权会话不能产生意图。
- [x] 不接受上游自报 verified：Coverage 从 SQLite 中取得，并在意图写入事务里复核同一个 Epoch；撤销/换代时拒绝落库。
- [x] 拒绝/skip/暂停/超长/非法事件组/无效决策一律不落库，成功仅新增 pending（绝不调用 SDK）。
- [x] 配额从账本读取；pending/dispatching/sent/unknown 保守占用，failed 释放；两个独立连接用事务内重复预算检查阻止超额。
- [x] 重叠事件组在账本层优先指回既有 intentId，不会拆组；不输出正文。
- [x] v4 临时库的 T4 对账与 T5 AI 账本仍正常；v3 不自动升级。
- [ ] T5 完整决策结果来源证明、Runner 受信上下文接线、Mock Sender、平台 SDK 适配、正式迁移和人工受控单发尚未验收。

### T6-2b Mock Dispatcher 验收 AC（2026-10-31）

- [x] 对假 ID、仅基线事件、已消费 claimed/processed、**另一个真实会话的 eligible 事件**拒绝 `invalid_event_group` 且 SQLite 无新增意图。
- [x] T5 `ai_batch_items` 一旦认领，传入部分、混组的 eventIds 均拒绝；整组检查在保存事务内执行。
- [x] 无已记录 T5 决策/摘要不符、Proof Epoch 换代、正文到期、身份或运行态错误：Mock Port 不获正文也不发起调用。
- [x] Fake T5 recorded 决策 + 同批次事件 + 当前可用 Proof → 单次 Mock 成功，返回 `mock_sent`、证据为 `mock:...`，重复调用不得产生第二次 Mock 发送。
- [x] Mock 确定未发送 → failed；timeout / throw / ambiguous → unknown，并断言 attempt=1，不能再次 claim；返回不带原文。
- [ ] 真实 AI 文本交接、Runner 注入的可信状态、真实 SDK adapter 与回执语义、L1 人工审核、真实平台字符限制、生产库迁移及长时间限流/断线测量均未完成。

### AC-T6.3a · 可信决策正文交接（**离线实现已通过**，2026-10-31）

设计文件：`docs/contracts/ai-send-handoff.md`。实现：`EveArchive.finalizeAiWithSend` + `schema-v5.sql`。证据：`app/test/send/handoff.test.ts` 19 条，全部在临时 v5 库上运行。**离线通过不等于真实发送 Gate。**

- [x] AC-T6.3a.1 T5 对外的 `DryRunAudit`、`AiBackend`、`AiDecision` 及原 `durableDryRunOne` dry-run 行为保持兼容；仅新增受信的内部已验证 `AiDecision` 交接，不接受任意外部 JSON 冒充原始回复。
- [x] AC-T6.3a.2 同一 `BEGIN IMMEDIATE` 事务提交 T5 `recorded` + T6 `pending` + `send_intent_events` + `send_text`；逐环节注入失败与进程崩溃无半状态。Policy 拒绝或 skip/defer 仅 recorded 不存正文。
- [x] AC-T6.3a.3 原始 T5 `claimId` 必须在 DB 中已 claimed、批次完全对应、Proof Epoch 未过期/未换代；同 claim 只能创建一次意图。无可信 claim 的旧 v4 pending 不可升级成可发送。
- [x] AC-T6.3a.4 `reply.delayMs` 生成 `not_before_ms`，写库时拒绝整数溢出及 `expiresAt<=notBefore`；早到/刚到/过期边界已测。**人工 L1 晚批准边界待 T6-3c。**
- [x] AC-T6.3a.5 终态（sent/failed/unknown）即删除正文、过期不可读已实现并测试；**`getSendText`/`mockDispatchCandidate` 的可达性收紧待 T6-3c**（当前仍是 archive 上的公开方法）。数据库明文存储、WAL 与备份敏感性已写入契约，未做加密。
- [x] AC-T6.3a.6 两个连接争用相同 claim/event、预算、Proof 和 pause ABA 均 fail-closed；失败不自动再次调用 Backend，不发送任何真实私信。
- [x] AC-T6.3a.7 提供 v4→v5 显式迁移、幂等和回滚/重启测试；v2/v3/v4 历史兼容。正式库仍 v2，未经备份和独立授权不得迁移。
- [x] AC-T6.3a.8 `pnpm typecheck`、全量单测、git diff --check 通过，并确保测试运行没有真实 Claude 调用、没有 `sendMsg`，T6-3a 成功也不等于真实发送 Gate 通过。

### AC-T6.3b · SDK 文本请求构造与验证（2026-10-31）

- [x] 与本机 `douyin-im@1.1.0` 的 `SendableMessage` 类型兼容：只构造纯 string，不传富文本/群聊/卡片，无 SDK 运行时 import、无 `sendMsg` 或网络执行路径。
- [x] 会话 UID、账号 UID/IM UID、单账号已验证在线、联系人类型/归属 UID、线程号完全相等；`group`、多账号、离线、Blocked/未知状态 fail-closed。
- [x] `intentId` 依照 `conversationId+sourceEventId` 重新计算，必须具备来源 claim、`pending`、0 次尝试、有效 not-before/expiry，过期或未到时刻不能构造。
- [x] 仅原样字符串；空白/控制字符/超过 500 UTF-16 code units/正文摘要不符均拒绝，错误结果不含正文。精确验证延迟与过期边界。
- [x] 9 个专项测试覆盖合法 Friend/Stranger、身份/群/时钟/内容/来源拒绝及源码没有 SDK 运行时发送依赖。
- [ ] 与真实活跃 SDK 实例绑定和从 SQLite v5 读取可信请求的生产路径尚未实现；Builder 的 snapshot 属性并非授权。
- [ ] 平台真实长度计数、`SendMessageResponse` 的成功证据、`SendMessageError` 分类及 L1 审批/一次真实发信均未验收。正式 v2 不迁移。

### AC-T6.3c · 受控发送执行与回执分类（**离线已实现**，2026-10-31）

契约：`docs/contracts/send.md §12`。实现：`src/send/dispatch.ts`。证据：`app/test/send/dispatch.test.ts` 13 条。**全程不接真实 SDK、不调用 `sendMsg`。**

- [x] AC-T6.3c.1 意图、事件组、`ai_claim_id`、`not_before_ms`、`decision_digest`、正文全部从 SQLite 读取，不接受调用方提供；`sendDispatchBinding` 为唯一读取入口。
- [x] AC-T6.3c.2 T5 claim 必须 `state='recorded'`、`decision_digest` 一致、`reply_length` 与正文长度一致；Proof Epoch 必须仍是当前 `coverageEpoch`，否则 `proof_changed`。
- [x] AC-T6.3c.3 L1 审批必须存在、`intentId` 精确匹配、`approvedAtMs <= now < expiresAtMs`；缺失/错配/过期均 `rejected` 且不调用传输层、不改变意图状态。
- [x] AC-T6.3c.4 回执分类封闭（修正版）：`checkCode===8610`→`failed/risk_controlled`；`checkCode===10502`、`statusCode===-3`、以及**任何未经实测确认的非零码**→`unknown/ambiguous_result`；仅 `statusCode===0` 且 `serverMessageId` 非空非 `'0'` → `sent`；超时→`timeout`；无结构化响应的异常→`transport_error`。`platform_rejected` 仅在 `CONFIRMED_REJECTION_CODES` 白名单命中时产生（当前为空，新增码须附实测证据）。
- [x] AC-T6.3c.5 `sent` 只表示服务端回执，不表示对方已显示或已读；`unknown` 永不自动重试；终态删除正文。
- [x] AC-T6.3c.6 claim 之后重新读取绑定并复核**正文、`text_digest`、决策摘要、事件组与 Proof Epoch**，任一变即结算 `failed`；已终结意图再次派发被拒。
- [x] AC-T6.3c.10 正文完整性使用账本保存的 `send_intents.text_digest` 与当前正文重算值比对；等长篡改必须被拒且传输层零调用。禁止用当前正文生成的摘要反喂校验器（自证正确）。
- [x] AC-T6.3c.11 SDK `SendMessageError.response` 必须被结构化分类；异常携带「看似成功」的 response 也不得判 `sent`。
- [x] AC-T6.3c.7 `dispatch.ts` 无 `douyin-im` 运行时依赖、无 `sendMsg`，测试以源码扫描固定该约束。
- [ ] AC-T6.3c.8 **首次真实发送**：真实 SDK 实例绑定、真实 `sendMsg`、服务端回执实测——需单独授权，本阶段未做。
- [ ] AC-T6.3c.9 L1 审批的持久化存储、签名与人工界面未实现；本阶段审批以注入对象传入，只证明「有审批才能发」的判定成立。
