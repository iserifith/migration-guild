import * as fs from "fs";
import type { EvaluatorName } from "../../registry/types";
import type { FoundryClient } from "../foundry-client";
import type { EvalConfig } from "../config";

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface EvaluatorInput {
  artifactId: string;
  legacySourcePath: string;
  modernSourcePath: string;
  testSourcePath?: string;
}

export interface EvaluatorResult {
  evaluator: EvaluatorName;
  pass: boolean;
  score: number | null;
  feedback: string;
  model: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LEGACY_IMPORT_PATTERNS: RegExp[] = [
  /javax\./,
  /com\.sun\./,
  /jakarta\.ejb/,
  /javax\.ws\.rs/,
  /javax\.servlet/,
  /org\.jboss/,
  /com\.ibm\./,
];

function readSource(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** Extract public method names using regex. */
function extractPublicMethodNames(source: string): string[] {
  const regex = /public\s+\S+\s+(\w+)\s*\([^)]*\)/g;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

// ─── Rule-based evaluators ────────────────────────────────────────────────────

/** Check that no legacy package imports appear in the migrated source. */
export function noLegacyImports(input: EvaluatorInput): EvaluatorResult {
  const modern = readSource(input.modernSourcePath);
  if (modern === null) {
    return {
      evaluator: "no-legacy-imports",
      pass: false,
      score: null,
      feedback: `Modern source not found: ${input.modernSourcePath}`,
      model: null,
    };
  }

  const foundImports: string[] = [];
  for (const line of modern.split("\n")) {
    for (const pattern of LEGACY_IMPORT_PATTERNS) {
      if (pattern.test(line)) {
        foundImports.push(line.trim());
        break;
      }
    }
  }

  const pass = foundImports.length === 0;
  return {
    evaluator: "no-legacy-imports",
    pass,
    score: null,
    feedback: pass
      ? "No legacy imports found."
      : `Found legacy imports:\n${foundImports.join("\n")}`,
    model: null,
  };
}

/** Verify that all public method names from the legacy source exist in the modern source. */
export function signaturePreservation(input: EvaluatorInput): EvaluatorResult {
  const legacy = readSource(input.legacySourcePath);
  if (legacy === null) {
    return {
      evaluator: "signature-preservation",
      pass: false,
      score: null,
      feedback: `Legacy source not found: ${input.legacySourcePath}`,
      model: null,
    };
  }
  const modern = readSource(input.modernSourcePath);
  if (modern === null) {
    return {
      evaluator: "signature-preservation",
      pass: false,
      score: null,
      feedback: `Modern source not found: ${input.modernSourcePath}`,
      model: null,
    };
  }

  const legacyMethods = extractPublicMethodNames(legacy);
  if (legacyMethods.length === 0) {
    return {
      evaluator: "signature-preservation",
      pass: true,
      score: 1.0,
      feedback: "No public methods found in legacy source.",
      model: null,
    };
  }

  const modernMethods = new Set(extractPublicMethodNames(modern));
  const missing = legacyMethods.filter((m) => !modernMethods.has(m));
  const score = (legacyMethods.length - missing.length) / legacyMethods.length;
  const pass = missing.length === 0;

  return {
    evaluator: "signature-preservation",
    pass,
    score,
    feedback: pass
      ? `All ${legacyMethods.length} public methods preserved.`
      : `Missing methods: ${missing.join(", ")}`,
    model: null,
  };
}

/** Count @Test annotations vs public methods in legacy to measure test coverage. */
export function testCoverage(input: EvaluatorInput): EvaluatorResult {
  const legacy = readSource(input.legacySourcePath) ?? "";
  const legacyMethodCount = extractPublicMethodNames(legacy).length;

  let testCount = 0;
  if (input.testSourcePath) {
    const testSource = readSource(input.testSourcePath);
    if (testSource !== null) {
      testCount = (testSource.match(/@Test/g) ?? []).length;
    }
  }

  const score = Math.min(1.0, testCount / Math.max(1, legacyMethodCount));
  const pass = testCount >= legacyMethodCount;

  return {
    evaluator: "test-coverage",
    pass,
    score,
    feedback: `${testCount} tests for ${legacyMethodCount} methods.`,
    model: null,
  };
}

// ─── LLM evaluator ────────────────────────────────────────────────────────────

/** Ask the LLM whether the modern code preserves the behavioral contract of the legacy code. */
export async function correctness(
  input: EvaluatorInput,
  client: FoundryClient,
  model?: string,
): Promise<EvaluatorResult> {
  const legacy = readSource(input.legacySourcePath);
  if (legacy === null) {
    return {
      evaluator: "correctness",
      pass: false,
      score: null,
      feedback: `Legacy source not found: ${input.legacySourcePath}`,
      model: model ?? null,
    };
  }
  const modern = readSource(input.modernSourcePath);
  if (modern === null) {
    return {
      evaluator: "correctness",
      pass: false,
      score: null,
      feedback: `Modern source not found: ${input.modernSourcePath}`,
      model: model ?? null,
    };
  }

  const systemPrompt =
    "You are a Java migration correctness evaluator. " +
    "Analyze legacy and modern Java code and respond only with valid JSON — no markdown, no prose.";

  const userPrompt =
    `Does the modern Java code preserve the behavioral contract of the legacy code?\n\n` +
    `Legacy code:\n\`\`\`java\n${legacy}\n\`\`\`\n\n` +
    `Modern code:\n\`\`\`java\n${modern}\n\`\`\`\n\n` +
    `Respond with JSON only: { "pass": boolean, "score": number, "feedback": string }\n` +
    `where score is between 0.0 and 1.0.`;

  let responseText: string;
  let responseModel: string;

  try {
    const res = await client.chatComplete({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      model,
    });
    responseText = res.choices[0]?.message.content ?? "";
    responseModel = res.model;
  } catch (err) {
    return {
      evaluator: "correctness",
      pass: false,
      score: null,
      feedback: `LLM call failed: ${(err as Error).message}`,
      model: model ?? null,
    };
  }

  try {
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as {
      pass: boolean;
      score: number;
      feedback: string;
    };
    return {
      evaluator: "correctness",
      pass: Boolean(parsed.pass),
      score:
        typeof parsed.score === "number"
          ? Math.min(1.0, Math.max(0.0, parsed.score))
          : null,
      feedback: parsed.feedback ?? "",
      model: responseModel,
    };
  } catch {
    return {
      evaluator: "correctness",
      pass: false,
      score: null,
      feedback: `Failed to parse LLM response: ${responseText}`,
      model: responseModel,
    };
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/** Run all evaluators enabled in cfg in sequence and return results. */
export async function runAllEvaluators(
  input: EvaluatorInput,
  client: FoundryClient,
  cfg: EvalConfig,
): Promise<EvaluatorResult[]> {
  const results: EvaluatorResult[] = [];

  for (const name of cfg.evaluators) {
    switch (name) {
      case "no-legacy-imports":
        results.push(noLegacyImports(input));
        break;
      case "signature-preservation":
        results.push(signaturePreservation(input));
        break;
      case "test-coverage":
        results.push(testCoverage(input));
        break;
      case "correctness":
        results.push(await correctness(input, client));
        break;
    }
  }

  return results;
}
