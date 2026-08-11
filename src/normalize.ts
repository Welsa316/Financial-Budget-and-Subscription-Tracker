/**
 * Description handling shared by the Teller sync, the statement importer and
 * the classifier. All three must agree, or deduplication and rule matching
 * silently drift apart.
 */

/**
 * Lowercases and strips the noise banks attach to descriptions — reference
 * numbers, dates, card suffixes, punctuation — so the same merchant reads the
 * same way whether it came from the API or a PDF statement.
 */
/**
 * Transaction-type prefixes that a PDF statement prints but the API does not.
 * Chase writes "Card Purchase 12/04 Netflix.Com ..." on a statement and returns
 * "NETFLIX.COM ..." over the API. Leaving these in place means the same charge
 * produces two different dedupe keys and imports duplicate every card purchase.
 */
const TYPE_PREFIXES =
  /^(?:recurring\s+)?(?:card\s+purchase(?:\s+with\s+pin)?|debit\s+card\s+purchase|purchase\s+authorized\s+on|pos\s+debit|pos\s+purchase|ach\s+debit|ach\s+credit|electronic\s+withdrawal|online\s+payment|check\s+card\s+purchase)\s+/;

export function normalizeDescription(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[#*]/g, ' ')
    .replace(/\b(?:ppd|ccd|web|tel|arc|pos|ach)\s+id\b/g, ' ')
    .replace(/\b\d{2}\/\d{2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\bx{2,}\d+\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/[^a-z0-9\s&.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Applied after the general clean-up so an embedded date between the prefix
  // and the merchant is already gone.
  const stripped = cleaned.replace(TYPE_PREFIXES, '').trim();
  // Never strip away the entire description.
  return stripped || cleaned;
}

/** Converts a decimal money string or number to signed integer cents. */
export function toCents(amount: string | number): number {
  const value = typeof amount === 'number' ? amount : Number.parseFloat(amount);
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot parse amount: ${String(amount)}`);
  }
  return Math.round(value * 100);
}

/**
 * Stable identity for a transaction independent of its source. Teller ids and
 * statement rows never match, so date + amount + normalized description is what
 * lets an imported row and a synced row recognise each other.
 */
export function dedupeKey(date: string, amountCents: number, description: string): string {
  return `${date}|${amountCents}|${normalizeDescription(description)}`;
}

/**
 * Whether two normalized descriptions refer to the same merchant. Used both
 * when a pending charge settles under new wording and when matching a refund
 * back to the purchase it reverses.
 */
export function descriptionsSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 10 && b.length >= 10 && (a.startsWith(b.slice(0, 10)) || b.startsWith(a.slice(0, 10)))) {
    return true;
  }
  const tokensA = new Set(a.split(' ').filter((token) => token.length > 2));
  const tokensB = new Set(b.split(' ').filter((token) => token.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;
  return shared / Math.min(tokensA.size, tokensB.size) >= 0.5;
}
