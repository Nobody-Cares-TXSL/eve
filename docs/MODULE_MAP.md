# 基础模块地图 — MODULE_MAP

> 版本：v1.1
> 状态：阶段 1 交付物（已确认）
> 范围：**仅阶段 1**。只划分 CLI、配置、运行状态、日志、进程控制。
> 归档、身份核验、AI、发送**本阶段不创建文件**，只在架构图中占位。

## 审查记录

| 日期 | 版本 | 范围 | 结论 |
|---|---|---|---|
| 2026-10-23 | v1.0 | 全文 | 发现 6 处问题（3 处阻断），**不确认** |
| 2026-10-23 | v1.1 | 全文 | 已修复全部 6 处 |
| 2026-10-23 | v1.1 | 复审 | 修复过程中发现 CLI_SPEC §4.2 的 `run` 流程缺少挂起步骤，已同步；**复审通过** |

### v1.0 审查问题与处置

| 编号 | 问题 | 处置 |
|---|---|---|
| P1 | 文件数量写 17，实际 18 | 已修复：改为 18，见 §2 |
| P2 | `run_loop` 接口无法表达「挂起等待」 | 已修复：改为返回 `LoopAction` 三态（`CONTINUE` / `SUSPEND` / `EXIT`），见 §4.2 |
| P3 | `Settings` 字段与 CLI_SPEC §7.1 不对齐 | 已修复：字段补全并交叉引用，见 §4.3 |
| P4 | 状态机纯函数无法区分 `stop` 在 running / paused_manual 下的语义 | 已修复：新增 `STOP_IMMEDIATE` 事件，见 §4.1 |
| P5 | `lock.py` 无「只读探测」能力，D7 无法实现 | 已修复：`lock.py` 增加 `probe()`，见 §3 |
| P6 | §8 依赖一段自相矛盾（FAIL/WARN 改到一半） | 已修复：删除残留，见 §8 |

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

**共 18 个文件**（含 4 个 `__init__.py`）。

> 计数（以树为准）：
> - `src/dac/`：`__init__.py` + `cli.py` = **2**
> - `commands/`：`__init__.py` + doctor/status/run/control/logs = **6**
> - `core/`：`__init__.py` + state_machine/loop = **3**
> - `infra/`：`__init__.py` + settings/paths/state_file/control_file/lock/log_setup = **7**
>
> 合计 2 + 6 + 3 + 7 = **18**。
>
> 初版把 `commands/` 误记为「4 个模块 + 1 个 `__init__.py`」（实为 5 + 1），
> 导致算式得 17 而结论写 18。已按树更正。

---

## 3. 模块职责

| 模块 | 职责 | 不负责 | 测试方式 |
|---|---|---|---|
| `cli.py` | 解析参数、分发命令、统一异常→退出码 | 任何业务逻辑 | 集成测试 |
| `commands/doctor.py` | 执行 D1～D11 检查、汇总、格式化输出 | 修复问题；**不得 import `load_settings`** | 注入检查函数，单测 |
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
| `infra/lock.py` | 单实例锁（文件锁）、**只读探测 `probe()`**（供 doctor D7 使用，不获取锁、不阻塞） | 判断能否运行 | 单测（双进程） |
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
    PAUSED_ENV = "paused_env"
    PAUSED_UNKNOWN = "paused_unknown"
    ERROR = "error"

class Event(str, Enum):
    START = "start"
    PAUSE = "pause"
    RESUME = "resume"
    STOP = "stop"                    # 运行中收到停止：当前轮结束后退出
    STOP_IMMEDIATE = "stop_now"      # 挂起中收到停止：立即退出，无「当前轮」
    CYCLE_END = "cycle_end"
    AUTH_LOST = "auth_lost"
    FATAL = "fatal"

def transition(state: RunState, event: Event) -> RunState:
    """返回新状态；非法转换抛 InvalidTransition。不读写任何文件。"""
```

**非法转换必须是错误，不是静默忽略。** 例：`stopped + RESUME` → `InvalidTransition`。

#### 为什么需要 `STOP_IMMEDIATE`

初版只有一个 `STOP` 事件，但 `stop` 在两种状态下的语义不同：

| 当前状态 | 收到 stop | 行为 |
|---|---|---|
| `running` | 当前轮**结束后**退出 | 需要等一轮 |
| `paused_manual` | **立即**退出 | 没有「当前轮」可等 |

纯函数 `transition(state, event)` 只知道状态，不知道进程是否正在执行一轮。
若用同一个 `STOP`，实现方只能自行判断——那就把语义漏到了调用方。

**拆成两个事件后**，调用方按「当前是否在轮次中」选择事件，状态机保持纯粹：

```
running        + STOP           → stopped
paused_manual  + STOP_IMMEDIATE → stopped
```

> `STOP_IMMEDIATE` 在 `running` 下是**非法转换**（有当前轮却要求立即退出，
> 会破坏「只在轮次边界改变状态」的约束）。

### 4.2 循环（可注入）

```python
# core/loop.py

class LoopAction(str, Enum):
    CONTINUE = "continue"    # 继续下一轮
    SUSPEND = "suspend"      # 挂起：不退出、不做业务，轮询控制文件
    EXIT = "exit"            # 退出循环

Tick = Callable[[], LoopAction]    # 一轮做什么，并决定本轮结束后如何走
OnSuspend = Callable[[], LoopAction]  # 挂起期间每次轮询后的判断
Sleep = Callable[[float], None]    # 可注入，便于测试

def run_loop(
    tick: Tick,
    on_suspend: OnSuspend,
    interval: float,
    pause_poll_seconds: float,
    sleep: Sleep = time.sleep,
) -> None:
    """循环骨架：
       CONTINUE → 休眠 interval 后进入下一轮
       SUSPEND  → 转入挂起，每 pause_poll_seconds 调用 on_suspend()
                  on_suspend 返回 CONTINUE 则回到正常轮次，返回 EXIT 则退出
       EXIT     → 立即返回
       只在轮次边界改变状态。"""
```

#### 为什么必须有三态

初版只有「继续 / 退出」两种出路，无法表达 `paused_manual` 的要求：

> 进程进入 `paused_manual` 后，**不退出、不做业务**，只做一件事：轮询控制文件（CLI_SPEC §4.4）

用 `should_continue` 返回 `False` 会让进程**退出**——但 `paused_manual` 要求进程存活。
在 `tick` 里自己死循环会违反「循环不感知业务」。

`SUSPEND` 是第三种出路：**循环交出控制权但保留进程**。

| 出路 | 进程 | 谁决定下一步 |
|---|---|---|
| `CONTINUE` | 存活，跑下一轮 | 循环自己 |
| `SUSPEND` | 存活，空转 | `on_suspend` 每次轮询返回 |
| `EXIT` | 退出 | — |

> 阶段 1 的 `tick` 只写心跳日志并返回 `CONTINUE`；`on_suspend` 读控制文件。
> 阶段 3 起 `tick` 换成「读→归档」；阶段 4 再加「生成→发送」。
> **循环本身不感知业务**，这是后续所有阶段能复用同一套暂停逻辑的前提。

### 4.3 配置（强校验）

```python
# infra/settings.py

@dataclass(frozen=True)
class Settings:
    # ── 阶段 1 全部字段，与 CLI_SPEC §7.1 一一对应，不得省略 ──
    cycle_seconds: int             # 必填，缺失即报错（无默认值）
    pause_poll_seconds: int = 2    # 挂起时轮询控制文件的间隔
    status_watch_seconds: int = 3  # status --watch 的刷新间隔
    log_level: str = "INFO"
    target_douyin_id: str = ""  # 为空 → D8 WARN，run 退出码 3
    login_credentials_file: str = ""  # 为空 → D9 WARN
    runtime_mode: str | None = None  # 缺失 → D10 WARN；阶段 1 仅 L3 为 OK
    risk_acceptance: str | None = None  # 缺失/拒绝 → D11 WARN

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

> **字段清单以 `CLI_SPEC §7.1` 为准**，本节只做类型映射。
> 新增配置字段时必须同时更新两处。

#### 外部字段路径 → 内部字段名的映射

配置文件的字段路径是**带点的层级路径**，内部 `Settings` 用**下划线平铺名**。
两者**不是同一组字符串**，不能直接比较。

| 配置文件路径（§7.1） | `Settings` 字段 |
|---|---|
| `cycle_seconds` | `cycle_seconds` |
| `pause_poll_seconds` | `pause_poll_seconds` |
| `status_watch_seconds` | `status_watch_seconds` |
| `log_level` | `log_level` |
| `target.douyin_id` | `target_douyin_id` |
| `login.credentials_file` | `login_credentials_file` |
| `runtime.mode` | `runtime_mode` |
| `risk.acceptance` | `risk_acceptance` |

**映射规则**：点号 `.` → 下划线 `_`。

> **测试定义修正**：初版说「测试断言 `Settings` 字段集合与 §7.1 表格一致」——
> 这个断言不成立，因为 `target.douyin_id` ≠ `target_douyin_id`。
>
> 正确的测试应断言：
> 1. `Settings` 的字段集合 == **映射表右列**的集合；
> 2. 映射表左列 == §7.1 表格的字段路径集合；
> 3. 每条路径按规则映射后，都能在 `Settings` 中找到。
>
> 映射表本身应作为代码中的常量（`FIELD_MAP`），测试直接读它。

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

| 阶段 | D2 级别 | 未安装时的输出 |
|---|---|---|
| 阶段 1 | `WARN` | 「阶段 3 才需要，可暂不安装」 |
| 阶段 3 起 | `FAIL` | 「缺少运行依赖，请 pip install -r requirements.txt」 |

> 与 `CLI_SPEC §2.2` 一致。

---

## 9. 阶段 1 完成标志

全部满足才算完成：

- [ ] 模块职责已就位，无空文件
      （**不强制 18 个文件**：结构是建议，允许按 Slice 实际需要合并或拆分，
       前提是 §1.2 的依赖边界与 §3 的职责划分不变）
- [ ] `core/state_machine.py` 单测覆盖所有合法与非法转换
- [ ] `dac doctor` 在干净目录、半配置目录、完整配置目录三种情况下行为正确
- [ ] `dac run` 能被 `pause` / `resume` / `stop` 可靠控制
- [ ] 双实例启动被拒绝
- [ ] 所有退出码与 CLI_SPEC §8 一致
- [ ] 日志中无凭证、无聊天正文
- [ ] 你能完整讲出「一条 `pause` 命令从输入到状态变更」的执行链（Understanding Gate）
