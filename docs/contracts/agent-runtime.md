# T5 Agent Runtime 适配 Contract（2026-10-29）

## 调研来源

- OpenDesign: https://github.com/nexu-io/open-design/blob/main/docs/agent-adapters.md 。使用声明式 RuntimeAgentDef、按 ID 注册、通用进程执行器与不同 CLI 的输出解析，而非每种 CLI 重建 AI 工作流。
- OpenHands: https://github.com/OpenHands/OpenHands/blob/main/docs/ACP_AGENTS.md 。通过 ACP 的 stdio JSON-RPC 兼容多种 Agent，适合作为未来协议层，不必当前一并引入。
- pi: https://github.com/pi0/pi-mono/blob/main/packages/coding-agent/docs/extensions.md 。插件、工具、事件监听和 provider 是不同的扩展点；Pi 的扩展具有进程权限，所以 Eve 要额外设计严格的能力网关。
- Claude 官方 CLI 文档: https://code.claude.com/docs/en/cli-reference 和 https://code.claude.com/docs/en/headless 。

## 当前实现

1. 稳定 AiBackend 接口只暴露 evaluate(request,signal)，永远返回 unknown，由 validateDecision 严格验证 reply / skip / defer。
2. AgentRegistry 目前只注册 claude_code；不注册 Codex、OpenCode、Pi，不从聊天内容加载外部 executable。AgentRuntimeDef 定义 binary、构造 argv、解析输出、允许能力；通用 StdioAgentTransport 实现进程启动、取消、超时、输出限制、临时工作目录和环境变量白名单。
3. 本地 Claude Code CLI 是 v2.1.310，仅检查版本而未实际调用。启动参数：--safe-mode 关闭插件/hooks/skills/CLAUDE.md；--tools 空值、--disallowedTools 星号、--strict-mcp-config 禁止 Claude 自带工具和 MCP；--disable-slash-commands、--no-session-persistence、--max-turns 1、--max-budget-usd 0.10。prompt 正文只走 stdin，不经 shell/argv；--output-format json 加 --json-schema；只有成功的 structured_output 可到业务校验器。
4. 与 --bare 不同，--safe-mode 保留现有 CLI 订阅登录凭据。安全限制不是操作系统级沙盒：Claude 进程仍是同用户权限，因此禁止任意工具与插件；日后开放工具必须有独立沙盒和授权。无 dangerously-skip-permissions。
5. 当前 DeepSeekBackend 只是此前模型 API 路线的未激活原型：不在 AgentRegistry、不在 Runner、默认 demo 也不选它。Claude 是当前唯一已注册的 Agent；以后接 Model API 或其他 Agent，业务决策和门控不变。

## 显式调用与门控

- pnpm t5:demo：离线虚构对话，模拟 Claude 进程返回，零费用、零发送、零 eligible 状态消费。
- EVE_T5_CLAUDE_CALL=1 pnpm t5:claude：主动授权一次真实 Claude CLI dry-run，仅用虚构数据与临时 SQLite，不读取正式 Eve 私信、不调用抖音发送接口。未设置 opt-in 就拒绝执行。可能消耗 Claude 订阅额度或 API 费用，未在本次运行。
- T4 usable 与 verified epoch 必须在调用前、后核验；失败、超时、状态变化一律丢弃结果。
- 未来 Plugin/Tool Gateway 单独负责插件注册、能力声明、审批、限额与审计。默认无文件读写、终端、MCP、消息发送能力；不能绕开 T4/T6。
- T5 仍未完成：持久 claim/audit、真人工审查、Agent 执行安全验收、真实 Claude 测试、上下文合并和长期限额/退避均为后续 Gate。

## T5 真实 Claude 单次联调结果与失效诊断（2026-10-29）

本轮按明确继续的 T5 计划执行 **1 次**实际 Claude Code CLI 模型调用，仅使用 `app/scripts/t5-demo.ts` 中的虚构消息、独立临时 v3 SQLite、`EVE_T5_CLAUDE_CALL=1`、严格工具/MCP/Chrome 禁用及固定预算。未读取正式 Eve 私信、未操作正式 DB、未发送抖音消息。

### 真实证据与不能冒充的部分

- `claude --version` 本机 2.1.310；`claude auth status` 返回 loggedIn=true、authMethod=oauth_token、apiProvider=firstParty；本机没有显式设置 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL。仅输出布尔状态与方法，不记录凭据。
- 首次单次 `EVE_T5_CLAUDE_CALL=1 pnpm t5:claude`：实测时长约 **5.1 秒**，`aiLedger={claimed:0,recorded:0,blocked:1,interrupted:0}`，审计 `status=blocked,reasonCode=backend_failed`、发送数 0、eligible 消费数 0。因旧实现把所有 stderr 和 CLI 输出异常折叠成 backend_failed，**根因未能识别；不能声称 API 成功，也不能归咎于账号或网络**。
- 此次单次请求可能产生 Claude 订阅额度消耗；未获取服务侧可验证的费用／token 数据，不能估算费用。**没有连续重试第二次真实模型调用**。
- 发现原 demo 即使 `blocked` 也返回退出码 0，误导用户和 Gate：现改为真实 CLI 模式审计非 dry_run 时设置退出码 **4**，有效成功仍是 0。新建独立的仿真 Claude 可执行文件，分别走 CLI 成功和认证失败路径；模拟运行不消耗任何模型额度。
- `StdioAgentTransport` 仅在内存中保留最多 8192 字符 stderr 作**固定类别匹配**，绝不打印、持久化原文。明确分类：agent_cli_configuration_error、agent_auth_error、agent_network_error、agent_rate_limit、agent_execution_failed；解析 JSON `is_error=true` 为 agent_result_error，结构不符为 agent_invalid_output。AI 引擎允许这些已知码进入脱敏审计，所有原因码都不包含身份或消息内容。
- Runner 现遇认证、网络、CLI 参数、额度、输出协议这几类后端异常，立刻关闭 AI 工作槽并以 paused_env / ai_backend_unhealthy 安全退出，不消费下一条 eligible。仿真集成测试验证数据库失去 verified、同消息没有成功审计、后续不继续启动 Claude。原有进程不退出时的真实 SDK 状态保护保持不变。
- 本地 Claude 启动参数再次比对官方 CLI reference：保留 --safe-mode / --tools 空 / --strict-mcp-config / --json-schema / --no-session-persistence，并新增 --no-chrome。--max-turns=1、--max-budget-usd=0.10 仍需正式成功调用校准（不能根据旧泛化错误码认定这些是根因）。

### 未通过的 Gate

真实 Claude 模型结果结构化成功与真实额度测量 **仍未通过**。下一次付费真实试运行应该在明确权限与预算的前提下使用新的脱敏分类，并只针对可诊断的错误修复；不允许在未经证据确认时循环重试。当前 Runner 对真实抖音的 AI 自动处理仍默认关闭；正式 SQLite 仍 v2。完整 T5 不标记完成。

### Claude preflight 边界补充

运行 `pnpm t5:check` 不会使用 `-p`，只检查公开 CLI 版本、帮助与认证状态。可接受的是 `status=ready`，表示本地入口满足最低条件；**不是**已消费真实额度的网络调用成功。 `t5:claude` 在显式开启后自动执行此预检，失败时不建临时库也不调用 Backend。正式实盘失败只可在另行授权的单次调用中按已实现的脱敏分类继续诊断。

### 第二次真实 CLI 诊断记录

`2026-10-29` 第二次显式测试仍是 blocked/backend_failed，耗时约 3.3 秒，输出审计记录被故障状态保护，未发送私信。仅凭 `claude auth status` 可用、HTTPS HEAD 404 不能推断模型成功、付费状态或请求是否实际到达模型服务器。当前预检在与 Agent 同等精简环境和临时目录下通过，排除简单的 cwd 环境/登录凭据缺失假说；非零退出结构化结果现另行固定分类（不泄露原始 stdout）。真实生成 Gate 继续保留未完成，下一轮不得未经确认自动重试。
