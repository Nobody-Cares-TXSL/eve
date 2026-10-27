# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目

`dac`：Ubuntu 本地 CLI，以「AI 小号」身份在抖音私信中与操作者自己的另一个账号持续对话。
产品形态 **L0 全自动**（D-015）：AI 自主决定是否回复、回复什么、何时发送并直接执行；
程序强制白名单、频率、幂等、`unknown` 禁重发等安全约束，AI 不可绕过。

**技术栈**：平台接入 = `douyin-im` SDK（WebSocket），主栈迁移 TypeScript（D-014）。
`src/dac/` 的 Python 基线（doctor）已验收并**冻结**：不新增功能，只接受文档同步。

```
docs/               设计文档（docs/human/ 人类文档 + docs/ AI 文档）
src/dac/  tests/    Python 基线（冻结，历史保留）
douyin-bot/  douyin-robot/   上游参考，.gitignore 忽略，只读
douyin-im/          平台接入 SDK（独立仓库，真实账号验证 7/7 通过）
```

## 规范基线（D-014/D-015 生效后）

新旧规范不得同时遵守。冲突时以 `docs/human/DECISIONS.md` 为准，**停下来问，不要自行选一种解释继续编码**。

| 项 | 现行 | 已作废（历史留在 git / SOURCE_AUDIT） |
|---|---|---|
| 语言 | TypeScript（Node 24 LTS + pnpm） | Python 新增功能 |
| 接入 | douyin-im WS 事件 + `getHistory` 对账 | Playwright / DOM / 选择器 / 轮询 tick |
| 形态 | L0 全自动（AI 决策 + 程序硬约束） | L1 作为产品形态（降级为首次真实发送的验收门） |
| 发送 | 意图先持久化后发送；`sent`=服务端回执 | 「点击即成功」「failed 一律可重试」 |

## 文档分两类

**人类文档**——讲为什么、是什么，供人审查设计：

| 文档 | 内容 |
|---|---|
| `docs/human/PRD.md` | 边界、运行模式、数据去向、AI 身份 |
| `docs/human/ARCHITECTURE.md` | 消息链、数据职责边界 |
| `docs/human/SOURCE_AUDIT.md` | 两个参考项目的审计结论、选型依据 |
| `docs/human/DECISIONS.md` | 生效中的决策及理由 |

**AI 文档**——讲怎么做、什么算对，照此执行：

| 文档 | 何时读 |
|---|---|
| `docs/AC.md` | 每个 Slice 开始前——验收标准 |
| `docs/CLI_SPEC.md` | 实现命令、退出码、配置字段时 |
| `docs/MODULE_MAP.md` | 决定文件放哪、依赖方向时 |
| `docs/FAILURE_RULES.md` | 处理错误、状态转换时 |

**过程记录**：`docs/SLICE_1_GATE.md`（Slice 1 验收），不参与日常开发。

文档与代码冲突时，改文档或改代码，不要长期不一致。

## Slice 流程

开始前确认：相关文档状态为「已确认」。审查通过 ≠ 用户确认。

```
范围确认 → AC 映射 → 测试设计 → 测试先行 → 最小实现 → 验证 → Understanding Gate
```

测试失败时：先查实现 → 再查 AC 证据是否描述准确 → 若设计有问题走变更流程。**不得为通过测试而改 AC。**

每轮开始前回答四问：完成什么（对应哪条 AC）／什么证据证明／失败时是什么状态／能否解释完整执行链。

**Understanding Gate**：能说清执行链、异常分支、对应测试三件事。说不清就不算完成，即使测试通过。

## 硬约束

1. **原 Python 基线的标准库命名检查**采用 `sys.stdlib_module_names`，见历史 AC-1.3。TypeScript 新工程另按 Node 模块解析规则设计命名与导入测试，不照搬 Python 扫描。
2. **必需配置字段缺失必须报错并指出字段路径**，禁止 `.get(key, default)` 掩盖。可选字段的默认值须在 `CLI_SPEC.md §3.2` 写明。
3. **发送三态** `sent` / `failed` / `unknown`，`unknown` 绝不自动重试——会导致对方收到两条。
4. **聊天正文可发 DeepSeek，但不进 git、不进日志、不发第三方**。凭证永不出本机。
5. **AI 不主动披露身份，被直接追问时承认**；不编造设定外的现实经历；不声称执行了现实动作。
6. **不复制两个参考项目的代码**（D-010），只借鉴设计。
7. **不超前创建模块**。阶段 1 不建 `archive`/`page`/`identity`/`ai`/`send`/`memory`，含空文件。

## 架构

原 Python 基线依赖为 `cli → commands → core → infra`。新 TypeScript 工程保留依赖方向与核心纯逻辑的原则，但具体模块与 Adapter/存储边界必须在迁移 Contract 中确定，不强制照搬旧目录。

消息链（`docs/human/ARCHITECTURE.md §4`）：SDK 事件 → 白名单与身份核验 → 历史对账/归档 → AI 决策/生成 → 程序硬约束 → 发送意图落盘 → 自动发送 → 回执记录。

TypeScript 新运行时采用有界事件队列、单消费者与暂停/停止栅栏，不得照搬已冻结 Python 基线的同步 `tick`/轮询实现。

## 已冻结 Python 基线的验证命令（非 TypeScript 新项目命令）

```bash
.venv/bin/python -m pytest tests/ -v                              # 全部测试
.venv/bin/python -m pytest tests/unit/test_doctor.py::test_name   # 单个测试
PYTHONPATH=src .venv/bin/python -m dac.cli doctor --json          # 运行 CLI
```

上述 Python 3.11+ 与 pytest 仅适用于历史基线。新 TypeScript 工程以 Node 24 + pnpm 为准；doctor 检查、文件结构、运行命令须在迁移 Slice 的 Contract 和 AC 中另定。

## 提交前

只有**改变已确认的设计、契约或范围**时才新增 `DECISIONS.md` 条目。修 bug、补测试、无行为变化的内部重构都不需要。
