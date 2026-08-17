#!/usr/bin/env python3
# Python conformance runner. Loads every shared JSON fixture under `fixtures/`, runs the
# reference validator, and asserts the verdict AND the set of firing check-ids match the
# fixture's declared `expect`. The TypeScript runner (test/conformance.test.ts) asserts the
# SAME fixtures against `runAudit`; both passing is what proves the two runtimes agree.
#
# Exit 0 when every fixture matches; exit 1 (with a diff) on the first mismatch.

import json
import sys
from pathlib import Path

from validator import run_audit

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def firing_checks(violations: list[dict]) -> list[str]:
    return sorted({v["check"] for v in violations})


def main() -> int:
    fixtures = sorted(FIXTURE_DIR.glob("*.json"))
    if not fixtures:
        print(f"no fixtures found in {FIXTURE_DIR}", file=sys.stderr)
        return 1

    failures = 0
    for path in fixtures:
        fx = json.loads(path.read_text(encoding="utf-8"))
        expect = fx["expect"]
        result = run_audit(
            fx.get("ledger", []),
            fx.get("columns", []),
            fx.get("claims", []),
            fx.get("periods", []),
            fx.get("crossFoot", []),
        )
        got_verdict = result["verdict"]
        got_checks = firing_checks(result["violations"])
        want_verdict = expect["verdict"]
        want_checks = sorted(expect.get("checks", []))

        ok = got_verdict == want_verdict and got_checks == want_checks
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {fx['name']:<34} verdict={got_verdict:<6} checks={got_checks}")
        if not ok:
            failures += 1
            print(f"       expected verdict={want_verdict} checks={want_checks}")
            for vio in result["violations"]:
                print(f"         - {vio['check']} {vio['status']} {vio['findingId']}: {vio['message']}")

    total = len(fixtures)
    if failures:
        print(f"\n{failures}/{total} fixtures FAILED")
        return 1
    print(f"\nall {total} fixtures passed (Python)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
