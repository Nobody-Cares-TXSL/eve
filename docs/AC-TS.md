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
| 条件 | 会话键以 `threadId` 为权威；一切 ID 以字符串保留（19 位值超 double 安全整数，转 number 必损坏）；缺失字段归 `null`/`non_text`/`-1`，不猜测 |
| 证据 | `pnpm test` 中 normalize 的 11 项断言（含反向断言：`String(Number(id)) !== id`） |
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
