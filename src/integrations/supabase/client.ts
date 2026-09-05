import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client for the dedicated PortfolioAI Supabase project.
 *
 * Uses the publishable (anon) key ONLY. Row Level Security is the authorization
 * boundary. The service-role key is never referenced here and never reaches the
 * browser. No credential value is ever hard-coded — only variable names.
 */

const url = import.meta.env['VITE_SUPABASE_URL'] as string | undefined;
const publishableKey = import.meta.env['VITE_SUPABASE_PUBLISHABLE_KEY'] as
  | string
  | undefined;

/** True when the dedicated Supabase project credentials are configured. */
export const isSupabaseConfigured = Boolean(url && publishableKey);

let client: SupabaseClient | null = null;

/**
 * Returns the browser Supabase client.
 * Throws a clear, non-sensitive error when the project is not yet connected,
 * rather than silently degrading.
 */
export function getSupabaseClient(): SupabaseClient {
  if (!url || !publishableKey) {
    throw new Error(
      "Supabase is not connected. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the secret store.",
    );
  }
  if (!client) {
    client = createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}
