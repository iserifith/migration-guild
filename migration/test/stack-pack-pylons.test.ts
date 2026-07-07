import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import test from "node:test";
import { classifyArtifactSource, loadClassificationSpec } from "../guildctl/classification";
import { loadStackPack } from "../guildctl/stack";

const repoRoot = path.resolve(__dirname, "..", "..");

// Single subtest: classifyArtifactSource shares mutable module state, so all
// Pylons assertions run in one serial test to avoid cross-subtest interference.
test("Pylons framework detection (signals, over-trigger guard, contract)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guild-pylons-"));
  fs.cpSync(path.join(repoRoot, "stacks"), path.join(root, "stacks"), { recursive: true });
  try {
    const pack = loadStackPack("python", root);
    const spec = loadClassificationSpec(pack);
    assert.ok(spec.frameworks.allowed.includes("pylons"), "pylons must be an allowed framework");

    // 1. BaseController subclass (Pylons controller pattern) -> pylons
    const controllerPath = path.join(root, "legacy", "controllers", "hello.py");
    fs.mkdirSync(path.dirname(controllerPath), { recursive: true });
    fs.writeFileSync(controllerPath, "from pylons import request\n\nclass HelloController(BaseController):\n    def index(self):\n        return request.params.get('id')\n");
    const controller = classifyArtifactSource(spec, { id: "legacy-source:default:hello", path: "legacy/controllers/hello.py" }, root);
    assert.equal(controller.framework, "pylons");
    assert.equal(controller.role, "rest-endpoint");

    // 2. routing.py with routes.Mapper -> pylons (startup-config)
    const routingPath = path.join(root, "legacy", "config", "routing.py");
    fs.mkdirSync(path.dirname(routingPath), { recursive: true });
    fs.writeFileSync(routingPath, "from routes import Mapper\n\nmapper = routes.Mapper()\n");
    const routing = classifyArtifactSource(spec, { id: "legacy-source:default:routing", path: "legacy/config/routing.py" }, root);
    assert.equal(routing.framework, "pylons");
    assert.equal(routing.role, "startup-config");

    // 3. A file merely named base.py with no Pylons import must stay plain-python
    const basePath = path.join(root, "legacy", "lib", "base.py");
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, "class Base:\n    pass\n");
    const plain = classifyArtifactSource(spec, { id: "legacy-source:default:base", path: "legacy/lib/base.py" }, root);
    assert.equal(plain.framework, "plain-python", "non-Pylons base.py must not match pylons");

    // 4. Flask still classifies as flask, not pylons
    const flaskPath = path.join(root, "legacy", "app.py");
    fs.writeFileSync(flaskPath, "from flask import Flask\napp = Flask(__name__)\n");
    const flask = classifyArtifactSource(spec, { id: "legacy-source:default:app", path: "legacy/app.py" }, root);
    assert.equal(flask.framework, "flask");

    // 5. Adding pylons must not change the fallback/ambiguous contracts
    assert.equal(spec.frameworks.fallback, "plain-python");
    assert.equal(spec.frameworks.ambiguous, "ambiguous");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
