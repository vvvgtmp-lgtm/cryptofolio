import { describe, expect, it } from 'vitest';
import { formatCompactUsd, formatPct, formatQty, formatUsd, pnlClass } from './format';

describe('formatters', () => {
  it('formats USD with cents, small prices with significant digits, and null as a dash', () => {
    expect(formatUsd(1234.5)).toBe('$1,234.50');
    expect(formatUsd(-20)).toBe('-$20.00');
    expect(formatUsd(0.000123)).toBe('$0.000123');
    expect(formatUsd(null)).toBe('—');
  });

  it('formats percentages with a sign', () => {
    expect(formatPct(1.234)).toBe('+1.23%');
    expect(formatPct(-2)).toBe('-2.00%');
    expect(formatPct(0)).toBe('0.00%');
    expect(formatPct(null)).toBe('—');
  });

  it('formats quantities with up to 8 decimals', () => {
    expect(formatQty(0.123456789)).toBe('0.12345679');
    expect(formatQty(10000)).toBe('10,000');
  });

  it('formats compact USD', () => {
    expect(formatCompactUsd(1.23e12)).toBe('$1.23T');
    expect(formatCompactUsd(48500)).toBe('$48.5K');
  });

  it('picks a colour class by sign', () => {
    expect(pnlClass(5)).toBe('text-gain');
    expect(pnlClass(-5)).toBe('text-loss');
    expect(pnlClass(0)).toBe('text-muted');
    expect(pnlClass(null)).toBe('text-muted');
  });
});
