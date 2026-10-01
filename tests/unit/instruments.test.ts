import { describe, expect, it } from 'vitest';

import { searchInstruments } from '../../examples/providers/instruments';

describe('instrument search', () => {
  it('preserves punctuation in canonical extra symbols while matching normalized queries', () => {
    expect(searchInstruments('9984', ['9984.T'])[0]?.symbol).toBe('9984.T');
    expect(searchInstruments('9984T', ['9984.T'])[0]?.symbol).toBe('9984.T');
  });

  it('keeps built-in symbols unchanged', () => {
    expect(searchInstruments('VCB')[0]?.symbol).toBe('VCB');
  });
});
