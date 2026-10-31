# T6 发送契约（T6-1 部分：发送意图与安全校验）

状态：**T6-1 生效**。T6-2 起的持久状态机与平台适配器在本文件后续追加。

## 1. 本 Slice 的范围

**做**：接收一条 T5 的 `AiDecision` 与当前运行上下文，判断是否满足发送条件；满足则生成**可审计的发送意图**，不满足则给出固定拒绝码。

**不做**：不调用 SDK、不调用 `sendMsg`、不写正式库、不发送任何消息、不启动计时器。T6-1 全程离线。

这样切分的理由：发送权限是整个项目风险最高的边界。先把「什么情况下允许发」用纯函数定死并测透，再接状态机与平台适配器。

## 2. 输入

```ts
interface SendCandidate {
  readonly decision: AiDecision;        // 来自 T5，只有 reply 可能产生发送意图
  readonly conversationId: string;      // 权威 threadId
  readonly sourceEventId: string;       // eligible 事件的 serverMessageId（幂等键组成）
  readonly identity: { ownerUid: string; targetUid: string };
  readonly coverage: { usable: boolean; state: string | null };
  readonly runtime: { phase: string; paused: boolean };
  readonly policy: SendPolicy;
  readonly now: number;                 // 注入，便于测试，不读系统时钟
  readonly priorIntents: readonly { conversationId: string; sourceEventId: string }[];
}

interface SendPolicy {
  readonly minIntervalMs: number;       // 两次发送最小间隔
  readonly maxPerHour: number;          // 滚动一小时上限
  readonly maxPerDay: number;           // 滚动 24 小时上限
  readonly silence: { readonly startMinute: number; readonly endMinute: number }; // 本地分钟数
  readonly maxTextLength: number;
  readonly recentSends: readonly number[]; // 已发送时间戳（毫秒），用于频率判断
}
```

`now` 与 `recentSends` 由调用方注入：T6-1 不读系统时钟、不查库，保证纯函数可测。

## 3. 输出

```ts
interface SendIntent {
  readonly intentId: string;        // 由 conversationId + sourceEventId 稳定派生
  readonly conversationId: string;
  readonly sourceEventId: string;
  readonly text: string;            // 正文：发送必需，属敏感数据
  readonly textDigest: string;      // SHA-256，供审计与日志使用
  readonly decisionDigest: string;
  readonly status: 'pending';
  readonly createdAt: number;
}

type SendRejection = {
  readonly ok: false;
  readonly code: SendRejectCode;
};
```

成功返回 `{ ok: true, intent }`，失败返回 `{ ok: false, code }`。**不存在「半成功」**。

## 4. 拒绝码（固定集合，不得扩展为任意字符串）

| 码 | 含义 |
|---|---|
| `not_reply` | 决策不是 `reply`（skip/defer 不产生发送意图） |
| `identity_invalid` | ownerUid/targetUid 非法、相同，或会话不属于唯一白名单 |
| `coverage_unusable` | T4 证明不可用（过期、非 verified、gap/ambiguous） |
| `runtime_not_running` | 运行态非 `running` 或处于暂停 |
| `content_empty` | 正文为空或全空白 |
| `content_too_long` | 超过 `policy.maxTextLength` |
| `content_control_chars` | 含控制字符（`\u0000-\u0008\u000b\u000c\u000e-\u001f`） |
| `duplicate_event` | 同一 `(conversationId, sourceEventId)` 已存在意图（幂等） |
| `rate_limited` | 超出 `maxPerHour` / `maxPerDay` |
| `min_interval` | 距上次发送不足 `minIntervalMs` |
| `silence_window` | 处于静默时段 |
| `invalid_policy` | 策略字段非法（负数、越界、静默区间两端相同等） |

## 5. 关键不变量

1. **幂等键**：`(conversationId, sourceEventId)`。同一服务端消息最多产生一个发送意图；重复调用返回 `duplicate_event`，**不返回第二个意图**。
2. **正文只在意图内**：`SendIntent.text` 是发送必需内容，属敏感数据。日志、审计、错误信息一律只用 `textDigest`，不得打印 `text`。
3. **校验顺序固定**：策略合法性（`invalid_policy`，最先）→ 身份 → 证明 → 运行态 → 决策类型 → 内容 → 幂等 → 频率（`min_interval` 先于 `rate_limited`）→ 静默。顺序固定才能保证同一输入稳定返回同一拒绝码。策略非法属配置错误，优先于任何业务判断返回。
4. **确定性**：除注入的 `now`/`recentSends` 外不读任何外部状态。相同输入必得相同输出。
5. **不预测未来**：本 Slice 不判断「对方是否已读」「消息是否会重复」，这些属 T6-2 的状态机与平台回执。

## 6. 与后续 Slice 的边界

- **T6-2**：把 `SendIntent` 持久化到 SQLite（`status: pending → dispatching → sent/failed/unknown`），事务与重启恢复；`unknown` 禁止自动重试。
- **T6-3**：平台发送适配器，先 Mock。真实发送需 T6-6 的 L1 人工确认门（D-015）。
- 本 Slice 产出的 `SendIntent` 在 T6-2 之前**不落盘**，只在内存中返回，不产生任何持久副作用。

## 7. 验收

- 每个拒绝码至少一条负例测试，断言返回该码且**不**产生意图。
- 幂等：同一事件重复调用只得到一个意图。
- 频率/静默：边界值（正好等于上限、正好在静默区间端点）行为明确。
- 审计安全：测试断言任何输出都不含正文。

## 8. T6-1b：持久化与状态机（SQLite v4）

### 8.1 为什么独立 v4

v3 是 T5 的 AI 决策账本，已有测试基线。发送账本另开 v4，两者独立演进、独立验收，避免修改 v3 影响 T5 证据。迁移为**显式操作**（`upgradeToV4()`），不自动升级正式库。

### 8.2 Schema

```sql
send_intents(
  intent_id PK, conversation_id, source_event_id,
  text_digest, decision_digest, status, attempt, reason_code,
  created_at_ms, updated_at_ms, claimed_at_ms, settled_at_ms, evidence,
  UNIQUE(conversation_id, source_event_id),
  CHECK(每个状态的字段自洽)
)
send_intent_events(conversation_id, server_message_id) PK, intent_id, ordinal
send_text(intent_id PK, body, created_at_ms, expires_at_ms)
```

三条关键约束：

1. **幂等**：`UNIQUE(conversation_id, source_event_id)`，重复提交不创建第二条。
2. **批次不可拆**：`send_intent_events` 以 `(conversation_id, server_message_id)` 为主键——任一事件已属于某意图，新意图即被拒绝并返回既有 `intentId`。这保证 T5 连续消息合并的一批事件不会被拆成多个发送意图。
3. **正文与账本分离**：正文只存在 `send_text`，带 `expires_at_ms`；账本只有摘要。T5 的 `decision_digest` **不能**用来恢复正文。

### 8.3 状态机

```
pending --claim--> dispatching --settle--> sent
                                     \--> failed
                                     \--> unknown
```

- `claim`：`UPDATE ... WHERE status='pending'`，检查 `changes===1`。两个 Worker 不可能同时成功。
- `settle`：`UPDATE ... WHERE status='dispatching'`。终态不可再变，不可再认领。
- `recoverInterruptedSends()`：所有遗留 `dispatching` 一律转 `unknown`（`reason_code='interrupted'`），**绝不自动重发**。必须在取得单实例锁后、处理新意图前调用。

### 8.4 结果判定（封闭集合）

- `sent`：必须提供平台证据（非空 `evidence`，如服务端回执 ID）。无证据不得判成功。
- `failed`：原因必须属于 `SEND_FAILURE_CODES`（`rejected_before_dispatch`、`identity_changed`、`content_rejected`、`budget_blocked`）——即**确定未发送**。
- `unknown`：原因必须属于 `SEND_UNKNOWN_CODES`（`timeout`、`interrupted`、`ambiguous_result`、`transport_error`）——超时、断线、崩溃只能进这里。
- 跨集合使用原因码直接拒绝（`invalid_reason_code`）。

### 8.5 正文保留期

- 保存时写入 `expires_at_ms = now + retentionMs`（`retentionMs` 必须为正整数，由调用方按策略给出）。
- `getSendText` 在 `now >= expires_at_ms` 时返回 `null`——过期即视为不可发送。
- `purgeExpiredSendText(now)` 只删正文，账本与摘要保留供审计。

### 8.6 本 Slice 的边界

**不做**：不接平台发送适配器、不调用 `sendMsg`、不迁移正式 v2/v3 库、不开启真实账号自动回复。T6-2 才讨论平台适配与受控发送 Gate。

## 9. T6-2a：安全组合层（离线 pending 意图）· 2026-10-31

本阶段仅实现 T6-2 的第一段，不等于平台发送适配器或受控真实发送 Gate。新增 `src/send/coordinator.ts`，组合 **T4 当前可用 Proof → T6-1 Policy → T6-1b SQLite v4 pending 账本**。不会调用 SDK、`sendMsg`、模型，也不自动把正式库迁移到 v4。

- 可信身份：Policy 的 `identity` 增加可选 `ownImUid`，适配 SDK 使用 `0:1:<自己的 IM UID>:<目标 UID>` 的线程；`EveArchive.matchSendIdentity` 必须核对它属于已认证 `ownUids`，绝不从线程文本反推可信 IM UID。归档会话白名单还要通过 `coverageStatus` 的 `validThread`。
- 运行态与 Coverage：调用者必须提供 Runner 当前运行态（目前仅离线模拟，尚未接 Runner）；Coverage 的 `verified/usable` 从归档数据库查询，不信任调用者。调用 `coverageEpoch` 获取 Proof ID，`saveSendIntent` 在 `BEGIN IMMEDIATE` 事务内**再次检查同一 Proof Epoch**，失效即拒绝落库。
- 预算与幂等：调用者无法注入最近发送历史。账本 `sendPolicySnapshot` 从 SQLite v4 读取已有意图作为 `priorIntents`，将 `pending/dispatching/sent/unknown` 视为保守的调用预算预留（按意图创建时间统计），仅确定未发送的 `failed` 不占预留；未来时间戳按时钟异常拒绝。随后同一 `BEGIN IMMEDIATE` 写入事务内再次检查最小间隔、滚动小时/24h 配额，避免两个独立 Worker 使用同一旧预算快照同时入库。重复意图和重叠事件组仍按唯一约束指回原意图。
- 事件组：输入 `eventIds` 必须去重、包含 `sourceEventId`、上限 3；违反者给出 `invalid_event_group`，不写账本。T5 决策使用本地 `validateDecision`；非法输出给出 `invalid_decision`。所有错误结果只含固定码、不会返回消息正文。
- 隐私：正文仍仅写 `send_text`，保存期不超过 7 天（实际值由配置传入），返回仅包含 `intentId` 或拒绝码，不记录正文。测试中所有数据为虚构，正式 v2 保持不动。
- v4 兼容缺口修复：`requireV2()` 原仅接受版本 2/3，导致升级到 v4 后 T4 `reconcileOnce` 抛 `reconcile_requires_v2`；现允许 2/3/4，继续拒绝 v1。T4 与 T5 在临时 v4 库上实际集成验证。

**剩余硬 Gate，不得标记完成**：① 当前 `prepareSendIntent` 尚未由 Runner 的真实 T5 决策与经过认证的运行态调用；T5 的 dry-run 审计只保留摘要，尚无安全的决策正文交接/来源证明；② 尚无 Mock Dispatcher 的调度、SDK 回执映射或真实平台发送适配器；③ 发送前的再次验证、过期正文、时区与 UTF-16 字数口径、`UNKNOWN` 结果的人工核查、单实例锁和正式库 v4 备份迁移均待后续 T6-2b / 受控发送 Gate。无独立实际发送授权前，绝不能触发真实 `sendMsg`。

## 10. T6-2b：真实事件归属验证与 Mock Dispatcher（2026-10-31）

**边界：本节只有临时 SQLite v4 与纯内存 MockSendPort。模拟 `mock_sent` 不是平台真的收到消息；此处没有接入真实 douyin-im、没有 `sendMsg` 调用，也没有取得真实发送授权。**

### 10.1 修复 eventIds 可信性漏洞

原 T6-2a Coordinator 仅校验输入 ID 格式，允许调用方编造数字串。现在 `saveSendIntent` 在 Coordinator 提供 `expectedProofEpoch` 的情况下，会在同一个 `BEGIN IMMEDIATE` 事务中，对每个事件 JOIN `eligible_events` 与 `messages`，确认属于确切的 `conversationId`、`eligible_events.state='pending'`、`sender_uid=targetUid`、`from_self=0`、kind=text 且正文非空。不存在、其他会话的 eligible、仅初始基线未 eligible、已 claimed/processed 的事件均返回 `invalid_event_group`，无意图落库。若事件属于 T5 `ai_batch_items`，整组必须与同一 `claim_id` 的全量批次及顺序严格一致，禁止部分、混组或换顺序。

T6-1b 底层直接 `saveSendIntent` 的旧离线测试仍可省略 `expectedProofEpoch`；这是测试级底层存储 API，**不构成生产发送权限**。所有 T6-2 协调流程都必须提供可信 Proof，真正发送阶段也必须独立复核 T5 来源。

### 10.2 T5 来源 Gate（仅 Mock）

`EveArchive.mockDispatchCandidate` 在任何 Mock 调用前同时核对：未过期 `send_text` 与正文 SHA256 摘要一致；匹配一个 `ai_decision_attempts.state='recorded',action='reply'` 的 T5 决策，且 `decision_digest`、`reply_length` 与该次发送完全匹配；发送关联批次与 `ai_batch_items` 全量一致；所有成员仍为当前线程目标用户的 eligible pending；**T5 原 `proof_epoch_id` 必须与当前可用 Proof Epoch 相同**。失败直接 `source_unverified`，不认领、不接触 Mock Port。

`dispatchMockOnce` 仅接受 `MockSendPort` 的实例与显式 `allowMockOnly:true`。运行态/白名单、正文长度在认领前检查，`pending→dispatching` 仍通过原有条件更新；认领后即时再复核 T5 来源，失效则确认未发送并 `failed/rejected_before_dispatch`。Port 整个实现只在内存模拟 `confirmed` / `rejected_before_dispatch` / `ambiguous` / `throws` / `hang`，绝不导入 douyin-im。

**模拟输出：** `confirmed` 只产生 `mock:<SHA256>` 证据并写入测试库 `sent`，外部返回状态 `mock_sent`；模拟明确未发送写 `failed`；模糊结果、异常、超时分别写 `unknown/ambiguous_result`、`unknown/transport_error`、`unknown/timeout`；这三种 `unknown` 绝不再自动认领或重发。所有结果只含固定码和 `intentId`，不回显发送正文。

### 10.3 未完成的真实发送硬 Gate

1. 此 Mock Dispatcher 没有接真实 Runner 的经过认证的运行态/单实例锁，也没有生产 SDK 适配器；测试通过不等于部署安全。
2. T5 目前只持久化决策摘要，正式的模型决策正文如何安全、及时地交接 T6，且避免伪造 `recorded` 证据，仍待设计/验收；本节通过**虚构的 T5 recorded 测试账本**验证来源链，绝不反推历史正文。
3. 生产 SDK 收发的回执 ID 语义、发送前权限复核与中途断线、超时是否实际送达、平台字符计数（UTF-16 与平台差异）、人工 L1 许可、正式 SQLite v2→v4 备份迁移及 UNKNOWN 人工核实均未完成。不得直接复制 `MockSendPort` 的成功判定到真实 SDK。

## 11. T6-3a 正文交接设计入口（2026-10-31）

已建立独立契约 `docs/contracts/ai-send-handoff.md`，并完成**离线实现**（`finalizeAiWithSend` + `schema-v5.sql`，19 条测试）。推荐 T5 不新建正文表；由受信 Engine 在**一次 SQLite 写事务**中把已验证回复的 T5 `recorded` 审计与 T6 `pending` 意图、完整事件组和 `send_text` 一起提交。对 `skip/defer` 或 T6 拒绝只记录 T5 审计，不落回复正文。旧 `durableDryRunOne` 仍只返回脱敏审计，不擅自改变已冻结的 T5 公共契约。

本设计要求独立 SQLite v5 显式迁移：绑定 `ai_claim_id`（原始 T5 claim）和 `not_before_ms`（真实兑现 reply.delayMs），不修改已有 v4 Schema；发送正文默认短期保留 15 分钟、最长 60 分钟，且必须在最早发送时刻后仍未到期。未来分发需有真实 Runner/单实例锁、Proof、L1 人工确认和真实 SDK Gate；本合同**不提供**真实发送权限。
