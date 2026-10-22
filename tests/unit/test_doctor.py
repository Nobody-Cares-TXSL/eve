import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from dac.commands import doctor as doctor_module
from dac.commands.doctor import CheckResult, render_json, run_doctor


def config(path: Path, **overrides):
    value = {
        "cycle_seconds": 30,
        "target": {"douyin_id": ""},
        "login": {"credentials_file": ""},
        "runtime": {"mode": "L3"},
        "risk": {"acceptance": "accepted"},
    }
    value.update(overrides)
    path.write_text(json.dumps(value), encoding="utf-8")


def test_missing_config_always_reports_eleven_checks(tmp_path):
    results, code = run_doctor(tmp_path / "missing.json", tmp_path / "data")
    payload = json.loads(render_json(results))
    assert [x["id"] for x in payload["checks"]] == [f"D{i}" for i in range(1, 12)]
    assert code == 2
    assert payload["checks"][3]["level"] == "fail"
    assert payload["checks"][9]["level"] == "warn"
    assert payload["checks"][10]["level"] == "warn"


def test_valid_config_returns_consistent_exit_code(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg)
    results, code = run_doctor(cfg, tmp_path / "data")
    assert len(results) == 11
    assert code == (2 if any(x.level == "fail" for x in results) else 0)
    assert results[9].level == "ok"
    assert results[10].level == "ok"


def test_broken_json_does_not_escape_and_keeps_d10_d11(tmp_path):
    cfg = tmp_path / "config.json"
    cfg.write_text("{broken", encoding="utf-8")
    results, code = run_doctor(cfg, tmp_path / "data")
    assert len(results) == 11
    assert code == 2
    assert results[3].level == "fail"
    assert results[9].level == results[10].level == "warn"


def test_bad_mode_fails_d4_and_d10(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg, runtime={"mode": "L9"})
    results, _ = run_doctor(cfg, tmp_path / "data")
    assert results[3].level == "fail"
    assert results[9].level == "fail"


def test_stdlib_name_scan_is_limited_to_project_src(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg)
    project_src = tmp_path / "src"
    project_src.mkdir()
    (project_src / "selectors.py").write_text("", encoding="utf-8")
    results, _ = run_doctor(cfg, tmp_path / "data", project_root=tmp_path)
    assert results[2].level == "fail"
    (project_src / "selectors.py").unlink()
    ref = tmp_path / "douyin-robot/src"
    ref.mkdir(parents=True)
    (ref / "selectors.py").write_text("", encoding="utf-8")
    results, _ = run_doctor(cfg, tmp_path / "data", project_root=tmp_path)
    assert results[2].level == "ok"


def test_existing_writable_directory_is_ok(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg)
    data = tmp_path / "data"
    data.mkdir()
    results, code = run_doctor(cfg, data)
    assert results[4].level == "ok"
    assert results[5].level == "ok"
    assert (data / "logs").is_dir()
    assert code == 0


def test_wrong_nested_object_type_is_reported_without_exception(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg, runtime="L3", risk="accepted")
    results, code = run_doctor(cfg, tmp_path / "data")
    assert len(results) == 11
    assert results[3].level == "fail"
    assert results[9].level == results[10].level == "fail"
    assert code == 2


def test_mode_upper_bound_tracks_engineering_stage(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg, runtime={"mode": "L2"})
    stage_one, _ = run_doctor(cfg, tmp_path / "data-1", stage=1)
    stage_three, _ = run_doctor(cfg, tmp_path / "data-3", stage=3)
    assert stage_one[9].level == "fail"
    assert stage_three[9].level == "ok"


def test_existing_read_only_directory_fails_even_as_root(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg)
    data = tmp_path / "data"
    data.mkdir()
    data.chmod(0o555)
    try:
        results, _ = run_doctor(cfg, data)
        assert results[4].level == "fail"
    finally:
        data.chmod(0o755)


def test_missing_optional_declarations_are_warn_not_config_fail(tmp_path):
    cfg = tmp_path / "config.json"
    config(cfg, runtime={}, risk={})
    results, _ = run_doctor(cfg, tmp_path / "data")
    assert results[3].level == "ok"
    assert results[9].level == results[10].level == "warn"


def test_assembly_crash_keeps_finished_checks(tmp_path, monkeypatch):
    """装配过程在 D7 之后崩溃时，D1～D7 保留真实结果，只有 D8～D11 被补记。

    兜底不能把所有项一律标 FAIL——那会掩盖究竟是哪一项出了问题。
    """
    cfg = tmp_path / "config.json"
    config(cfg)
    boom = RuntimeError("装配崩溃")

    def failing_build(*args):
        # 模拟 _build_checks 已完成前 7 项后自身出错
        collected = args[4]
        for i, level in enumerate(["ok", "warn", "ok", "ok", "ok", "ok", "warn"], start=1):
            collected.append(CheckResult(f"D{i}", level, f"已完成 D{i}"))
        raise boom

    monkeypatch.setattr(doctor_module, "_build_checks", failing_build)
    results, code = run_doctor(cfg, tmp_path / "data")
    assert [x.id for x in results] == [f"D{i}" for i in range(1, 12)]
    # 已完成项原样保留
    assert [x.detail for x in results[:7]] == [f"已完成 D{i}" for i in range(1, 8)]
    assert results[0].level == "ok" and results[1].level == "warn"
    # 未完成项才是兜底补记
    for item in results[7:]:
        assert item.level == "fail"
        assert "未能完成" in item.detail
    assert "RuntimeError" in results[7].detail
    assert code == 2


def test_single_check_crash_does_not_take_down_others(tmp_path, monkeypatch):
    """单项检查崩溃（被 _check 隔离）时，其余十项仍产出真实结果。"""
    cfg = tmp_path / "config.json"
    config(cfg)
    monkeypatch.setattr(doctor_module, "_lock_result",
                        lambda data_dir: (_ for _ in ()).throw(OSError("stat 失败")))
    results, code = run_doctor(cfg, tmp_path / "data")
    assert len(results) == 11
    assert results[6].level == "fail" and "检查异常" in results[6].detail
    assert results[7].level == "warn"  # D8 不受影响，仍是真实的「未配置」
    assert results[9].level == "ok"    # D10 配置合法应通过
    assert code == 2
