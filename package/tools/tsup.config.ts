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
      config: "foundry/config.ts",
      "foundry-client": "foundry/foundry-client.ts",
      "tracing/tracer": "foundry/tracing/tracer.ts",
      "tracing/commands": "foundry/tracing/commands.ts",
      "eval/evaluators": "foundry/eval/evaluators.ts",
      "eval/run-eval": "foundry/eval/run-eval.ts",
      "eval/commands": "foundry/eval/commands.ts",
      "batch/submit": "foundry/batch/submit.ts",
      "batch/poll": "foundry/batch/poll.ts",
      "batch/apply": "foundry/batch/apply.ts",
      "batch/commands": "foundry/batch/commands.ts",
    },
    outDir: "foundry/dist",
    format: ["cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
]);
