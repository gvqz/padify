/**
 * nl-dates — the quick-add grammar's spec.
 *
 * Every rule the parser documents is pinned here with a pinned `now`:
 * Wed Oct 21 2026, 14:30 local (plus a Friday for the same-weekday
 * rules). The suite is deliberately adversarial — the parser's whole
 * contract is that it NEVER eats title words it did not mean, so the
 * false-positive cases matter as much as the parses.
 */

import { describe, expect, it } from 'vitest';
import { parseQuickAdd } from './nl-dates';

/** Wed Oct 21 2026, 14:30 local time. */
const WED = new Date(2026, 9, 21, 14, 30, 0, 0);
/** Fri Oct 23 2026, 14:30 local time — for the same-weekday rules. */
const FRI = new Date(2026, 9, 23, 14, 30, 0, 0);

/** Asserts an ISO lands on a local Y/M/D (optionally H:M). */
function day(iso: string, y: number, m: number, d: number, h?: number, min?: number): void {
  expect(iso).not.toBe('');
  const date = new Date(iso);
  expect(date.getFullYear()).toBe(y);
  expect(date.getMonth()).toBe(m);
  expect(date.getDate()).toBe(d);
  if (h !== undefined) expect(date.getHours()).toBe(h);
  if (min !== undefined) expect(date.getMinutes()).toBe(min);
}

const parse = (input: string, now: Date = WED) => parseQuickAdd(input, now);

describe('no when-words — the input passes through untouched', () => {
  it('keeps a plain title', () => {
    const p = parse('buy oat milk');
    expect(p.title).toBe('buy oat milk');
    expect(p.dueDate).toBe('');
    expect(p.reminderAt).toBe('');
    expect(p.matched).toEqual([]);
  });

  it('does not eat a bare trailing number', () => {
    expect(parse('chapter 5').title).toBe('chapter 5');
    expect(parse('buy 2 apples').dueDate).toBe('');
  });

  it('does not eat words that merely end in a when-word', () => {
    expect(parse('fix the knight').title).toBe('fix the knight');
    expect(parse('sun shade report').dueDate).toBe('');
  });

  it('keeps a when-word that is not trailing', () => {
    const p = parse('buy monday newspaper');
    expect(p.title).toBe('buy monday newspaper');
    expect(p.dueDate).toBe('');
  });

  it('keeps "tomorrow" alone — an empty title is never a date', () => {
    const p = parse('tomorrow');
    expect(p.title).toBe('tomorrow');
    expect(p.dueDate).toBe('');
  });

  it('handles the empty input', () => {
    expect(parse('').title).toBe('');
    expect(parse('   ').dueDate).toBe('');
  });
});

describe('relative days', () => {
  it('tomorrow', () => {
    const p = parse('call the dentist tomorrow');
    expect(p.title).toBe('call the dentist');
    day(p.dueDate, 2026, 9, 22, 0, 0);
  });

  it('tomorrow with a time', () => {
    const p = parse('call the dentist tomorrow 9am');
    expect(p.title).toBe('call the dentist');
    day(p.dueDate, 2026, 9, 22, 9, 0);
  });

  it('the typos people actually type', () => {
    for (const word of ['tmr', 'tmrw', 'tmw', 'tommorow', 'tommorrow']) {
      const p = parse(`email ${word}`);
      expect(p.title).toBe('email');
      day(p.dueDate, 2026, 9, 22);
    }
  });

  it('case does not matter', () => {
    const p = parse('Call the DENTIST TOMORROW');
    expect(p.title).toBe('Call the DENTIST');
    day(p.dueDate, 2026, 9, 22);
  });

  it('today', () => {
    day(parse('water the plants today').dueDate, 2026, 9, 21);
  });

  it('tonight implies 8pm', () => {
    const p = parse('call mom tonight');
    expect(p.title).toBe('call mom');
    day(p.dueDate, 2026, 9, 21, 20, 0);
  });

  it('tonight with an explicit time keeps the explicit time', () => {
    day(parse('call mom tonight at 11').dueDate, 2026, 9, 21, 23, 0);
  });

  it('on tomorrow — the preposition goes', () => {
    const p = parse('book flights on tomorrow');
    expect(p.title).toBe('book flights');
    day(p.dueDate, 2026, 9, 22);
  });
});

describe('weekdays', () => {
  it('a bare weekday is its coming occurrence', () => {
    const p = parse('dentist friday');
    expect(p.title).toBe('dentist');
    day(p.dueDate, 2026, 9, 23); // Wed → Fri = +2
  });

  it('the same weekday reads as today', () => {
    const p = parse('standup friday', FRI);
    expect(p.title).toBe('standup');
    day(p.dueDate, 2026, 9, 23, 0, 0);
  });

  it('next skips the coming one — 8..14 days out', () => {
    const p = parse('mow the lawn next monday');
    expect(p.title).toBe('mow the lawn');
    day(p.dueDate, 2026, 10, 2); // Wed Oct 21 → Mon Nov 2
  });

  it('next on the same weekday is a week out', () => {
    day(parse('review next friday', FRI).dueDate, 2026, 9, 30);
  });

  it('on sat / coming sunday', () => {
    day(parse('beach on sat').dueDate, 2026, 9, 24);
    day(parse('call grandma coming sunday').dueDate, 2026, 9, 25);
  });

  it('3-letter and long forms both parse', () => {
    day(parse('demo thu').dueDate, 2026, 9, 22);
    day(parse('demo thursday').dueDate, 2026, 9, 22);
  });
});

describe('in N days / weeks', () => {
  it('in 3 days', () => {
    const p = parse('rotate the tires in 3 days');
    expect(p.title).toBe('rotate the tires');
    day(p.dueDate, 2026, 9, 24);
  });

  it('in a week / in two weeks', () => {
    day(parse('check in a week').dueDate, 2026, 9, 28);
    day(parse('check in two weeks').dueDate, 2026, 10, 4);
  });

  it('refuses in 0 days', () => {
    expect(parse('buy in 0 days').dueDate).toBe('');
  });
});

describe('month days', () => {
  it('nov 1', () => {
    const p = parse('pay rent nov 1');
    expect(p.title).toBe('pay rent');
    day(p.dueDate, 2026, 10, 1);
  });

  it('a passed month-day rolls to next year', () => {
    day(parse('new year jan 1').dueDate, 2027, 0, 1);
  });

  it('an explicit year wins', () => {
    day(parse('taxes april 15 2027').dueDate, 2027, 3, 15);
  });

  it('day-first: 30 oct', () => {
    day(parse('halloween party 30 oct').dueDate, 2026, 9, 30);
  });

  it('ordinals and "of": 1st of december', () => {
    day(parse('cards 1st of december').dueDate, 2026, 11, 1);
  });

  it('refuses impossible days', () => {
    expect(parse('meet feb 30').dueDate).toBe('');
    expect(parse('meet feb 31').dueDate).toBe('');
  });
});

describe('clock times', () => {
  it('the PM rule: "at 9" is the afternoon', () => {
    const p = parse('standup at 9:30');
    expect(p.title).toBe('standup');
    day(p.dueDate, 2026, 9, 21, 21, 30);
  });

  it('a leading zero pins the morning (passed → tomorrow)', () => {
    day(parse('flight at 09:30').dueDate, 2026, 9, 22, 9, 30);
  });

  it('24h stays 24h', () => {
    day(parse('flight at 19:00').dueDate, 2026, 9, 21, 19, 0);
  });

  it('am/pm markers', () => {
    day(parse('call europe at 9pm').dueDate, 2026, 9, 21, 21, 0);
    day(parse('call europe 4:30pm').dueDate, 2026, 9, 21, 16, 30);
    day(parse('lunch at noon').dueDate, 2026, 9, 22, 12, 0); // passed 12:00 → tomorrow
    day(parse('submit at 12am').dueDate, 2026, 9, 22, 0, 0); // passed 00:00 → tomorrow
  });

  it('a passed time rolls to tomorrow', () => {
    day(parse('gym at 9am').dueDate, 2026, 9, 22, 9, 0); // now is 14:30
  });

  it('midnight is the coming night', () => {
    day(parse('deadline midnight').dueDate, 2026, 9, 22, 0, 0);
  });

  it('a bare 9am without at', () => {
    day(parse('ping london 9am').dueDate, 2026, 9, 22, 9, 0);
  });
});

describe('dayparts', () => {
  it('tomorrow morning / saturday night', () => {
    day(parse('gym tomorrow morning').dueDate, 2026, 9, 22, 9, 0);
    day(parse('party saturday night').dueDate, 2026, 9, 24, 20, 0);
  });

  it('at night — a prefixed daypart without a date is today-or-tomorrow', () => {
    day(parse('walk the dog at night').dueDate, 2026, 9, 21, 20, 0);
  });

  it('a bare trailing daypart is NOT a date', () => {
    const p = parse('watch the game last night');
    expect(p.title).toBe('watch the game last night');
    expect(p.dueDate).toBe('');
  });

  it('in the morning', () => {
    day(parse('water the plants in the morning').dueDate, 2026, 9, 22, 9, 0);
  });
});

describe('weekend + next week', () => {
  it('weekend is the coming saturday morning', () => {
    day(parse('clean the garage weekend').dueDate, 2026, 9, 24, 9, 0);
    day(parse('clean the garage this weekend').dueDate, 2026, 9, 24, 9, 0);
  });

  it('next week', () => {
    day(parse('plan the sprint next week').dueDate, 2026, 9, 28);
  });
});

describe('the reminder form', () => {
  it('remind me … at TIME → a reminder, and the day stays the due date', () => {
    const p = parse('remind me to call mom tomorrow at 9');
    expect(p.title).toBe('call mom');
    day(p.dueDate, 2026, 9, 22, 0, 0);
    day(p.reminderAt, 2026, 9, 22, 21, 0);
  });

  it('remind without a time is just a due date', () => {
    const p = parse('remind me to buy milk tomorrow');
    expect(p.title).toBe('buy milk');
    day(p.dueDate, 2026, 9, 22);
    expect(p.reminderAt).toBe('');
  });

  it('remind me with no when-words passes through', () => {
    const p = parse('remind me to buy milk');
    expect(p.title).toBe('remind me to buy milk');
    expect(p.dueDate).toBe('');
  });
});

describe('clusters — date + time in either order', () => {
  it('date then time', () => {
    const p = parse('ship the package friday at 5pm');
    expect(p.title).toBe('ship the package');
    day(p.dueDate, 2026, 9, 23, 17, 0);
  });

  it('time then date', () => {
    day(parse('ship the package at 5pm friday').dueDate, 2026, 9, 23, 17, 0);
  });

  it('in N days then a time', () => {
    day(parse('launch in 3 days at 5pm').dueDate, 2026, 9, 24, 17, 0);
  });

  it('a second date phrase stays in the title', () => {
    const p = parse('compare friday vs monday plans');
    expect(p.dueDate).toBe('');
    expect(p.title).toBe('compare friday vs monday plans');
  });
});

describe('cleanliness', () => {
  it('trailing punctuation does not block the parse', () => {
    const p = parse('call the dentist tomorrow.');
    expect(p.title).toBe('call the dentist');
    day(p.dueDate, 2026, 9, 22);
  });

  it('connector words go with the when-words', () => {
    expect(parse('buy milk on monday').title).toBe('buy milk');
    expect(parse('standup at 9:30').title).toBe('standup');
    expect(parse('launch in 3 days').title).toBe('launch');
  });

  it('double spaces collapse', () => {
    expect(parse('call  the   dentist tomorrow').title).toBe('call the dentist');
  });
});

describe('fails safe', () => {
  it('a time alone with no title is not consumed', () => {
    const p = parse('9:30');
    expect(p.title).toBe('9:30');
    expect(p.dueDate).toBe('');
  });

  it('an unparseable month-day leaves the line alone', () => {
    const p = parse('meet foo 45 bar');
    expect(p.title).toBe('meet foo 45 bar');
    expect(p.dueDate).toBe('');
  });

  it('never throws on punctuation soup', () => {
    for (const line of ['...!!!', 'at at at', 'in in in', 'next next', 'on on on', '——']) {
      expect(() => parse(line)).not.toThrow();
    }
  });
});
