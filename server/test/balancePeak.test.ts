import { describe, expect, it } from 'vitest';
import { nextPeak } from '../src/services/balancePeak.js';

describe('what a balance counts as full', () => {
  it('starts at the first balance seen', () => {
    expect(nextPeak({}, 30)).toBe(30);
  });
  it('stays while spending', () => {
    expect(nextPeak({ peak: 30, last: 30 }, 24)).toBe(30);
    expect(nextPeak({ peak: 30, last: 24 }, 10)).toBe(30);
  });
  it('ignores small increases such as refunds', () => {
    expect(nextPeak({ peak: 30, last: 10 }, 10.5)).toBe(30);
  });
  it('restarts after a top-up', () => {
    expect(nextPeak({ peak: 30, last: 5 }, 25)).toBe(25);
    expect(nextPeak({ peak: 30, last: 5 }, 50)).toBe(50);
  });
});
