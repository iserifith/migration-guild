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
      cli: "legmod/cli.ts",
    },
    outDir: "legmod/dist",
    format: ["cjs"],
    clean: true,
    sourcemap: true,
  },
]);
