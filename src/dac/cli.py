"""dac 命令行入口。"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from dac.commands.doctor import render_json, run_doctor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="dac")
    sub = parser.add_subparsers(dest="command", required=True)
    doctor = sub.add_parser("doctor", help="环境与配置自检")
    doctor.add_argument("--config", type=Path, default=Path("./config/config.json"))
    doctor.add_argument("--data-dir", type=Path, default=Path.home() / ".local/share/dac")
    doctor.add_argument("--stage", type=int, choices=range(1, 8), default=1, help=argparse.SUPPRESS)
    doctor.add_argument("--json", action="store_true", dest="json_output")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        if args.command == "doctor":
            results, code = run_doctor(args.config, args.data_dir, args.stage)
            if args.json_output:
                print(render_json(results))
            else:
                for result in results:
                    label = {"ok": "OK", "warn": "WARN", "fail": "FAIL"}[result.level]
                    print(f"[{label:<4}] {result.id:<3} {result.detail}")
                    if result.fix:
                        print(f"       → 修复：{result.fix}")
                summary = {level: sum(item.level == level for item in results) for level in ("fail", "warn", "ok")}
                print(f"\n结论：{summary['fail']} 项 FAIL、{summary['warn']} 项 WARN、{summary['ok']} 项 OK。")
            return code
        return 2
    except SystemExit as exc:
        return int(exc.code or 0)
    except Exception as exc:
        print(f"CLI 错误：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
