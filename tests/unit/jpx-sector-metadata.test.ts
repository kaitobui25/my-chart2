import { describe, expect, it, vi } from 'vitest';
import { JpxSectorMetadata } from '../../examples/workstation/jpx-sector-metadata';

const catalog = { asOf: '2026-09-30', sourceUrl: 'https://www.jpx.co.jp/', records: {
  '7203.T': { name: 'Toyota', sector33Code: '3700', sector33Name: '輸送用機器', sector17Code: '06', sector17Name: '自動車・輸送機' },
} };
describe('JPX sector metadata', () => {
  it('shares one request between tiles and serves subsequent lookups from cache', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog)));
    const repo = new JpxSectorMetadata(fetchImpl);
    const [first, second] = await Promise.all([repo.get('7203.T'), repo.get('7203.T')]);
    expect(first?.text).toBe('33: 3700 · 17: 06');
    expect(first?.title).toContain('輸送用機器');
    expect(second).toEqual(first);
    await repo.get('7203.T');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await repo.get('130A.T')).toBeNull();
  });
  it('skips indices and crypto and backs off on transient errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 502 }));
    const repo = new JpxSectorMetadata(fetchImpl);
    expect(await repo.get('^N225')).toBeNull();
    expect(await repo.get('BTC-USD')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await repo.get('7203.T')).toBeNull();
    expect(await repo.get('6758.T')).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
