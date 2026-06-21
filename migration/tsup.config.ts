import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: {
      cli: "registry/cli.ts",
      index: "registry/index.ts",
    },
    outDir: "registry/dist",
    format: ["cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: {
      cli: "guildctl/cli.ts",
    },
    outDir: "guildctl/dist",
    format: ["cjs"],
    clean: true,
    sourcemap: true,
  },
  {
    entry: {
      config: "provider/config.ts",
      "provider-client": "provider/provider-client.ts",
      "tracing/tracer": "provider/tracing/tracer.ts",
      "tracing/commands": "provider/tracing/commands.ts",
      "eval/evaluators": "provider/eval/evaluators.ts",
      "eval/run-eval": "provider/eval/run-eval.ts",
      "eval/commands": "provider/eval/commands.ts",
      "batch/submit": "provider/batch/submit.ts",
      "batch/poll": "provider/batch/poll.ts",
      "batch/apply": "provider/batch/apply.ts",
      "batch/commands": "provider/batch/commands.ts",
    },
    outDir: "provider/dist",
    format: ["cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
]);
