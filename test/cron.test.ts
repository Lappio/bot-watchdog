import { describe, expect, it } from 'vitest';
import { nextOccurrence, previousOccurrence, validateExpression, validateTimezone } from '../src/cron';

describe('cron calculations inside workerd', () => {
  it('validates standard syntax and IANA zones', () => {
    for (const expression of ['* * * * *', '*/15 9-17 * * 1-5', '0,30 1,12 * 1-12/2 0,6']) expect(validateExpression(expression)).toBe(true);
    for (const expression of ['* * * * * *', '60 * * * *', '*/0 * * * *', 'bad', '@daily', '0 0 L * *']) expect(validateExpression(expression)).toBe(false);
    expect(validateTimezone('America/New_York')).toBe(true);
    expect(validateTimezone('Asia/Shanghai')).toBe(true);
    expect(validateTimezone('Invalid/Zone')).toBe(false);
    expect(validateTimezone('+08:00')).toBe(false);
  });
  it('uses inclusive boundaries and handles milliseconds', () => {
    const instant = new Date('2026-01-05T09:30:00Z');
    expect(nextOccurrence('*/15 9-17 * * 1-5', 'UTC', instant)).toEqual(instant);
    expect(previousOccurrence('*/15 9-17 * * 1-5', 'UTC', instant)).toEqual(instant);
    expect(nextOccurrence('*/15 9-17 * * 1-5', 'UTC', new Date(+instant + 1))?.toISOString()).toBe('2026-01-05T09:45:00.000Z');
    expect(previousOccurrence('*/15 9-17 * * 1-5', 'UTC', new Date(+instant - 1))?.toISOString()).toBe('2026-01-05T09:15:00.000Z');
  });
  it('handles lists, ranges, and Shanghai dates across UTC midnight', () => {
    const instant = new Date('2026-01-05T00:00:00Z');
    expect(previousOccurrence('0,30 7-9 * * 1-5', 'Asia/Shanghai', instant)?.toISOString()).toBe('2026-01-05T00:00:00.000Z');
    expect(previousOccurrence('0 7 * * *', 'Asia/Shanghai', instant)?.toISOString()).toBe('2026-01-04T23:00:00.000Z');
    expect(nextOccurrence('0 7 * * *', 'Asia/Shanghai', instant)?.toISOString()).toBe('2026-01-05T23:00:00.000Z');
  });
  it('keeps inclusive boundaries at a DST gap and follows Croner gap/fold policy', () => {
    // Croner shifts a nonexistent 02:30 to 03:30 and runs a repeated 01:30 once.
    const gap = new Date('2026-03-08T07:30:00Z');
    expect(nextOccurrence('30 2 * * *', 'America/New_York', new Date('2026-03-08T06:59:00Z'))).toEqual(gap);
    expect(previousOccurrence('30 2 * * *', 'America/New_York', gap)).toEqual(gap);
    expect(nextOccurrence('30 2 * * *', 'America/New_York', gap)).toEqual(gap);
    expect(nextOccurrence('30 1 * * *', 'America/New_York', new Date('2026-11-01T05:31:00Z'))?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
  it.each([
    ['2026-03-07T15:00:00Z', '2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'],
    ['2026-10-31T15:00:00Z', '2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z'],
  ])('tracks New York DST offset around %s', (at, prev, next) => {
    expect(previousOccurrence('0 9 * * *', 'America/New_York', new Date(at))?.toISOString()).toBe(prev);
    expect(nextOccurrence('0 9 * * *', 'America/New_York', new Date(at))?.toISOString()).toBe(next);
  });
});

it('returns null for impossible schedules, invalid zones, syntax and instants', () => {
  for (const calculate of [previousOccurrence, nextOccurrence]) {
    expect(calculate('0 0 31 2 *', 'UTC', new Date('2026-10-24T00:00:00Z'))).toBeNull();
    expect(calculate('* * * * *', 'Invalid/Zone', new Date())).toBeNull();
    expect(calculate('bad', 'UTC', new Date())).toBeNull();
    expect(calculate('* * * * *', 'UTC', new Date(NaN))).toBeNull();
  }
});
