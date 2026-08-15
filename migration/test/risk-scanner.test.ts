import assert from "node:assert/strict";
import test from "node:test";
import { scoreArtifact, resolveRiskSpec } from "../guildctl/risk";

const defaultSpec = resolveRiskSpec(undefined);

function repeat(line: string, times: number): string {
  return Array.from({ length: times }, () => line).join("\n");
}

test("reflection-pattern detection produces a reflection-usage:<pattern-id> reason code", () => {
  const content = [
    "public class Loader {",
    "  void load(String name) {",
    "    Class.forName(name);",
    "  }",
    "}",
  ].join("\n");
  const record = scoreArtifact("a1", content, defaultSpec);
  assert.ok(record.reasonCodes.includes("reflection-usage:java-class-forName"));
  assert.ok(record.riskScore > 0);
});

test("God-method detection via brace-depth tracking flags a method exceeding god_method_max_lines", () => {
  const spec = resolveRiskSpec({ god_method_max_lines: 5 });
  const content = ["public void bigMethod() {", repeat("    doWork();", 10), "}"].join("\n");
  const record = scoreArtifact("a2", content, spec);
  const code = record.reasonCodes.find((c) => c.startsWith("god-method:"));
  assert.ok(code, `expected a god-method reason code, got: ${JSON.stringify(record.reasonCodes)}`);
  assert.match(code!, /^god-method:bigMethod@L1 \(12 lines > 5\)$/);
});

test("God-method detection via indent-depth tracking flags a method exceeding god_method_max_lines", () => {
  const spec = resolveRiskSpec({
    god_method_max_lines: 5,
    method_boundary: { style: "indent", start_pattern: String.raw`^\s*def\s+\w+\s*\(` },
  });
  const content = ["def bigfunc():", repeat("    do_work()", 6)].join("\n");
  const record = scoreArtifact("a3", content, spec);
  const code = record.reasonCodes.find((c) => c.startsWith("god-method:"));
  assert.ok(code, `expected a god-method reason code, got: ${JSON.stringify(record.reasonCodes)}`);
  assert.match(code!, /^god-method:bigfunc@L1 \(7 lines > 5\)$/);
});

test("cyclomatic-complexity detection counts complexity_keywords + 1 McCabe baseline", () => {
  const spec = resolveRiskSpec({ cyclomatic_complexity_limit: 3 });
  const content = [
    "public void branchy() {",
    repeat("    if (flag) { doWork(); }", 5),
    "}",
  ].join("\n");
  const record = scoreArtifact("a4", content, spec);
  const code = record.reasonCodes.find((c) => c.startsWith("cyclomatic-complexity:"));
  assert.ok(code, `expected a cyclomatic-complexity reason code, got: ${JSON.stringify(record.reasonCodes)}`);
  // baseline 1 + 5 "if" occurrences = 6
  assert.match(code!, /^cyclomatic-complexity:branchy@L1 \(complexity 6 > 3\)$/);
});

test("heuristic-skipped:<heuristic> reason code is recorded when no method matches are found", () => {
  const content = "just some plain text\nwith no method signatures at all\n";
  const record = scoreArtifact("a5", content, defaultSpec);
  assert.ok(record.reasonCodes.includes("heuristic-skipped:god-method"));
  assert.ok(record.reasonCodes.includes("heuristic-skipped:cyclomatic-complexity"));
});

test("a plain artifact produces risk_score ≈ 0 and an empty reason-code list", () => {
  const content = ["public void tiny() {", "    return;", "}"].join("\n");
  const record = scoreArtifact("a6", content, defaultSpec);
  assert.equal(record.riskScore, 0);
  assert.deepEqual(record.reasonCodes, []);
  assert.equal(record.highRisk, false);
});

test("score formula: each term is capped independently and the total is clamped to [0, 100]", () => {
  // Reflection alone caps at 30.
  const reflectionOnly = scoreArtifact(
    "b1",
    ["public void ok() {", "  Class.forName(\"x\");", "  return;", "}"].join("\n"),
    defaultSpec,
  );
  assert.equal(reflectionOnly.riskScore, 30);

  // A massive God method alone caps at 35 (overage * 0.5, capped).
  const godSpec = resolveRiskSpec({ god_method_max_lines: 5, cyclomatic_complexity_limit: 10000 });
  const massiveGod = scoreArtifact(
    "b2",
    ["public void huge() {", repeat("    doWork();", 500), "}"].join("\n"),
    godSpec,
  );
  assert.equal(massiveGod.riskScore, 35);

  // Massive complexity alone caps at 35 (overage * 2, capped).
  const complexitySpec = resolveRiskSpec({ cyclomatic_complexity_limit: 1, god_method_max_lines: 10000 });
  const massiveComplexity = scoreArtifact(
    "b3",
    ["public void branchy() {", repeat("    if (flag) { doWork(); }", 200), "}"].join("\n"),
    complexitySpec,
  );
  assert.equal(massiveComplexity.riskScore, 35);

  // All three combined never exceed the overall [0, 100] clamp.
  const allSpec = resolveRiskSpec({ god_method_max_lines: 5, cyclomatic_complexity_limit: 1 });
  const worstCase = scoreArtifact(
    "b4",
    [
      "public void worst() {",
      "  Class.forName(\"x\");",
      repeat("  if (flag) { doWork(); }", 200),
      "}",
    ].join("\n"),
    allSpec,
  );
  assert.equal(worstCase.riskScore, 100);
  assert.ok(worstCase.riskScore <= 100);
});
