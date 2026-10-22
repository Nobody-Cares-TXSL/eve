import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV = {**os.environ, "PYTHONPATH": str(ROOT / "src")}


def invoke(config, data, *extra):
    return subprocess.run(
        [sys.executable, "-m", "dac.cli", "doctor", "--config", str(config),
         "--data-dir", str(data), "--json", *extra],
        cwd=ROOT, env=ENV, capture_output=True, text=True,
    )


def test_cli_json_has_stable_eleven_check_contract(tmp_path):
    result = invoke(tmp_path / "absent.json", tmp_path / "data")
    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert [c["id"] for c in payload["checks"]] == [f"D{i}" for i in range(1, 12)]
    assert payload["summary"]["fail"] >= 1


def test_cli_valid_config_and_directory_creation(tmp_path):
    config = tmp_path / "config.json"
    config.write_text(json.dumps({
        "cycle_seconds": 30,
        "target": {"douyin_id": ""},
        "login": {"credentials_file": ""},
        "runtime": {"mode": "L3"},
        "risk": {"acceptance": "accepted"},
    }), encoding="utf-8")
    data = tmp_path / "new-data"
    result = invoke(config, data)
    assert result.returncode == 0
    assert data.is_dir() and (data / "logs").is_dir()
    payload = json.loads(result.stdout)
    assert len(payload["checks"]) == 11
    assert payload["summary"]["fail"] == 0


def _valid_config_payload(**overrides):
    value = {
        "cycle_seconds": 30,
        "target": {"douyin_id": ""},
        "login": {"credentials_file": ""},
        "runtime": {"mode": "L3"},
        "risk": {"acceptance": "accepted"},
    }
    value.update(overrides)
    return json.dumps(value)


def _levels_by_id(payload):
    return {item["id"]: item["level"] for item in payload["checks"]}


def test_cli_scenario_clean_dir_missing_config(tmp_path):
    """场景一：干净目录 + 缺配置。D4 FAIL，其余稳定输出，退出码 2。"""
    config, data = tmp_path / "absent.json", tmp_path / "data"
    result = invoke(config, data)
    assert result.returncode == 2
    payload = json.loads(result.stdout)
    assert [c["id"] for c in payload["checks"]] == [f"D{i}" for i in range(1, 12)]
    levels = _levels_by_id(payload)
    assert levels["D4"] == "fail"
    assert "cycle_seconds" in payload["checks"][3]["detail"] or "不存在" in payload["checks"][3]["detail"]
    # 依赖未装（本环境无 playwright/httpx）→ 阶段 1 为 WARN，不升级为 FAIL
    assert levels["D2"] == "warn"
    # D10/D11 因配置不可用而 WARN，而非抛异常
    assert levels["D10"] == "warn" and levels["D11"] == "warn"
    # 目录仍然被创建（诊断不阻塞工程动作）
    assert data.is_dir() and (data / "logs").is_dir()
    assert payload["summary"]["fail"] == 1


def test_cli_scenario_half_config(tmp_path):
    """场景二：有合法配置 + 已存在可写目录。全绿，退出码 0。"""
    config = tmp_path / "config.json"
    config.write_text(_valid_config_payload(), encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    result = invoke(config, data)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert len(payload["checks"]) == 11
    assert payload["summary"]["fail"] == 0
    levels = _levels_by_id(payload)
    assert levels["D4"] == "ok" and levels["D5"] == "ok" and levels["D6"] == "ok"
    assert levels["D8"] == "warn"  # 未填目标账号，但不阻塞


def test_cli_scenario_read_only_directory(tmp_path):
    """场景三：合法配置 + 已存在的只读目录。D5/D6 FAIL，退出码 2，进程不崩。"""
    config = tmp_path / "config.json"
    config.write_text(_valid_config_payload(), encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    os.chmod(data, 0o555)
    try:
        result = invoke(config, data)
        assert result.returncode == 2
        payload = json.loads(result.stdout)
        assert len(payload["checks"]) == 11
        levels = _levels_by_id(payload)
        assert levels["D4"] == "ok"   # 配置本身没问题
        assert levels["D5"] == "fail"  # 只读目录被检出
    finally:
        os.chmod(data, 0o755)


def test_cli_summary_matches_checks(tmp_path):
    """summary 计数与 checks 逐条一致——防止汇总与明细脱节。"""
    config = tmp_path / "absent.json"
    result = invoke(config, tmp_path / "data")
    payload = json.loads(result.stdout)
    counts = {"fail": 0, "warn": 0, "ok": 0}
    for item in payload["checks"]:
        counts[item["level"]] += 1
    assert payload["summary"] == counts
    assert sum(counts.values()) == len(payload["checks"]) == 11
