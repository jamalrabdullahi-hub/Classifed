import { describe, expect, it } from 'vitest';
import { MIN_FILL_MS, signupBotSignal } from '../src/domain/signup-signals';

describe('signupBotSignal', () => {
  const now = 1_000_000_000;

  it('passes a person who took a normal amount of time', () => {
    expect(signupBotSignal({ honeypot: '', renderedAt: now - 15_000 }, now)).toBeNull();
  });

  it('flags a filled honeypot regardless of timing', () => {
    expect(signupBotSignal({ honeypot: 'https://spam.example', renderedAt: now - 60_000 }, now)).toBe('honeypot');
  });

  it('flags a submission faster than a person can type', () => {
    expect(signupBotSignal({ renderedAt: now - (MIN_FILL_MS - 1) }, now)).toBe('too_fast');
  });

  it('does not punish missing, future or very old timestamps', () => {
    expect(signupBotSignal({}, now)).toBeNull();
    expect(signupBotSignal({ renderedAt: now + 5_000 }, now)).toBeNull();
    expect(signupBotSignal({ renderedAt: now - 2 * 24 * 3_600_000 }, now)).toBeNull();
  });
});
