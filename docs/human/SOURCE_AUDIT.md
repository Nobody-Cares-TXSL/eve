# 源码审计报告 — SOURCE_AUDIT

> 版本：v1.2
> 状态：阶段 0 交付物（已确认）
> 审计对象：`douyin-bot/`（popohuan）、`douyin-robot/`（crazyants）
> 审计日期：2026-10-22
> 审计方法：逐文件阅读 + 实际运行验证

## 证据类型说明

本报告的结论分两类，**必须区分**：

| 标记 | 含义 | 可信度 |
|---|---|---|
| **[运行]** | 实际执行命令验证过，附命令与输出 | 高——证明代码确实这样运行 |
| **[静态]** | 仅阅读代码，未运行 | 中——只能证明代码这样写，未证明运行时后果 |

> **为什么要区分**：初版把两类混在一起，让整份审计的可信度被高估。
> 复现方法见 `AC.md` AC-0.2 的证据表。

**统计**：P0/P1 共 7 条 —— [运行] 4 条（2.1、2.2、2.3、3.2），[静态] 3 条（2.4、2.5、3.1）。

---

## 0. 结论速览

| 项目 | 许可证 | 能否复制代码 | 本项目是否复制 |
|---|---|---|---|
| `douyin-bot` | **MIT**（`douyin-bot/LICENSE`） | ✅ 法律上可以，需保留声明 | ❌ **不复制**（见 D-010） |
| `douyin-robot` | **无 LICENSE 文件** | ❌ 不可以，默认保留所有权利 | ❌ 不复制 |

**本项目对两个仓库都采用独立实现，只借鉴设计（D-010）。**

`douyin-bot` 虽然 MIT 允许复制，但它的实现带有已识别缺陷（见 §3），
复制会把缺陷一起带进来。统一为「都不复制」也更容易执行和检查。

**技术主干选 `douyin-robot` 是指选它的架构分层，不是选它的代码。**

---

## 1. 许可证审计

### 1.1 douyin-bot

```
MIT License
Copyright (c) 2026 popohuan
```

- 可自由使用、修改、分发、商用，需保留版权声明。
- **风险**：MIT 不提供任何担保。若原项目实现本身有缺陷（本报告列出的那些），不会因为许可证宽松而消失。

### 1.2 douyin-robot

- `git ls-files | grep -i license` → **无结果**
- `README.md` 只有免责声明，没有授权条款
- 无 `COPYING`、`NOTICE`

**法律状态**：默认版权保留（All Rights Reserved）。公开在 GitHub 上**不等于**授权使用。

**行动约束**：
1. 不复制任何 `.py` 文件、函数体、注释到新项目；
2. 可以阅读并**理解其设计思路**，用完全不同的代码结构重新实现；
3. 如果未来需要直接复用，必须先联系作者取得书面授权，或确认其添加了许可证。

> 本报告后续所有「借鉴」条目，均指**设计思想**，不含代码。

---

## 2. douyin-robot 审计

### 2.1 🔴 P0 [运行] — 项目当前无法启动

**现象**（实测）：

```
$ python3 src/main.py --help
AttributeError: module 'selectors' has no attribute 'SelectSelector'
```

**根因**：`src/selectors.py` 与 Python 标准库 `selectors` 同名。

- `src/main.py:11` 把 `src/` 插入 `sys.path[0]`；
- 之后任意 `import asyncio` → `subprocess` → `import selectors` 命中项目文件；
- 标准库被劫持，`subprocess` 初始化失败，程序在 `main.py:2` 崩溃。

**影响**：README 里所有命令全部不可用。该项目**从未在干净环境验证过启动**。

**新项目必须遵守的规则**：
- 禁止任何模块名与标准库同名（`selectors`、`types`、`queue`、`logging`、`json`、`email`、`code`、`parser`、`platform`、`token`、`copy`、`signal`、`socket`、`random`、`statistics`、`secrets`、`typing`、`enum`、`abc`、`io`、`os`、`re`、`time`、`uuid`、`hashlib`、`datetime`、`pathlib`、`tempfile`、`shutil`、`subprocess`、`threading`、`asyncio`、`sqlite3`）；
- 提交前加一条自动检查（阶段 1 的 `cli doctor`）。

### 2.2 🔴 P0 [运行] — 轮询间隔配置完全失效

**证据**：`src/runner.py:377` 调用 `_random_range(cfg["poll"])`，而 `_random_range` 读的是 `min`/`max` 键，配置里是 `cycle_min_seconds`/`cycle_max_seconds`。

**实测**：

```python
_random_range({'cycle_min_seconds': 15, 'cycle_max_seconds': 35})  # → 1.31 秒
```

**影响**：README 承诺「每轮 15–35 秒，低频像真人」，实际**每轮只休息约 1 秒**。这是最容易触发平台风控的一处，且与文档严重不符。

**新项目要求**：配置读取必须有类型化 schema 校验，禁止用 `.get(key, 默认值)` 静默兜底——缺失键必须在启动时**报错**，而不是悄悄用一个无关的默认值。

### 2.3 🟠 P1 [运行] — 每日限额从未生效

**证据**：`rg 'replied_at_day'` 全仓库只有 `reply_engine.py:85` 一处**读取**，`runner.py` 只写 `replied_at`，从不写 `replied_at_day`。

**影响**：`max_per_friend_per_day: 100` 永远拿小时列表计算，日限额形同虚设。

**新项目要求**：任何「限额」必须有对应测试，证明它真的会拦截。

### 2.4 🟠 P1 [静态] — 消息身份依赖纯文本哈希

**证据**：`reply_engine.py:144` `fp = msg_fingerprint(newest_text)`，`state_store.py:19` 对文本做 SHA256。

**问题**：
- 同一句话发两次（「好」「哈哈」）第二次会被判定为已处理；
- 对方先发「好」，我方也发「好」后，文本相同导致误判。

**影响**：阶段 2 的 Contract 不能假设「有稳定消息 ID」，这是**待验证的前置假设**。

### 2.5 🟠 P1 [静态] — 示例配置无法通过校验

**证据**：`config/config.example.json` 的 `whitelist.friends[0]` 的 `name`/`douyin_id` 为空，`ai.api_key` 为空，`ai.base_url` 为空。

- `validate_config` 会因白名单为空抛异常；
- 即使填了白名单，`base_url: ""` 会覆盖 `DEFAULTS` 里的 `https://api.deepseek.com/v1`，导致 `AIClient` 报错。

**影响**：按 README「6 步快速开始」走，第 2 步之后任何命令（包括 `--import-cookie`）都会先撞配置校验。

**新项目要求**：示例配置必须**开箱能跑通 `doctor`**；敏感项缺失时给出精确到字段的提示，而不是抛裸异常。

### 2.6 🟡 P2 — 会话扫描范围硬限制

**证据**：`src/douyin_chat.py:42` `_SCAN_ROW_LIMIT = 40`。

**影响**：只给 `douyin_id` 不给 `name` 时，只扫前 40 行会话。好友多时会漏。

**新项目影响**：因为是单目标账号，此问题可降级——但仍需处理「目标会话不在首屏」的情况。

### 2.7 ✅ 值得借鉴的设计

| 设计 | 位置 | 借鉴理由 |
|---|---|---|
| **按抖音号核验身份** | `douyin_chat.py:405` `_identity_ok` | 昵称可改、备注可改，抖音号相对稳定。身份不匹配时**拒绝读取和回复**，是正确的安全默认值 |
| **`user/info` 接口被动监听** | `douyin_chat.py:130` `_install_user_info_hook` | 不用逆向签名，只旁路已发生的请求拿身份，思路干净 |
| **选择器集中管理** | `src/selectors.py` | 改版时只改一个文件 |
| **发送后确认** | `douyin_chat.py:720` `_confirm_sent` | 不假设点击成功，回读页面确认气泡存在 |
| **故障现场保存** | `douyin_chat.py:771` | 截图 + HTML + 会话列表，排查改版的唯一有效手段 |
| **审计日志 JSONL** | `src/audit_logger.py` | 每动作一行，便于追溯 |
| **模块分层** | 目录结构 | `selectors` / `douyin_chat` / `reply_engine` / `state_store` 职责清晰，纯逻辑与 I/O 分离，可测试性好 |

### 2.8 需重新设计而非借鉴的部分

| 设计 | 问题 | 新方案方向 |
|---|---|---|
| `StateStore` 用 JSON 文件 | 并发写不安全、无事务、无历史 | SQLite + 事务（阶段 2） |
| 去重用「上次指纹」单值 | 只能记住一条，多条连发会漏 | 事件表 + 唯一约束（阶段 2） |
| 频率限制用时间戳列表 | 无日维度、无持久化 | 独立计数表（阶段 2） |
| 上下文只取页面可见 8 条 | 页面滚走后丢失 | SQLite 归档为主，页面为辅（阶段 2） |

---

## 3. douyin-bot 审计

### 3.1 🟠 P1 [静态] — 身份核验比 douyin-robot 弱

**证据**：`bot_manager.py:344`

```python
return !!header && header.innerText.includes('{nickname}');
```

**问题**：按**昵称子串**判断。昵称包含关系（「小明」与「小明同学」）或同名会导致**串话**——把消息发给错误的人。

**新项目**：必须按抖音号核验，昵称只用于定位。

### 3.2 🟠 P1 [运行] — SQLite 连接泄漏

**证据**：`database.py` 全文使用 `with get_connection() as conn:`。

**实测**：

```python
with sqlite3.connect(':memory:') as conn: pass
conn.execute('select 1')   # 成功 → 连接未被关闭
```

`sqlite3.Connection` 的上下文管理器**只管理事务提交/回滚，不关闭连接**。每轮轮询会累积连接。

**新项目要求**：显式 `try/finally: conn.close()`，或使用连接池/单连接 + 队列。

### 3.3 🟡 P2 — 物理坐标硬编码

**证据**：
- `bot_manager.py:292` `{'x': 1200, 'y': 845}`
- `bot_manager.py:357` `{x: 1106, y: 80}`
- `bot_manager.py:312` `r.x > 1300 && r.y > 800`

**问题**：窗口尺寸、缩放比例、DPI 变化即失效。

**新项目要求**：只允许用选择器或相对坐标（相对容器宽高百分比）。

### 3.4 🟡 P2 — 遗留死代码

**证据**：`rg 'from storage|import storage|from config import|from douyin_bot'` 只命中 `douyin_bot.py` 自身。

`config.py`、`storage.py`、`douyin_bot.py` 三者互相引用，但**无任何其他模块使用**，是上一版架构残留。实际生效的是 `database.py` + `bot_manager.py`。

**新项目**：不继承这部分。

### 3.5 🟡 P2 — 提示词与产品不符

**证据**：`database.py:82`「你正在**微信**上自动回复我的女朋友」。

项目是抖音，内置 Prompt 写微信。属于复制粘贴遗留。

### 3.6 🟡 P2 — 数据库文件被提交进 git

**证据**：`douyin-bot/bot_douyin.db`（52KB）在仓库中。

**内容核查**（只读，仅统计）：

| 表 | 行数 |
|---|---|
| friends | 1（昵称 `示例好友`） |
| settings | 7（`llm_api_key` 为空） |
| 其余 | 0 |

**结论**：当前**不含真实凭证或聊天内容**。但 `.gitignore` 未忽略 `*.db`，存在未来误提交真实数据的风险。

**新项目**：`.gitignore` 必须包含 `*.db`、`*.sqlite*`、`state/`、`logs/`、`.env`。

### 3.7 ✅ 值得借鉴的设计

| 设计 | 位置 | 借鉴理由 |
|---|---|---|
| **滑动窗口对齐归档** | `database.py:449` `archive_chat_messages` | 用「已有后缀 vs 新数据前缀」的最大重叠来找增量，比纯文本去重健壮 |
| **长期对话存档表** | `database.py:254` `friend_chat_history` | 持久化上下文，不依赖页面可见范围 |
| **全局指令 / 人格 / 知识库三层 Prompt** | `database.py:15/80/126` | 分层合理：通用行为约束、角色风格、事实记忆各司其职 |
| **物理输入 + 双重发送** | `bot_manager.py:272` `_send_reply` | 先 Enter，检测输入框未清空再点发送按钮，提高成功率 |
| **风控检测与提示** | `bot_manager.py:104` | 明确区分「验证码」与普通错误 |

### 3.8 需重新设计而非借鉴的部分

| 设计 | 问题 | 新方案方向 |
|---|---|---|
| 按昵称匹配 | 可能串话 | 抖音号核验 |
| `with` 管理连接 | 连接泄漏 | 显式关闭 |
| 坐标点击 | 脆弱 | 选择器优先 |
| 文本对齐去重 | 同文异事件误判 | 事件表 + 稳定 ID（若可得） |
| 内置 Prompt 库 | 耦合业务 | 人格文件外置 |

---

## 4. 交叉对比

> **历史候选方案评估**（§4–§7）：两参考项目的浏览器路线对比，
> 保留作选型依据；现行方案见 §8 与 D-014。

| 维度 | douyin-bot | douyin-robot | 新项目选择 |
|---|---|---|---|
| 身份核验 | 昵称子串（弱） | 抖音号（强） | **抖音号** |
| 数据存储 | SQLite | JSON 文件 | **SQLite** |
| 归档算法 | 滑动窗口对齐 | 无（只用页面） | **借鉴滑动窗口，重新定义** |
| 去重 | 哈希 + 2 小时窗口 | 单个指纹 | **事件表 + 唯一约束** |
| 发送确认 | 检查输入框清空 | 回读气泡 | **回读气泡** |
| 故障现场 | 仅日志 | 截图 + HTML + 会话 JSON | **截图 + HTML + 会话 JSON** |
| 交互 | Web 控制台 | CLI | **CLI** |
| 测试 | 无 | 无 | **必须有** |

---

## 5. 两个项目的共同缺陷

1. **零测试**。`fd 'test_|_test'` 在两个项目中均无结果。`reply_engine`、`config_loader`、`state_store`、`archive_chat_messages` 都是纯逻辑，本该最易测。
2. **无依赖锁**。`requirements.txt` 只有下限，无 `requirements.lock` 或 `pyproject.toml` 固定版本。Playwright 大版本升级可能破坏行为。
3. **无 CI**。没有 lint、类型检查、测试的自动化。
4. **未区分发送三态**。两者都把「点击发送」当作「发送成功」，无法处理 `unknown`。
5. **无优雅停机**。`douyin-bot` 的 `run()` 是 `while True`，无信号处理。

---

## 6. 对阶段 0～2 的直接输入

| 审计发现 | 影响的阶段 | 必须采取的行动 |
|---|---|---|
| douyin-robot 无许可证 | 全部 | 独立实现，不复制代码（D-010） |
| `selectors` 命名冲突 | 阶段 1 | 模块命名规范 + `doctor` 自检 |
| 配置静默兜底 | 阶段 1 | 强类型 schema，缺键即报错 |
| **日限额未生效** | **阶段 2（数据层）+ 阶段 4（行为层）** | 阶段 2 建计数表并验证读写（AC-2.11a）；**拦截行为移至阶段 4** |
| 消息无稳定 ID | **阶段 2/3** | 阶段 2 的 Contract 原生支持 `id_mode` / `no_id_mode`（D-003）；阶段 3 只验证能否拿到 ID，不阻塞阶段 2 |
| 昵称匹配可串话 | 阶段 3 | 抖音号核验，不匹配即拒绝 |
| SQLite 连接泄漏 | 阶段 2 | 显式关闭 + 连接使用约定 |
| 无测试 | 阶段 2 起 | 每个 Slice 必须带测试 |

> **修正**：初版把「日限额未生效」整体归到阶段 2，但阶段 2 不实现发送，
> 无法验收「拒绝发送」。已拆分为数据层（阶段 2）与行为层（阶段 4）。

---

## 7. 结论

- **可以借鉴设计的**：身份核验流程、选择器集中管理、发送后回读确认、故障现场保存、滑动窗口归档、Prompt 分层。
- **必须重新实现的**：配置系统、状态存储、去重、频率限制、发送状态机。
- **必须放弃的**：douyin-robot 的全部代码（许可证）、douyin-bot 的昵称匹配与坐标点击。

---

## 8. douyin-im 验证（2026-10-27）

第三个候选接入方案：`zhinjs/douyin-im` v1.1.0，TypeScript，MIT，纯 Node 走 WebSocket。

### 8.1 验证结果

| 项 | 结果 | 证据 |
|---|---|---|
| 登录真实账号 | ✅ **通过** | 扫码 + mobile-sms 二次验证，约 3 分钟上线 |
| 消息标识可靠 | ✅ **通过** | `serverMessageId` 唯一，见 §8.2 |
| 收发消息 | ✅ 通过 | 收 50+ 条，发 1 条，回执见 §8.6 |
| Session 持久化 | ✅ 已落盘 | `account.json` + `im-state.sqlite` |
| **重启恢复** | ✅ **通过**（优雅退出后；早期 `kill -9` 误判已纠正，见 §8.4） | SIGINT 退出后重启，直接上线无需扫码 |
| **断线重连** | ✅ **通过** | 1.2 秒重连、补收无重复；半开窗口有固有漏收窗口，需 `getHistory` 对账兜底（§8.5） |
| 发送状态语义 | ✅ **通过** | `statusCode` + `serverMessageId` 可判三态（回执层级=服务端接收，见 §8.6） |
| 平台风险接受 | ✅ **操作者已接受**（2026-10-27） | 两个号均属操作者本人；接受限流/封禁风险 |

**七项技术检查记录通过，另有一项风险接受声明（不是技术测试）。** 成功分支有真实联调证据，异常与长期运行分支尚未全面覆盖。已发现的遗留风险：
凭据失效时需人工删凭据重扫（§8.4）；半开窗口漏消息靠重连后对账找回（§8.5）。

### 8.2 消息标识（关键发现）

**存储层**（`im-state.sqlite` 的 `messages` 表）：`conversation_id` / `message_key` / `create_time` / `payload`。

**事件层**（`MessageEvent`，见 `src/sdk/events/message.ts:19`）：

| 事件字段 | 落盘字段 | 示例 | 稳定性 |
|---|---|---|---|
| `serverMessageId` | `payload.msgId` | `7701247709714892345` | ⭐ **服务端唯一** |
| `clientMessageId` | `payload.clientMessageId` | `3024bcd1-e258-...` | 客户端 UUID |
| `indexInConversation` | 同名字段 | `1672502401420000` | 会话内单调递增 |
| `senderUid` | 同名字段 | `10000000000002` | 判断方向 |
| `messageType` | `payload.msgType` | `7`=文本 | 枚举未穷举 |
| `content.kind` | — | `'text'` / `'image'` / ... | 语义分类，比数字可靠 |

> **注意字段名不一致**：落盘是原始协议 JSON（`msgId`/`msgType`），
> 事件对象是 SDK 包装后的（`serverMessageId`/`messageType`）。
> **接入层必须做映射，不能让原始结构渗透到业务层**——这正是 Platform Adapter 的职责。

**同文异事件验证**（关键）：

对方连续发的多条消息，`serverMessageId` 各不相同：

```
s:7701258778709001787  idx=...1330000
s:7701258806836479525  idx=...1350000
s:7701258832983262769  idx=...1360000
```

**这证明 `serverMessageId` 能区分「内容相同但事件不同」**——
正是 `douyin-bot` 用文本哈希解决不了的问题。

**结论**：`(conversationId, serverMessageId)` 可直接做复合主键，去重无需文本比对。

### 8.3 发现的缺陷

**退出时 `database is not open`**：

```
WARN WebSocket error: Error: database is not open
    at SqliteImStateStore.getFrontierCursors (state-store.ts:1062)
```

SQLite 连接先关闭，WS 回调仍在读 `frontier` 游标。
正常退出无害；异常断线时可能影响游标落盘。

> **实测未复现影响**：§8.5 的两次断线重连均无重复投递，游标恢复正常。
> 该缺陷的严重性降级为「退出路径的日志噪音」。

### 8.4 重启恢复（通过——修正早期误判）

**最终结论：优雅退出后重启，Session 正常恢复。**

```
[20:44:58] ✓ WebSocket 已连接
           qrRequired: false
           note: 'Session 已恢复，无需扫码'
```

**早期误判的根因（记录以免重蹈覆辙）**：

最初三轮测试都报 `code=13 rejected session`，据此得出「重启恢复失败」——**错了**。
那三轮的共同点是用 `kill -9` 强杀进程：

| 退出方式 | 下次启动 |
|---|---|
| `kill -9`（无 logout，服务端 session 未注销但本地凭据与最后刷新的 ticket 绑定失效） | ❌ `code=13` |
| SIGINT / 正常流程退出 | ✅ Session 直接恢复 |

**教训**：验证「重启恢复」必须模拟真实退出路径（systemd 会发 SIGTERM），
不能只 `kill -9` 再下结论。本次差点把可用能力误判为阻断项。

**仍存在的两个真实问题**：

1. **`code=13` 不降级扫码**（`src/sdk/account.ts:853`）：session 真过期时，SDK 直接抛异常，
   不会自动回到扫码流程。触发概率低（需异常退出），但发生后**必须人工删凭据**。
2. **账号目录扫描不过滤**（`src/store/account-store.ts:57`）：`accounts/` 下任意子目录
   都被当账号读取。备份/迁移凭据时**不能靠改名**，必须移出该目录。

**对项目的影响**：正常运维（systemd 重启、崩溃后重启）均可自动恢复；
仅在「凭据彻底失效」时需要一次人工扫码。

### 8.5 断线重连（通过，但有一个必须兜底的窗口）

**重连机制**（两轮 SIGSTOP 实测，模拟网络中断）：

```
[16:40:31] WARN WebSocket 断开 code=3003 reason=ping timeout
[16:40:33] INFO ✓ WebSocket 已连接     ← 1.2 秒重连
```

| 项 | 实测结果 |
|---|---|
| 断线检测延迟 | 30s 挂起不触发，70s 触发 → 心跳超时约 60s |
| 重连耗时 | ~1.2 秒 |
| 退避策略 | 指数退避封顶 30s，**永不放弃**（读源码 `reconnect.ts` 确认） |
| 事件 | `system.reconnecting`（attempt/delayMs）→ `system.online` |
| 重复投递 | 全量消息 53 条 / 唯一 key 53，**0 重复** |

**完全断线期间的消息补收**：✅ 正常（142-144 三条在重连后完整补收，序号连续）。

**⚠️ 半开窗口会漏消息**（实测发现）：

对方在「进程挂起恢复后、ping timeout 检测到断线前」发的 5 条消息（序号 137-141），
旧 socket 已被服务端 FIN（CLOSE-WAIT，4963 字节滞留内核缓冲区），消息进了 TCP 缓冲
但从未到达应用层；重连后的服务端补推**也不覆盖这几条**。
本地序号 `...136 → ...142` 出现跳号。

显式调用 `friend.getHistory({count:50})` 拉取服务端历史后，5 条全部补回，0 重复。

**规律**：重连补得了「连接死透期间」的消息，补不了「半开窗口（最长约 60s）」期间的。
这是 WebSocket 接入的固有窗口，不是 SDK 缺陷。

**对 dac 架构的要求**（Platform Adapter 必须实现）：

1. **缺口线索**：`indexInConversation` 只作顺序参考；数值差不等同于消息条数，不能只凭跳号断言缺失。
2. **重连后对账**：每次 `system.online`（含重连）后按游标分页执行 `getHistory()`，直到验证覆盖已保存的同步水位；单次 `count:50` 成功不代表长时间断线的完整补收。
   按 `(conversationId, serverMessageId)` 去重合并——本次验证证明该手段能完整找回漏网消息；
3. 对账是兜底不是常规路径，WS 推送仍是主通道。

> **`node:sqlite` 实验性警告**：每次启动都有 `ExperimentalWarning: SQLite is an experimental feature`，
> 与 Node 24 文档一致（RC 状态）。若迁移 TS，需评估锁版本或换 `better-sqlite3`。

### 8.6 发送状态（通过）

实测 `/ping` 的回复回执：

```
statusCode: 0
statusMsg: 'OK'
serverMessageId: '7701258784303302181'   ← 服务端分配
clientMessageId: 'f33d5791-2683-...'     ← 客户端生成
checkCode: undefined
elapsedMs: 889
```

SDK 已有判定函数 `src/services/im/content.ts:351`：

```typescript
export function isMessageDelivered(res: SendMessageResponse): boolean {
  return res.statusCode === 0
    && Boolean(res.serverMessageId)
    && res.serverMessageId !== '0'
    && res.checkCode !== 8610;
}
```

**三态映射**：

| 状态 | 判定 |
|---|---|
| `sent` | `statusCode=0` 且 `serverMessageId` 有效 —— **只证明服务端接收**，不证明对端已显示/已读 |
| `failed` | 服务端明确拒绝（`statusCode≠0`，或 `checkCode=8610` 内容审核拦截）。**是否可重试按错误分类决定**，不一律重试 |
| `unknown` | 已提交但无法确认回执（超时、断连） |

> 注意：`checkCode` 是内容安全审核状态（0=通过），`8610` 表示被拦截。
> SDK 提供了 `isMessageDelivered()` 判定「送达」，但它覆盖的是「服务端接收」层级。
> 三态语义的权威定义在 `PRD.md §6.1`（D-015 后已按证据强度收紧）。

### 8.7 对现有设计的影响

**§2.4 的结论需要更新**：原文说「消息无稳定 ID，阶段 2 的 Contract 不能假设有 ID」。

两个参考项目拿不到 ID，是因为它们**走浏览器 DOM 抓取**——是方法限制，不是平台限制。
纯 Node SDK 能拿到服务端 `msgId`。

→ `DECISIONS.md` D-003 已更新：`id_mode` 升为主路径，`no_id_mode` 降为兜底。

**§5 的「共同缺陷」不适用于 douyin-im**：它有测试（jest）、有 `pnpm-lock.yaml`、有 CI 配置。

### 8.8 与 Playwright 方案对比

| 维度 | Playwright | douyin-im |
|---|---|---|
| 消息获取 | DOM 抓取 | WebSocket 事件 |
| 消息 ID | ❌ | ✅ |
| 平台改版影响 | 前端改版即失效 | 协议层，影响较小 |
| 风控/协议兼容机制 | 浏览器方案可能调整自动化特征 | SDK 内含签名、browserInfo 兼容与设备相关实现；**不能认定不需要** |
| 语言 | Python | TypeScript |

**最后一行是设计原则问题**：`PRD.md §2.1` 硬性边界 4 要求「不绕过风控」。
Playwright 需要 `--disable-blink-features=AutomationControlled` 这类伪装，本质上是在规避检测；
SDK 走桌面协议但仍包含签名、browserInfo 兼容模板等机制；不能仅凭“不用 Playwright”就断言不存在风控兼容行为。D-014 已划分 SDK 内部与 dac 自身的技术约束。

### 8.9 迁移建议（验证完成后更新）

**7 项验证全部通过。阻断项不存在（早期误判），迁移 douyin-im 的主要顾虑只剩两个可兜底项：**

| 遗留风险 | 概率 | 兜底 |
|---|---|---|
| 凭据失效时不自动降级扫码（§8.4） | 低（需异常退出路径） | 人工删除凭据重扫；或向 SDK 提 PR |
| 半开窗口漏消息（§8.5） | 每次断线都可能出现（≤60s 窗口） | **Platform Adapter 重连后 `getHistory()` 对账**，已实测有效 |

**建议：采纳 douyin-im 作为平台接入层，整体迁移 TypeScript。**

理由：
- 消息 ID、断线重连、发送三态都实测可用，且**架构上单语言单进程**；
- 当前 Python 代码仅 Slice 1（667 行），迁移成本处于最低点；
- SDK 的真实消息 ID 与 WebSocket 接收能力适合作为接入层依据，但长期稳定性及协议风险仍需单独验收。

**D-014 / D-015 均已正式确认。**

**不因迁移而推翻**：`PRD.md` 全部边界、`AC.md` 验收语义、`ARCHITECTURE.md` 分层、
`FAILURE_RULES.md` 故障分类、SQLite 数据模型、发送三态、Slice 工作流。

> **迁移时需注意**：`node:sqlite` 在 Node 24 为实验特性（每次启动有 ExperimentalWarning）。
> 验证会话中未观察到数据问题，但样本有限；正式实现前评估锁 Node 补丁版本或换 `better-sqlite3`。

---

## 9. 结论

> 本节以 §8 验证完成后的状态为准（2026-10-27），技术选型已由 D-014 落定。

- **平台接入层**：`douyin-im` 验证 **7/7 全部通过**。早期「5/7、重启需人工扫码」
  是 `kill -9` 误判，已纠正（§8.4）。**D-014：采用该 SDK，技术栈迁移 TypeScript。**
- **借鉴的 SDK 路线设计**：WS 事件 + `serverMessageId` 幂等、优雅退出刷新 Session、
  重连后 `getHistory()` 对账（§8.5）、发送回执 `isMessageDelivered` 三态判定（§8.6）。
- **借鉴的参考项目设计**（语言无关）：身份核验流程、滑动窗口归档思路、Prompt 分层、
  审计日志、故障现场保存。
- **随迁移作废的（Playwright 特有）**：选择器集中管理、DOM 气泡提取、坐标点击、
  风控伪装参数。其中「选择器改版维护」被 §8.5 的对账机制取代。
- **必须重新实现的**：配置系统、状态存储、去重、频率限制、发送状态机（语义不变，TS 实现）。
- **必须放弃的**：douyin-robot 的全部代码（许可证）、douyin-bot 的昵称匹配与坐标点击。
