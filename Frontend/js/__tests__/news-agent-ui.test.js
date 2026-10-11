/**
 * News Agent / X import UI helpers: the map popup's source wording and the
 * admin source badges. Runs the real functions from the shipped files.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';

const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

function loadSourceInfo() {
  const fn = src('dashboard-app.js').match(/function sourceInfo\(p\) \{[\s\S]*?\n {2}\}/)[0];
  return new Function(`${fn}; return sourceInfo;`)();
}

function loadAdminAgent() {
  const window = {};
  new Function('window', 'document', src('admin-agent.js'))(window, {});
  return window.BATAgent;
}

describe('map popup source wording', () => {
  const sourceInfo = loadSourceInfo();

  it('credits Bengaluru Traffic Police for their X posts', () => {
    const info = sourceInfo({ source: 'Bengaluru Traffic Police (X)', link: 'https://x.com/blrcitytraffic/status/2108526123160424481' });
    expect(info).toEqual({ label: 'Bengaluru Traffic Police on X', linkText: 'View post on X ↗', href: 'https://x.com/blrcitytraffic/status/2108526123160424481' });
  });

  it('names other X accounts by handle', () => {
    expect(sourceInfo({ source: 'X: @someone', link: 'https://x.com/someone/status/1' }).label).toBe('@someone on X');
  });

  it('credits the publisher and the News Agent', () => {
    const info = sourceInfo({ source: 'Deccan Herald', link: 'https://www.deccanherald.com/a', foundBy: 'agent' });
    expect(info).toEqual({ label: 'Deccan Herald (found by BAT News Agent)', linkText: 'Read article ↗', href: 'https://www.deccanherald.com/a' });
  });

  it('leaves older rows as they were and drops unsafe links', () => {
    expect(sourceInfo({ source: 'The Hindu', link: 'https://www.thehindu.com/x' })).toEqual({ label: 'The Hindu', linkText: 'Read article ↗', href: 'https://www.thehindu.com/x' });
    expect(sourceInfo({ source: 'User Report', link: null }).href).toBeNull();
    expect(sourceInfo({ source: 'X', link: 'javascript:alert(1)' }).href).toBeNull();
    expect(sourceInfo({ link: '#' }).label).toBe('—');
  });

  it('never calls these records live or real-time', () => {
    const cases = [
      { source: 'Bengaluru Traffic Police (X)', link: 'https://x.com/blrcitytraffic/status/1' },
      { source: 'Deccan Herald', link: 'https://a.com', foundBy: 'agent' },
      { source: 'X: @a', link: 'https://twitter.com/a/status/2' },
    ];
    for (const c of cases) {
      const { label, linkText } = sourceInfo(c);
      expect(`${label} ${linkText}`).not.toMatch(/\blive\b|real[- ]?time/i);
    }
  });
});

describe('admin source badges', () => {
  const agent = loadAdminAgent();

  it('tells agent, X and citizen rows apart', () => {
    expect(agent.sourceKind({ description: 'A biker died. (Found by BAT News Agent)', link: 'https://a.com' })).toBe('agent');
    expect(agent.sourceKind({ link: 'https://x.com/blrcitytraffic/status/123', description: 'x (Imported from X by a BAT admin)' })).toBe('x');
    expect(agent.sourceKind({ reporter_id: 'u1', description: 'I saw a crash' })).toBe('user');
    expect(agent.sourceKind({ source: 'The Hindu', link: 'https://a.com' })).toBeNull();
  });

  it('badge markup is fixed text only', () => {
    expect(agent.sourceBadgeHtml({ description: '(Found by BAT News Agent)' })).toMatch(/>Agent</);
    expect(agent.sourceBadgeHtml({ link: 'https://twitter.com/a/status/1' })).toMatch(/>X</);
    expect(agent.sourceBadgeHtml({ reporter_id: 'u1' })).toBe('');
  });

  it('recognises X post links the same way as the server', () => {
    expect(agent.isXPostUrl('https://mobile.twitter.com/blrcitytraffic/status/123?s=20')).toBe(true);
    expect(agent.isXPostUrl('https://x.com/blrcitytraffic')).toBe(false);
    expect(agent.isXPostUrl('http://x.com/a/status/1')).toBe(false);
    expect(agent.isXHost('https://x.com/blrcitytraffic')).toBe(true);
    expect(agent.isXHost('https://www.thehindu.com/x.com/status/1')).toBe(false);
  });

  it('splits pasted links one per line', () => {
    expect(agent.parseLines(' https://x.com/a/status/1 \r\n\n https://x.com/b/status/2\n')).toEqual(['https://x.com/a/status/1', 'https://x.com/b/status/2']);
  });

  it('labels every pipeline status', () => {
    for (const s of ['imported', 'duplicate', 'not_accident', 'outside_bangalore', 'invalid_link', 'error', 'deferred']) {
      expect(agent.statusLabel(s)).not.toBe(s);
    }
    expect(agent.statusLabel('outside_bangalore')).toBe('Not in Bangalore');
  });
});
