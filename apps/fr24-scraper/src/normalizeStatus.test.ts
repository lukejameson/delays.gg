import { describe, it, expect } from 'vitest';

/**
 * Tests for the FR24 scraper's normalizeStatus function.
 *
 * Mirrors the logic in apps/fr24-scraper/src/scraper.ts.
 * FR24 status strings are unpredictable — this test ensures
 * all known variants map to our standard vocabulary.
 */

function normalizeStatus(rawStatus: string): string {
  const s = rawStatus.trim().toLowerCase();
  if (s.includes('landed')) return 'Landed';
  if (s.includes('cancelled') || s.includes('canceled')) return 'Cancelled';
  if (s.includes('diverted')) return 'Diverted';
  if (s.includes('airborne') || s.includes('en route') || s.includes('in flight')) return 'Airborne';
  if (s.includes('delayed')) return 'Delayed';
  if (s.includes('scheduled') || s.includes('on time')) return 'Scheduled';
  if (s.includes('boarding')) return 'Boarding';
  if (s.includes('departed') || s.includes('took off')) return 'Airborne';
  if (s.includes('arrived')) return 'Landed';
  if (s.includes('estimated') || s.includes('expected')) return 'Scheduled';
  return rawStatus.trim() || 'Scheduled';
}

describe('normalizeStatus', () => {
  it('maps Landed variants', () => {
    expect(normalizeStatus('Landed 12:34')).toBe('Landed');
    expect(normalizeStatus('landed')).toBe('Landed');
    expect(normalizeStatus('LANDED 22:00')).toBe('Landed');
    expect(normalizeStatus('Arrived')).toBe('Landed');
  });

  it('maps Airborne variants', () => {
    expect(normalizeStatus('Airborne')).toBe('Airborne');
    expect(normalizeStatus('En Route')).toBe('Airborne');
    expect(normalizeStatus('In Flight')).toBe('Airborne');
    expect(normalizeStatus('Departed')).toBe('Airborne');
    expect(normalizeStatus('Took off')).toBe('Airborne');
  });

  it('maps Cancelled variants', () => {
    expect(normalizeStatus('Cancelled')).toBe('Cancelled');
    expect(normalizeStatus('Canceled')).toBe('Cancelled');
  });

  it('maps Diverted variants', () => {
    expect(normalizeStatus('Diverted to EXT')).toBe('Diverted');
    expect(normalizeStatus('Diverted to London Gatwick')).toBe('Diverted');
    expect(normalizeStatus('diverted to JER')).toBe('Diverted');
  });

  it('maps Delayed', () => {
    expect(normalizeStatus('Delayed')).toBe('Delayed');
    expect(normalizeStatus('delayed 30m')).toBe('Delayed');
  });

  it('maps Boarding', () => {
    expect(normalizeStatus('Boarding')).toBe('Boarding');
    expect(normalizeStatus('boarding now')).toBe('Boarding');
  });

  it('maps Scheduled / On Time / Estimated', () => {
    expect(normalizeStatus('Scheduled')).toBe('Scheduled');
    expect(normalizeStatus('On Time')).toBe('Scheduled');
    expect(normalizeStatus('Estimated 08:45')).toBe('Scheduled');
    expect(normalizeStatus('Expected 14:30')).toBe('Scheduled');
  });

  it('returns raw status for unknown strings', () => {
    expect(normalizeStatus('Some Unknown Status')).toBe('Some Unknown Status');
  });

  it('returns Scheduled for empty/whitespace', () => {
    expect(normalizeStatus('')).toBe('Scheduled');
    expect(normalizeStatus('   ')).toBe('Scheduled');
  });
});
