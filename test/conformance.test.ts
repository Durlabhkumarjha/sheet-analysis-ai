// TypeScript conformance runner. Loads every shared JSON fixture under
// `reconciliation/fixtures/` and asserts `runAudit` produces the verdict AND the set of
// firing check-ids the fixture declares in `expect`. The Python runner
// (reconciliation/run_fixtures.py) asserts the SAME fixtures against the reference
// validator; both passing is what proves the two runtimes agree, verdict and firing
// check-ids, across every defect/clean pair.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runAudit,
  type LedgerFinding,
  type AuditColumnProfile,
  type AuditClaim,
  type AuditPeriod,
  type AuditVerdict,
  type CrossFootGroup,
} from "../src/analysis/reconcile";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "reconciliation", "fixtures");

type Fixture = {
  name: string;
  domain: string;
  expect: { verdict: AuditVerdict; checks: string[] };
  ledger: LedgerFinding[];
  columns: AuditColumnProfile[];
  claims: AuditClaim[];
  periods: AuditPeriod[];
  crossFoot?: CrossFootGroup[];
};

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8")) as Fixture);
}

function firingChecks(violations: { check: string }[]): string[] {
  return [...new Set(violations.map((v) => v.check))].sort();
}

const fixtures = loadFixtures();

describe("audit gate conformance (shared fixtures)", () => {
  it("loads the full defect/clean suite", () => {
    // Guard against an empty glob silently passing the suite, and prove both halves exist.
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(fixtures.some((f) => f.expect.verdict === "PASS")).toBe(true);
    expect(fixtures.some((f) => f.expect.verdict === "BLOCK")).toBe(true);
    for (const domain of ["sales", "expense", "marketing"]) {
      const pair = fixtures.filter((f) => f.domain === domain);
      expect(pair.some((f) => f.expect.verdict === "PASS"), `${domain} needs a PASS control`).toBe(true);
      expect(pair.some((f) => f.expect.verdict !== "PASS"), `${domain} needs a defect`).toBe(true);
    }
  });

  for (const fx of fixtures) {
    it(`${fx.name} -> ${fx.expect.verdict} [${fx.expect.checks.join(",")}]`, () => {
      const { verdict, violations } = runAudit(fx.ledger, fx.columns, fx.claims ?? [], fx.periods ?? [], fx.crossFoot ?? []);
      expect(verdict).toBe(fx.expect.verdict);
      expect(firingChecks(violations)).toEqual([...fx.expect.checks].sort());
    });
  }
});
