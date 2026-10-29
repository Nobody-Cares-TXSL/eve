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
