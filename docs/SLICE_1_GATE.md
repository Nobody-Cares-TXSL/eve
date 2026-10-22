# Slice 1 Understanding Gate

> 版本：v1.0
> 状态：Slice 1 验收记录
> 对应 AC：AC-1.1、AC-1.2、AC-1.3
> 判定标准见 `CLAUDE.md`「Understanding Gate 的判定标准」：
> 必须说清 **执行链**、**异常分支**、**测试证据** 三项。

---

## 一、这一轮完成了什么

`dac doctor` 能逐项诊断环境与配置，输出固定 D1～D11 十一项结果，支持 `--json`，
在配置缺失、配置损坏、目录权限异常时均不抛异常。

**不包含**（明确未做）：`run` / `pause` / `resume` / `stop` / `status` / `logs`。
这些属于后续 Slice。

---

## 二、执行链

### 2.1 主链路：`dac doctor --json`

```
[1] 进程启动
     │  python -m dac.cli doctor --config X --data-dir Y --json
     ▼
[2] cli.main()
     │  build_parser().parse_args()
     │  → args.command == "doctor"
     ▼
[3] run_doctor(config_path, data_dir, stage, project_root)
     │  路径规范化：expanduser().resolve()
     │  创建 collected: list[CheckResult] = []
     ▼
[4] _build_checks(...)  ← 按固定顺序装配，每项经 _check 隔离
     │
     │  D1  _python_result()              sys.version_info
     │  D2  _dependency_result(stage)     importlib.util.find_spec
     │  D3  _module_names_result(root)    rglob("*.py") ∩ stdlib_module_names
     │  D4  _config_result(path, holder)  读文件 → JSON 解析 → 字段校验
     │  D5  _check_path(data_dir)         存在性/可写/权限位，必要时 mkdir
     │  D6  _check_path(data_dir/"logs")  同上
     │  D7  _lock_result(data_dir)        run.lock 是否存在（只读）
     │  D8  _target_result(holder)        复用 D4 加载的 data
     │  D9  _credentials_result(holder)   同上
     │  D10 _runtime_result(holder, stage) 同上 + 阶段能力上限
     │  D11 _risk_result(holder)          同上
     ▼
[5] 汇总
     │  has_fail = any(level == "fail")
     │  返回 (results, 2 if has_fail else 0)
     ▼
[6] cli.main() 格式化
     │  --json → render_json(results)
     │  否则   → 人类可读表格
     ▼
[7] 退出码
     │  返回 code → raise SystemExit(main()) → 进程退出码
```

### 2.2 `holder` 是 D4 与 D8～D11 的连接点

```
holder: dict = {"data": None}
        │
        ├─ D4 执行时写入：holder["data"] = 解析后的 dict（或 None）
        │
        └─ D8～D11 读取：data = holder.get("data")
              ├─ 是 dict  → 做真实检查
              └─ 是 None  → 返回 "配置不可用，未检查…（见 D4）"，级别 warn
```

**为什么必须这样**：配置只读一次。若 D8～D11 各自重新读文件，
一次诊断会读 5 次文件，且可能出现「D4 读到旧内容、D10 读到新内容」的不一致。

---

## 三、异常分支

### 3.1 三层故障隔离

| 层 | 位置 | 拦截什么 | 后果 |
|---|---|---|---|
| **第一层** | `_check()` 的 `try/except` | 单项检查函数内部崩溃 | 只有该项变 `fail`，其余十项照常 |
| **第二层** | `run_doctor()` 的 `try/except` | `_build_checks` 装配代码自身崩溃 | 已完成项原样保留，未完成项补记 |
| **第三层** | `cli.main()` 的 `try/except` | 参数解析、格式化等 CLI 层异常 | 打印到 stderr，退出码 `1` |

**第一层是常规路径**：绝大多数诊断异常（文件不存在、权限不足、JSON 损坏）
在这里就被转成检查项。

**第二层是兜底**：`_build_checks` 只做「依次调用 + 追加」，本身几乎不会崩。
真正走到这里说明有代码缺陷。

**第三层是最后防线**：CLI 层不应有业务逻辑，走到这里说明是用法或实现问题。

### 3.2 第二层兜底不能「一律标 FAIL」

初版实现是：

```python
except Exception:
    results = [CheckResult(f"D{i}", "fail", ...) for i in range(1, 12)]
```

**问题**：D1～D7 已经执行完了，它们的真实结果被丢弃。
用户看到 11 项全 FAIL，无法判断究竟是哪一项出了问题。

现版：

```python
except Exception as exc:
    results = _fallback_results(collected, exc)
    # collected 里已有的项原样保留
    # 只给「不在 collected 里」的编号补记
```

**测试证据**：`test_assembly_crash_keeps_finished_checks`
构造「D1～D7 已完成、随后崩溃」的场景，断言：

- D1～D7 的 detail 与 level 原样保留（`已完成 D1` … `已完成 D7`）
- D8～D11 才是兜底补记的 `fail`
- 结果仍按 D1→D11 排序

### 3.3 D4 失败时 D10/D11 为什么是 `warn` 而不是 `fail`

| 问题 | 答案 |
|---|---|
| D4 失败意味着什么？ | 配置不可用（不存在/损坏/结构非法） |
| D10/D11 检查什么？ | 配置中声明的 `runtime.mode` / `risk.acceptance` |
| 配置都读不到，还能判定「非法」吗？ | **不能** |
| 那该报什么？ | `warn` + 「配置不可用，未检查…（见 D4）」 |

**关键**：D10/D11 报 `warn` 不是「忽略问题」，而是**如实说明这两项没能检查**。
真正的错误由 D4 报告，不重复计。

**反例（错误设计）**：让 D10/D11 也报 `fail`。
后果是一次配置缺失会产出 3 个 FAIL，用户会以为有三处问题。

### 3.4 D4 与 D10 可以同时报不同结果

这是你特别问到的点。分两种情况：

| 配置内容 | D4 | D10 | 为什么 |
|---|---|---|---|
| `runtime.mode: "L9"` | `fail`（非法值） | `fail`（非法值） | 两者都在校验同一个值的**合法性** |
| `runtime.mode: "L2"`，`--stage 1` | `ok`（值合法） | `fail`（超出阶段上限） | D4 只管**语法**，D10 管**工程一致性** |

**职责划分**：

```
D4  = 配置是否「形式合法」（字段存在、类型正确、枚举值在允许集合内）
D10 = 配置是否「与当前工程阶段匹配」（模式不超过该阶段能力）
```

`L2` 是合法枚举值，所以 D4 通过；但阶段 1 还没有只读归档能力，所以 D10 失败。

**测试证据**：
- `test_bad_mode_fails_d4_and_d10`（非法值 → 两者都 fail）
- `test_mode_upper_bound_tracks_engineering_stage`（L2 在 stage 1 失败、在 stage 3 通过）

---

## 四、测试证据

### 4.1 测试清单（18 项）

| 文件 | 测试 | 覆盖 |
|---|---|---|
| `tests/unit/test_doctor.py` | `test_missing_config_always_reports_eleven_checks` | AC-1.1 证据① |
| | `test_valid_config_returns_consistent_exit_code` | AC-1.1 证据② |
| | `test_broken_json_does_not_escape_and_keeps_d10_d11` | AC-1.1 证据⑤ |
| | `test_bad_mode_fails_d4_and_d10` | AC-1.2 证据④ |
| | `test_stdlib_name_scan_is_limited_to_project_src` | AC-1.3 证据②③ |
| | `test_existing_writable_directory_is_ok` | AC-1.1 证据④ |
| | `test_wrong_nested_object_type_is_reported_without_exception` | AC-1.2 结构校验 |
| | `test_mode_upper_bound_tracks_engineering_stage` | D10 工程一致性 |
| | `test_existing_read_only_directory_fails_even_as_root` | AC-1.1 证据③ |
| | `test_missing_optional_declarations_are_warn_not_config_fail` | AC-1.2 证据③ |
| | `test_assembly_crash_keeps_finished_checks` | **第二层故障隔离** |
| | `test_single_check_crash_does_not_take_down_others` | **第一层故障隔离** |
| `tests/integration/test_cli_doctor.py` | `test_cli_json_has_stable_eleven_check_contract` | JSON 契约 |
| | `test_cli_valid_config_and_directory_creation` | 目录创建 |
| | `test_cli_scenario_clean_dir_missing_config` | **场景一（真实 CLI）** |
| | `test_cli_scenario_half_config` | **场景二（真实 CLI）** |
| | `test_cli_scenario_read_only_directory` | **场景三（真实 CLI）** |
| | `test_cli_summary_matches_checks` | summary 与明细一致 |

### 4.2 三类目录场景全部走真实 CLI

初版只有单元测试覆盖目录场景。现版三个场景都通过 `subprocess` 启动真实进程：

```python
subprocess.run([sys.executable, "-m", "dac.cli", "doctor",
                "--config", str(config), "--data-dir", str(data), "--json"])
```

| 场景 | 配置 | 目录 | 预期 |
|---|---|---|---|
| 一 | 缺失 | 不存在（会被创建） | D4 `fail`，D2 `warn`，D10/D11 `warn`，退出码 `2` |
| 二 | 合法 | 已存在且可写 | 全部 `ok`/`warn`，退出码 `0` |
| 三 | 合法 | 已存在但只读（`chmod 555`） | D4 `ok`，D5 `fail`，退出码 `2` |

### 4.3 实际运行验证

```
$ PYTHONPATH=src .venv/bin/python -m dac.cli doctor \
    --config /tmp/xxx/absent.json --data-dir /tmp/xxx/data --json
```

输出 11 项，`summary = {"fail": 1, "warn": 5, "ok": 5}`，退出码 `2`。

### 4.4 其他检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `.venv/bin/python -m pytest tests/ -v` | 18 passed |
| 编译 | `.venv/bin/python -m compileall -q src tests` | 通过 |
| 空白字符 | `git diff --check` | 通过 |

---

## 五、能解释什么（Gate 自检）

| 问题 | 回答 |
|---|---|
| 一条 `doctor --json` 从输入到输出的完整链？ | §2.1 的 7 步 |
| 配置只读一次是怎么保证的？ | §2.2 的 `holder` 传递 |
| 单项检查崩了会怎样？ | §3.1 第一层，只有该项 fail |
| 装配代码崩了会怎样？ | §3.1 第二层，保留已完成项 |
| 为什么 D4 失败时 D10/D11 是 warn？ | §3.3 |
| 为什么 D4 和 D10 可以不同结果？ | §3.4 的职责划分 |
| 怎么证明三类目录场景都对？ | §4.2 的 subprocess 测试 |

---

## 六、结论

**Slice 1 达到验收标准。**

三项待补已全部完成：

| 待补项 | 状态 | 证据 |
|---|---|---|
| 三类目录场景的真实 CLI 覆盖 | ✅ | §4.2，3 个 subprocess 测试 |
| 收紧故障隔离，不一律标 FAIL | ✅ | §3.2，2 个隔离测试 |
| Understanding Gate | ✅ | 本文档 |
