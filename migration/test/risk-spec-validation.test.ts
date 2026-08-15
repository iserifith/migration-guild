import assert from "node:assert/strict";
import test from "node:test";
import { validateRiskSpec, resolveRiskSpec, type RiskSpec } from "../guildctl/risk";

test("god_method_max_lines must be a finite number > 0 if present", () => {
  assert.throws(() => validateRiskSpec({ god_method_max_lines: 0 }, "pack:x"), /pack:x.*god_method_max_lines/s);
  assert.throws(() => validateRiskSpec({ god_method_max_lines: -5 }, "pack:x"), /pack:x.*god_method_max_lines/s);
  assert.throws(() => validateRiskSpec({ god_method_max_lines: Infinity }, "pack:x"), /pack:x.*god_method_max_lines/s);
  assert.doesNotThrow(() => validateRiskSpec({ god_method_max_lines: 80 }, "pack:x"));
});

test("cyclomatic_complexity_limit must be a finite number > 0 if present", () => {
  assert.throws(() => validateRiskSpec({ cyclomatic_complexity_limit: 0 }, "pack:x"), /pack:x.*cyclomatic_complexity_limit/s);
  assert.throws(() => validateRiskSpec({ cyclomatic_complexity_limit: -1 }, "pack:x"), /pack:x.*cyclomatic_complexity_limit/s);
  assert.doesNotThrow(() => validateRiskSpec({ cyclomatic_complexity_limit: 15 }, "pack:x"));
});

test("high_risk_score_cutoff must be a finite number >= 0 if present", () => {
  assert.throws(() => validateRiskSpec({ high_risk_score_cutoff: -1 }, "pack:x"), /pack:x.*high_risk_score_cutoff/s);
  assert.doesNotThrow(() => validateRiskSpec({ high_risk_score_cutoff: 0 }, "pack:x"));
  assert.doesNotThrow(() => validateRiskSpec({ high_risk_score_cutoff: 50 }, "pack:x"));
});

test("method_boundary.style must be brace or indent", () => {
  assert.throws(
    () => validateRiskSpec({ method_boundary: { style: "tabs" as unknown as "brace", start_pattern: "^def " } }, "pack:x"),
    /pack:x.*method_boundary\.style/s,
  );
  assert.doesNotThrow(() => validateRiskSpec({ method_boundary: { style: "brace", start_pattern: "\\{$" } }, "pack:x"));
  assert.doesNotThrow(() => validateRiskSpec({ method_boundary: { style: "indent", start_pattern: "^def " } }, "pack:x"));
});

test("method_boundary.start_pattern and every reflection_patterns[].match must compile as RegExp", () => {
  assert.throws(
    () => validateRiskSpec({ method_boundary: { style: "brace", start_pattern: "(unclosed" } }, "pack:x"),
    /pack:x.*method_boundary\.start_pattern/s,
  );
  assert.throws(
    () =>
      validateRiskSpec(
        { reflection_patterns: [{ id: "bad", match: "(unclosed", evidence: "bad regex" }] },
        "pack:x",
      ),
    /pack:x.*reflection_patterns\[0\]\.match/s,
  );
  assert.doesNotThrow(() =>
    validateRiskSpec(
      { reflection_patterns: [{ id: "ok", match: "\\bClass\\.forName\\s*\\(", evidence: "reflective load" }] },
      "pack:x",
    ),
  );
});

test("duplicate reflection_patterns[].id within one pack is rejected", () => {
  assert.throws(
    () =>
      validateRiskSpec(
        {
          reflection_patterns: [
            { id: "dup", match: "\\bfoo\\(", evidence: "a" },
            { id: "dup", match: "\\bbar\\(", evidence: "b" },
          ],
        },
        "pack:x",
      ),
    /pack:x.*duplicate.*dup/s,
  );
});

test("an absent risk: block falls back to built-in defaults (80 / 15 / 50) without throwing", () => {
  assert.doesNotThrow(() => validateRiskSpec(undefined, "pack:x"));
  const resolved = resolveRiskSpec(undefined);
  assert.equal(resolved.godMethodMaxLines, 80);
  assert.equal(resolved.cyclomaticComplexityLimit, 15);
  assert.equal(resolved.highRiskScoreCutoff, 50);
});

test("absent individual fields within a present risk: block fall back to built-in defaults", () => {
  const risk: RiskSpec = { god_method_max_lines: 40 };
  assert.doesNotThrow(() => validateRiskSpec(risk, "pack:x"));
  const resolved = resolveRiskSpec(risk);
  assert.equal(resolved.godMethodMaxLines, 40);
  assert.equal(resolved.cyclomaticComplexityLimit, 15);
  assert.equal(resolved.highRiskScoreCutoff, 50);
  assert.ok(resolved.reflectionPatterns.length > 0, "should fall back to built-in reflection patterns");
  assert.ok(resolved.complexityKeywords.length > 0, "should fall back to built-in complexity keywords");
  assert.equal(resolved.methodBoundary.style, "brace");
});
