# 验收条件 — TypeScript 迁移基线（AC-TS）

> 版本：v1.0（2026-10-28，随 TODO T0-4 建立）
> 状态：生效（T0 部分）；T2 起的条目随对应 Slice 启用
> 原则（AC.md 头部）：继承 Python 基线（AC-1.x）的**诊断思想**，
> 替换其**实现细节绑定**（Python/Playwright/.py 扫描 → Node/SDK/TS/凭据）。
> 已验收的 Python 证据保留在 AC.md 与 SLICE_1_GATE.md，不回改。

---

## T0：工程骨架与依赖接入（本轮启用）

### AC-T0.1 干净检出可复现

| 项 | 内容 |
|---|---|
| 条件 | 干净 clone 后，凭锁文件安装即得到与验证版一致的依赖；typecheck/test 零失败 |
| 证据 | `cd app && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` 退出码全 0；`pnpm test` 输出 `pass ≥ 15, fail 0` |
| 失败状态 | 安装或校验失败 → T0 未完成，不进入 T1 |
| 类型 | 自动测试 |

### AC-T0.2 SDK 接入方式与 Contract 一致（R-01）

| 项 | 内容 |
|---|---|
| 条件 | 依赖为 npm 固定版本 `douyin-im@1.1.0`；不引用 `src/` 私有路径；不依赖被忽略的本地 `douyin-im/` 目录 |
| 证据 | ① `app/package.json` 与锁文件版本一致；② `rg "douyin-im" app/src app/test` 的 import 仅出现包名主入口；③ 移动/删除本地 `douyin-im/` 目录后 typecheck+test 仍通过（证明零本地路径依赖） |
| 失败状态 | 任一不满足 → 按 Contract §4 降级路径（git 锁 commit → vendoring）并更新 Contract |
| 类型 | 自动测试 + 人工检查 |

### AC-T0.3 边界：凭据与产物不入库

| 项 | 内容 |
|---|---|
| 条件 | `node_modules/`、`state/`、`data/`、`*.sqlite*`、二维码、验证产物均不被 git 跟踪；测试全 mock，无网络与真实账号代码路径 |
| 证据 | ① `git check-ignore` 对六类路径逐一命中；② 创建含 fake 会话目录后 `git status` 不显示；③ `pnpm test` 在无网络环境变量下通过；④ `rg sendMsg app/test` 为空（只读阶段不发） |
| 失败状态 | 任何命中 → 立即修 `.gitignore` 并检查历史是否已泄露 |
| 类型 | 自动测试 |

### AC-T0.4 归一化层的字段不变量（normalize 已有测试，此处为契约登记）

| 项 | 内容 |
|---|---|
| 条件 | 会话键必须有 `threadId`，禁止用 shortId 回退；一切 ID 以字符串保留（19 位值超 double 安全整数，转 number 必损坏）；缺失字段归 `null`/`non_text`/`-1`，不猜测；文本事件必须由 SDK `content.kind=text` 明确确认 |
| 证据 | `pnpm test` 中 normalize 的 13 项断言（含反向断言：非文本带标题仍 `non_text`、缺 `content.kind` 不判 text、threadId 缺失即拒绝、`String(Number(id)) !== id`）；全套 ≥20 |
| 失败状态 | AC 失败 → T1 不得开始（幂等键建立在归一化正确之上） |
| 类型 | 自动测试 |

### AC-T0.5 复用账本先于复用（R-03 / D-018）

| 项 | 内容 |
|---|---|
| 条件 | `app/NOTICE.md` 存在且 N-01 登记 SDK 依赖；任何 MIT 片段进仓库前已有账本行 + 代码头注释指向 |
| 证据 | `app/NOTICE.md` 存在；对 `app/src`、`app/test` 全量 diff 审查无未登记的第三方来源 |
| 失败状态 | T3 前 NOTICE 缺失 → 阻断该 Slice 合码 |
| 类型 | 人工检查 |

### AC-T0.6 SDK 公开 API 形状冒烟（防「类型对、运行错」）

| 项 | 内容 |
|---|---|
| 条件 | 锁定版 SDK 可被 Node 24 原生加载，关键公开导出存在且为预期类型；SQLite 实验警告不视为失败 |
| 证据 | `test/platform/sdk-public-api.test.ts`：`import('douyin-im')` → `createClient/configureLogger/getLogger` 为 function；`createClient({dataDir: <临时目录>})` 可构造即释放，不登录不发信 |
| 失败状态 | 加载失败 → 依赖链问题，T0 未验收 |
| 类型 | 自动测试 |

---

## 继承映射（旧 → 新）

| Python 基线 | TS 继承者 | 变化 |
|---|---|---|
| AC-1.1 D1~D11（doctor） | AC-T2.x（T2 定义） | 检查对象换 Node/pnpm/SDK/凭据 |
| AC-1.2 缺字段必须指名 | AC-T2.x 配置校验 | 同一语义，TS 实现 |
| AC-1.3 stdlib 同名扫描 | **不再适用** | Node/TS 无同名劫持机制；教训转为「不依赖 SDK 私有路径」（AC-T0.2） |
| AC-1.6 单实例锁 | AC-T2.x | 语义保留，`flock` 规则不变 |
| AC-1.7 退出码 0~4 | AC-T2.x | 表原样迁移（CLI_SPEC §5） |
| AC-2.x 归档 | AC-T3.x（T3 前写） | Contract `docs/contracts/archive.md` 先行 |
| — | AC-T0.5 / D-018 | 迁移新增：复用账本 |

> 本文件条目同样受「不得为过测试改 AC」约束。

## T1 — 只读平台接入（离线 Gate 已实施，线上 Gate 待验证）

- AC-T1.1：仅允许一个已验证登录账户、一个目标 UID，匹配严格私信 `threadId`，拒绝群/他人；错误 UID 必须拒绝运行。
- AC-T1.2：SDK 事件不得越过 platform 边界，私信以服务端 ID 字符串化，分享/评论等不当作文本；历史查询保留游标、hasMore、状态码与方向。
- AC-T1.3：凭据/二维码不进入 Git/应用日志，二维码本地 0700 目录、0600 文件；失效/结束后清理；短信与验证挑战不得自动绕过。
- AC-T1.4：只读线上验收必须由人工填写两个平台 UID、真实登录或 Session 恢复、本人第二账号发来测试消息，确认目标可收到但绝不发送。线上 Gate 未执行前不得勾选 TODO T1 完成。

## T2 — 运行态与 CLI（新增的验收条件）

- **AC-T2.1 配置/doctor**：有效配置、缺配置、损坏 JSON、未知字段、相同 UID 五种情况；doctor --json 恒有 D1~D11、稳定顺序、计数汇总一致；不得输出敏感信息。
- **AC-T2.2 单实例/持久阻塞**：同目录并发 run 只有一个启动，冲突退出码 4；SIGKILL 后 runtime 为 stale 且保留证据，重启不得悄悄覆盖业务阻塞；paused_auth/risk/env/unknown 必须显式 unblock。
- **AC-T2.3 控制**：pause/resume/stop 命令经 UUID 请求/ack，暂停后不再开始处理，恢复保持同一个 PID；stop 可从暂停退出；旧实例请求不会被新进程执行。
- **AC-T2.4 事件队列**：固定上限、单消费者、暂停栅栏、异常转 paused_env、溢出不静默丢消息；mock 验证。
- **AC-T2.5 退出码**：测试 SIGINT/SIGTERM 的真实 Node 退出码为 0；已 offline 后 SDK logout reject 不得误报 1；真正没有确认关闭则报 1；锁 4、配置 2、阻塞 3。不得取 tee 管道 $? 充证据。
- **AC-T2.6 安全**：运行时无 sendMsg、业务日志无正文，state/control 目录 0700、文件 0600；无真实抖音网络连接的自动化测试。
- **AC-T2.7 文件系统不可信**：请求目录中的符号链接不得被当作控制指令，也不得写穿到链接目标；状态文件被替换为符号链接时，原子写必须替换路径本身而非写入外部目标；请求文件名与内部 id 不一致必须拒绝；非法 JSON 请求被丢弃且不阻塞后续合法请求。
- **AC-T2.8 doctor 强诊断**：doctor 的每项检查必须能因真实缺陷转为 fail/warn（可被证伪），不得是固定文案：源码出现 `sendMsg` → D10 fail；凭据目录非 0700 → D9 warn；src 下出现 `.py` → D3 fail；配置缺失 → D4/D8 fail。D11（平台风险）无法自动化，明确保留为人工确认项。doctor 输出不得回显账号 UID。
- **AC-T2.9 测试卫生**：子进程测试结束后不得留下孤儿进程（flock 派生的 `--locked` 孙进程）；时间敏感断言用轮询而非固定延迟，全套并行重复运行不得偶发失败。
