// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  // M10 and M11 are deployed to the dedicated PortfolioAI Supabase project.
  // Missing dates and genuinely unstated source brokers are supported only as
  // explicitly INCOMPLETE ledger states; neither fact is ever invented.
  vite: {
    define: {
      "import.meta.env.VITE_M10_NULL_DATE_COMMIT": JSON.stringify("true"),
      "import.meta.env.VITE_M11_NULL_BROKER_COMMIT": JSON.stringify("true"),
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
