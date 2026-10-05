/**
 * Startup settings that must either fail loudly or default to the safe value.
 */

// Project used when SUPABASE_URL is not set (only together with a service-role key).
export const DEFAULT_SUPABASE_URL = 'https://xcjzfifybnzocyjlktpo.supabase.co';

/**
 * Supabase client settings for the API. The API must use the service-role key:
 * with the anon key every server-side query silently runs under RLS as a
 * signed-out visitor. Returns null when Supabase is not configured at all
 * (offline / local dev) and throws when it is only half configured.
 */
export function resolveSupabaseConfig(env = process.env) {
  const url = String(env.SUPABASE_URL || '').trim();
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (serviceKey) return { url: url || DEFAULT_SUPABASE_URL, key: serviceKey };
  const anonKey = String(env.SUPABASE_ANON_KEY || '').trim();
  if (url || anonKey) {
    throw new Error(
      `${url ? 'SUPABASE_URL' : 'SUPABASE_ANON_KEY'} is set but SUPABASE_SERVICE_ROLE_KEY is missing. ` +
      'The API needs the service-role key and no longer falls back to the anon key. ' +
      'Add SUPABASE_SERVICE_ROLE_KEY to server/.env, or remove the Supabase settings to run without Supabase.'
    );
  }
  return null;
}

/**
 * Express "trust proxy" setting from TRUST_PROXY. Off unless set. Behind a
 * reverse proxy set it to the number of proxies in front of the API (usually
 * 1) so rate limits see the client IP instead of the proxy's. Also accepts
 * true/false or a comma-separated list of trusted addresses/subnets
 * ("loopback, 10.0.0.0/8"). Returns undefined when trust proxy stays off.
 */
export function parseTrustProxy(raw) {
  const v = String(raw ?? '').trim();
  if (!v || /^(false|off|no|0)$/i.test(v)) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^(true|on|yes)$/i.test(v)) return true;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}
