# T3 — Eve SQLite 消息归档 Contract v1（待实现）

状态：**Contract v1 固化后开始 Implementation；T3 Gate 尚待验证**。遵循 D-003、D-014、D-018；T1 只读白名单、T2 有界队列及运行状态优先。T3 不接 AI、不发送消息。T4 才负责远端分页对账与“可处理”放行。

## 1. 职责与存储边界

- Eve 业务库：`<app data-dir>/eve.sqlite`；不得将它放进 SDK `accounts/*/im-state.sqlite`，不得直接读写 SDK 内部表。SDK 缓存不可当作 Eve 的业务真相源。
- SQLite 使用 Node 24 `node:sqlite` 的 `DatabaseSync`（已本机确认 SQLite 3.51.2）；本阶段单进程单写入者，数据库访问通过 archive 模块串行执行；禁止把同步 DB 调用放入 SDK 回调。始终显式 close，退出时先停止 intake、消费/归档收敛、再关闭库。
- 初始化时锁定本机目录为 0700、数据库文件及其 WAL/SHM 为当前用户仅可访问；拒绝不可信符号链接。SQLite `foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout` 有界；每次连接明确配置。连接错误进入安全阻塞，不能跳过归档继续执行 AI。
- **账号隔离**：单 Eve DB 仅绑定一个 selfUid 和一个 targetUid。首开库固化 `owner_uid`、`target_uid`；之后启动与配置不符时拒绝读写，禁止清表后悄悄切换身份。UID/服务器消息 ID 全是 TEXT，不转 JavaScript number，不将真实 ID 写入 Git。
- 消息正文在本机归档，敏感。普通日志、doctor、测试报告不得输出正文/昵称/UID。DB 与备份本身属于敏感材料；不要承诺 SQLite 物理文件加密（T3 不提供）。

## 2. 输入、输出及前置过滤

输入为 `PlatformPort` 归一化后的 `InboundMessage`（T1：conversationId、serverMessageId、clientMessageId、senderUid、fromSelf、text、kind、messageType、createTime、indexInConversation）。Archive 接口不 import SDK。身份参数必须从可信平台上线事件经组合根传入，绝不能从 InboundMessage 或外部 JSON 直接认定为已经验证。

**必须先验证白名单再落盘**：会话必须与本库固定的 owner/target 标识精确关联；发送者只能是二者之一（需兼容 T1 使用的 IM UID 对）；fromSelf 与 senderUid 判定一致。不能仅凭看似合法的 conversationId 就接受伪造数据。T3 组合根应传入已验证的 ownUid 集合，由归档层二次校验。任何不符合者返回 `rejected`，绝不写业务表。

输入支持 `source: live | history`、`batchId`（可选）与 `coverageProof`（仅 T4 可签发的可信历史覆盖证据；T3 默认没有）。这些额外元数据属于归档调用参数，**不擅自增加 T1 InboundMessage 字段**。

单条 `ArchiveResult` 为 `new | matched | ambiguous | rejected`（含只供内部追踪的本地 row ID、`requiresReconcile`、安全原因码，不回传正文）。`matched` 只表示相同平台事件 ID 已存，`new` 只表示此次写入成功，**两者都不等于历史已完整或可发送**。

## 3. v1 Schema（规范 SQL；运行时同内容另存于 app/src/archive/schema.sql）

```sql
CREATE TABLE archive_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  owner_uid TEXT NOT NULL,
  target_uid TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  sync_state TEXT NOT NULL DEFAULT 'unverified'
    CHECK (sync_state IN ('unverified','reconciling','verified','gap','ambiguous')),
  verified_anchor_id TEXT,
  history_cursor TEXT,
  last_verified_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  CHECK (sync_state <> 'verified' OR
         (verified_anchor_id IS NOT NULL AND last_verified_at_ms IS NOT NULL))
) STRICT;

CREATE TABLE messages (
  local_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  server_message_id TEXT NOT NULL,
  client_message_id TEXT,
  sender_uid TEXT NOT NULL,
  from_self INTEGER NOT NULL CHECK (from_self IN (0,1)),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','non_text')),
  message_type INTEGER NOT NULL,
  create_time TEXT,
  index_in_conversation TEXT,
  first_source TEXT NOT NULL CHECK (first_source IN ('live','history')),
  archived_at_ms INTEGER NOT NULL,
  UNIQUE (conversation_id, server_message_id)
) STRICT;
CREATE INDEX idx_messages_conversation_order
  ON messages(conversation_id, archived_at_ms, local_id);

CREATE TABLE uncertain_messages (
  local_id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  client_message_id TEXT,
  sender_uid TEXT NOT NULL,
  from_self INTEGER NOT NULL CHECK (from_self IN (0,1)),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','non_text')),
  message_type INTEGER NOT NULL,
  create_time TEXT,
  index_in_conversation TEXT,
  source TEXT NOT NULL CHECK (source IN ('live','history')),
  batch_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('missing_server_id','alignment_ambiguous')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','resolved','dismissed')),
  linked_message_id INTEGER REFERENCES messages(local_id),
  archived_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_uncertain_pending ON uncertain_messages(status,conversation_id);

CREATE TABLE archive_gaps (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  reason TEXT NOT NULL,
  from_anchor_id TEXT,
  to_anchor_id TEXT,
  detected_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER
) STRICT;
CREATE INDEX idx_open_gaps ON archive_gaps(conversation_id,resolved_at_ms);

CREATE TABLE archive_batches (
  batch_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  source TEXT NOT NULL CHECK (source IN ('live','history')),
  request_digest TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  committed_at_ms INTEGER NOT NULL,
  inserted_count INTEGER NOT NULL CHECK (inserted_count >= 0),
  matched_count INTEGER NOT NULL CHECK (matched_count >= 0),
  ambiguous_count INTEGER NOT NULL CHECK (ambiguous_count >= 0)
) STRICT;
```

约束说明：

- `(conversation_id,server_message_id)` 是 **id_mode 唯一身份**；消息的相同文字、时间或 clientMessageId 绝不能代替事件 ID。
- 缺 serverMessageId 的事件**不能插入 messages**；写入 `uncertain_messages` 进入 `ambiguous`，绝不借 SQL NULL 与 UNIQUE 的行为假装完成去重。没有 ID 时相同内容的不同消息不得被消掉。T3 不把文本指纹当主键；未来如做可靠滑动窗口对齐，必须另加可证伪 AC。
- `messages` 的逻辑唯一键严格是复合唯一约束；`local_id` 只是数据库内部引用。只有源消息身份相同、关键不可变字段一致时返回 `matched`；同 key 但正文/发送者矛盾时报告数据冲突并安全阻塞，**不得 `INSERT OR REPLACE` 覆写**。
- `index_in_conversation`、`create_time` 字符串原样保存，不能推导消息数量/假定序号连续，不能当可靠水位。序号仅用于排序及诊断辅助。
- `archive_batches` 的 `batch_id` 是成功批次的重放键。请求摘要为 SHA-256（规范化完整请求、字段位置、消息原始顺序均参与；摘要只用于同请求一致性对比，**绝不**用于消息事件去重），同 ID 同摘要返回先前结果且不增加 uncertain 行；同 ID 不同摘要明确 `batch_conflict` 并拒绝，跨 ID 缺 serverMessageId 的事件仍新建 ambiguous。摘要不能保证无 ID 事件的跨批次唯一性。

## 4. 原子写入与一致性

每次 `archiveBatch(conversationId, messages[], metadata)` 使用同一连接的一次 `BEGIN IMMEDIATE` → 写入/去重 → 记录不确定项、gap 状态及 batch → 根据可信覆盖证据选择是否更新 `verified_anchor_id/history_cursor/sync_state` → `COMMIT`；失败必 `ROLLBACK`，并阻断后续消息消费。**禁止消息已写、业务水位未写（或反之）的半提交**。

- `new` 和 `matched` 都不得自动推动可信覆盖水位。
- live 消息只能标注“已观察到”，不得凭最新 messageId 或 index 推进 `verified_anchor_id`。
- history 页游标只是分页位置，**不是完整性证明**。T4 必须提供证明已覆盖旧锚点或首次完整枚举的 coverageProof，才可在同事务内将 `sync_state` 更新到 `verified`。
- 无可验证重叠、页缺失/失败、断线窗口不明、游标冲突或有 `uncertain_messages.pending` → `gap/ambiguous`；保留旧 `verified_anchor_id` 及审计线索，拒绝标记 verified。
- 初始化无历史锚点为 `unverified`；第一次接收实时私信不是“首次全量同步”。
- 如 T2 队列溢出或进程崩溃，即使存量消息完整，仍须显式设置未验证/待对账状态；不能清除 `paused_env` 就认为消息完整。

## 5. 失败、恢复及迁移

- **跨会话隔离**：数据库 API 必须对整个 batch 校验 conversationId 和发送者；一次输入混入其他会话时整批拒绝、无部分写入。
- **事务中途崩溃**：利用 SQLite 原子提交/WAL 恢复；重启从最后的已提交批次及锚点继续。绝不能通过文本/昵称猜测遗漏事件。
- **中间空洞（gap）**：无重叠只允许先归档确定的消息并显式开 gap，不能据此声称 T4 完整恢复；输入不足以判定时写 pending ambiguous，不能丢弃正文。
- **生命周期**：打开/事务/关闭均由归档模块独占；连接、Statement 不越过模块边界；在 T2 优雅退出的消费收敛以后关闭，不跟 SDK 回调竞争已关闭的 DB。
- **迁移版本**：`PRAGMA user_version` 与 `archive_meta.schema_version` 一致（首版 1）。迁移前核对目标库身份和版本，低版本使用一次受事务保护的升级，高于本程序已知版本则拒绝打开，迁移失败回滚且不修改现有内容。未来破坏性迁移先备份（敏感文件 0600）且单独经 AC/Gate 验证；禁止启动时无提示删表重建。
- 对数据库损坏、空间不足、BUSY 超时、磁盘只读、身份不符、SQL schema 不兼容：安全停止/进入持久 `paused_env` 或不可恢复 `error`，按 T2 的退出码契约处理；不得继续业务消费。

## 6. T3 与 T4 边界 / 验收计划

T3 实现数据库 schema、归档事务、唯一键、uncertain/gaps、只读查询 API、迁移/连接生命周期与 mock 结合；**不实现** `getHistory` 多页网络对账、不声称 verified、不接 AI/发送。T4 才实现 coverageProof 的构造与审核、跨页进度/锚点对齐，且应该新增可处理队列的门控。

必测：相同文字不同 serverMessageId；双方相同文字；同一服务端 ID 重放；不同 conversationId 中同 ID；serverMessageId 缺失（不丢失、标 ambiguous）；冲突 key 不覆盖；混合会话批次全拒；无重叠 gap；批次中故障回滚；WAL 重启恢复；版本不兼容；错误 ownerUid；关闭后拒绝写入；真实账号/凭据不参与测试。

**Source audit / 复用策略**：参考 MIT `douyin-bot/database.py` 与 `storage.py` 的关系模型和窗口对齐想法，但本 Contract 的 SQL 为 Eve 原生设计；当前**不复制上游 SQL/源码**，无需新增 NOTICE 复用账本条目。如果实现阶段决定迁移具体片段，必须先补 `app/NOTICE.md` 逐片段登记，遵守 D-018。避免继承其连接泄漏、昵称键及内容哈希去重。

## 7. 本轮已冻结的实现前两项规则

1. 平台上线状态携带 SDK 自身确认的 `imUid`；归档组合根核对其 `uid === config.selfUid`，只接受该状态的 `[uid,imUid]` 集合。线程 `0:1:owner-or-imUid:targetUid` 可以匹配主 UID 或 IM UID；发件方必须在 ownUids/targetUid 内且 `fromSelf` 完全相符。无认证事件时不得写入；测试含 imUid 不同、自身回显、伪造/串号。
2. `archive_batches.request_digest` SHA-256 覆盖 `conversationId`、`source`、`gapReason`（有/无）、消息数及每条消息全部 InboundMessage 字段，按固定字段次序 JSON 序列化。重复 batchId 同摘要不重复插入 ambiguous；不同摘要报 `batch_conflict` 并回滚。不同 batchId 的无 ID 记录保守保留两条 ambiguous，永不按正文删去。
