import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * Vitest configuration for the registry UI.
 *
 * Kept separate from vite.config.ts so production builds are unaffected.
 * Tests run in a jsdom environment so DOM APIs are available.
 * Test files live alongside source files with a .test.{ts,tsx} suffix.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test-setup.ts", "src/main.tsx", "src/**/*.test.{ts,tsx}"],
    },
  },
});
