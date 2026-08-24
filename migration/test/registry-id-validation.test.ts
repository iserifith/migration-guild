import assert from "node:assert/strict";
import test from "node:test";
import { RegistryError, validateId } from "../registry/types";

/**
 * validateId is the only guard between a caller-supplied artifact ID and
 * writeContext's path.join(...) — see #221. It must reject traversal
 * segments, not just check the <kind>:<module>:<ClassName> shape.
 */

test("validateId accepts a well-formed three-part id", () => {
  assert.doesNotThrow(() => validateId("legacy-source:com.acme:Widget"));
});

test("validateId rejects an id with too few or too many parts", () => {
  assert.throws(() => validateId("legacy-source:Widget"), RegistryError);
  assert.throws(() => validateId("legacy-source:com.acme:Widget:extra"), RegistryError);
});

test("validateId rejects a module segment containing path traversal", () => {
  assert.throws(() => validateId("kind:../../../tmp/pwned:Class"), RegistryError);
});

test("validateId rejects segments containing forward or back slashes", () => {
  assert.throws(() => validateId("kind:foo/bar:Class"), RegistryError);
  assert.throws(() => validateId("kind:foo\\bar:Class"), RegistryError);
});

test("validateId rejects a class-name segment containing traversal", () => {
  assert.throws(() => validateId("kind:module:../../escape"), RegistryError);
});
