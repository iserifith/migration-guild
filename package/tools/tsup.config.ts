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
]);
