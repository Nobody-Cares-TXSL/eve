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

## 12. T6-3b：SDK 文本请求构造与参数验证（2026-10-31）

**状态：仅离线构造 / 禁止实际调用。** 新增 `app/src/platform/outbound-request.ts` 的 `prepareSdkTextDraft(input)`，它是一个纯函数：不导入任何 SDK 运行时值，不调用 `Client`、`Account`、`Friend`、`Stranger`，不查询联系人、数据库、网络，不使用时钟。唯一 SDK 引用是 `import type {SendableMessage} from 'douyin-im'`，编译期间验证纯字符串是当前已安装的 `douyin-im@1.1.0` 接受的发送参数形状。**它不能、也不允许进行真实发送或决定发出时机。**

### 已确认的 SDK 接口事实

本机 `douyin-im@1.1.0` 的 `ChatContact.sendMsg(message:SendableMessage):Promise<SendMessageResponse>` 允许将**纯 string**作为文本消息发送参数；`Friend` 与 `Stranger` 继承该接口，但 `Group` 也可能提供发送接口，**绝不可因具有同名方法就允许群聊**。SDK 的联系人有 `uid`、`threadId`、`account`、`conversationType`，`blocked` 属性可为 `undefined`。`SendMessageResponse` 提供 `statusCode`、`statusMsg`、可选 `serverMessageId`、可选 `clientMessageId` 和 `checkCode`；是否服务器确认成功、能否当作 `sent` 的证据与各类 `SendMessageError` 语义需等真实 SDK 适配和受控联调后确定，**本轮不实现成功判定**。上游源码/声明见 `app/node_modules/douyin-im/lib/sdk/contacts/chat-contact.d.ts`、`.../services/im/types.d.ts`；SDK 说明：https://github.com/zhinjs/douyin-im 。

### 纯函数输入与判定

- `intent` 快照：`intentId` 必须等于 `SHA256(conversationId + '\\0' + sourceEventId)`，并带合法 `aiClaimId`、`textDigest`、`pending`、`attempt=0`、`notBeforeMs`、`expiresAtMs`、正文；不接受旧版无来源/无延迟快照。**只有源数据结构检查，不代表函数本身查询过 SQLite v5 或已验证真实 T5 claim。**
- `expected` 白名单：`ownerUid`、`ownImUid`、`targetUid` 全为数字字符串，目标与自有 UID 不同；`session` 必须恰好一个账号，`verified=true` 且 `online=true`，`uid/imUid` 与白名单一致。
- `contact` 只接受 `friend/stranger`；拒绝 `group`、群聊会话 `conversationType=2`、目标 UID 不符、联系人归属账号不符、`threadId` 不完全一致；`blocked=true` 或 `blocked=undefined` 均拒绝（SDK 未返回拉黑状态不能视作未拉黑）。不根据昵称、备注、联系方式或历史会话猜 UID。
- 回复正文只接受非空纯字符串；UTF-16 code unit 上限由 `maxTextLength<=500` 限制，拒绝控制字符、SHA256 摘要不符，不允许转成富文本、链接卡片、群 @ 或任意 JSON。
- `nowMs` 从外部注入，必须在 `[notBeforeMs,expiresAtMs)`；到期和未到执行时间都拒绝。返回要么 `{ok:false,code:<固定枚举>}`，要么 `{ok:true,draft}`；成功 draft 仅包含精确的账号/意图关联元数据与纯文本，**含敏感正文，严禁日志、CLI 输出和持久化副本**。没有自动网络副作用。
- `session/contact` **仍只是快照对象而不是安全能力**。真实发送阶段必须从已经认证且仍在活跃的 SDK `Account` / `Friend|Stranger` 实例重新读取并核对（包括 `contact.account === activeAccount`），在取得独占锁/当前 Proof/有效 L1 审批后重新构造请求；不能让调用者自行伪造 `verified` 或 `contact.blocked` 即获得发送权限。

### T6-3b 范围边界

本阶段不建立 `PlatformPort.send()`，不接 Runner，不读取真实正文库，不调用 SDK 发送、不处理服务端回执、不迁移正式 v2。真实 SDK 成功/失败/超时和 `unknown` 三态分类、发送前原子 `dispatching` 认领、L1 凭证及重启锁、平台 Unicode 长度与风险设置属于 T6-3c 或更后的独立 Gate。绝不把 `prepareSdkTextDraft().ok=true` 当作 `可以发送` 的权限证明。

## 12. T6-3c：受控发送执行与回执分类（离线，不真实发送）

本阶段把「已审批的意图」交给一个**注入的**发送传输层，并按 SDK 回执做三态判定。**不引入真实 SDK 实例、不调用 `sendMsg`**；真实首次发送是单独授权的验收操作。

### 12.1 输入必须是可信快照，且账本为准

- `session`：账号唯一、`verified`、`online`，`uid`/`imUid` 与期望一致。**快照本身不构成活跃会话证明**——真实性由调用方（Runner 唯一实例锁）保证。
- `contact`：只接受 `friend`/`stranger`；`blocked` **直接读真实实例的 `.blocked`**，`undefined` 保留为未知并拒绝（不得映射成 `false`）。
- `transport`：由适配器绑定到已验证联系人的发送通道。本阶段只接受注入的 fake；`dispatch.ts` 不 import `douyin-im`。
- 意图的会话、事件组、`ai_claim_id`、`not_before_ms`、`decision_digest`、正文**全部从 SQLite 读取**，不接受调用方提供。

### 12.2 执行顺序（固定）

1. 读取 v5 绑定：意图必须 `pending`、`attempt===0`、`ai_claim_id` 与 `not_before_ms` 同时存在。
2. 校验 T5 claim：`state='recorded'`、`action='reply'`、`decision_digest` 一致；**正文必须与账本保存的 `text_digest` 比对**（不得用当前正文重算摘要自证）；Proof Epoch 仍是当前 `coverageEpoch`。
3. 校验 L1 审批：`approvalId` 格式、`intentId` 必须精确匹配、`approvedAtMs <= now < expiresAtMs`。
4. 用 T6-3b 的 `prepareSdkTextDraft` 复核会话/联系人/内容/时间。
5. `claimSendIntent` 条件更新（`pending → dispatching`）。
6. **claim 之后重新读取绑定并复核**（正文、`text_digest`、决策摘要、事件组**以及 Proof Epoch**），任一不符立即结算 `failed`。
7. 调用 `transport.sendText(draft.message)`，带超时。
8. 按 §12.3 分类并结算。

### 12.3 回执分类（封闭）

`SendMessageResponse` 字段存在**不等于**送达。判定规则：

| 条件 | 结果 | 原因码 |
|---|---|---|
| `checkCode === 8610`（SDK 明确「内容安全检查未通过，消息未投递」） | `failed` | `risk_controlled` |
| `checkCode === 10502`（已提交但可能审核中） | `unknown` | `ambiguous_result` |
| `statusCode === -3`（SDK 源码 `content.js:326`：缺 `serverMessageId`，**结果无法确认**） | `unknown` | `ambiguous_result` |
| `statusCode === 0` 且 `serverMessageId` 为非空、非 `'0'` 字符串 | `sent` | 证据 = `serverMessageId` |
| `statusCode` 为其他非零值 | `unknown` | `ambiguous_result` |
| 其余（缺 ID、ID 为 `'0'`、字段类型异常） | `unknown` | `ambiguous_result` |
| 超时 | `unknown` | `timeout` |
| 传输层抛异常且无可分类响应 | `unknown` | `transport_error` |

**`failed` 必须是「确定未发送」**。SDK 的非零状态码语义没有实测证据时一律按 `unknown` 处理；`CONFIRMED_REJECTION_CODES` 白名单为空，新增码必须附实测证据并同步本契约。

SDK 会抛 `SendMessageError`，其 `.response` 携带真实 `SendMessageResponse`。分类器**必须优先结构化解析该响应**（`responseFromError`），只有拿不到结构化响应时才退化为 `transport_error`。异常路径即使 response 看起来像成功也**绝不判 `sent`**。

`sent` 只表示**服务端回执**，不表示对方已显示或已读。`unknown` 永不自动重试。

### 12.4 L1 审批的本阶段边界

审批记录以注入对象传入（`approvalId`/`intentId`/`approvedAtMs`/`expiresAtMs`），执行时严格校验作用域与时效。**审批的持久化存储、签名与人工界面不在本阶段**；T6-3c 通过只证明「有审批才能发」这条判定成立，不证明审批系统已上线。

### 12.5 不做

不接真实 SDK、不调用 `sendMsg`、不迁移正式库、不自动重试、不开放 L0、不发送任何私信。

## 13. T6-3c-real-A：真实实例绑定、审批持久化与证据收紧（离线）

本阶段把前一轮「调用方自带快照 + 自带审批对象」的信任假设全部拆除。**仍不真实发送。**

### 13.1 会话快照只能由活实例派生

`src/platform/outbound-session.ts` 的 `deriveSendSession()` 接受真实的 `client` / `account` / `contact`，并逐项核验：

| 检查 | 不成立时 |
|---|---|
| `client.accounts.length === 1` 且 `accounts[0] === account` | `session_unverified` |
| `account.online === true`、`uid`/`imUid` 与期望一致 | `session_unverified` |
| `contact.account === account`（**同一对象引用**） | `contact_unverified` |
| `contact` 由 `account.pickFriend(uid)` 或 `pickStranger(uid)` **真实返回** | `contact_unverified` |
| `contact.uid`、`conversationType === 1`、`threadId` 与期望会话一致 | `contact_unverified` / `foreign_conversation` |
| `contact.blocked === false`（`undefined` 视为未知，保守拒绝） | `contact_blocked` |

`sessionStillLive()` 在发送前重新派生，并**额外校验对象引用**：账号或联系人被替换成字段相同的新实例，同样视为漂移。只比字段会漏掉这种替换。

### 13.2 L1 审批必须是可核验的持久记录（v6）

`schema-v6.sql` 新增 `send_approvals`：

```sql
send_approvals(approval_id PK, intent_id UNIQUE, recipient_uid,
               text_digest, approved_at_ms, expires_at_ms, consumed_at_ms)
```

- 一个意图至多一份审批（唯一索引），终态后无法再批准重发。
- 登记时校验：意图必须 `pending` 且尚未有审批；`text_digest` 必须等于账本 `send_intents.text_digest`；`recipient_uid` 必须等于该库的 `target_uid`。
- 消费用条件更新：`consumed_at_ms IS NULL AND approved_at_ms <= now < expires_at_ms`，且四元组（approval_id / intent_id / recipient_uid / text_digest）全部匹配。**只能成功一次**。
- 审批消费失败时，意图结算为 `failed/rejected_before_dispatch`，不发消息。

审批的**人工界面与签名**仍不在本阶段：这里保证的是「审批必须是数据库里的真实记录，且用过即废」，不是「审批系统已上线」。

### 13.3 `sent` 证据收紧

`serverMessageId` 来自 protobuf Long，必须是 `^[1-9][0-9]{0,63}$`。`'0'`、空串、前导零、非数字、含字母一律**不构成送达证据**，归入 `unknown`。这是对「任意非空字符串都能当 sent」的收紧。

### 13.4 执行顺序（real-A 版）

```
读账本 → 校验 claim/摘要/Proof → 派生会话快照 → 核对会话一致性
→ 校验 v6 审批绑定 → T6-3b 构造器复核 → 原子认领 → 消费审批
→ 发送前再复核（绑定/正文/事件/Proof/实例引用）
→ 注入传输层（带超时）→ 分类结算
```

### 13.5 不做

不接真实 SDK 实例、不调用 `sendMsg`、不迁移正式库、不自动重试、不开放 L0。真实发送属 **T6-3c-real-B**，需单独授权指定接收方与消息内容。

## 14. T6-3c-real-B0：可信出口与人工审批（离线）

拆成两个 Gate：**B0（离线）** 与 **B1（单次真实发送，需单独授权）**。本节只覆盖 B0。

### 14.1 L1 审批必须是人的动作

上一版 `createSendApproval()` 是 `EveArchive` 上的公开方法：任何代码路径都能直接造一条合法审批记录。它校验的是**记录内容合法**，不是**审批者是你本人**。

`src/send/approval-cli.ts` 把批准变成一次本机交互：

- 必须在 TTY 中运行（`canPromptInteractively()`；非 TTY 拒绝，防脚本静默批准）。
- 屏幕同时显示**接收方 UID** 与**完整待发正文**（正文只在本机终端出现，不进日志、不进返回值）。
- 输入必须精确等于 `CONFIRM`——**不做 trim**，`'CONFIRM '`、`'confirm'`、空回车一律取消。
- 登记前用**当前正文重算的摘要**与账本 `text_digest` 比对；只比「两次读到的账本值相同」不够（账本被整体改写时仍会通过）。
- 一个意图至多一份审批（v6 唯一索引），重复批准返回 `unavailable`。

### 14.2 发送能力必须由 Port 内部绑定

`SendTransport` 原是结构接口——任何 `{ sendText() {} }` 都能获得发送路径，「谁能发消息」由调用方决定。这不可接受。

`src/platform/outbound-transport.ts` 引入一次性令牌：

- `issueTrustedSendPort()` 只允许 **DouyinReadOnlyPort 内部**调用（它持有真实 SDK `Contact`）。
- 出口携带 `conversationId` 与 `recipientUid`；`dispatchOnce` 校验它们与意图/审批一致。
- 未登记的出口 → `untrusted_transport`，**传输层零调用**。
- `revokeTrustedSendPort()` 在 Port 关闭时撤销，旧出口立即失效。

注意：TypeScript 的结构类型仍无法**证明**对象来自真实 SDK；令牌机制把「任意构造」降级为「必须经过 Port 内部登记」。真正的证明来自 B1 的真实联调。

### 14.3 B1 的前置条件（未开始）

- B0 全部通过；
- 正式库完成**经批准的备份 + v6 迁移**；
- 操作者明确指定接收方、精确消息内容，并授权**最多一次** `sendMsg()`；
- 遇 `unknown` 不重试、不补发，不自动开启 L0。

## 15. T6-3c-real-B1 前置：真实 SDK 出口与迁移演练（离线）

### 15.1 唯一受控发送出口

`DouyinReadOnlyPort.createTrustedSendPort(conversationId)` 是全项目**唯一**出现 `sendMsg` 的地方：

- 只在 `started && verified && active` 时创建；未上线返回 `null`。
- 只接受属于唯一白名单目标的会话；其他线程一律 `null`。
- 联系人必须已绑定且 `uid === targetUid`。
- 出口携带 `conversationId` 与 `recipientUid`，经 `issueTrustedSendPort()` 登记。
- **每次 `sendText` 前重新核验**：会话失效/账号下线/换号即抛 `send_session_changed`，不调用 `sendMsg`。
- `stop()` 撤销全部出口，令牌立即失效。

### 15.2 doctor D10 语义演进

D10 从「源码零 `sendMsg`」改为「`sendMsg` 只能出现在白名单文件」：

- 出现在 `platform/douyin.ts` 之外 → **fail**，并列出违规文件；
- 完全没有 → ok（只读阶段）；
- 仅出现在唯一出口 → ok，并说明位置。

### 15.3 迁移演练

`scripts/t6-migration-rehearsal.ts <备份>` 在**副本**上执行 v2→v6：

- 逐级迁移，每步校验消息数不变；
- 迁移后校验版本/meta 对齐、消息/批次/会话数保留、`quick_check=ok`、新表齐全；
- 重复迁移幂等；
- 在停在 v5 的副本上注入 v6 失败，验证回滚（仍 v5、无 `send_approvals`、数据完整）；
- 校验源备份 SHA-256 未变；
- **报告不输出 owner/target UID**，只报告身份是否存在。

## 16. 正式库 v2→v6 迁移（受控执行）

### 16.1 迁移不是单一事务

`upgradeToV6()` 只接受 v5。正式库从 v2 出发，实际执行链是**四次独立的显式升级**：

```
v2 --upgradeToV3()--> v3 --upgradeToV4()--> v4 --upgradeToV5()--> v5 --upgradeToV6()--> v6
```

每一步各自 `BEGIN IMMEDIATE` / `COMMIT`。因此**任一步失败时数据库会合法地停在中间版本**，不会整体回滚到 v2。此时不得调用任何「降级函数」，只能按恢复流程用迁移前备份还原。

### 16.2 迁移 Gate（脚本固化）

`scripts/t6-migrate-prod.ts --confirm --backup-dir <dir>`：

1. **确认无人占用**：`lsof` 检查数据库与 `-wal`/`-shm`；`pgrep` 确认没有 `cli.ts run`。
2. **一致性备份**：`VACUUM INTO` 生成快照（含 WAL 已提交内容），校验可打开、版本、消息/批次计数、SHA-256，并写 JSON 清单。
3. **逐级迁移**：每步后校验 `user_version`、`archive_meta.schema_version`、消息数、`quick_check`。
4. **最终核验**：`quick_check`、`foreign_key_check`（零违规）、消息/批次/会话/Epoch 计数与迁移前一致。
5. **失败即停**：不继续下一步、不尝试降级；报告停在哪个版本并给出还原指引。
6. **收尾**：确认 Runner 仍未运行、未启用任何真实发送。

脚本不导入任何发送模块，也不启动 Runner。

### 16.3 迁移成功 ≠ 授权发送

数据库到 v6 只代表具备存储结构。**首次 `sendMsg()` 仍需独立授权**，且必须指定接收方、完整正文与「最多一次」范围。

## 17. 真实 T5→T6 交接通道（2026-11-01）

### 17.1 为什么不能直接塞固定测试文字

T6 的发送意图要求 `ai_claim_id` 绑定一条**真实的 T5 recorded 决策**，且 `decision_digest` 与 `reply_length` 必须与该决策一致。若把一段固定测试文字直接写进 `send_text` 并伪造 `ai_decision_attempts` 记录：

- 等于伪造审计链，破坏「意图必须可追溯到真实模型决策」这一前提；
- 后续任何「只发你批准的那一条」的论证都会失效。

因此**首次发送的正文必须由模型产生**，通道是 `durableDecisionWithSend()`。

### 17.2 通道实现

`src/ai/engine.ts`：

- 抽出 `evaluateBackend()`：调用后端并把结果收敛为「合法 `AiDecision`」或「固定失败码」。与旧 `evaluateCandidate` 的唯一区别是**合法时返回原始决策对象**——T6 需要正文，不能只留摘要。
- 新增 `durableDecisionWithSend()`：`claimAiDryRun` → `evaluateBackend` → `finalizeAiWithSend`。
  - 合法 reply → 同一事务内完成 T5 `recorded` + T6 `pending` 意图 + 受限正文；
  - skip/defer → 只记 `recorded`，不产生意图与正文；
  - 策略拒绝 → 仍记 `recorded`，返回 `recorded_no_intent` + 拒绝码；
  - 后端失败/非法决策 → 只记 `blocked` 审计，无意图、无正文；
  - 推理窗口内 Proof 换代 → `blocked`，不落意图。

`durableDryRunOne()` 行为完全不变（仍只写摘要），既有测试全部保持通过。

### 17.3 仍然不发送

`engine.ts` 不导入 `douyin-im`、不调用 `sendMsg`、不引用 `src/send/`（测试以源码扫描固定）。通道只负责「产生合法的待审批意图」。

### 17.4 Runner 尚未接线（有意为之）

Runner 的 AI 槽仍是 test-only，CLI 对 `--experimental-ai-dry-run` 直接返回 2。在没有授权的启用路径之前把它接到 `durableDecisionWithSend`，只会：

- 在真实运行中生成 `pending` 意图与**真实聊天正文**（写入 `send_text`），却没有可用的派发器；
- 形成无人消费的隐私面。

因此 Runner 接线留到「首次发送授权」那一步，与 L1 审批、单实例锁、派发器一并完成。

## 18. B1 首次发送验收（修订版，2026-11-01）

### 18.1 修订原因

上一版要求操作者**预先指定精确回复正文**，这与产品目标冲突：Eve 要像一个有稳定人格的人那样自己决定说什么，而不是每句话都等人批准文案。同时，接收方 UID 本可由 SDK 从真实入站事件中取得，不应要求人工查找。

**L1 只是一次性的安全验收门槛**（验证第一次 `sendMsg()` 不发错人、不重复、不泄漏），**不是长期产品形态**。验收通过后按证据决定何时开放 L0。

### 18.2 修订后的验收流程

```
真实私信（操作者用另一个号发出）
  → SDK 给出 event.senderUid / threadId / chatType
  → 可信会话检查（单目标白名单、身份、Coverage、频率、运行态）
  → AI 结合上下文与人格自行决策：reply / skip / defer
  → reply 才进入发送链：T5 recorded + T6 pending（正文由模型产生）
  → TTY 展示**实际接收方**与**完整正文**
  → 操作者输入 CONFIRM
  → 最多一次 sendMsg()，禁止重试或补发
```

关键点：

- **不预先指定正文**：正文由模型在该会话上下文中生成；操作者在确认时看到的是最终要发出的内容。
- **不手工查 UID**：接收方来自 SDK 的 `event.senderUid` 与对应 `Contact`，并须通过 `contact.account === account`、`pickFriend/pickStranger` 真实返回、`threadId` 一致等校验（见 §13.1）。
- **AI 可以决定不发**：`skip` / `defer` 是合法结果，验收不要求它必须回复。若模型选择不回复，本次验收视为「未产生发送」，可再用一条新的真实私信重试——**不是重试同一条**。

### 18.3 L1 与 L0 的边界

| | L1（首次验收） | L0（目标形态） |
|---|---|---|
| 谁决定说什么 | AI | AI |
| 谁决定发不发 | AI，但发送前有人确认 | AI |
| 人工介入 | 仅此一次 | 无 |
| 约束 | 单目标、最多一次、禁止重试 | 程序强制白名单/频率/静默/幂等 |

L1 通过不自动等于开放 L0；L0 需要单独的 Gate。

### 18.4 明确不在本次范围

- **多会话准入**：当前 `DouyinReadOnlyPort` 使用固定 `targetUid` 并过滤其他会话。若要「任何好友/陌生人发来消息都能自主回复」，需要把单目标白名单升级为多会话准入 + 分会话限流，这是一次架构扩展，**不能在首次发送时顺带放开**。
- 长期记忆、关系上下文、主动聊天（属 T7/T8）。

## 19. L0 自动回复链路（D-019）

### 19.1 正常路径无人工确认

```
登录（操作者扫码一次，之后 Session 自动恢复）
  → SDK 收到真实私信
  → 识别发送方 / 会话 / 内容
  → 程序验证：白名单、Coverage、运行态、频率、幂等
  → AI 自主决策：reply / skip / defer
  → reply 才进入受控发送通道
  → 受控出口发送 → 三态结算
```

**不再有「发送前等人点头」。** `l1_review` 仅作为可选的人工旁观测试模式存在。

### 19.2 权限二分（D-015 保留部分）

| 权 | 持有者 | 内容 |
|---|---|---|
| 对话决策权 | **AI** | 回不回、说什么、何时发 |
| 安全执行约束 | **程序** | 白名单、频率、静默、暂停、幂等、`unknown` 禁重试、Coverage 有效期 |

AI 不能跳过白名单、静默期与限流；程序不提供可被 AI 输出影响的开关。

### 19.3 实现

`src/send/l0-loop.ts` 的 `runL0Once()`：

1. `durableDecisionWithSend()` —— AI 决策 + 同一事务落 T5 `recorded` + T6 `pending` 意图 + 受限正文；
2. 非 reply（skip/defer/策略拒绝）直接返回，**不发送**；
3. reply 则 `dispatchOnce(..., mode: 'l0_auto')` —— 走全部程序 Gate；
4. 结果映射为 `sent / failed / unknown / send_blocked`。

`dispatch.ts` 的 `mode`：

- `l0_auto`：**不要求审批记录**，也不消费审批；
- `l1_review`：必须存在真实登记且未消费的审批记录（保留为测试模式）。

**任何模式都禁止代码自动调用 `createSendApproval()` 伪造审批。**

### 19.4 隐私

- 待发正文只存 `send_text`，带过期清理，终态即删；
- 日志与审计只记录意图 ID、脱敏身份、正文摘要、决策结果、发送状态与固定错误码；
- **不记录正文，不记录真实 UID**。

### 19.5 范围

本次仅**单会话** L0。多会话准入（任何好友/陌生人自主回复）需单独设计会话准入、分会话限流与隔离，不在本次范围。

### 19.6 尚未接线的部分

`runL0Once()` 已可端到端运行（Fake SDK），但 **Runner 尚未调用它**：需要
单实例锁、暂停栅栏、`createTrustedSendPort` 生命周期与「何时开始自动回复」的
一次性启用开关。真实平台发送仍需操作者单独授权。

## 20. 可信出口的两个 P0 修复（2026-11-02）

### 20.1 P0-1：签发能力曾对所有模块开放

**问题**：`issueTrustedSendPort()` 是公开导出。任何仓库内模块都能导入它，为自己构造的对象登记 WeakSet 令牌——令牌因此**不能证明**对象来自 `DouyinReadOnlyPort`。

**修复**：

- 删除公开的 `issueTrustedSendPort()`。
- 出口类 `FrozenSendPort` **不导出**，构造函数私有；对象创建后 `Object.freeze`，无法改写会话或收件人。
- 签发只能通过 `registerSendPortIssuer(owner, identity)`；该函数要求 `identity` 是经 `claimPortIdentity()` 登记的 Port 身份对象。普通模块无法凭空取得该对象，因此**签不出可信出口**。
- 签发器支持 `revoke` / `revokeAll`；Port `stop()` 调用 `revokeAll()`，旧出口与签发能力同时失效。

### 20.2 P0-2：验证的出口与发送的出口可能不同

**问题**：`dispatchOnce` 校验 `input.trustedPort`，却用 `input.transport.sendText()` 发送。二者没有引用一致性检查——可以「验证 A、发送 B」。

**修复**：

- `DispatchInput` **删除** `transport` 字段，只保留单一 `trustedPort`。
- 校验通过后，所有发送调用只走这个已校验对象：`port.sendText(...)`。
- 回归测试断言：只传 A 时 B 的调用次数恒为 0；源码扫描禁止 `input.transport.sendText` 与 `readonly transport: SendTransport` 回潮。

### 20.3 仍未做

Runner 接线（单实例锁、暂停栅栏、延迟调度、出口生命周期、默认关闭的启用开关）尚未开始。
