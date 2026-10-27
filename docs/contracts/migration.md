# 迁移 Contract — T0-1

> 版本：v1.0（2026-10-27，随 T0 建立）
> 状态：生效
> 依据：D-014（douyin-im + TypeScript）、D-015（L0 全自动）、TODO T0-1

---

## 1. 目录与工具链

| 项 | 决定 |
|---|---|
| TS 代码目录 | `app/`（与冻结的 Python 基线 `src/dac/`、`tests/` 并存，互不引用） |
| 运行时 | Node.js **24 LTS**（原生 type-stripping，`node src/cli.ts` 直跑，无构建步骤） |
| 包管理 | **pnpm**（`app/pnpm-lock.yaml` 提交，`--frozen-lockfile` 为 CI/复验口径） |
| 语言 | TypeScript **严格模式** + `erasableSyntaxOnly`（禁止 enum/namespace 等不可擦除语法，保证原生直跑） |
| 模块系统 | ESM（`"type": "module"`，`moduleResolution: nodenext`，导入写 `.ts` 扩展名） |
| 测试 | `node --test`（零测试框架依赖），目录 `app/test/`，与被测代码镜像分层 |
| CLI 入口 | `dac <command>` = `node app/src/cli.ts <command>`（安装脚本入口待 T2） |

**验证命令**（T0 Gate 的可复现证据）：

```bash
cd app
pnpm install --frozen-lockfile
pnpm typecheck        # tsc --noEmit
pnpm test             # node --test test/
```

---

## 2. 模块依赖方向（继承 ARCHITECTURE，TS 化）

```
cli/            命令入口，只做解析与分发
  ↓
core/           业务编排：队列消费者、状态机、决策调用
  ↓
platform/       Adapter：SDK ↔ Eve 内部类型（唯一允许 import douyin-im 的层）
archive/        SQLite 归档（T3）
send/           发送意图与三态（T6）
  ↓
infra/          配置、日志、db 连接、路径
```

**规则**：

1. 依赖只能向下；`platform/` 之外 **import 'douyin-im' 即违规**（lint 以 grep 断言，T2 落实）。
2. SDK 原始对象（`MessageEvent` 实例等）**不得跨越 `platform/` 边界**；
   出口一律为 `platform/types.ts` 定义的纯数据结构。
3. `core/` 不感知 SDK 存在——它只看见端口接口（`PlatformPort`），mock 因此天然可替换。

---

## 3. 两个 SQLite 的职责边界（T1-7/P1-7 的 Contract 化）

| | SDK 缓存 `data/accounts/<uid>/im-state.sqlite` | Eve 业务库（路径待 T3 定，默认 `state/dac.sqlite`） |
|---|---|---|
| 所有者 | douyin-im（写权限完全归它） | dac 业务层 |
| 内容 | SDK 会话缓存、frontier 游标 | 归档消息、同步水位、发送意图、频率计数、审计 |
| Eve 可写 | ❌ 绝不 | ✅ 唯一真相源 |
| Eve 可读 | 仅诊断用途，只读模式 | — |
| 删除/迁移 | 不做（删了等于丢 Session） | 备份/迁移自行管理 |

**恢复语义**：业务真相以 Eve 库为准。SDK 缓存丢失只影响传输游标，
由 T4 的 `getHistory()` 对账补回；**两者不对账合并**。

---

## 4. SDK 接入方式（R-01 落地）

| 项 | 决定 |
|---|---|
| 来源 | **npm `douyin-im@1.1.0`**（integrity `sha512-OMd5nk…` 已核对；发布 2026-10-09，与验证基线 f6eee66 同版本） |
| 锁定 | `pnpm-lock.yaml` 提交；升级 = 新 Slice，重跑 T4 对账测试后才允许 |
| 导入 | 仅 `import type { MessageEvent, Account, … } from 'douyin-im'`（类型）+ `platform/` 内运行时 import |
| 不依赖 | 其 `src/` 私有路径、`/protocol` `/base` 子路径、被根目录 gitignore 的本地 `douyin-im/` 目录 |
| 归属 | `LICENSE`（MIT）与 `THIRD_PARTY_NOTICES.md` 由 node_modules 携带；登记进 `app/NOTICE.md`（D-018） |

**降级路径**（若 npm 包与本地验证版行为不一致被发现）：git 依赖锁 commit `f6eee66` → vendoring；每步都在本文件追加记录。

---

## 5. 隐私与凭证边界

1. `state/`、`data/`、`*.sqlite*`、`login-qr.png`、日志目录全部在 `.gitignore`（D-017 配套）；
2. SDK 事件中的消息正文**不落 Eve 日志**（只记长度/指纹，规则同 FAILURE_RULES §5）；
3. smoke test 与单测一律用 mock 数据；任何测试不得建立真实连接。

---

## 6. T0 各任务与本文的关系

| 任务 | 证据位置 |
|---|---|
| T0-2 固定版本依赖 + 导出检查 | `app/package.json`、`pnpm-lock.yaml`、`test/platform/sdk-public-api.test.ts` |
| T0-3 mock smoke test | `test/platform/normalize.test.ts`、`test/platform/adapter-port.test.ts` |
| T0-4 TS 版 doctor AC | `docs/AC.md` AC-T0.4 一节（诊断思想继承 D1～D11，扫描对象换成 Node/SDK/凭据） |
