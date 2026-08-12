/** Money is stored and computed in integer cents; formatting is the only place it becomes a string. */

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** "$1,234.56", negatives as "-$1,234.56". */
export function money(cents: number): string {
  return usd.format(cents / 100);
}

/** Magnitude only — for tables where a separate column carries the direction. */
export function moneyAbs(cents: number): string {
  return usd.format(Math.abs(cents) / 100);
}

export function moneyWhole(cents: number): string {
  return usdWhole.format(cents / 100);
}

/** Escapes text destined for HTML. Every interpolated value goes through this. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Acronyms worth preserving in bank descriptions. Uppercasing every short word
 * instead turns "Cafe du Monde" into "Cafe DU Monde".
 */
const ACRONYMS = new Set([
  'atm', 'llc', 'inc', 'usa', 'us', 'ach', 'pos', 'tv', 'ny', 'la', 'dc', 'id', 'rtp', 'ppd',
]);

export function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      ACRONYMS.has(word) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * A money figure with the cents dropped back a size.
 *
 * Borrowed from the reference designs and it earns its keep: at display size
 * the decimal is the least important part of the number and reading it at full
 * weight slows the whole figure down. Returns HTML, so the caller must not
 * escape it again — the input is a number, not text.
 */
export function moneyParts(cents: number): string {
  const whole = money(cents);
  const dot = whole.lastIndexOf('.');
  if (dot === -1) return esc(whole);
  return `${esc(whole.slice(0, dot))}<span class="money__cents">${esc(whole.slice(dot))}</span>`;
}
