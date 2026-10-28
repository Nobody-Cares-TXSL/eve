# T4 — 断线分页对账与可信恢复 Contract v0.1

状态：**设计草案；尚未冻结、尚未实现、尚未验收**。基线：Git `c77425b`（T3 71/71，真实只读归档已验收）。本文定义恢复的**可证伪条件**，而不是对平台消息绝不丢失的承诺。

## 1. 目标与非目标

- 在启动、Session 恢复、WebSocket 断开/重连以及发现不可信缺口后，使用 T1 `PlatformPort.readHistory()` 对**唯一白名单私信会话**进行有界分页对账，合并 T3 Eve SQLite 归档，避免重复落库、静默跳过和重复进入未来的 AI 决策。
- 允许“无法证明完整”：明确记录 gap / ambiguous / 未验证，停止业务处理门控，保留已成功归档的记录，不能为了让测试通过而把 `verified` 门槛降低。
- **本 Slice 仍只读**：不调用 DeepSeek，不发送、不标记已读、不改变抖音联系人；T5 才生成决策，T6 才发送，T9 才运维七天。
- 完整性范围只针对 SDK 当前历史 API **可检索、可见、未被删除的消息**。平台删除、历史截断、外部隐匿消息、平台端不保证快照一致等不能凭本地证据声称“绝对零丢失”。

## 2. 入口、事件与状态机

- 入口触发：①每次启动且身份已核验；②`system.reconnecting`/ `system.offline` 使现有证明失效，重新 `online` 后开始新 epoch；③T2 队列溢出/消息冲突/非正常退出/人工要求重新对账。**T3 `unverified` 不允许直接跳过首次对账**。
- 一个账户、一个目标 conversation、一个活跃 reconcile epoch。同一 epoch 不可并发读历史或同时签发两个独立水位。epoch 为随机 UUID + 本次受信任身份快照 + 运行实例标识；与进程生命周期有关的旧 epoch 不得在新进程自动签发证明。
- 业务状态：`unverified -> reconciling -> verified`；发生无重叠、分页不前进、未知排除、覆盖证据不足时 `gap` 或 `ambiguous`；进入 `verified` 只能由 §6 的完整事务。
- `verified` 是在一个**已经闭合并落盘的历史核对窗口**内的条件性证明，**不是**“未来始终完整”，也不是允许 T5/T6 立即执行。下一次断线、重启或待处理未归档事件都必须再次关闭门控并核对。
- T2 `phase` 与 T3 `sync_state` 独立：允许进程在线、`sync_state=gap` 但仅做只读诊断；若归档不可用或用户身份失效则使用 T2 `paused_env`/ `paused_auth`（码 3）退出。不能单凭 `run` 是 running 或 `paused_env` 被人工解除就开启 AI。
- 实时消息在对账中仍可**先归档**，但尚未完成覆盖的业务事件必须扣在持久待处理区，不能进入 AI。对账中 SDK 重连、账号 IM UID 改变、`stop` 或信号触发：使 epoch 失效；不得继续在旧 epoch 推进水位。

## 3. PlatformPort 的分页 Contract（必须先改 T1 边界，再写恢复器）

现有 `readHistory(conversationId, cursor?)` 只保证单页、默认向 older、每页请求 50；SDK 公共 `ChatContact.getHistory({cursor,count,direction,includeCurrent})` 支持这些参数。SDK 会在历史结果中按索引升序排列；**排列顺序与 older 游标前进方向不同**。

必须保留现有 `HistoryPage` 字段 `statusCode,hasMore,cursor,direction,messages`，新增或等价提供：
- `rawCount`：SDK 该页返回的原始消息条数（过滤前）；
- `acceptedCount`：成功验证/归一化后进入 `messages` 的数量；
- `excludedCount` 及稳定原因类别：不匹配线程/发送者、删除、未知或不可转换字段、缺关键字段；**不输出被排除正文**。删除/无法验证的排除**不能静默用 `acceptedCount` 冒充完整页**；
- 请求参数 `requestedCursor`、`requestedDirection`、响应 `cursor`、原始 `hasMore`；可在 wrapper 中保留调用参数，不得凭消息索引推导游标。
- 归一化后的 `serverMessageId`、`indexInConversation`、`createTime` 为字符串，绝不转 JS Number；SDK 返回的 19 位消息 ID 和高位游标必须保持精度。
- 回调/SDK adapter 不执行 Eve SQLite 同步 I/O；只能返回纯数据结果与异常。历史页只允许从 SDK 已绑定的目标 `Contact` 拉取；绝不拼假 threadId、读取其他账号/群或调用 `sendMsg`。
- 当前 Adapter 会 `flatMap` 直接丢弃非白名单/删除或归一化失败的行，**T4 实现前必须修补计数和原因报告**，否则禁止签发 `coverageProof`。空的 `messages` 不等于空的原始页。
- SDK 对 `cursor != null` 且 `includeCurrent !== true` 可能排除锚点行；故比较“原始数量 vs 返回数量”时应以 SDK **最终对外返回的** `ChatHistory.messages` 为 rawCount，不能反推平台初始网络包的原始数量。对页边锚点用持久服务端 ID 重叠验证，不能指望 SDK 每页都返回 anchor。

## 4. 分页算法与可停止条件

1. **启动栅栏**：已认证唯一 self UID + IM UID + target UID，归档库可读写；先将目标 conversation 的 epoch 与 `reconciling` 事务落盘，冻结一切未来 AI 可处理输出，才开始历史请求。实时消息可排入持久 archive，但尚未认证的前置事件必须安全阻塞，不可丢弃。
2. **读头页**：`direction=older`、`count=50`、初始 `cursor=null`；保存本次头页中全部可验证服务端 ID（仅有限数量的对账元数据）。获取头部边界，不依赖本地“最大 ID 就是最新”。对页数据逐条做 T3 身份复核和幂等归档。
3. **向旧页推进**：只使用 SDK 的下一页 `cursor`，继续 older；每页的 `statusCode=0`、`direction=older`、`acceptedCount+excludedCount=rawCount`、字段有效；请求 cursor、返回 cursor 与上一次结果构成可审计链。页次不得使用固定索引步长。
4. **边界覆盖**：
   - 有已验证持久锚点：必须在同一白名单会话的这条历史页链中**观察到该服务端 ID 的真实重叠**，且期间无未知排除、接口失败或游标异常；“DB 里已有 ID”不算链中观察到重叠。
   - 初次无锚点：要明确取得 `hasMore=false` 的分页终点，且所有历史页均可验证，才能考虑构建首个基线；单页少于 50 条**不能**当作终点。
   - 不能仅凭返回空页、索引跳号或 `hasMore=false` 本身宣称“历史覆盖闭合”；还要通过头部闭合验证和原始行可观测性检验。
5. **闭合头部并发窗口**：分页期间实时消息继续到达。历史追至锚点/终点后，重新从头读取并与开始时的头部集合和当期实时入库集比较，补收新增部分，直到新头页与已归档的 head 对齐、并且当前实时队列已安全落盘；重复读取的头部发生连续变化则有界重试或降为 gap。SDK 不是快照 API，**不能把一次旧页扫描当成瞬时全局快照**。
6. **限制**：预设有限的每次页数、最大消息数、最大持续时间、单页失败退避次数；失败或达到限制必须持久记录 `gap`/未完成，不得无限循环、也不得从断掉的 cursor 直接当成 verified。
7. **异常页**：`hasMore=true` 却 next cursor 不变/反复出现、方向错误、重复页但无法前进、状态非零、history 页面身份变化、未知行被过滤、`hasMore=true` 且连续空页、客户端取消/SDK Session 失效，均视为不能证明完整。相邻页重复 ID 是允许的正常现象，按 ID matched，但不能让其掩盖游标不前进。
8. **历史不可见**：SDK 无已绑定联系人、历史为空但无法确认初始会话、接口不支持快照闭合、账户或会话不一致 → `unverified/gap`；不制造 synthetic anchor。

## 5. SQLite 对账事务与幂等

- T3 `archiveBatch` 仍是每页写入入口，来源为 `history`，与实时 `live` 共享 `(conversation_id,server_message_id)` 唯一键；相同 ID 的实时/历史重叠是 `matched`，不同 ID 的同文必须保留，冲突身份或正文不得覆盖。
- 每页持久 `epoch_id`、`page_no`、请求/响应 cursor、`hasMore`、数量与接受/排除原因计数、页内 ID 摘要和 batchId。推荐 `batchId=epochId:pageNo`；同 batchId 不同输入则 `batch_conflict`。不得将同一页的未提交消息和“已提交页”元数据拆成两个半事务。
- 新增 T4 schema **v2** 的候选表：`reconcile_epochs`、`reconcile_pages`、`eligible_events`（唯一键同 conversation + serverMessageId）。具体字段、约束、迁移脚本在实施前 AC 中定稿，**不能静默改 T3 v1 表结构**。已有 T3 消息和批次必须无损迁移，`user_version` 与 `archive_meta.schema_version` 事务一致。
- `history_cursor` 是一个请求位置，不是完整性证据，也不能作为已证明水位直接提供给 T5；分页已落盘但 epoch 中断后允许安全重放已存页面或**从头重扫**，不得因残留游标省略未知区间。
- 对 `verified_anchor_id` 的更新必须在**同一个 SQLite 事务**内与最终页面入库、epoch 证据校验、`sync_state=verified` 和 eligible-event 发布一起提交。事务失败全回滚；重启不得看到“标 verified 但消息没入库”或“已允许处理但证明尚未提交”。
- 对于空/非文本/删除等事件：身份与分页完整性证据跟消息是否适合 AI 处理是两回事；可归档的 `non_text` 不自动进 AI；缺 serverMessageId 进入 `uncertain_messages.pending`，不得进入 eligible_events。若存在待确认无 ID、打开的 gap 或语义冲突，不能推进到 verified。
- 同时来自 live/history 的事件只能获得**一个** eligible 记录，T5/T6 后续领取也必须具持久唯一约束和 claim/processed 状态；T4 只实现门控与待处理记录，不调用 AI，不修改发送态。
- 任何能签发完整性证明的结构应只由 reconcile 模块生成，并由 archive 模块在 SQLite 事务里**复核对应的已提交 epoch/page 链**；一个业务调用方传 `{verified:true}` 或自造 `coverageProof` 不足以改变 sync_state。

## 6. coverageProof 的最小必要条件

内部覆盖证据至少引用：`epochId`、受信任账号身份快照、`conversationId`、第一个头页标识、旧锚点（或明确完整枚举终点）、每页已提交/游标链/接受数量的校验摘要、最后的头部闭合标识、最终覆盖上界/下界、生成时间、没有打开 gap 和 ambiguous 的 DB 检查结果。

接受证明的代码必须检查：
- 当前 epoch 仍有效、当前端口仍是相同登录身份，运行时没有 reconnection/stop/pause 风险或未落盘实时队列；
- 非空完整 page 链，无 skipped/failed/unaccounted excluded，未超出有界条件；
- 旧持久锚点在当前页面链内可观察到，或者首次全量枚举确已走到终点；并且最新头部已闭合；
- 所有候选事件已经同事务归档、去重与审计；未解决 gap/ambiguous 会阻止证明；
- `verified_anchor_id` 与可处理 eligible 事件的时间窗一致；**如果任何项无法证明，保持 gap/unverified，不写 verified**。

完整性证据是内部**有限范围的程序证据**，不是平台签名/加密认证，也不能替代平台实际是否完整返回历史的保证。

## 7. 故障与安全状态

| 事件 | 持久处理 | 允许后续 AI/发送？ |
|---|---|---|
| 启动或断线恢复时未对账 | `unverified/reconciling` + gate closed | 否 |
| `hasMore` 页超过 50 条，需要多页 | 继续 older，事务保存各页，不得停在第一页 | 否，直到证明完成 |
| 旧锚点不在可用历史范围 / 无重叠 | `gap`，保留旧锚点与页面证据 | 否 |
| 缺 ID、未知过滤或页链矛盾 | `ambiguous/gap`，保存可确认部分 | 否 |
| 接口超时、非零 status、cursor 循环 | 有限重试；超限持久 gap，需重扫 | 否 |
| Session 失效或身份变化 | 终止当前 epoch；T2 `paused_auth` | 否 |
| SQLite 错误、队列满、未归档事件 | 终止 epoch；T2 `paused_env` | 否 |
| 中途 SIGTERM | 停止新页、完成/回滚当前事务、epoch 不可当 verified | 否 |
| 中途 SIGKILL | 已提交页可恢复；旧进程证明失效，需新 epoch 再核验 | 否 |
| 头部持续变化导致无法闭合 | 有界失败并保存原因 | 否 |
| 完整覆盖+头部闭合+事务提交 | `verified`，生成唯一 eligible 事件 | T4 仍不调用 AI；供 T5/T6 再核验 |

## 8. 交付顺序与 AC/Gate

T4-1：完善 PlatformPort 历史页可观测性，覆盖 SDK 光标与过滤行为；先补 fixture，再实现。T4-2：设计并迁移 SQLite v2 对账 epoch/page/eligibility，测试迁移失败回滚。T4-3：实现有界分页恢复器及重连 epoch/门控，与 T2 queue/runner 合并。T4-4：验证历史超过 50 条、交错实时消息、重连乱序、重复推送、失败/超时和进程强杀。T4-5：只读运行时诊断与 Gate 证据，不启用发送。

**必须测试的反向条件：** 51/120 条翻页、首轮无 anchor 与已锚定重连、18 位以上光标与 19 位 message ID、重复页/不前进/空页、`hasMore=false` 但存在被过滤行、无 ID、群消息混入、历史错身份、历史页 status 错误、闭合头部时新消息涌入、并发 epoch、Page COMMIT 前/后 SIGKILL、v1→v2 回滚、旧 PID 的 proof 重放、反复重启不重复 eligible、停机/暂停期间 gate 关闭、真实只读日志不泄漏正文/UID。

**冻结前必须确认的三个细节：**
1. SDK `readHistory` 的过滤与 `ChatHistory` 排序语义需要负面 fixture；否则 rawCount 与游标链证明不能准确。
2. v2 Schema 的 epoch/page 与 eligible 原子提交边界必须明确；`verified_anchor_id` 的定义为“被证明的恢复锚点”而非最大 messageId。
3. 启动从无锚点的历史终点建立基线、再次扫描头部闭合时，如何在有界情况下分辨持续更新与真正未闭合；无法证明时必须留 gap。

文档不授权直接将 `sync_state` 设为 verified。以 AC-T4.x 和模拟 Gate 冻结后方可进入实现。

## 9. 本轮实施范围与保守边界

- 已落实 T4-1 接口：\`HistoryPage\` 增加过滤前/接受/排除统计、排除类别、缺 ID 数量和请求游标/方向；T1 adapter 通过 \`projectHistoryPage\` 从 SDK **最终返回**的消息序列推导，SDK 内部对 anchor 的过滤无法由此还原。被过滤或缺 ID 不能签发完整覆盖证明。
- 已新增 T4 v2 SQLite Schema，采用 \`EveArchive.upgradeToV2()\` **显式**事务迁移。普通 T3 连接仍建立 v1，新/旧 v1 均不自动升级，v2 也可重新打开。迁移只创建对账元数据表和未来处理资格表，尚无恢复器对这些表进行写入或签发 proof。
- 实施 T4-3 前必须冻结 epoch 页面事务 API、持久状态约束以及真正的完整性证明验证。现有 v2 表存在**不等于**对账完整、历史补收完成或 AI 可用。

## 10. T4-3 第一轮实现（本节取代 §9 中“尚无恢复器”的旧状态）

- 核心：`app/src/runtime/reconcile.ts` 的 `reconcileOnce()` 接受受信任账户、会话、实例 ID 和 isSafe() 栅栏。无锚点须读到 hasMore=false 的终点；旧锚点须在本轮历史页里真实出现。重新读取头页，要求 ID 序列完全相同才能闭合。仅是 SDK 可见范围内的条件性覆盖证明。
- DB：`app/src/archive/store.ts` 的 beginEpoch、recordReconcilePage、failEpoch 和 reconcileStats 均使用 v2 元数据。`schema-v2.sql` 使用 ids_json+ids_digest 留存页 ID 证据。消息归档和页证据同事务；最终 head_close 页、verified 水位和唯一 eligible_events 也同事务。带故障注入测试，不接受外部 `{verified:true}` 直接改状态。
- Eligible：初次基线不把历史旧聊天误当作待处理消息。已锚定后的新增目标文本生成唯一 eligible，复合服务端 ID 去重。T4 不调用 AI、不发送。
- Runner：只有明确启用实验模式才运行 T4；默认 T3 run 不自动迁移数据库。仅从平台验证的消息事件或 T3 已经归档且身份校验后唯一的会话恢复 threadId，绝不拼造会话键。Session 变更、pause、stop 使 epoch 失效，消费队列需空闲。
- 实验模式可能将真实 Eve v1 数据库显式升级至 v2。实盘试用前应备份数据库、完成剩余 Gate；当前不推荐长期无人值守启用。
- 限制：SDK 不是历史快照 API，头部变化会保守留 gap。真实历史分页、SIGKILL 页恢复链、复杂风控/网络失败等尚未验收。T4 不算完成。

## 11. T4-4 强杀与取消的补充约束

- 历史 SDK 请求缺少真正 Abort API，因此只撤销等待与 epoch，不谎称能够取消网络传输。每个 PlatformPort 保留一个 pending 请求栅栏；timeout/abort 后若底层请求仍悬挂，新 epoch 不发第二个并发历史请求，返回稳定失败理由，直到原请求 settle。迟到返回不得归档或改变水位。
- 当前会话完整性与历史已验证锚点分离：`EveArchive.invalidateCurrentCoverage()` 关闭 v2 当前 gate（`verified`、`reconciling` → `unverified`，取消仍活跃的 epoch），不删除 `verified_anchor_id`。T4 实验性 Runner 启动、重连及正常停止均关闭 gate，避免复用旧运行状态。
- 头页闭合要求重新请求头页得到相同的服务端 ID 序列、相同的 cursor 和相同 hasMore；同页重复 ID 不足以证明覆盖。若任何一项变化都持久记录 gap，不降级为 verified。
- 真实子进程 SIGKILL 已新增三条证据覆盖 T4 页面/事务/verified 恢复；**尚不能等同真实 SDK 断线、网络抖动、7 天运维或平台历史绝对完整**。

## 12. T4-5 现场诊断与负载 Gate 状态

- 600 条多页离线负载、三种资源预算拒绝已通过；超限页不得部分提交，保留原始已提交消息但不得签发 verified。测试不宣称 600 条就代表了真实抖音历史接口的吞吐能力。
- 对已登录且仅有一个目标会话的账号，允许 `DouyinReadOnlyPort.readHistory()` 在初次目标 Contact 缺失时，从 SDK `getStrangerList()` 的**本地会话视图**尝试一次重新绑定；只接受目标 UID 与已归档 threadId 双匹配对象。SDK 未能提供绑定时必须拒绝，不通过手工计算 threadId/短 ID 或拓宽白名单绕过。
- 为避免真实 T4 测试破坏 T3 归档，另设默认禁用、加单实例锁和超时保护的只读探针，最多读取 3 页并只输出计数。**本次真实探针仍在 readHistory 失败，未证明分页可用**；尽管账号已验证上线，真实多页历史 Gate 必须保持未完成。不得假设已成功或自动迁移 v1。

## 13. T4-5 真实失败点与身份最小访问边界

- 2026-10-29 的只读诊断码为 `history_local_contact_missing`：已通过真实登录/身份门禁，但 SDK 已绑定联系人缓存与 `getStrangerList()` 本地投影都未找到与目标 UID/threadId 双重匹配的 SDK Contact，因此不能调用 `getHistory()`。此前笼统 `sdk_or_session_failure` 的归因已被缩小。**没有真实历史页证据。**
- SDK `refreshStrangerConversations()` 的实现会从陌生人箱读取多条其他会话及其消息，不是只针对目标 UID 的精确查询。为了遵守单目标/最小访问 Contract，不自动调用，不能将归档 threadId/UID 填入人工构造的 `Stranger.bind`。待授权目标会话由 SDK 正常入站事件或可信同步恢复为真实 Contact 后，才能重试安全只读探针。
- `onHistoryDiagnostic` 回调只返回固定白名单阶段码；原始异常、状态描述、Cookie、token、UID、正文永不穿越此诊断接口。未公开的 SDK 内部 `resolveShortId()` 不能被应用硬依赖，缺少短会话 ID 提示不等于 SDK 无法本地补全；作为诊断布尔值而非擅自拼造地址。
