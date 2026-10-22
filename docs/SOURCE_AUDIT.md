# 源码审计报告 — SOURCE_AUDIT

> 版本：v1.1
> 状态：阶段 0 交付物
> 审计对象：`douyin-bot/`（popohuan）、`douyin-robot/`（crazyants）
> 审计日期：2026-10-22
> 审计方法：逐文件阅读 + 实际运行验证（结论标注了证据来源）

---

## 0. 结论速览

| 项目 | 许可证 | 能否复制代码 | 建议定位 |
|---|---|---|---|
| `douyin-bot` | **MIT**（`douyin-bot/LICENSE`） | ✅ 可以，需保留版权声明 | 借鉴数据层与产品化经验 |
| `douyin-robot` | **无 LICENSE 文件** | ❌ **不可以**，默认保留所有权利 | **只借鉴设计，独立实现** |

**技术主干选 `douyin-robot` 是指选它的架构分层，不是选它的代码。** 它的代码一行都不能复制进新项目。这一点直接影响阶段 5 的开发方式。

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

### 2.1 🔴 P0 — 项目当前无法启动

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

### 2.2 🔴 P0 — 轮询间隔配置完全失效

**证据**：`src/runner.py:377` 调用 `_random_range(cfg["poll"])`，而 `_random_range` 读的是 `min`/`max` 键，配置里是 `cycle_min_seconds`/`cycle_max_seconds`。

**实测**：

```python
_random_range({'cycle_min_seconds': 15, 'cycle_max_seconds': 35})  # → 1.31 秒
```

**影响**：README 承诺「每轮 15–35 秒，低频像真人」，实际**每轮只休息约 1 秒**。这是最容易触发平台风控的一处，且与文档严重不符。

**新项目要求**：配置读取必须有类型化 schema 校验，禁止用 `.get(key, 默认值)` 静默兜底——缺失键必须在启动时**报错**，而不是悄悄用一个无关的默认值。

### 2.3 🟠 P1 — 每日限额从未生效

**证据**：`rg 'replied_at_day'` 全仓库只有 `reply_engine.py:85` 一处**读取**，`runner.py` 只写 `replied_at`，从不写 `replied_at_day`。

**影响**：`max_per_friend_per_day: 100` 永远拿小时列表计算，日限额形同虚设。

**新项目要求**：任何「限额」必须有对应测试，证明它真的会拦截。

### 2.4 🟠 P1 — 消息身份依赖纯文本哈希

**证据**：`reply_engine.py:144` `fp = msg_fingerprint(newest_text)`，`state_store.py:19` 对文本做 SHA256。

**问题**：
- 同一句话发两次（「好」「哈哈」）第二次会被判定为已处理；
- 对方先发「好」，我方也发「好」后，文本相同导致误判。

**影响**：阶段 2 的 Contract 不能假设「有稳定消息 ID」，这是**待验证的前置假设**。

### 2.5 🟠 P1 — 示例配置无法通过校验

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

### 3.1 🟠 P1 — 身份核验比 douyin-robot 弱

**证据**：`bot_manager.py:344`

```python
return !!header && header.innerText.includes('{nickname}');
```

**问题**：按**昵称子串**判断。昵称包含关系（「小明」与「小明同学」）或同名会导致**串话**——把消息发给错误的人。

**新项目**：必须按抖音号核验，昵称只用于定位。

### 3.2 🟠 P1 — SQLite 连接泄漏

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
| douyin-robot 无许可证 | 全部 | 独立实现，不复制代码 |
| `selectors` 命名冲突 | 阶段 1 | 模块命名规范 + `doctor` 自检 |
| 配置静默兜底 | 阶段 1 | 强类型 schema，缺键即报错 |
| 日限额未生效 | 阶段 2 | 计数表 + 拦截测试 |
| 消息无稳定 ID | **阶段 2/3** | **阶段 3 前置验证；阶段 2 的 Contract 需按「可能无 ID」设计** |
| 昵称匹配可串话 | 阶段 3 | 抖音号核验，不匹配即拒绝 |
| SQLite 连接泄漏 | 阶段 2 | 显式关闭 + 连接使用约定 |
| 无测试 | 阶段 2 起 | 每个 Slice 必须带测试 |

---

## 7. 结论

- **可以借鉴设计的**：身份核验流程、选择器集中管理、发送后回读确认、故障现场保存、滑动窗口归档、Prompt 分层。
- **必须重新实现的**：配置系统、状态存储、去重、频率限制、发送状态机。
- **必须放弃的**：douyin-robot 的全部代码（许可证）、douyin-bot 的昵称匹配与坐标点击。

**下一步**：进入阶段 1，先建立可诊断的 CLI 骨架。
