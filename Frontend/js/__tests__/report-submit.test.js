/**
 * Security batch 1, item 7 — report.html sends the SOS first, independently
 * of the report save (js/report-submit.js holds the order of work).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'fs';

let submit;
beforeAll(async () => {
  await import('../report-submit.js');
  ({ submit } = globalThis.ReportSubmit);
});

const reportHtml = fs.readFileSync(new URL('../../report.html', import.meta.url), 'utf8');

describe('ReportSubmit.submit', () => {
  it('sends the SOS before the report save starts', async () => {
    const order = [];
    let releaseSos;
    const sendSos = vi.fn(() => new Promise(resolve => { order.push('sos:start'); releaseSos = () => { order.push('sos:done'); resolve({ alertId: 'a1' }); }; }));
    const saveReport = vi.fn(async () => { order.push('report:start'); return { response: { status: 201 } }; });

    const pending = submit({ live: true, sendSos, saveReport });
    await Promise.resolve();
    expect(sendSos).toHaveBeenCalledTimes(1);
    expect(saveReport).not.toHaveBeenCalled(); // nothing about the report runs ahead of the SOS
    releaseSos();
    const out = await pending;
    expect(order).toEqual(['sos:start', 'sos:done', 'report:start']);
    expect(out.sos).toEqual({ alertId: 'a1' });
  });

  it('still saves the report when the SOS fails', async () => {
    const saveReport = vi.fn(async () => ({ response: { status: 201 } }));
    const out = await submit({ live: true, sendSos: async () => { throw new Error('offline'); }, saveReport });
    expect(saveReport).toHaveBeenCalledTimes(1);
    expect(out.sosError.message).toBe('offline');
    expect(out.report).toEqual({ response: { status: 201 } });
  });

  it('keeps the SOS result when the report save fails', async () => {
    const out = await submit({
      live: true,
      sendSos: async () => ({ alertId: 'a1', trackUrl: 'track.html?id=a1&t=x' }),
      saveReport: async () => { throw new Error('photo upload failed'); },
    });
    expect(out.sos).toMatchObject({ alertId: 'a1' });
    expect(out.reportError.message).toBe('photo upload failed');
  });

  it('does not send an SOS for a report that is not live', async () => {
    const sendSos = vi.fn();
    const out = await submit({ live: false, sendSos, saveReport: async () => ({ response: null }) });
    expect(sendSos).not.toHaveBeenCalled();
    expect(out.sos).toBeNull();
  });
});

describe('report.html wiring', () => {
  it('loads report-submit.js before the page script and uses it', () => {
    const helper = reportHtml.indexOf('<script src="js/report-submit.js"></script>');
    expect(helper).toBeGreaterThan(-1);
    expect(helper).toBeLessThan(reportHtml.indexOf("getElementById('report-form').addEventListener('submit'"));
    expect(reportHtml).toMatch(/window\.ReportSubmit\.submit\(\{/);
  });

  it('no longer waits for a saved report before raising the SOS', () => {
    expect(reportHtml).not.toMatch(/report_id:\s*data\.id/);
    const sosCall = reportHtml.indexOf('/api/emergency`');
    const savedBranch = reportHtml.indexOf('response.status === 201');
    expect(sosCall).toBeGreaterThan(-1);
    expect(sosCall).toBeLessThan(savedBranch); // the SOS request lives in raiseSos(), not in the "report saved" branch
  });

  it('does not alert hospitals twice when a failed report is retried', () => {
    expect(reportHtml).toMatch(/live: document\.getElementById\('field-live'\)\.checked && !sentSos/);
  });
});
