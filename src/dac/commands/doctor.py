"""环境自检：每项检查都是独立的故障隔离边界，任何诊断异常都不能逃逸到 CLI。"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class CheckResult:
    id: str
    level: str
    detail: str
    fix: str | None = None

    def as_dict(self) -> dict[str, str]:
        result = {"id": self.id, "level": self.level, "detail": self.detail}
        if self.fix:
            result["fix"] = self.fix
        return result


def _check(identifier: str, fn: Callable[[], Any]) -> list[CheckResult]:
    """执行一项检查。崩溃也只损失这一项的结果，不影响其余十项。

    fn 可以返回 CheckResult、(level, detail[, fix]) 元组、或 CheckResult 列表。
    """
    try:
        result = fn()
    except Exception as exc:  # 单项故障隔离边界
        return [CheckResult(identifier, "fail", f"检查异常：{type(exc).__name__}: {exc}")]
    if isinstance(result, CheckResult):
        return [result]
    if isinstance(result, list):
        return result
    level, detail, *fix = result
    return [CheckResult(identifier, level, detail, fix[0] if fix else None)]


def _fallback_results(partial: list[CheckResult], exc: Exception) -> list[CheckResult]:
    """装配流程本身崩溃时的最后兜底：保留已完成项，只补记未完成项。

    每项检查都经 `_check` 隔离后，走到这里意味着装配代码自身出错；
    已完成检查的结果必须原样保留，才能定位究竟是哪一项出了问题。
    """
    message = f"因 doctor 内部错误未能完成检查：{type(exc).__name__}: {exc}"
    reported = {item.id for item in partial}
    order = {f"D{i}": i for i in range(1, 12)}
    out = list(partial)
    for i in range(1, 12):
        identifier = f"D{i}"
        if identifier not in reported:
            out.append(CheckResult(identifier, "fail", message))
    return sorted(out, key=lambda item: order[item.id])


_EXPECTED_FIELDS: dict[str, type] = {
    "cycle_seconds": int,
    "pause_poll_seconds": int,
    "status_watch_seconds": int,
    "log_level": str,
    "target.douyin_id": str,
    "login.credentials_file": str,
    "runtime.mode": str,
    "risk.acceptance": str,
}
_PARENT_KEYS = ("target", "login", "runtime", "risk")
_POSITIVE_FIELDS = ("cycle_seconds", "pause_poll_seconds", "status_watch_seconds")
_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
_VALID_MODES = {"L0": 3, "L1": 2, "L2": 1, "L3": 0}  # 值越大能力越强
_VALID_ACCEPTANCE = {"accepted", "not-accepted"}


def _python_result() -> tuple:
    version = f"{sys.version.split()[0]} (要求 >= 3.11)"
    if sys.version_info >= (3, 11):
        return ("ok", version)
    return ("fail", version, "升级 Python 至 3.11 或更高版本")


def _dependency_result(stage: int) -> tuple:
    missing = [name for name in ("playwright", "httpx") if importlib.util.find_spec(name) is None]
    if not missing:
        return ("ok", "playwright、httpx 可导入")
    names = "、".join(missing)
    if stage < 3:
        return ("warn", f"缺少 {names}（阶段 {stage} 暂不阻塞）", "阶段 3 起安装 requirements.txt")
    return ("fail", f"缺少 {names}", "安装缺少的运行依赖")


def _module_names_result(project_root: Path | None) -> tuple:
    # 扫描的是本项目源码，而不是用户任意指定的配置文件所在目录。
    root_dir = (project_root or Path(__file__).resolve().parents[3]).resolve() / "src"
    if not root_dir.exists():
        return ("ok", f"源码目录尚不存在，跳过扫描：{root_dir}")
    ignored = {".git", ".venv", "venv", "__pycache__"}
    conflicts = [
        str(file.relative_to(root_dir))
        for file in root_dir.rglob("*.py")
        if not any(part in ignored for part in file.parts)
        and file.stem in sys.stdlib_module_names
    ]
    if conflicts:
        return ("fail", f"与标准库同名：{', '.join(conflicts)}", "重命名冲突模块")
    return ("ok", "无标准库同名模块")


def _load_config(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"配置文件不存在：{path}"
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return None, f"配置文件无法读取：{type(exc).__name__}: {exc}"
    if not isinstance(raw, dict):
        return None, "配置根节点必须是 JSON 对象"
    return raw, None


def _field(data: dict[str, Any], dotted: str) -> tuple[Any, bool]:
    current: Any = data
    for part in dotted.split("."):
        if not isinstance(current, dict) or part not in current:
            return None, False
        current = current[part]
    return current, True


def _flatten_keys(data: dict[str, Any], prefix: str = "") -> set[str]:
    result: set[str] = set()
    for key, value in data.items():
        path = f"{prefix}.{key}" if prefix else key
        result.add(path)
        if isinstance(value, dict):
            result |= _flatten_keys(value, path)
    return result


def _config_result(config_path: Path, holder: dict[str, Any]) -> CheckResult:
    """D4：加载配置并校验结构；加载结果经 holder 供 D8～D11 复用。"""
    data, error = _load_config(config_path)
    holder["data"] = data
    if error:
        return CheckResult("D4", "fail", error,
                           "按 docs/CLI_SPEC.md §7.1 创建配置，并填写必需字段 cycle_seconds")

    problems: list[str] = []
    for parent in _PARENT_KEYS:
        parent_value, parent_exists = _field(data, parent)
        if parent_exists and not isinstance(parent_value, dict):
            problems.append(f"{parent} 类型错误，期望 object")
    for field, expected_type in _EXPECTED_FIELDS.items():
        value, exists = _field(data, field)
        if field == "cycle_seconds" and not exists:
            problems.append(f"{field} 缺失（必填）")
            continue
        if not exists:
            continue
        valid_type = (type(value) is int) if expected_type is int else isinstance(value, expected_type)
        if not valid_type:
            problems.append(f"{field} 类型错误，期望 {expected_type.__name__}")
        elif field in _POSITIVE_FIELDS and value <= 0:
            problems.append(f"{field} 必须大于 0")
        elif field == "log_level" and value not in _LOG_LEVELS:
            problems.append("log_level 必须是 DEBUG/INFO/WARNING/ERROR/CRITICAL")
        elif field == "runtime.mode" and value not in _VALID_MODES:
            problems.append("runtime.mode 必须是 L0/L1/L2/L3")
        elif field == "risk.acceptance" and value not in _VALID_ACCEPTANCE:
            problems.append("risk.acceptance 必须是 accepted/not-accepted")

    known = set(_EXPECTED_FIELDS)
    unknown = sorted(
        path for path in _flatten_keys(data) - known
        if not any(known_path.startswith(path + ".") for known_path in known)
    )
    if problems:
        return CheckResult("D4", "fail", "；".join(problems), "按 docs/CLI_SPEC.md §7.1 修复字段与类型")
    if unknown:
        return CheckResult("D4", "warn", f"配置结构合法；未知字段将忽略：{', '.join(unknown)}")
    return CheckResult("D4", "ok", "配置结构合法")


def _check_path(path: Path, label: str) -> CheckResult:
    try:
        if path.exists():
            if not path.is_dir():
                return CheckResult(label, "fail", f"路径存在但不是目录：{path}")
            if not os.access(path, os.W_OK | os.X_OK):
                return CheckResult(label, "fail", f"目录不可写：{path}")
            # root 下 os.access 可能掩盖 chmod 000/555；权限位也需要验证。
            if path.stat().st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH) == 0:
                return CheckResult(label, "fail", f"目录权限位不允许写入：{path}")
        else:
            path.mkdir(parents=True, exist_ok=True)
            if not path.is_dir() or not os.access(path, os.W_OK | os.X_OK):
                return CheckResult(label, "fail", f"目录创建后不可写：{path}")
        return CheckResult(label, "ok", str(path.resolve()))
    except OSError as exc:
        return CheckResult(label, "fail", f"{path}: {type(exc).__name__}: {exc}")


def _lock_result(data_dir: Path) -> tuple:
    lock = data_dir / "run.lock"
    if lock.exists():
        return ("warn", f"锁文件存在，需由 run 非阻塞核验是否被持有：{lock}",
                "doctor 只读探测，不获取也不删除锁文件")
    return ("ok", "未发现运行锁文件")


def _target_result(holder: dict[str, Any]) -> tuple:
    data = holder.get("data")
    if not isinstance(data, dict):
        return ("warn", "配置不可用，未检查目标账号（见 D4）")
    value, exists = _field(data, "target.douyin_id")
    if exists and isinstance(value, str) and value.strip():
        return ("ok", "已配置 target.douyin_id")
    return ("warn", "未配置 target.douyin_id（阶段 3 前无需填写）")


def _credentials_result(holder: dict[str, Any]) -> tuple:
    data = holder.get("data")
    if not isinstance(data, dict):
        return ("warn", "配置不可用，未检查登录凭证（见 D4）")
    value, exists = _field(data, "login.credentials_file")
    if exists and isinstance(value, str) and value:
        cred = Path(value).expanduser()
        if cred.is_file():
            return ("ok", f"凭证文件存在：{cred}")
    return ("warn", "未配置或凭证文件不存在（阶段 3 前无需填写）")


def _stage_max_mode(stage: int) -> str:
    return "L3" if stage <= 2 else "L2" if stage == 3 else "L1" if stage <= 5 else "L0"


def _runtime_result(holder: dict[str, Any], stage: int) -> tuple:
    data = holder.get("data")
    if not isinstance(data, dict):
        return ("warn", "配置不可用，未检查 runtime.mode（见 D4）")
    if "runtime" in data and not isinstance(data["runtime"], dict):
        return ("fail", "runtime 类型错误，期望 object")
    mode, exists = _field(data, "runtime.mode")
    if not exists:
        return ("warn", "未声明 runtime.mode")
    if not isinstance(mode, str) or mode not in _VALID_MODES:
        return ("fail", f"非法 runtime.mode：{mode!r}")
    max_mode = _stage_max_mode(stage)
    if _VALID_MODES[mode] > _VALID_MODES[max_mode]:
        return ("fail", f"{mode} 超出阶段 {stage} 的工程能力上限；当前最高为 {max_mode}",
                f"将 runtime.mode 调整为 {max_mode}")
    return ("ok", f"{mode}（阶段 {stage} 允许，当前最高为 {max_mode}）")


def _risk_result(holder: dict[str, Any]) -> tuple:
    data = holder.get("data")
    if not isinstance(data, dict):
        return ("warn", "配置不可用，未检查 risk.acceptance（见 D4）")
    if "risk" in data and not isinstance(data["risk"], dict):
        return ("fail", "risk 类型错误，期望 object")
    value, exists = _field(data, "risk.acceptance")
    if not exists:
        return ("warn", "未声明 risk.acceptance")
    if not isinstance(value, str) or value not in _VALID_ACCEPTANCE:
        return ("fail", f"非法 risk.acceptance：{value!r}")
    if value == "accepted":
        return ("ok", "accepted")
    return ("warn", "not-accepted（风险未接受）")


def _build_checks(
    config_path: Path,
    data_dir: Path,
    stage: int,
    project_root: Path | None,
    collected: list[CheckResult],
) -> None:
    """按 D1～D11 固定顺序执行检查，结果依次追加到 collected。

    每项都经 `_check` 隔离；collected 允许只含前缀部分，
    装配中断时由 `_fallback_results` 基于它补记。
    """
    holder: dict[str, Any] = {"data": None}
    collected.extend(_check("D1", _python_result))
    collected.extend(_check("D2", lambda: _dependency_result(stage)))
    collected.extend(_check("D3", lambda: _module_names_result(project_root)))
    collected.extend(_check("D4", lambda: _config_result(config_path, holder)))
    collected.extend(_check("D5", lambda: _check_path(data_dir, "D5")))
    collected.extend(_check("D6", lambda: _check_path(data_dir / "logs", "D6")))
    collected.extend(_check("D7", lambda: _lock_result(data_dir)))
    collected.extend(_check("D8", lambda: _target_result(holder)))
    collected.extend(_check("D9", lambda: _credentials_result(holder)))
    collected.extend(_check("D10", lambda: _runtime_result(holder, stage)))
    collected.extend(_check("D11", lambda: _risk_result(holder)))


def run_doctor(
    config_path: Path,
    data_dir: Path,
    stage: int = 1,
    project_root: Path | None = None,
) -> tuple[list[CheckResult], int]:
    """即使个别检查失败也返回完整结果；退出码只由结果级别决定，doctor 自身永不抛异常。"""
    collected: list[CheckResult] = []
    try:
        _build_checks(Path(config_path).expanduser().resolve(), Path(data_dir).expanduser().resolve(),
                      stage, project_root, collected)
        results = collected
    except Exception as exc:  # 最后兜底：保留已完成项，只补记未完成项
        results = _fallback_results(collected, exc)
    has_fail = any(item.level == "fail" for item in results)
    return results, 2 if has_fail else 0


def render_json(results: list[CheckResult]) -> str:
    counts = {level: sum(item.level == level for item in results) for level in ("fail", "warn", "ok")}
    return json.dumps({"checks": [item.as_dict() for item in results], "summary": counts},
                      ensure_ascii=False, indent=2)
