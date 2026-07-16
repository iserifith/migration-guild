import { createHash } from "node:crypto";

export type Language = "java" | "python";

export interface MemberSignature {
  kind: "method" | "constructor" | "field";
  name: string;
  normalized: string;
}

export interface SignatureDigest {
  language: Language;
  sha256: string;
  members: MemberSignature[];
  raw: string;
}

export type DeltaKind =
  | "private-constructor-added"
  | "field-became-final"
  | "method-added"
  | "public-method-removed"
  | "visibility-narrowed";

export interface SignatureDelta {
  kind: DeltaKind;
  member: string;
  before: string | null;
  after: string | null;
  detail: string;
}

export interface SignatureDiff {
  identical: boolean;
  deltas: SignatureDelta[];
}

// ─── Java extraction ────────────────────────────────────────────────────────

const JAVA_MEMBER_RE =
  /^(?:(?:public|protected|private)\s+)?(?:(?:static|final|synchronized|abstract|native|strictfp)\s+)*(?:[\w<>\[\],\s?]+)\s+(\w+)\s*\(/gm;

const JAVA_FIELD_RE =
  /^(?:(?:public|protected|private)\s+)?(?:(?:static|final|transient|volatile)\s+)*(?:[\w<>\[\],\?]+)\s+(\w+)\s*[;=]/gm;

const JAVA_CTOR_RE =
  /^(?:(?:public|protected|private)\s+)?(?:[\w<>\[\],\s]+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{/gm;

const JAVA_MODIFIERS_RE = /\b(public|protected|private|static|final|synchronized|abstract|native|transient|volatile|strictfp)\b/g;

function stripJavaAnnotations(line: string): string {
  return line.replace(/@\w+(?:\([^)]*\))?\s*/g, "");
}

function stripJavaGenerics(sig: string): string {
  return sig.replace(/<[^>]*>/g, "");
}

function normalizeJavaModifiers(raw: string): string {
  const modifiers = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = JAVA_MODIFIERS_RE.exec(raw)) !== null) {
    modifiers.add(m[1]!);
  }
  return [...modifiers].sort().join(" ");
}

function extractJavaSignatures(source: string): MemberSignature[] {
  const lines = source.split("\n");
  const members: MemberSignature[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = stripJavaAnnotations(rawLine.trim());
    if (!line || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) continue;

    const clean = stripJavaGenerics(line);

    // Detect if this line has a method/constructor signature (has parens)
    const hasParens = /\(/.test(clean) && /\)/.test(clean);

    // Fields: has no parentheses and looks like a field declaration
    if (!hasParens) {
      const fieldMatch = JAVA_FIELD_RE.exec(clean);
      if (fieldMatch) {
        const name = fieldMatch[1]!;
        const modifiers = normalizeJavaModifiers(line);
        const isFinal = /\bfinal\b/.test(line);
        const typeMatch = clean.match(/^(?:(?:public|protected|private)\s+)?(?:(?:static|final|transient|volatile)\s+)*([\w<>\[\],\?]+)\s+\w+\s*[;=]/);
        const type = typeMatch?.[1] ?? "Object";
        const normalized = `field ${type} ${name}${isFinal ? " final" : ""}`;
        const key = `field:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          members.push({ kind: "field", name, normalized: `${modifiers} ${normalized}`.trim() });
        }
      }
      JAVA_FIELD_RE.lastIndex = 0;
      continue;
    }

    // Lines with parentheses: extract the name and check if it's a constructor or method.
    // A constructor looks like:  [modifiers] ClassName(params) {
    // A method looks like:       [modifiers] ReturnType methodName(params) {
    // The key difference: a constructor has ClassName immediately before (, a method has
    // a return type (possibly multiple words) then methodName before (.
    const memberMatch = JAVA_MEMBER_RE.exec(clean);
    if (!memberMatch) {
      JAVA_MEMBER_RE.lastIndex = 0;
      continue;
    }
    const capturedName = memberMatch[1]!;
    if (/^(if|for|while|switch|catch|try|return|throw|new|class|interface|enum|import|package|assert)$/.test(capturedName)) {
      JAVA_MEMBER_RE.lastIndex = 0;
      continue;
    }

    // Extract everything before the first ( to determine constructor vs method
    const beforeParens = clean.slice(0, clean.indexOf("(")).trim();
    const parts = beforeParens.split(/\s+/).filter(Boolean);
    // In a method: parts = [modifiers..., returnType, methodName]
    // In a constructor: parts = [modifiers..., ClassName]
    // If the last word before ( matches capturedName, and there are >= 2 words before it
    // that look like modifiers+returnType, it's a method.
    // If parts only has modifiers+capturedName (no extra word between modifiers and name),
    // it's likely a constructor.
    const isLikelyConstructor = parts.length <= 2 ||
      (parts.length === 2 && /^(public|protected|private|static|final|abstract|synchronized|native|strictfp)$/.test(parts[0]!));

    const modifiers = normalizeJavaModifiers(line);
    const paramMatch = clean.match(/\(([^)]*)\)/);
    const params = paramMatch?.[1] ?? "";

    if (isLikelyConstructor) {
      const normalized = `constructor ${capturedName}(${params})`.trim();
      const key = `constructor:${capturedName}:${params}`;
      if (!seen.has(key)) {
        seen.add(key);
        members.push({ kind: "constructor", name: capturedName, normalized: `${modifiers} ${normalized}`.trim() });
      }
    } else {
      // Method: everything between modifiers and name is the return type
      const modifiersList = modifiers.split(" ").filter(Boolean);
      const returnParts = parts.slice(0, parts.length - 1).filter(
        (p) => !/^(public|protected|private|static|final|abstract|synchronized|native|strictfp)$/.test(p),
      );
      const returnType = returnParts.length > 0 ? returnParts.join(" ") : "void";
      const normalized = `method ${returnType} ${capturedName}(${params})`;
      const key = `method:${capturedName}:${params}`;
      if (!seen.has(key)) {
        seen.add(key);
        members.push({ kind: "method", name: capturedName, normalized: `${modifiers} ${normalized}`.trim() });
      }
    }
    JAVA_MEMBER_RE.lastIndex = 0;
  }

  return members;
}

// ─── Python extraction ──────────────────────────────────────────────────────

const PY_DEF_RE = /^\s*(?:(?:@\w+(?:\([^)]*\))?\s*)*)?(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*[\w\[\], .|"']+)?\s*:/gm;

const PY_INIT_ATTR_RE = /^\s+self\.(\w+)\s*[=:]/gm;

const PY_CLASS_DEF_RE = /^\s*class\s+(\w+)\s*(?:\([^)]*\))?\s*:/;

function extractPythonSignatures(source: string): MemberSignature[] {
  const lines = source.split("\n");
  const members: MemberSignature[] = [];
  const seen = new Set<string>();
  let currentClass: string | null = null;
  let currentIndent = 0;
  let inDocstring = false;
  const docstringDelimiters = ['"""', "'''"];

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    // Track docstrings
    for (const delim of docstringDelimiters) {
      if (trimmed.startsWith(delim)) {
        if (inDocstring && trimmed.endsWith(delim) && trimmed.length > 3) {
          inDocstring = false;
        } else if (!inDocstring) {
          inDocstring = true;
        }
      }
    }
    if (inDocstring) continue;

    // Class definition
    const classMatch = PY_CLASS_DEF_RE.exec(line);
    if (classMatch) {
      currentClass = classMatch[1]!;
      currentIndent = line.length - line.trimStart().length;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Track leaving current class scope
    if (currentClass && indent <= currentIndent && trimmed && !trimmed.startsWith("@") && !trimmed.startsWith("def") && !trimmed.startsWith("self.")) {
      if (indent <= currentIndent - 1 && !line.startsWith(" ") && !line.startsWith("\t")) {
        currentClass = null;
      }
    }

    // Method definitions
    const defMatch = PY_DEF_RE.exec(line);
    if (defMatch) {
      const name = defMatch[1]!;
      const params = defMatch[2]!;
      const decorators = [];
      let prevLine = "";
      for (let i = lines.indexOf(rawLine) - 1; i >= 0; i--) {
        const prev = lines[i]!.trim();
        if (prev.startsWith("@")) {
          decorators.unshift(prev);
        } else if (prev === "" || prev.startsWith("#")) {
          continue;
        } else {
          break;
        }
      }
      const prefix = currentClass ? `${currentClass}.` : "";
      const isStatic = decorators.some((d) => d === "@staticmethod");
      const isClass = decorators.some((d) => d === "@classmethod");
      const modifier = isStatic ? "static " : isClass ? "classmethod " : "";
      const normalized = `${modifier}def ${prefix}${name}(${params})`;
      const key = `method:${prefix}${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        members.push({ kind: "method", name: `${prefix}${name}`, normalized });
      }
      PY_DEF_RE.lastIndex = 0;
      continue;
    }

    // Instance attributes in __init__
    if (currentClass && trimmed.startsWith("self.")) {
      const attrMatch = PY_INIT_ATTR_RE.exec(line);
      if (attrMatch) {
        const attrName = attrMatch[1]!;
        const normalized = `field ${currentClass}.${attrName}`;
        const key = `field:${currentClass}.${attrName}`;
        if (!seen.has(key)) {
          seen.add(key);
          members.push({ kind: "field", name: `${currentClass}.${attrName}`, normalized });
        }
        PY_INIT_ATTR_RE.lastIndex = 0;
      }
    }
  }

  return members;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function extractSignatures(source: string, language: Language): MemberSignature[] {
  return language === "java" ? extractJavaSignatures(source) : extractPythonSignatures(source);
}

export function signatureDigest(source: string, language: Language): SignatureDigest {
  const members = extractSignatures(source, language);
  const sorted = [...members].sort((a, b) => a.normalized.localeCompare(b.normalized));
  const canonical = sorted.map((m) => m.normalized).join("\n");
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  return { language, sha256, members, raw: source };
}

export function contentSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function byteIdentity(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return createHash("sha256").update(a).digest("hex") === createHash("sha256").update(b).digest("hex");
}

// ─── Delta detection ────────────────────────────────────────────────────────

const JAVA_VISIBILITY_ORDER: Record<string, number> = {
  "": 0,
  private: 1,
  protected: 2,
  public: 3,
};

function javaVisibility(normalized: string): string {
  if (normalized.startsWith("public ")) return "public";
  if (normalized.startsWith("protected ")) return "protected";
  if (normalized.startsWith("private ")) return "private";
  return "";
}

function javaVisibilityRank(v: string): number {
  return JAVA_VISIBILITY_ORDER[v] ?? -1;
}

function isConstructorMember(m: MemberSignature): boolean {
  return m.kind === "constructor";
}

function isMethodMember(m: MemberSignature): boolean {
  return m.kind === "method";
}

function isFieldMember(m: MemberSignature): boolean {
  return m.kind === "field";
}

function methodKey(m: MemberSignature): string {
  // Extract params from normalized form for overloaded constructor/method disambiguation
  const parenStart = m.normalized.indexOf("(");
  const parenEnd = m.normalized.indexOf(")");
  const params = parenStart >= 0 && parenEnd > parenStart
    ? m.normalized.slice(parenStart, parenEnd + 1)
    : "";
  return `${m.kind}:${m.name}:${params}`;
}

export function diffSignatures(before: SignatureDigest, after: SignatureDigest): SignatureDiff {
  const deltas: SignatureDelta[] = [];

  const beforeMap = new Map(before.members.map((m) => [methodKey(m), m]));
  const afterMap = new Map(after.members.map((m) => [methodKey(m), m]));

  // Private constructor added
  for (const [key, afterMember] of afterMap) {
    if (!beforeMap.has(key) && isConstructorMember(afterMember)) {
      const vis = javaVisibility(afterMember.normalized);
      if (vis === "private") {
        deltas.push({
          kind: "private-constructor-added",
          member: afterMember.name,
          before: null,
          after: afterMember.normalized,
          detail: `private constructor added: ${afterMember.name}`,
        });
      }
    }
  }

  // Field became final
  for (const [key, afterMember] of afterMap) {
    const beforeMember = beforeMap.get(key);
    if (beforeMember && isFieldMember(beforeMember) && isFieldMember(afterMember)) {
      const wasFinal = /\bfinal\b/.test(beforeMember.normalized);
      const isNowFinal = /\bfinal\b/.test(afterMember.normalized);
      if (!wasFinal && isNowFinal) {
        deltas.push({
          kind: "field-became-final",
          member: afterMember.name,
          before: beforeMember.normalized,
          after: afterMember.normalized,
          detail: `field became final: ${afterMember.name}`,
        });
      }
    }
  }

  // Method added
  for (const [key, afterMember] of afterMap) {
    if (!beforeMap.has(key) && isMethodMember(afterMember)) {
      deltas.push({
        kind: "method-added",
        member: afterMember.name,
        before: null,
        after: afterMember.normalized,
        detail: `method added: ${afterMember.name}`,
      });
    }
  }

  // Public method removed
  for (const [key, beforeMember] of beforeMap) {
    if (!afterMap.has(key) && isMethodMember(beforeMember)) {
      const vis = javaVisibility(beforeMember.normalized);
      if (vis === "public") {
        deltas.push({
          kind: "public-method-removed",
          member: beforeMember.name,
          before: beforeMember.normalized,
          after: null,
          detail: `public method removed: ${beforeMember.name}`,
        });
      }
    }
  }

  // Visibility narrowed (methods + constructors)
  for (const [key, afterMember] of afterMap) {
    const beforeMember = beforeMap.get(key);
    if (beforeMember && (isMethodMember(beforeMember) || isConstructorMember(beforeMember))) {
      const beforeVis = javaVisibility(beforeMember.normalized);
      const afterVis = javaVisibility(afterMember.normalized);
      if (
        beforeVis &&
        afterVis &&
        javaVisibilityRank(afterVis) < javaVisibilityRank(beforeVis)
      ) {
        deltas.push({
          kind: "visibility-narrowed",
          member: afterMember.name,
          before: beforeMember.normalized,
          after: afterMember.normalized,
          detail: `visibility narrowed: ${beforeMember.name} from ${beforeVis} to ${afterVis}`,
        });
      }
    }
  }

  return { identical: deltas.length === 0, deltas };
}
