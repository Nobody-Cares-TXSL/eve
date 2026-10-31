# T5 AI 决策 Contract（v0 · 2026-10-29）

## 四问与范围

- 要做什么：从 T4 已持久化的 pending eligible_events 选取唯一目标会话的一条消息，在当前覆盖证明 usable 时交给 AI 做 reply / skip / defer 决策，并生成不含正文的 dry-run 审计结果。
- 证据：使用离线临时 v2 SQLite；API 和 Agent 后端共用 Contract；覆盖失效、非法响应、超时、提示注入、异常均不得发送消息。
- 失败状态：coverage_unusable、no_pending_event、backend_failed、invalid_decision、coverage_lost_after_inference，均须 fail closed。
- 执行链：SQLite 挑选候选 → coverageStatus().usable → 有界上下文 → AiBackend.evaluate → validateDecision → 二次 usable 检查 → 仅 dry-run 审计。
- 本轮非目标：真实模型 API 网络调用、Agent CLI 子进程、插件执行、发送、真正处理状态消费；T5 尚未完成。

## 稳定接口

AiBackend 提供 id、kind（model-api 或 agent-runtime）和 evaluate(request,signal): Promise<unknown>。Model API 和 Agent CLI 内部生命周期可不同，但不得接触平台 Port、发送函数、原始 UID、线程 ID、Token、数据库路径或任意本机工具权限。

AiRequest 包含固定人格指令与有界历史对话 role=user/assistant + text。只传当前授权会话内的必要文字，禁止向 AI 暴露账号、消息 ID、敏感配置或其他会话。历史消息视作不可信用户输入，不能授权工具执行或覆盖系统约束。

AiDecision 使用严格判别联合：
- reply: action=reply，非空且有界 text，短 reason，delayMs 为 0..600000；
- skip: action=skip，短 reason，无 text/delayMs；
- defer: action=defer，短 reason，delayMs 为 1000..86400000，无 text。
所有未知字段和不符合范围的内容都应拒绝；T6 仍需重新执行发送安全审核。

DryRunAudit 仅返回状态、backend 标识/类型、事件 ID 的 SHA-256、action、回复长度和摘要、失败理由码、执行耗时；不含正文、用户名、UID、Cookie、会话地址。

## T4 门控与失败模式

领取前独立检查 coverageStatus().usable；仅 sync_state=verified 或有 eligible 事件不足以授权。
推理后再次检查 usable；推理期间若暂停/离线/过期/重启，丢弃决策，不输出回复内容，不标记 eligible processed。
候选只允许目标 sender 的 text、非空消息、pending 状态；严格限制消息数量和每条文字长度，不越过当前事件位置读取未来消息。
后端报错、挂起、超时、返回 JSON 无效时只给出脱敏错误，不记录输入文本。
本轮 dry-run **不消费 eligible 状态**，避免没有持久化决策表时冒称“只处理一次”；T5 后续 Slice 再接事务 claim + durable audit。

## 扩展路线与 Gate

首个纵切以 FakeBackend 证实统一决策契约、门控和审计；之后接显式配置的 DeepSeek API 和可授权的 Agent Runtime。
Plugin/Tool Gateway 本轮只划边界、不搭通用插件框架。Agent 和插件绝不能自行发送抖音消息。
T5 最终 Gate 尚需：真实 API（显式授权）/限额与退避、连续消息合并、注入和异常负例、持久领取与审计、100% dry-run 无发送。T5 不提前标记完成。

## T5-1 实现注记

现已包含纯 TypeScript DeepSeekBackend：固定官方 HTTPS Chat Completions URL，JSON Output、显式凭据、有限请求次数和输出上限；仅用注入的 mock fetcher 验证，不从 Runner/CLI 自动调用真实外部模型。后端执行前后必须对比 coverageEpoch（实际 verified epoch ID），避免暂停→重新对账后出现 ABA 复活旧决策。可运行的纯 Mock 演示：在 app 目录执行 pnpm t5:demo。完整 T5 的持久 claim/audit、真实模型调用与 Agent 可执行适配尚未完成。

## 2026-10-29 选择变更：当前 Agent 仅 Claude

经用户明确指定，首个实际 Agent 选 Claude Code CLI。AgentRegistry 仅启用 claude_code；DeepSeekBackend 保留在代码中作为 Model API 端口的未启用原型。详情及官方/GitHub 设计依据见 docs/contracts/agent-runtime.md。未经单独授权不得运行真实 Claude 模型；真实消息发送仍在 T6 禁止门之后。

## T5-2 · 持久认领与不重复调用（2026-10-29）

本轮新增显式 v2→v3 迁移（app/src/archive/schema-v3.sql）。**不自动升级正式 Eve 数据库**，升级前须备份、校验和单实例锁；现有 T4 在 Schema v3 上保持兼容。备份脚本和 verify 已兼容 v3，专项测试在临时库验证。

新增表 ai_decision_attempts：每个 (conversation_id, server_message_id) 仅允许一条认领，存储 claim UUID、Proof Epoch、后端 ID/type、认领/完成时间、状态及 SHA-256 事件/决策摘要和 reply 长度。**不得保存正文、模型推理内容、API Key、CLI stderr 或发送指令**。

状态与安全语义：
- claimed：事务中先验证 coverageStatus().usable 和当前 epoch，然后用唯一索引持久认领，再允许调用 Claude。
- recorded：推理完成后仍属于相同 verified epoch，单事务记录 reply/skip/defer 的摘要/长度。该状态仅表示“dry-run 决策已审计”，**不代表已发送**。
- blocked：后端异常、超时、格式非法、取消或证明失效。不可重用旧结果，也不自动重试。
- interrupted：进程在认领后崩溃/退出，单实例重启时由 recoverAbandonedAiClaims 显式把残留 claimed 标为 interrupted，不自动重调付费 Agent。
- 所有结果 fail closed，原 eligible_events.state 仍是 pending；这不是 T6 的发送意图，T6 不得直接消费 ai_decision_attempts 作为发送授权。需另外设计发送意图审批与幂等三态。

执行链：新 API claimAiDryRun → 复用 T5-1 evaluateCandidate → finishAiDryRun（事务中重新检查 Proof Epoch，同步写入摘要）。原 dryRunOne 仍保留为无需 v3 的只读预览，不视为“只处理一次”。durableDryRunOne 仅在显式升级 v3 的测试/受控环境使用，目前没有接入真实 Runner 生产轮询。

失败策略：单条消息最多一次**自动 AI 尝试**，失败不自动重试，后续必须补充人工核查/受控重试策略；这避免无法确定计费或是否完成时无限重试。真实 SIGKILL 子进程验证了认领提交后崩溃→启动恢复 interrupted。

本次实机仅测试临时 SQLite + 虚构账号 Mock SDK / Claude fake transport，未调用真实 Claude、未发送消息、未迁移正式库。

T5 最终 Gate 仍缺：正式 v3 备份迁移及 Runner 接线、真正的 Claude CLI 受控联网验收、上下文连续消息合并、工具沙箱、费率退避和终端审计。上述均不得因本轮测试通过而自动标记完成。

## T5-3 受控 Runner AI dry-run 工作槽（2026-10-29）

T5 的运行时接线使用 Runner 的可选 AiDryRunSlot 注入：backend + maxAttempts（1～10）+ timeoutMs（1～30000）。默认无 AI 槽；此阶段没有允许真实账号触发 Agent 的 CLI 选项，CLI 对 --experimental-ai-dry-run 明确拒绝并返回 2。仅测试代码能显式注入模拟 Claude 后端。**没有生产 AI 常驻行为，也没有网络模型调用**。

只有以下条件同时成立时才尝试认领：已验证账号及唯一目标线程、Runner running、SDK online、T4 reconciler 不在运行且没有未处理的对账请求、消息归档队列 isIdle、当前 coverageEpoch 存在且在 90s 有效期内、未达到本进程 maxAttempts。每次只调用一次 durableDryRunOne，先在 v3 SQLite 原子持久认领，再执行 Backend，后续写入 AI ledger，所有失败 fail closed。单进程 attempts 上限**不是跨进程计费总预算**，正式上线仍需持久的时间窗口预算和退避政策。

T4 实时消息事件先进入原归档队列，**批次事务提交之后**才设置 reconciliationRequested；对账通过才能生成新的 eligible。新消息会立刻 abort 旧 AI（即便同会话）；offline/reconnecting、online 重新绑定、pause、stop、故障阻塞也取消 in-flight Agent。Runner 停机等待 aiRunning 结束之后才关闭 EveArchive，避免挂起任务对已关闭库写入。

Runner 初始化带 AI 槽时，必须看到**已经存在的 v3**；仅调用 recoverAbandonedAiClaims() 将旧 claimed 改 interrupted，不隐式升级正式 v2。随后 T4 启动/重连时照常撤销旧 coverage、重新对账。旧认领不因重启或重新签发 verified 而被自动调用第二次。该恢复方法**必须在单实例锁下执行**；当前测试 Runner 由测试环境控制单实例，CLI 正式运行已有 flock，但本阶段禁止其启动 AI 槽。

验收：9 项 Runner/CLI 专项验证（包括新消息触发对账、新消息取消旧 Agent、SDK reconnecting 取消旧决策、pause、startup v3 约束、旧 claimed 恢复、CLI 不接受无支持的 AI 自动运行开关），真实 Mock 端口和临时 v3 SQLite，零真实 Claude 调用、零抖音发送。

T5 仍未完成：真实 CLI 单次权限与输出兼容验收、跨进程/跨日成本预算、连续消息合并、正式 v3 一致性备份及迁移、真正的 Runner opt-in CLI 接入、人工审核和插件工具安全模型。特别是没有实盘网络授权，不得把本段理解为允许启动真实自动 AI。

## T5-4（部分实现）连续消息合并与跨重启调用限额（2026-10-29）

**边界**：仍是显式开启的内部 dry-run 槽，正式 CLI 不开放 AI 自动运行，也不调用真实 Claude、发送私信或升级正式 v2 数据库。当前 v3 Schema 尚未在正式环境部署，因此本轮直接在 v3 草案中新增 ai_batch_items 表，而不是隐式进行线上 Schema 修改。

### 连续消息如何认领

- AI 一次认领至多 3 条相邻待处理事件（`maxBatchEvents:1..3`，默认 1）。`ai_decision_attempts` 一行表示一次 AI 尝试；`ai_batch_items` 为本次尝试关联所有被认领消息，以 `(conversation_id,server_message_id)` UNIQUE 约束防止任何组内成员再次被其他组领取。两张表在同一个 `BEGIN IMMEDIATE / COMMIT` 事务中写入；崩溃时整组事件也不会被自动重新领取。
- **不能把 SQLite local_id 当消息发生顺序**：T4 历史分页可能按新→旧插入。候选事件和上下文按照可验证的 13 位毫秒 `create_time` 选择，不依赖插入先后；有相同毫秒时间时不跨事件推断顺序。上下文不读事件之后的消息。
- 只有当前授权目标的 pending、无历史 AI 尝试的文本消息、时间单调递增且彼此不超过 15 秒、拼接后总字数不超过 1200，才能合并。出现自己发送的消息、非文本、未建立 eligible、已经认领、超时或超过组上限时立即停止合并；任何已归档事件存在缺失/无效时间戳时，保守退回每条独立处理。
- Runner 在收到实时新消息后先完成持久归档和 T4 对账；`quietPeriodMs` 可配置为 0..15000（默认 0 仅保持兼容测试），等待对方一段时间未再发送才启动新的 AI 槽。新消息仍立即 Abort 正在运行的旧 Agent。真实环境启用前必须单独设置非零静默窗口。
- 合并只生成一次 `AiDecision`，但不会自行向抖音发送消息，也不会把 `eligible_events` 标记成已发送/processed。

### 跨重启限额和退避

- `AiCallPolicy` 的默认保守频控：最近一小时最多 6 次，滚动 24 小时最多 30 次；可设置 `maxPerHour 1..100`、`maxPerDay 1..500`、`minIntervalMs 0..3600000`、`failureCooldownMs 0..86400000`。目前最小间隔和失败冷却的默认值为 0，必须在真实 Claude 上线前配置明确的正值。
- 额度在**同一认领事务**中，根据 `ai_decision_attempts.claimed_at_ms` 计数，包含成功、blocked、interrupted 的尝试。拒绝返回固定码 `ai_budget_hourly`、`ai_budget_daily` 或 `ai_cooldown`，**不创建认领记录、不调用 Claude**；未来时间戳视为时间回拨并关闭门控。这是调用次数预算而非真实美元费用统计。
- 失败冷却检查任何最近一次 blocked/interrupted 的完成时间；进程重启不会清除记录。Runner 对这些拒绝延迟再检查，不将额度拒绝算作一次实际 AI 调用。
- T5-4 剩余 Gate：真实 Claude 单次费用/额度的观测、正式持久预算配置及异常退避、长期运行校准、多条非文本/特殊内容组合、Prompt 注入与人工审批。测试通过不代表 T5 或 T5-4 全部完成。

**上下文排序兼容说明**：如果当前消息没有可信 13 位毫秒时间戳、但有可解析的数字 `indexInConversation`，可以用该字段为**已存在且不晚于当前事件**的归档消息排序以构造有限上下文；不能用索引步长声称不存在漏收，也不能把索引作为连续消息合并的充分条件。两种排序线索都不成立时，AI 上下文只含当前事件。

## T5 功能冻结（2026-10-30）

T5 核心能力已通过端到端证据，接口在此冻结。**冻结不等于 T5 整体完成**；下列三项验收仍开放。

### 冻结的接口（不得随意改动）

| 接口 | 位置 | 冻结内容 |
|---|---|---|
| `AiBackend` | `src/ai/contracts.ts` | `evaluate(request, signal) → unknown`；只接收 `{instructions, turns}`；不持有平台端口、UID、messageId、SQLite 路径 |
| `AiDecision` | `src/ai/contracts.ts` | `reply{text,reason,delayMs}` / `skip{reason}` / `defer{reason,delayMs}`，字段集合精确 |
| `validateDecision` | `src/ai/decision.ts` | 唯一的语义边界：reply 0..600000、defer 1000..86400000、reason ≤120、text ≤500、未知字段拒绝 |
| `DryRunAudit` / `DryRunFailure` | `src/ai/contracts.ts` | 审计只含 action、长度、摘要、错误码；错误码 = `AgentTransportCode` ∪ 引擎自身码，不再二次坍缩 |
| `AgentRuntimeDef` | `src/ai/agent-registry.ts` | 注册表只接受 `capabilities` 全 false 的定义；不支持任意用户命令 |
| 持久认领 | `src/archive/store.ts` | 同一 eligible 事件至多一次自动认领；崩溃后遗留为 `interrupted`，不自动重试 |

改动上述任一接口，需先更新本文件、`docs/AC-TS.md` 对应 AC 与 `docs/TODO-GATES.md` 证据，再改代码。

### 真实 Claude 的特殊约束（实现层必须遵守）

1. **`StructuredOutput` 是唯一允许的工具**。`--json-schema` 依赖它；用 `--tools ''` 或 `--disallowedTools '*'` 会把它一并禁掉，导致 schema 永远无法满足。文件、Shell、浏览器、MCP、发送能力继续禁用。
2. **不得设置 `--max-turns 1/2`**。结构化输出需要额外的工具回合，实测会被截断为 `error_max_turns`。资源边界由 `--max-budget-usd`、传输层超时与输出字节上限共同约束。
3. **输出形态兼容两种**：单个 `result` 对象，或事件数组（取最后一个 `type='result'`）。
4. **模型名不绑定 Anthropic 命名**：由 `EVE_CLAUDE_MODEL` 配置，只做注入安全校验。
5. **权限边界是应用层工具白名单，不是 OS 沙箱**。不得对外声称已隔离文件系统或进程。

### 仍然开放的验收项（进入 T6 后也不得跳过）

- **费用观测**：目前只有单次 `--max-budget-usd 0.10` 上限与调用次数预算表，**没有跨会话的费用累计与告警**。
- **长期异常恢复**：持续运行下的超时、限流、网络抖动的退避策略未做长期验证。
- **正式 SQLite v3 迁移**：正式库仍为 v2；v3 迁移只在临时库验证过，未备份迁移到正式库。
- **真实发送**：0 次。T5 全程 dry-run。

## T6-3a 合同扩展：T5 → T6 正文交接（2026-10-31，**离线已实现**）

**已实现为 `EveArchive.finalizeAiWithSend`（v5）。T5 公共 API 未改动。** 详见 `docs/contracts/ai-send-handoff.md`。保留 `AiBackend`、`AiDecision`、`validateDecision`、`DryRunAudit` 和既有 `durableDryRunOne` 的已验收语义：审计不会回传/持久化回复正文。

后续如启用独立的受信 Runner 发送模式，应在 Engine 的**内部**保留一次已验证的 `AiDecision`，通过新的联合事务入口原子终结 T5 claim 与创建可选 T6 pending；`skip/defer` 与拒发不存正文，事务失败不允许重跑模型。实施之前必须同步更新本文件、T6 send 契约、AC、Gate 并提供新旧路径回归证据。未验收前，T5 仍严格执行 dry-run-only。
