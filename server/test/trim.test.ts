import { describe, expect, it } from 'vitest';
import { cleanRange, trimArgs } from '../src/services/trim.js';

describe('trimming videos', () => {
  it('keeps the range inside the video', () => {
    expect(cleanRange(1.23456, 4, 10)).toEqual({ start: 1.235, end: 4 });
    expect(cleanRange(-2, 4, 10)).toEqual({ start: 0, end: 4 });
    expect(cleanRange(2, 99, 10)).toEqual({ start: 2, end: 10 });
    expect(cleanRange(2, 5, null)).toEqual({ start: 2, end: 5 });
  });

  it('refuses ranges that are too short, invalid or the whole video', () => {
    expect(() => cleanRange(3, 3.2, 10)).toThrow(/at least 0.5 s/);
    expect(() => cleanRange(5, 2, 10)).toThrow(/at least/);
    expect(() => cleanRange('x', 2, 10)).toThrow(/Choose where/);
    expect(() => cleanRange(0, 10, 10)).toThrow(/keeps the whole video/);
  });

  it('cuts frame-accurately and keeps audio when there is any', () => {
    const args = trimArgs('in.mp4', 'out.mp4', 1.5, 4.25);
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '1.5']);
    expect(args[args.indexOf('-t') + 1]).toBe('2.75');
    expect(args).toContain('libx264');
    expect(args).toContain('0:a:0?');
    expect(args.at(-1)).toBe('out.mp4');
  });
});
