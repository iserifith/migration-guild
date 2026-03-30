import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "registry/cli.ts",
    index: "registry/index.ts",
  },
  format: ["cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
