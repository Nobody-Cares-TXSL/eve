# 基础模块地图 — MODULE_MAP

> 版本：v1.0
> 状态：阶段 1 交付物（待确认）
> 范围：**仅阶段 1**。只划分 CLI、配置、运行状态、日志、进程控制。
> 归档、身份核验、AI、发送**本阶段不创建文件**，只在架构图中占位。

---

## 1. 设计约束

### 1.1 命名规则（来自 SOURCE_AUDIT §2.1）

**禁止**任何模块名与 Python 标准库同名。已知高危名称：

```
selectors  types    queue    logging   json     email
code       parser   platform token     copy     signal
socket     random   statistics secrets typing enum
abc        io       os       re        time     uuid
hashlib    datetime pathlib  tempfile  shutil   subprocess
threading  asyncio  sqlite3  config    storage  state
```

> 注意最后三个：`config`、`storage`、`state` **不在标准库中**，但 `douyin-bot` 用了 `config.py`/`storage.py`，
> 容易与第三方包或未来扩展冲突。本项目统一加前缀或用领域词。

**约束**：所有内部模块名必须带领域前缀 `dac_`，或使用明确不属于标准库的词。
阶段 1 的自动检查（AC-1.3）会对 `sys.stdlib_module_names` 求交集，交集必须为空。

### 1.2 分层规则

```
cli（入口）
  ↓ 只调用
core（编排）
  ↓ 只调用
infra（基础设施）
```

**禁止反向依赖**：`infra` 不得 import `cli`；`core` 不得 import `cli`。

### 1.3 可测性规则

**纯逻辑与 I/O 必须分开**。阶段 1 的具体体现：

- 状态转换是**纯函数**（输入当前状态 + 事件 → 输出新状态），不碰文件；
- 文件读写是薄封装，可被内存实现替换。

---

## 2. 阶段 1 模块清单

```
src/dac/
├── __init__.py
├── cli.py                  # 入口：参数解析、命令分发
├── commands/
│   ├── __init__.py
│   ├── doctor.py           # AC-1.1, AC-1.3
│   ├── status.py
│   ├── run.py
│   ├── control.py          # pause / resume / stop
│   └── logs.py
├── core/
│   ├── __init__.py
│   ├── state_machine.py    # 纯函数：状态转换
│   └── loop.py             # 轮次循环骨架（可注入「一轮做什么」）
└── infra/
    ├── __init__.py
    ├── settings.py         # 配置加载与强校验
    ├── paths.py            # 路径解析（绝对化）
    ├── state_file.py       # 状态文件读写
    ├── control_file.py     # 控制文件读写
    ├── lock.py             # 单实例锁
    └── log_setup.py        # 日志配置（含脱敏）
```

**共 17 个文件**（含 `__init__.py`）。这是阶段 1 的全部。

---

## 3. 模块职责

| 模块 | 职责 | 不负责 | 测试方式 |
|---|---|---|---|
| `cli.py` | 解析参数、分发命令、统一异常→退出码 | 任何业务逻辑 | 集成测试 |
| `commands/doctor.py` | 执行 D1～D9 检查、汇总、格式化输出 | 修复问题；**不得 import `load_settings`** | 注入检查函数，单测 |
| `commands/status.py` | 读状态文件 → **校验 PID** → 输出状态 + 建议 | 修改状态 | 单测（构造状态文件 + fake pid） |
| `commands/run.py` | 组装依赖、启动循环、处理退出 | 具体每轮做什么 | 集成测试 |
| `commands/control.py` | 校验当前状态 → 写控制文件 | 操作进程 | 单测 |
| `commands/logs.py` | 读取/跟随日志文件 | 写日志 | 单测 |
| `core/state_machine.py` | **纯函数**：`(状态, 事件) → 新状态` | 读写文件 | **单测，覆盖率 100%** |
| `core/loop.py` | 轮次循环、边界检查控制信号 | 业务动作 | 注入 fake tick，单测 |
| `infra/settings.py` | 加载、校验、默认值 | 判断能否运行 | **单测** |
| `infra/paths.py` | 路径解析、目录创建 | 业务 | 单测 |
| `infra/state_file.py` | 原子读写状态、**PID 存活校验**（唯一实现，供 status/run/control 共用） | 状态合法性 | 单测 |
| `infra/control_file.py` | 原子读写控制意图、`request_id` 幂等消费 | 意图合法性 | 单测 |
| `infra/lock.py` | 单实例锁（文件锁） | — | 单测（双进程） |
| `infra/log_setup.py` | 日志 handler、脱敏 filter | — | 单测（脱敏规则） |

---

## 4. 关键接口（阶段 1 内部约定）

> 这里只定**函数签名**，不定实现。目的是让 Slice 之间的边界清晰。

### 4.1 状态机（纯函数）

```python
# core/state_machine.py

class RunState(str, Enum):
    STOPPED = "stopped"
    RUNNING = "running"
    PAUSE_REQUESTED = "pause_requested"
    PAUSED_MANUAL = "paused_manual"
    PAUSED_AUTH = "paused_auth"
    PAUSED_RISK = "paused_risk"
    PAUSED_UNKNOWN = "paused_unknown"
    ERROR = "error"

class Event(str, Enum):
    START = "start"
    PAUSE = "pause"
    RESUME = "resume"
    STOP = "stop"
    CYCLE_END = "cycle_end"
    AUTH_LOST = "auth_lost"
    FATAL = "fatal"

def transition(state: RunState, event: Event) -> RunState:
    """返回新状态；非法转换抛 InvalidTransition。不读写任何文件。"""
```

**非法转换必须是错误，不是静默忽略。** 例：`stopped + RESUME` → `InvalidTransition`。

### 4.2 循环（可注入）

```python
# core/loop.py

Tick = Callable[[], None]          # 一轮要做什么（阶段 1 只记心跳）
ShouldContinue = Callable[[], bool]

def run_loop(tick: Tick, should_continue: ShouldContinue, interval: float) -> None:
    """每轮：tick() → 检查控制信号 → 休眠。只在轮次边界检查信号。"""
```

> 阶段 1 的 `tick` 只写心跳日志；阶段 3 起换成「读→归档」；阶段 4 再加「生成→发送」。
> **循环本身不感知业务**，这是后续所有阶段能复用的前提。

### 4.3 配置（强校验）

```python
# infra/settings.py

@dataclass(frozen=True)
class Settings:
    target_douyin_id: str          # 可为空 → WARN
    cycle_seconds: int             # 必填，缺失即报错
    log_level: str
    ...

class ConfigError(Exception):
    """携带字段路径与原始原因，供 CLI 精确输出。"""
    field: str
    reason: str

def load_settings(path: Path) -> Settings:
    """缺失必需字段 → ConfigError(字段路径)。不做静默兜底。"""

def inspect_settings(path: Path) -> list[CheckResult]:
    """不抛异常。逐项检查并返回结果列表，供 doctor 使用。
    文件不存在、JSON 损坏、字段缺失都作为 CheckResult 返回，不中断。"""

def check_runtime_ready(s: Settings) -> list[str]:
    """返回运行条件缺失项（如 target_douyin_id 为空）。空列表 = 可运行。"""
```

**两类校验分开**（D-007）：

| 函数 | 失败时 | 影响 |
|---|---|---|
| `load_settings` | 抛 `ConfigError` | **除 `doctor` 外**的命令退出码 `2` |
| `inspect_settings` | 返回 `FAIL` 项 | 只有 `doctor` 使用；`doctor` 永不因配置问题抛异常 |
| `check_runtime_ready` | 返回缺失项列表 | 只有 `run` 退出码 `3` |

> **`doctor` 不走 `load_settings`。** 它调用 `inspect_settings`，因为 `doctor` 的存在意义
> 恰恰是诊断「配置坏了」的情况——若它自己因配置异常退出，就失去了作用。
> 这条规则是 `MODULE_MAP` 的硬约束，`commands/doctor.py` 不得 import `load_settings`。

---

## 5. 阶段 1 明确不创建的东西

| 不创建 | 原因 | 何时创建 |
|---|---|---|
| `archive.py` / `db.py` | 阶段 2 | 阶段 2 |
| `page.py` / `page_selectors.py` | 阶段 3 | 阶段 3 |
| `identity.py` | 阶段 3 | 阶段 3 |
| `ai.py` | 阶段 4 | 阶段 4 |
| `send.py` | 阶段 4 | 阶段 4 |
| `memory.py` | 阶段 5 | 阶段 5 |
| 任何 Web / API 代码 | 非目标 | 永不 |

> **不建空文件、不建占位类。** 空抽象会让人误判进度，也会在后续阶段被强行填成错误的形状。

---

## 6. 整体架构中的位置

```
┌─────────────────────────────────────────────────────┐
│ 阶段 1 已实现                                        │
│  cli → commands → core/loop → infra                  │
└────────────────────────┬────────────────────────────┘
                         │ 后续阶段插入
┌────────────────────────▼────────────────────────────┐
│ 阶段 2   archive ─────────────────┐                  │
│ 阶段 3   page ── identity ────────┤                  │
│ 阶段 4   ai ── send ──────────────┤                  │
│ 阶段 5   memory ──────────────────┤                  │
│ 阶段 6   proactive ───────────────┘                  │
└─────────────────────────────────────────────────────┘
```

`core/loop.py` 的 `tick` 参数就是这些模块的接入点。
**阶段 1 只保证这个接入点存在且可替换**，不预先设计它的内部结构。

---

## 7. 测试组织

```
tests/
├── unit/
│   ├── test_state_machine.py    # 状态转换全覆盖
│   ├── test_settings.py         # 配置校验（含 AC-1.2）
│   ├── test_stdlib_names.py     # AC-1.3
│   ├── test_log_redaction.py    # 日志脱敏
│   └── test_paths.py
└── integration/
    ├── test_doctor.py           # AC-1.1
    ├── test_pause_resume.py     # AC-1.5
    ├── test_single_instance.py  # AC-1.6
    └── test_exit_codes.py       # AC-1.7
```

**约定**：

- 单元测试不碰文件系统（用 `tmp_path` 除外）；
- 集成测试通过 `subprocess` 真实启动 CLI，断言退出码与 `--json` 输出；
- **不 mock 状态机**——它是纯函数，直接测。

---

## 8. 依赖

阶段 1 的**全部**第三方依赖：**无**。

- 配置解析：标准库 `json` / `tomllib`
- 文件锁：标准库 `fcntl`（Linux）
- 日志：标准库 `logging`
- 测试：`pytest`（仅开发依赖）

`playwright`、`httpx` 在阶段 1 **不需要安装**。
但 `doctor` 的 D2 检查需要检测它们是否存在——**检测 ≠ 依赖**。
若未安装，D2 报 `FAIL` 并说明「阶段 3 才需要，可暂不安装」时，应降级为 `WARN`。

> 修正：D2 在阶段 1 应为 `WARN`，阶段 3 起升为 `FAIL`。已在 CLI_SPEC 中同步。

---

## 9. 阶段 1 完成标志

全部满足才算完成：

- [ ] 17 个文件按职责就位，无空文件
- [ ] `core/state_machine.py` 单测覆盖所有合法与非法转换
- [ ] `dac doctor` 在干净目录、半配置目录、完整配置目录三种情况下行为正确
- [ ] `dac run` 能被 `pause` / `resume` / `stop` 可靠控制
- [ ] 双实例启动被拒绝
- [ ] 所有退出码与 CLI_SPEC §8 一致
- [ ] 日志中无凭证、无聊天正文
- [ ] 你能完整讲出「一条 `pause` 命令从输入到状态变更」的执行链（Understanding Gate）
