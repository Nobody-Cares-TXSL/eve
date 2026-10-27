# NOTICE — 第三方复用账本（D-018）

> 规则：每段进入本仓库的第三方来源代码（含改译），在此登记一行。
> 代码文件头部以注释指向条目编号。**先登记，后合码。**
> 字段：`编号 | eve 位置 | 来源仓库@commit/版本 | 源路径 | 许可证 | 处理 | 理由`

## 账本

### N-01 · douyin-im SDK（依赖，非源码复制）

| 项 | 值 |
|---|---|
| 来源 | npm `douyin-im@1.1.0`（integrity `sha512-OMd5nk9h58dRiaDotogcQXjKX/oVPnaW9isVr79ajtepItzh0NuXWxyo6fOLZHdw4xatKsyY8yCeTCzI87kifQ==`），仓库 `zhinjs/douyin-im`@`f6eee66` |
| 许可证 | MIT（Copyright (c) 2025-2026 Zhin.js contributors），见 `node_modules/douyin-im/LICENSE` |
| 处理 | **作为依赖集成**，不复制其源码；仅经 `src/platform/` 使用公开导出 |
| 理由 | D-014 选型；SDK 已 7/7 真实验证（docs/human/SOURCE_AUDIT.md §8） |
| 上游引用链 | SDK 自身参考 jumpbyte-bot（GPL-3.0，声明**未复制源文件**）、oicq（MPL-2.0）、DouYin_Spider（声明未复制）。MIT 独立实现不传染 GPL；若未来 fork SDK 需重新评估此链 |

### 待登记（预留，未发生）

| 编号 | 计划 | 时点 |
|---|---|---|
| N-02 | `douyin-bot/database.py` 的归档 SQL 结构（如有采纳） | T3 前登记 |
| N-03 | `douyin-bot/llm_service.py` 的调用流程模板（如有采纳） | T5 前登记 |

> 规则重申（TODO 复用表）：不继承 `douyin-bot` 的连接泄漏、昵称匹配、文本哈希去重、坐标点击；
> `douyin-robot` 无许可证——只借鉴设计，不复制函数体与注释。
