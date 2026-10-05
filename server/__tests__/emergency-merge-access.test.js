/**
 * Security batch 1, item 1 — SOS merge access. Only the first reporter's
 * tracking token can change or cancel an alert. A report merged into it gets
 * its own view-only token that cannot cancel, update or add photos, and does
 * not see other reporters' notes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createEmergencyFeatures } from '../emergency/index.mjs';
import { createMemoryStore } from '../emergency/store-memory.mjs';
import { hashToken } from '../emergency/util.mjs';
import { hospitals, fakeRouter, clock, SCENE, silentLogger } from './fixtures/emergency-fixtures.js';

const OWNER_NOTE = 'Owner note: my brother, blue shirt';
const OWNER_PHONE = '98450 12345';

let app, features, store, clk;

beforeEach(async () => {
  clk = clock();
  store = createMemoryStore({ hospitals: hospitals(), now: clk.now });
  features = createEmergencyFeatures({
    store, router: fakeRouter(), logger: silentLogger, now: clk.now,
    verifyUser: async () => null,
    userDirectory: { findByEmail: async () => null, setRole: async () => {} },
    limits: { sos: 1000, photo: 1000, read: 1000, write: 1000 },
  });
  await features.init();
  app = express();
  app.use(express.json());
  features.registerRoutes(app);
});

/** First SOS from the "owner", then a second report of the same crash 60 s later. */
async function raiseAndMerge() {
  const first = await request(app).post('/api/emergency').send({ ...SCENE, triage: { injured: '1' }, note: OWNER_NOTE, reporter_phone: OWNER_PHONE });
  clk.advance(60);
  const second = await request(app).post('/api/emergency').send({ lat: SCENE.lat + 0.0005, lng: SCENE.lng, note: 'Second note: saw it from the bus stop' });
  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  expect(second.body.merged).toBe(true);
  expect(second.body.alertId).toBe(first.body.alertId);
  return { id: first.body.alertId, owner: first.body.trackToken, viewer: second.body.trackToken };
}

describe('merged SOS reports get a view-only token', () => {
  it('issues the merged reporter a different token that is view-only', async () => {
    const { id, owner, viewer } = await raiseAndMerge();
    expect(viewer).not.toBe(owner);

    const asViewer = await request(app).get(`/api/emergency/${id}?token=${viewer}`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body).toMatchObject({ id, status: 'new', view_only: true, can_cancel: false, note: null, report_count: 2 });

    const asOwner = await request(app).get(`/api/emergency/${id}?token=${owner}`);
    expect(asOwner.body).toMatchObject({ view_only: false, can_cancel: true });
    expect(asOwner.body.note).toContain(OWNER_NOTE);
  });

  it('never shows the merged reporter anyone else\'s note, in any field', async () => {
    const { id, viewer } = await raiseAndMerge();
    const res = await request(app).get(`/api/emergency/${id}?token=${viewer}`);
    expect(JSON.stringify(res.body)).not.toContain('Owner note');
    expect(JSON.stringify(res.body)).not.toContain(OWNER_PHONE);
  });

  it('the view-only token cannot cancel the alert', async () => {
    const { id, owner, viewer } = await raiseAndMerge();
    const cancel = await request(app).post(`/api/emergency/${id}/cancel?token=${viewer}`).send({ reason: 'prank' });
    expect(cancel.status).toBe(403);
    expect(cancel.body.code).toBe('view_only');
    const still = await request(app).get(`/api/emergency/${id}?token=${owner}`);
    expect(still.body.status).toBe('new');
  });

  it('the view-only token cannot change notes or the callback number, or add photos', async () => {
    const { id, viewer } = await raiseAndMerge();
    const patch = await request(app).patch(`/api/emergency/${id}?token=${viewer}`).send({ note: 'injected', reporter_phone: '90000 00000' });
    expect(patch.status).toBe(403);
    const photo = await request(app).post(`/api/emergency/${id}/photo?token=${viewer}`).set('Content-Type', 'image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(photo.status).toBe(403);

    const alert = await store.getAlert(id);
    expect(alert.reporter_phone).toBe(OWNER_PHONE);
    expect(alert.note).not.toContain('injected');
    expect(alert.photo_count || 0).toBe(0);
  });

  it('the view-only token can still follow the route', async () => {
    const { id, viewer } = await raiseAndMerge();
    const route = await request(app).get(`/api/emergency/${id}/route?token=${viewer}`);
    expect(route.status).toBe(200);
  });

  it('the first reporter can still update and cancel; the viewer sees it cancelled without the reason', async () => {
    const { id, owner, viewer } = await raiseAndMerge();
    const upd = await request(app).patch(`/api/emergency/${id}?token=${owner}`).send({ note: 'Driver trapped' });
    expect(upd.status).toBe(200);
    expect(upd.body.view_only).toBe(false);

    const cancel = await request(app).post(`/api/emergency/${id}/cancel?token=${owner}`).send({ reason: 'Private: taken to hospital by family' });
    expect(cancel.status).toBe(200);
    expect(cancel.body).toMatchObject({ status: 'cancelled', cancel_reason: 'Private: taken to hospital by family' });

    const seen = await request(app).get(`/api/emergency/${id}?token=${viewer}`);
    expect(seen.body.status).toBe('cancelled');
    expect(seen.body.cancel_reason).toBeNull();
    expect(JSON.stringify(seen.body)).not.toContain('Private: taken');
  });

  it('an unknown token is still a 404', async () => {
    const { id } = await raiseAndMerge();
    expect((await request(app).get(`/api/emergency/${id}?token=nope`)).status).toBe(404);
    expect((await request(app).post(`/api/emergency/${id}/cancel?token=nope`)).status).toBe(404);
  });
});

describe('trackRole', () => {
  it('treats the first stored hash as the owner and later ones (including older merged alerts) as viewers', () => {
    const alert = { track_token_hashes: [hashToken('owner-token'), hashToken('merged-1'), hashToken('merged-2')] };
    expect(features.service.trackRole(alert, 'owner-token')).toBe('owner');
    expect(features.service.trackRole(alert, 'merged-1')).toBe('viewer');
    expect(features.service.trackRole(alert, 'merged-2')).toBe('viewer');
    expect(features.service.trackRole(alert, 'other')).toBeNull();
    expect(features.service.trackRole({ track_token_hashes: [] }, 'owner-token')).toBeNull();
    expect(features.service.trackRole({}, 'owner-token')).toBeNull();
  });
});
