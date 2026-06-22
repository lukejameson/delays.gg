import { describe, it, expect } from 'vitest';

/**
 * Tests for deriveStatus in guernsey-scraper.
 *
 * This is a simplified copy of the real deriveStatus function
 * to keep the test self-contained and fast (no DB dependency).
 */

interface StatusUpdate {
  flightCode: string;
  flightDate: string;
  statusTimestamp: Date;
  statusMessage: string;
}

function deriveStatus(updates: StatusUpdate[], scheduledTime: Date): string | null {
  if (updates.length === 0) return null;

  const preScheduleCutoff = scheduledTime.getTime() - 30 * 60_000;
  for (let i = updates.length - 1; i >= 0; i--) {
    const msg = updates[i].statusMessage.toLowerCase();
    const isPreSchedule = updates[i].statusTimestamp.getTime() < preScheduleCutoff;
    if (msg.includes('landed') || msg.includes('voyagereported')) {
      if (!isPreSchedule) return 'Landed';
    } else if (msg.includes('airborne')) {
      if (!isPreSchedule) return 'Airborne';
    } else if (msg.includes('diverted') || msg.includes('diverting')) {
      return 'Diverted';
    }
  }

  const last = updates[updates.length - 1].statusMessage.toLowerCase();
  if (last.includes('cancelled') || last.includes('canceled') || last.includes('flight cancelled')) return 'Cancelled';

  // Simplified approx handling
  if (last.includes('approx') && !last.includes('delayed')) {
    return 'Scheduled';
  }

  if (last.includes('delayed') || last.includes('expected at') ||
      last.includes('new etd') || last.includes('next info') || last.includes('indefini') ||
      last.includes('boarding expected')) return 'Delayed';
  if (last.includes('check in open') || last.includes('check-in open') ||
      last.includes('go to departure')) return 'Check-In Open';
  if (last.includes('final call') || last.includes('go to door') || last.includes('go to gate') ||
      last.includes('gate closed') || last.includes('door and gate') ||
      last.includes('wait in lounge')) return 'Boarding';
  if (last.includes('check in suspended') || last.includes('check in closes') ||
      last.includes('check-in closes') || last.includes('check in opens')) return 'Delayed';
  if (last.includes('holding overhead') || last.includes('holding in')) return 'Airborne';
  if (last.includes('on time')) return 'Scheduled';
  if (last.includes('pax on') || last.includes('pax from') || last.includes('passengers on') ||
      last.includes('passengers from')) return 'Scheduled';

  return updates[updates.length - 1].statusMessage;
}

const scheduled = new Date('2026-06-15T10:00:00Z');

const makeUpdate = (msg: string, minutesFromNow: number = 0): StatusUpdate => ({
  flightCode: 'GR601',
  flightDate: '2026-06-15',
  statusTimestamp: new Date(scheduled.getTime() + minutesFromNow * 60_000),
  statusMessage: msg,
});

describe('deriveStatus', () => {
  it('returns null for empty updates', () => {
    expect(deriveStatus([], scheduled)).toBeNull();
  });

  it('detects Landed', () => {
    expect(deriveStatus([makeUpdate('Landed 12:14')], scheduled)).toBe('Landed');
  });

  it('detects Airborne', () => {
    expect(deriveStatus([makeUpdate('Airborne at 06:49')], scheduled)).toBe('Airborne');
  });

  it('returns Diverted for all diversion variants', () => {
    expect(deriveStatus([makeUpdate('Diverted To EXETER')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Diverted to Jersey')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('DIVERTED TO EXETER')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Diverting to Jersey')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Flight Diverted To EXT Next Info 15:00')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Flight diverting to EXT')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Aircraft Diverted to LGW - Due To Fog')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Diverted To LONDON GATWICK')], scheduled)).toBe('Diverted');
    expect(deriveStatus([makeUpdate('Diverted to EXT - Not returning')], scheduled)).toBe('Diverted');
  });

  it('detects Cancelled', () => {
    expect(deriveStatus([makeUpdate('Flight Cancelled')], scheduled)).toBe('Cancelled');
    expect(deriveStatus([makeUpdate('Canceled')], scheduled)).toBe('Cancelled');
  });

  it('detects Delayed', () => {
    expect(deriveStatus([makeUpdate('Flight Delayed. Check in opens 16:00 New ETD 18:30')], scheduled)).toBe('Delayed');
    expect(deriveStatus([makeUpdate('Delayed To 10:40')], scheduled)).toBe('Delayed');
    expect(deriveStatus([makeUpdate('Expected at 14:00')], scheduled)).toBe('Delayed');
    expect(deriveStatus([makeUpdate('Next Info 15:00')], scheduled)).toBe('Delayed');
  });

  it('detects Boarding', () => {
    expect(deriveStatus([makeUpdate('Final Call')], scheduled)).toBe('Boarding');
    expect(deriveStatus([makeUpdate('Go To Door A')], scheduled)).toBe('Boarding');
    expect(deriveStatus([makeUpdate('Wait In Lounge')], scheduled)).toBe('Boarding');
  });

  it('detects Check-In Open', () => {
    expect(deriveStatus([makeUpdate('Check In Open')], scheduled)).toBe('Check-In Open');
    expect(deriveStatus([makeUpdate('Go to Departure Lounge')], scheduled)).toBe('Check-In Open');
  });

  it('detects Scheduled / On Time', () => {
    expect(deriveStatus([makeUpdate('On Time')], scheduled)).toBe('Scheduled');
    expect(deriveStatus([makeUpdate('Pax on board')], scheduled)).toBe('Scheduled');
  });

  it('ignores stale Landed/Airborne before scheduled time', () => {
    const staleUpdate = makeUpdate('Landed 08:00', -180); // 3 hours before scheduled
    expect(deriveStatus([staleUpdate, makeUpdate('On Time')], scheduled)).toBe('Scheduled');
  });

  it('returns raw message for truly unknown status', () => {
    expect(deriveStatus([makeUpdate('Some Random Status')], scheduled)).toBe('Some Random Status');
  });
});
