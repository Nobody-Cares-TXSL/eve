# Eve 开发 TODO（D-014 / D-015 生效）

> 状态：T0 已验收（2026-10-28，证据见 `docs/TODO-GATES.md`）；T1～T9 未开始。
> 基线：主仓库 3112198；douyin-im f6eee669c39094224e00c6b877e1964d9da4e393；douyin-bot 8c84980584d555b18eef3dc78daa4e35a121c905；douyin-robot b8eef83c3db7dcb4534f6ce6de93e3b092416403。
> 总目标：Ubuntu 本地、单目标账号、只发文字、L0 AI 自主回复和主动聊天；由程序强制白名单、频率、暂停、幂等及 unknown 禁重发。
> 工作方式：**单 Agent、单工作区、一个 Slice 一次交付**。先 Contract/AC/测试，再写最小实现；不能为了让测试通过而修改已确认 AC。
> 适用性：原 Python doctor 18 个测试和 docs/SLICE_1_GATE.md 是历史已验收基线；下列未勾选任务均不能被视为已实现。

## 复用规则（开工前必读）

| 本地来源 | 已检查的许可 | 可复用范围 | 集成原则 |
|---|---|---|---|
| douyin-im（zhinjs，v1.1.0，本地 f6eee66） | MIT，另有 THIRD_PARTY_NOTICES.md | **直接集成**公开 SDK：Client、Account、Friend/ChatContact、MessageEvent、Session 恢复、getHistory、sendMsg、测试用例 | 首选固定版本依赖与 Platform Adapter；不复制整个 src，不改上游账号数据；如 vendoring/fork，保留 LICENSE 与 THIRD_PARTY_NOTICES 并记录具体 commit |
| douyin-bot（popohuan，本地 8c84980） | MIT | **允许直接选用**适合的 SQL、文本模板、纯逻辑片段并迁移为 TypeScript | 先审计具体片段、留下来源及 MIT 声明；Python 代码不得为了复用而新增常驻 Python 服务 |
| douyin-robot（crazyants，本地 b8eef83） | 未找到 LICENSE/COPYING | **只参考设计**：身份核验、限流、日志、配置、运维，不能复制函数体或注释 | 取得作者有效授权或发现明确许可后再重新评估直接复用 |

- [x] R-01：明确 SDK 接入方式：固定来源和 commit、pnpm 锁文件、构建/导出可用；不能仅依赖被根仓库忽略的本地 douyin-im/ 目录。审查 README、docs/guide.md、LICENSE、THIRD_PARTY_NOTICES.md。
- [x] R-02：整理复用清单（来源路径、commit、许可证、采纳/舍弃原因、需要保留的版权声明）。先检查 douyin-bot/database.py、storage.py、llm_service.py；不照搬已知 SQLite 连接泄漏、昵称匹配、文本哈希去重及浏览器坐标代码。
- [x] R-03：建立 NOTICE.md 并执行**逐片段登记制**（D-018）：每段 MIT 来源代码登记 `eve 文件:行 | 来源仓库@commit | 源文件:行 | 许可证 | 处理 | 理由`，代码头注释指向条目；改译（Python→TS）同样保留原声明。**NOTICE.md 在 T3 开始前建立**，T6 结束全量对账。不要提交上游凭证、真实消息正文、二维码、原始测试报告。
- [x] R-04：D-010 与 CLAUDE.md 同步本复用原则；D-001 对无许可证 douyin-robot 的禁止复制继续有效。

## 开发顺序与依赖

**T0 迁移骨架 → T1 SDK 只读 Adapter → T2 CLI/运行状态 → T3 归档 Contract → T4 对账恢复 → T5 AI 决策 dry-run → T6 安全发送/L0 → T7 长期记忆 → T8 主动聊天 → T9 长期运维。**

优先交付真实可运行的纵切，不提前生成整个项目的空文件树。所有 TS 模块均处于新代码目录，旧 src/dac 和 tests 保持冻结。每个 Slice 的完成标准必须包含：AC 对应、负面路径、可重现命令与输出、Understanding Gate。

### T0 — TypeScript 项目骨架与第三方依赖（第一步）

- [x] T0-1：定义迁移 Contract：新目录、模块依赖方向、Node 24 / pnpm / TS 严格模式、CLI 启动命令；明确 SDK 自身缓存库与 Eve 业务库的独立职责。
- [x] T0-2：接入固定版本的 douyin-im 作为依赖，检查 Client/Account/MessageEvent/ChatContact 公开导出，保留上游许可证与第三方说明；避免引用其 src/ 私有路径。
- [x] T0-3：建立仅本地 mock 的 SDK Adapter smoke test、类型检查、测试脚本；不连接真实抖音、不发送消息。
- [x] T0-4：定义 TS 版 doctor 的 AC，继承旧 D1～D11 的诊断思想，替换 Python、Playwright、.py 扫描为 Node、SDK、目录与凭据边界检查。
- **Gate**：在干净 checkout 中按锁文件安装并执行 typecheck/test 成功；引用 SDK 的公开 API；凭证与测试输出不被 Git 跟踪。

### T1 — Platform Adapter 最小只读纵切

- [ ] T1-1：定义平台端口：login / restore / close、online/offline、单账号身份、私信消息事件、readHistory；显式拒绝群消息和未验证身份。
- [ ] T1-2：直接复用 douyin-im SDK 的登录、Session 持久化、WS 事件，不另造 Passport/协议栈；将 SDK 原始对象转换为 Eve 内部结构，消息 ID 始终以字符串保存。
- [ ] T1-3：白名单过滤发生在任何业务日志、归档、AI 调用前；SDK 自身日志与底层缓存也纳入隐私审查，不能承诺 SDK 传输层完全不接触其他会话。
- [ ] T1-4：会话 UID/账号 UID 不匹配、扫码过期、验证码挑战、Session 失效时进入明确状态，不自动过验证。
- [ ] T1-5：无头登录与验证凭据物生命周期（D-017）：二维码仅写 `<data-dir>/login-qr.png`（600 权限），stdout 提示路径；验证 URL / challenge token 永不入日志；登录成功、超时或取消后立即删除二维码；不建 HTTP 展示或远程推送通道。恢复路径（扫码后如何确认 Session 可用）纳入 T9-4 手册。
- **Gate**：模拟两种身份、群消息、重复事件及登录失效；只能看到唯一允许目标的归一化事件；只读运行绝不调用 sendMsg。

### T2 — TS CLI、可暂停的事件消费者与故障状态

- [x] T2-1：实现 TS 配置校验、doctor --json、status、run、pause/resume/stop、日志脱敏；CLI 合约在开发前确认。
- [x] T2-2：SDK 回调只投递到**有界队列**；单消费者顺序处理，暂停后禁止新业务消费；规定队列满时背压/安全暂停和历史补收。
- [x] T2-3：状态文件区分进程存活与业务阻塞原因，paused_unknown、paused_auth 不得被 PID 死亡覆盖为普通 stopped。
- [x] T2-4：验证控制请求幂等、单实例、SIGTERM 优雅停机和 SIGKILL 重启恢复；退出码与 systemd 策略一致。
- **Gate**：三种配置场景 + 两实例测试 + pause/resume 同 PID + SIGKILL 后阻塞原因不丢；关闭时不会继续执行队列发送。**已达成（55/55，见 docs/TODO-GATES.md T2 段）**

### T3 — Eve SQLite 消息归档（不接 AI）

- [x] T3-1：编写 docs/contracts/archive.md：字段、复合唯一键、读写事务、同步水位、gap / ambiguous、迁移版本及输入输出。
- [x] T3-2：采用 (conversationId, serverMessageId) 幂等归档（id_mode 主路径），保留无 ID 时的保守兜底；不能把内容哈希当事件 ID。
- [x] T3-3：SDK 自带 im-state.sqlite 只作 SDK 缓存；Eve SQLite 是业务记录真相源，消息写入与业务同步水位在一个事务中推进。
- [x] T3-4：以 douyin-bot/database.py、storage.py 的 SQL/历史归档设计为候选，**逐段对照**复用；禁止继承已识别的连接泄漏和昵称键。
- **Gate**：同文两条、双方同文、重放去重、跨会话隔离、无重叠、事务中途异常、进程崩溃恢复测试全过。**已达成（71/71，含真实 SIGKILL 崩溃恢复与真实只读归档现场，见 docs/TODO-GATES.md T3 段）**

### T4 — WS 断线后的分页对账与可信恢复

- [x] T4-1：每次上线/重连安排目标会话 getHistory({ cursor, count, direction }) 分页对账，直至覆盖持久化水位或显式宣布不能确认完整性。
- [x] T4-2：indexInConversation 只作顺序线索，不以固定数值步长断定漏几条；去重按服务端消息 ID。
- [x] T4-3：模拟半开连接、重复推送、重连后乱序、历史超过单页、分页失败、Session 过期、重启时水位回滚。
- [x] T4-4：只有对账完成的可处理消息才进入 AI 队列；恢复期间允许安全只读或停发。
- **Gate**：超过 50 条的漏收历史也能分页恢复；无法恢复时显式状态而非静默跳过；不得出现重复 AI 处理。**应用层 Gate 已达成（2026-10-29，124/124，见 docs/TODO-GATES.md T4-8/T4-9）。真实物理断网与 90s 有效期校准转入 T9。**

### T5 — AI 决策与生成（L3 / dry-run）

- [x] T5-1：先定义 AI 决策结构：reply / skip / defer；生成内容、延迟建议与理由摘要均结构化校验。（Contract + 离线 dry-run；见 docs/TODO-GATES.md）
- [ ] T5-2：按 2026-10-29 新决策，优先 Claude Code CLI 的 Agent Runtime Adapter（仅注册 Claude），保留通用 Model API 接口供以后使用；最小上下文、人格 Prompt、超时、限额与错误退避仍需真实验收。DeepSeek API 原型暂不启用。
- [ ] T5-3：参考 douyin-bot/llm_service.py 的调用流程和可许可复用的模板；douyin-robot/src/prompts.py 仅参考设计，不复制文本。
- [ ] T5-4：离线 fixture 测试不回复、合并连续消息、延迟回复、提示注入、第三方内容伪造指令、模型异常。
- **Gate**：100% 不触发真实发送；能显示完整的 input-event → 上下文 → AI 决策 → dry-run 输出及审计元数据（无正文日志）。

### T6 — L0 自动发送与未知结果保护

- [ ] T6-1：定义 docs/contracts/send.md：发送意图唯一键、pending → dispatching → sent/failed/unknown、错误重试分类、事务及冲突解决。
- [ ] T6-2：pending 落盘成功后、**真正调用 SDK 前**必须持久化 dispatching；重启遗留 dispatching 保守进入 unknown，绝不盲目重发。
- [ ] T6-3：调用 douyin-im Friend/ChatContact.sendMsg，按符合契约的服务端成功回执判 sent；不得宣称对端已显示或已读。
- [ ] T6-4：在程序侧强制执行唯一白名单、频率/静默、消息长度、暂停、身份复核，AI 无权改写；发送前重新验一次。
- [ ] T6-5：用 mock 覆盖响应成功、明确拒绝、超时/断线、进程被杀、并发重复事件、审核拒绝、速率上限和 unknown 人工恢复。
- [ ] T6-6：首次真实发送按 D-015 使用临时 L1 人工确认验收门；人工检查日志/回执后切换正式 L0，**L1 不是最终交互依赖**。
- **Gate**：异常情况下不重复发送、不发错目标；unknown 永不自动重试；常态 L0 可以自行 reply/skip/defer。

### T7 — 长期记忆

- [ ] T7-1：实现固定人格（不可被 AI 覆盖）、近期上下文与 SQLite 长期事实，记录来源消息 ID、更新时间与有效性。
- [ ] T7-2：AI 提取长期事实先进入候选区，人工确认后才进入永久层；不做向量数据库、RAG、LangChain。
- [ ] T7-3：提供命令审查/修改/删除候选与已保存事实；只有与当前回复相关的最小记忆允许进入模型上下文。
- **Gate**：记忆重启仍在；错误推断不自动入永久层；删除后不再注入。

### T8 — AI 主动聊天

- [ ] T8-1：定时器仅唤醒**是否联系**决策；存在未完成话题/明确后续跟进才允许 AI 提议发送。
- [ ] T8-2：静默期、频率上限、对方未回应时不催促及未知发送结果阻断，均由程序强制。
- [ ] T8-3：主动发送复用 T6 同一意图表和三态状态机，不开发第二套发送通道。
- **Gate**：无合理话题时不发送；休眠/重启后不会补发过期计划或形成消息风暴。

### T9 — Ubuntu 24.04 长期运行、可观测与验收

- [ ] T9-1：systemd --user service、重启策略、日志轮转、健康检查；在笔记本休眠、网络切换及断电恢复后保持安全。
- [ ] T9-2：对账号凭证、聊天正文、截图、错误堆栈、测试报告及 node SDK 日志执行脱敏与 Git 泄露检查；凭证只存本机受控目录。
- [ ] T9-3：资源基线（CPU/RAM/SQLite/FD）、7 天稳定性验收，不声称“测试通过”即证明长期可靠。
- [ ] T9-4：编写用户操作手册：首次扫码、恢复凭证、status、pause/resume、unknown 核对、备份及干净卸载。
- **Gate**：按照 PRD 的可恢复、可诊断与 7 天可靠性标准提交证据；所有异常有可操作的状态说明。

## 当前下一步

**R-01～R-04、T0、T1、T2、T3、T4 已完成（证据见 docs/TODO-GATES.md）。下一步：T5 AI 决策与生成（dry-run），仍一次一个 Slice。T5 强制 Gate：领取消息前必须检查 `coverageStatus().usable`，不得仅凭 `sync_state=verified` 或 `eligible_events` 存在就放行。** 下一次开始编程前先完成：本 Slice 的四问、Contract、可重复 AC、测试设计、理解关口。通过后才勾选，未完成任务不提前标记完成。

**当前最重要的边界**：SDK 已验证的是可行性，不是 Eve 整体完成；不修改上游账号凭证，不在未经准备的情况下触发真实自动发送。