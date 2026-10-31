# T6-3a · T5 → T6 决策正文安全交接 Contract v0.1

> 日期：2026-10-31。状态：**设计定稿候选 / 尚未实现 / Gate 未通过**。
> 前提：T5 合法决策与 durable claim 已实现；T6-2b Mock Gate 已通过（253/253）。本节不授权真实模型调用、正式库迁移或抖音发送。
> 相关：`docs/contracts/ai-decision.md`（T5 冻结）、`docs/contracts/send.md`（T6-1～2b）、`docs/AC-TS.md`。

## 1. 核心选择

**不新增 T5 正文表，不改变 T5 对外 DryRunAudit。** 原始 `AiDecision` 仅在受信 Runner / Engine 的内部调用栈中短暂存在。仅通过 T6 Policy 的 `reply` 正文，才准被写到已存在的 `send_text`；`skip` / `defer` / 拒绝项不会持久化回复正文。

**必须原子交接**：不能先单独执行 `finishAiDryRun()` 再执行 `saveSendIntent()`，因为两者各自管理事务，崩溃会留下 recorded 但没有 pending 的状态。为新受信流程提供一个单一的 `BEGIN IMMEDIATE` / `COMMIT`：完成 T5 claim 终结及可选 T6 pending 入库，二者在一次事务内成功或回滚。旧 `durableDryRunOne()` 仍保持审计-only，不得偷偷接发送。

**v4 不原地修改**：v3 是 T5 claim 账本、v4 是 T6 状态机已有基线。为绑定决定来源与真正执行 delayMs，设计 `schema-v5.sql` 并提供显式 `upgradeToV5()`。正式 SQLite v2 不自动升级，不允许生产环境自行补列。

## 2. 信任边界与端口（拟议接口，非现有代码）

```ts
// INTERNAL ONLY: neither public CLI/plugin nor external AgentBackend can call this.
// T5 Backend STILL returns untrusted unknown. Only Engine can validate and pass
// the normalized in-memory decision from validateDecision().
interface ValidatedAiHandoff {
  readonly claimId: string;          // DB claimAiDryRun() 已创建
  readonly proofEpoch: string;       // 该 claim 原始 T4 epoch
  readonly candidateEventIds: readonly string[]; // 由 DB ai_batch_items 取得
  readonly decision: AiDecision;     // normalize 后的、仅暂存内存
}
interface TrustedSendContext {
  readonly singleInstanceHeld: true; // 运行时锁/受信调用层，不接受配置字符串伪称
  readonly ownerUid: string;
  readonly ownImUid: string;
  readonly targetUid: string;
  readonly phase: 'running';
  readonly paused: false;
  readonly nowMs: number;
  readonly coverageMaxAgeMs: number;
  readonly policy: SendPolicyWithoutRecentSends;
  readonly bodyRetentionMs: number;
}
type HandoffResult =
 | {status:'recorded_no_intent'; reasonCode: 'not_reply' | SendRejectCode}
 | {status:'recorded_pending'; intentId:string; notBeforeMs:number; expiresAtMs:number}
 | {status:'blocked'; reasonCode: 'claim_inactive' | 'coverage_changed' |
    'source_invalid' | 'storage_unavailable' | 'policy_invalid'};
```

上面是**行为契约示意**，实现前应以类型擦除安全、受信模块可见性及完整固定错误码为准。不得把带 `decision.text` 的 `ValidatedAiHandoff` 存进日志、请求文件、CLI JSON 或插件消息；返回值中也不得包含正文。纯 TypeScript 字面量标志不等于 OS 级身份认证；安全权限仍依赖 Runner 唯一实例锁和未暴露的内部调用路径。

## 3. 单次生命周期与事务

1. 在可信 Runner 的单实例锁下，以 T4 verified/usable 的 epoch 和 eligible 事件原子认领 T5 `claimId`、`ai_batch_items`（保留现有 claim 语义）；只有已授权的内部运行态才允许启动 handoff 模式。
2. 调用 `AiBackend.evaluate()`（**仅一次**），结果 `unknown` 在 Engine 内经 `validateDecision()`。保持 T5 原有 Agent 超时、取消、Proof 过期和 ABA 复核；任何失败不留回复正文，不允许模型因发送落库异常被自动二次调用。
3. 只有合法 `AiDecision` 进入新的受信 `finalizeAiWithSend()`。内部事务首先读取 claim 当前 `state='claimed'`、会话、目标身份、原始 Proof Epoch 和有序 `ai_batch_items`；不得相信调用方任意提供的 eventIds、会话 ID、决策摘要或伪造的 `recorded` 状态。
4. 在**同一 `BEGIN IMMEDIATE` 事务**内再次查询 T4 `coverageEpoch`，确认与原 claim epoch 一致；检查当前 `eligible_events` 所有成员均合法且未消费，并检查 Runner 在任何 await 之后没有被暂停/停止/断线（外部串行化 + 写事务内能判定的数据库事实，不能仅靠 DB 证明 Runner 状态）。
5. 用已验证的原始 `AiDecision` 计算 `decisionDigest=SHA256(JSON.stringify(decision))`、`replyLength`（UTF-16 code units）、`textDigest=SHA256(reply.text)`；与 T5 现有审计格式一致。**摘要是完整性校验，不是不可伪造的授权凭据**。只用内部决策作为正文来源。
6. `skip/defer`：仅按原 T5 契约原子写入 `recorded` 审计，绝不创建 `send_intents/send_text`。`reply`：通过受信 T6 Policy 的身份、内容、限额、静默、批次和时钟检查，才在同一事务中写 `recorded` 审计 + **一条** `pending` 意图 + 完整事件组 + 一条受限 `send_text`。发送预算必须在事务内最终复核，不得用早前快照放行。
7. 对合法 reply 但 T6 Policy 拒绝：T5 仍记录有效的 `recorded` 决策（仅摘要），结果 `recorded_no_intent` + 固定拒绝码，不留下正文或发送意图；既有 T5 claim 不可因拒发而再领取/重复花费模型额度。
8. 事务/SQLite 异常：整次结算回滚，claim 保持 `claimed`；单实例重启恢复将它标记 `interrupted`，**不再自动请求模型**，也不允许用摘要反推正文或补发。
9. 一次成功 COMMIT 后，重放同一 `claimId` 必须返回已终结/无副作用；不能创建第二意图，更不能覆盖旧 `send_text`。任何发送动作另须通过后续 L1 人工授权 Gate。

## 4. 延迟、保留期、正文读取

- **延迟不得丢失。** `not_before_ms = finalized_at_ms + reply.delayMs`（安全整数相加，拒绝溢出）；`delayMs` 仍以 T5 的 0..600000 为权威界限。未到 `not_before_ms` 不得认领发送（后续 Dispatcher 需要在 SQLite claim 的条件更新中检查，而不仅在应用层 sleep）。
- 设计默认 `bodyRetentionMs = 15 min`，配置最多 60 min；允许更短，但必须严格满足 `not_before_ms < expires_at_ms`，否则拒绝创建意图。过期不自动延长保留、不会重新生成回复；L1 审批超过 TTL 必须拒发。实施时验证该 TTL 与真实使用场景的可行性，不能假设人工始终在 15 分钟内批准。
- 仅 `send_text` 保存归一化后的待发送字符串；T5 `ai_decision_attempts`、`send_intents`、`ai_batch_items`、审计、stdout/stderr、临时 prompt 文件里都**不存额外回复副本**。原始聊天消息已有 T3/T4 的归档存储，不能宣称整个库不保存任何对话内容。
- 读取权限：仅后续经过受信 Runner 上下文、唯一实例锁、有效审批与新鲜 Proof 的发送控制器可读取待发正文；未来的 L1 本机审批查看器需要独立授权和访问审计。通用 `getSendText()` / `mockDispatchCandidate()` 不构成生产读权限，真实阶段必须收紧其可达性。
- `send_text` 到期即不可读；对 `sent/failed/unknown` 尽早清理正文，仅保留哈希和元数据。应用崩溃后由受控启动/清理流程 purge 过期正文，但**清理不得改变 unknown 不重发不变量**。
- 目前 SQLite 存的是**明文正文**，目录/文件 0700/0600 只提供操作系统文件权限，不是加密；WAL、备份和崩溃恢复文件可能保留旧内容。上线前需明确备份与 WAL 的保留/加密策略，不能把“独立表”称为“已加密”。

## 5. 版本演进方案（v5 草案）

在 `schema-v5.sql` 中为发送意图添加新的可信来源绑定与延迟字段（具体约束由迁移实现和测试确定）：

```sql
-- conceptual only; do not execute or mutate schema-v4.sql
ALTER TABLE send_intents ADD COLUMN ai_claim_id TEXT REFERENCES ai_decision_attempts(claim_id);
CREATE UNIQUE INDEX ux_send_intents_ai_claim ON send_intents(ai_claim_id)
  WHERE ai_claim_id IS NOT NULL;
ALTER TABLE send_intents ADD COLUMN not_before_ms INTEGER;
```

- 新 handoff 写入的记录两列均必填、必须有效且与 `ai_batch_items` 完整绑定；**旧 v4 测试/模拟数据若无 `ai_claim_id` 一律不可由真实 Dispatcher 使用**。版本升级时不把旧 pending 自动转换成可发送。
- v5 显式逐级迁移 v2→v3→v4→v5，需离线备份、原子迁移、版本/meta 对齐、回滚/故障注入及重启一致性验收。生产目前仍 v2；本设计不执行迁移。
- 由于 SQLite ALTER 的约束能力有限，强制“新记录必须含 claimId / notBefore”可在新的专用写方法、触发器或新表中实现；不能只依赖 TypeScript 可选属性。不得改写已经提交的 `schema-v4.sql`。
- L1 人工批准凭证及真实 SDK 服务端回执的结构后续再定义；本 v5 草案**不等于发送权限表已上线**。

## 6. 必须满足的失败闭环

| 故障点 | T5 审计 | T6 意图/正文 | 自动再试 |
|---|---|---|---|
| Backend 失败、无效决策、取消 | blocked 或 interrupted | 无 | 否 |
| skip/defer | recorded | 无 | 否 |
| 合法 reply 被 Policy 拒绝 | recorded | 无 | 否 |
| Proof 在推理/结算时换代 | blocked 或 claim 随后 interrupted | 无 | 否 |
| 事务开始后注入崩溃/SQL 错误 | 未提交；旧 claim 仍 claimed | 无半条 | 否 |
| recorded + pending 同事务提交 | recorded | 一条未发送 pending + 受限正文 | **不得自动发送** |
| 重启发现 pending 已过保留期 | recorded | 正文不可读；后续显式关闭 pending | 否 |
| 已有相同 claimId/事件组重放 | 原记录不变 | 无重复/不覆盖 | 否 |

注意 `sent` / `failed` / `unknown` 是后续发送阶段的终态，不是 T6-3a 交接成功时的状态。未经 L1 许可，任何 pending 都不得被真实 SDK 消费。

## 7. 实施顺序及 Gate

1. 先将 T5 冻结 Contract、T6 Contract、AC 和 Gate 同步。保留 `durableDryRunOne` 的既有审计出口，新增私有、受信的内部评估结果交接；公共 Backend 不获得数据库/发送权限。
2. 只在**临时 SQLite v5 + Fake AiBackend** 上做故障注入：验证事务原子性、完整 `ai_batch_items`、Proof ABA、两独立连接争用、replay、取消、预算、`delayMs`、正文 TTL、skip/defer、日志与返回结果泄漏测试。
3. 跑 typecheck、全量测试、版本兼容迁移测试、git diff --check；正式库保持 v2；`sendMsg` 零调用；**模型真实请求 0 次**。
4. 只有上述 Gate 通过，才能标记 T6-3a **离线正文交接功能已实现**。即便通过，真实 Runner 接线、真实 SDK 出站、人工确认、平台长度/成功回执及持续运行仍需各自 Gate，不能在本阶段越过。

**设计门槛：** 若实现无法证明 `recorded + pending + send_text` 处于同一事务，或者任何路径允许未绑定 T5 claim 的正文进入真实发送队列，必须 fail-closed，不能用两段事务/后台重试“先交付再补证据”。
