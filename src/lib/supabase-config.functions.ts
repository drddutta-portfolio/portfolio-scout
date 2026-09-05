import { createServerFn } from "@tanstack/react-start";

/**
 * Returns the dedicated Supabase project's PUBLIC configuration to the browser.
 *
 * Only the project URL and publishable (anon) key are returned. Both are
 * public by design: Row Level Security is the authorization boundary.
 * The service-role key is never read here and never reaches the browser.
 *
 * Values come from the secure secret store at request time — never from
 * source code, never at module scope.
 */
export const getPublicSupabaseConfig = createServerFn({
  method: "GET",
}).handler(async () => {
  const url = process.env["PORTFOLIOAI_SUPABASE_URL"];
  const publishableKey = process.env["PORTFOLIOAI_SUPABASE_PUBLISHABLE_KEY"];

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase is not connected. Set PORTFOLIOAI_SUPABASE_URL and PORTFOLIOAI_SUPABASE_PUBLISHABLE_KEY in the secret store.",
    );
  }

  return { url, publishableKey };
});
