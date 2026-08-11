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

/** Title-cases a bank description for display without destroying known acronyms. */
export function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(/\s+/)
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}
