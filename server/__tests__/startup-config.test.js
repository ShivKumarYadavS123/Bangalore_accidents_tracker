/**
 * Security batch 1, items 6 and A — startup configuration.
 *   A: Supabase without the service-role key refuses to start (no anon fallback).
 *   6: "trust proxy" comes from TRUST_PROXY and is off by default.
 * index.js is not imported here: it loads server/.env and starts listening.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { resolveSupabaseConfig, parseTrustProxy, DEFAULT_SUPABASE_URL } from '../config.js';

const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

describe('resolveSupabaseConfig (item A)', () => {
  it('uses the service-role key', () => {
    expect(resolveSupabaseConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' }))
      .toEqual({ url: 'https://p.supabase.co', key: 'svc' });
  });

  it('falls back to the default project URL only when the service-role key is set', () => {
    expect(resolveSupabaseConfig({ SUPABASE_SERVICE_ROLE_KEY: 'svc' })).toEqual({ url: DEFAULT_SUPABASE_URL, key: 'svc' });
  });

  it('refuses SUPABASE_URL without SUPABASE_SERVICE_ROLE_KEY, even when the anon key is set', () => {
    expect(() => resolveSupabaseConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon-secret' }))
      .toThrow(/SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is missing/);
    expect(() => resolveSupabaseConfig({ SUPABASE_URL: 'https://p.supabase.co' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => resolveSupabaseConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: '   ' })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('refuses the anon key on its own (it would otherwise be the silent fallback)', () => {
    expect(() => resolveSupabaseConfig({ SUPABASE_ANON_KEY: 'anon-secret' })).toThrow(/SUPABASE_ANON_KEY is set but SUPABASE_SERVICE_ROLE_KEY is missing/);
  });

  it('never puts key values in the error message', () => {
    try {
      resolveSupabaseConfig({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon-secret' });
      throw new Error('expected a throw');
    } catch (e) {
      expect(e.message).not.toContain('anon-secret');
    }
  });

  it('returns null (offline dev, no Supabase client) when nothing is configured', () => {
    expect(resolveSupabaseConfig({})).toBeNull();
    expect(resolveSupabaseConfig({ SUPABASE_URL: '', SUPABASE_ANON_KEY: '' })).toBeNull();
  });

  it('index.js uses it, exits on a bad config, and has no anon-key fallback', () => {
    expect(indexSource).toMatch(/resolveSupabaseConfig\(process\.env\)/);
    expect(indexSource).toMatch(/process\.exit\(1\)/);
    expect(indexSource).not.toMatch(/SUPABASE_ANON_KEY/);
  });
});

describe('parseTrustProxy (item 6)', () => {
  it('is off unless set', () => {
    for (const v of [undefined, null, '', '  ', 'false', 'FALSE', 'off', 'no', '0']) expect(parseTrustProxy(v)).toBeUndefined();
  });

  it('accepts a hop count, true, or a list of trusted addresses', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy(' 2 ')).toBe(2);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toEqual(['loopback', '10.0.0.0/8']);
  });

  it('index.js applies it to the app', () => {
    expect(indexSource).toMatch(/parseTrustProxy\(process\.env\.TRUST_PROXY\)/);
    expect(indexSource).toMatch(/app\.set\('trust proxy', trustProxy\)/);
  });
});

/** The same wiring as index.js: set trust proxy only when TRUST_PROXY parses to a value. */
function appWith(trustProxyEnv) {
  const app = express();
  const trustProxy = parseTrustProxy(trustProxyEnv);
  if (trustProxy !== undefined) app.set('trust proxy', trustProxy);
  app.use(rateLimit({ windowMs: 60000, max: 1, standardHeaders: true, legacyHeaders: false }));
  app.get('/ip', (req, res) => res.json({ ip: req.ip }));
  return app;
}

describe('trust proxy behaviour', () => {
  it('by default ignores X-Forwarded-For, so a client cannot pick its own rate-limit key', async () => {
    const app = appWith(undefined);
    const a = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(a.status).toBe(200);
    expect(a.body.ip).not.toBe('203.0.113.7');
    const b = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.9');
    expect(b.status).toBe(429); // a forged header does not buy a fresh bucket
  });

  it('with TRUST_PROXY=1 uses the client IP from the proxy, so clients get separate limits', async () => {
    const app = appWith('1');
    const a = await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(a.body.ip).toBe('203.0.113.7');
    expect((await request(app).get('/ip').set('X-Forwarded-For', '203.0.113.7')).status).toBe(429);
    const other = await request(app).get('/ip').set('X-Forwarded-For', '198.51.100.9');
    expect(other.status).toBe(200);
    expect(other.body.ip).toBe('198.51.100.9');
  });
});
