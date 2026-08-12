import { getSetting, setSetting } from './db.js';

/**
 * Which cards the dashboard shows, and in what order.
 *
 * Monarch has a Customize button with drag and drop. For one person on one
 * phone that is a lot of machinery for a decision made about twice a year, so
 * this is a list of checkboxes and up/down links that posts a form — no drag
 * targets, no client-side state, and it works with the keyboard for free.
 *
 * Two cards are deliberately not in the list. The connection banners and the
 * sync card are how the dashboard tells you it is lying to you, and hiding
 * those is the one setting that could make every other number untrustworthy in
 * silence.
 */
export const CARD_IDS = [
  'paycheck',
  'review',
  'balances',
  'shape',
  'commitments',
  'spending',
  'transactions',
] as const;

export type CardId = (typeof CARD_IDS)[number];

export const CARD_LABELS: Record<CardId, string> = {
  paycheck: 'Friday paycheck',
  review: 'Needs a look',
  balances: 'Available to spend',
  shape: 'A typical month',
  commitments: 'Commitments',
  spending: 'Last 30 days',
  transactions: 'Recent transactions',
};

/**
 * The groups rows sit under, in order.
 *
 * A page of ten identical boxes has no hierarchy — everything shouts equally,
 * so nothing is read. Collapsing each card to one row of icon, name and value
 * puts the whole dashboard on a screen or two, and headings do the separating
 * that ten borders were failing to do.
 */
export const GROUPS = ['week', 'coming', 'activity'] as const;
export type GroupId = (typeof GROUPS)[number];

export const GROUP_LABELS: Record<GroupId, string> = {
  week: 'This week',
  coming: 'Coming up',
  activity: 'Where it goes',
};

export const CARD_GROUP: Record<CardId, GroupId> = {
  paycheck: 'week',
  review: 'week',
  // The balance renders as the wallet card, outside every group; the id
  // stays so it can still be hidden from /cards.
  balances: 'coming',
  shape: 'coming',
  commitments: 'coming',
  spending: 'activity',
  transactions: 'activity',
};

/**
 * One simple mark each, drawn inline so nothing external loads and the CSP
 * stays as tight as it is. Stroked rather than filled, at a common 24-unit
 * grid, so they read as one set rather than as eight borrowed glyphs.
 */
export const CARD_ICONS: Record<CardId, string> = {
  paycheck: 'M3 7h18v10H3zM12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3',
  review: 'M12 3.5 21 20H3zM12 10v4M12 16.5v.5',
  balances: 'M4 6h16v12H4zM4 10h16M8 14h4',
  shape: 'M12 3a9 9 0 1 0 9 9h-9z',
  commitments: 'M4 5h13l3 3v11H4zM8 5v5h7V5M8 15h8',
  spending: 'M4 20V11m5 9V5m5 15v-6m5 6V8',
  transactions: 'M4 8h13l-3-3M20 16H7l3 3',
};

/** Cards that stay put: the paycheck is the point, and the queue guards it. */
const ALWAYS_SHOWN: readonly CardId[] = ['paycheck'];

export interface CardLayout {
  order: CardId[];
  hidden: Set<CardId>;
}

const SETTING_KEY = 'dashboard_cards';

function isCardId(value: string): value is CardId {
  return (CARD_IDS as readonly string[]).includes(value);
}

export function defaultLayout(): CardLayout {
  return { order: [...CARD_IDS], hidden: new Set() };
}

/**
 * Reads the stored layout, repairing anything that no longer lines up.
 *
 * A card added in a later release will not be in a layout saved before it
 * existed, and one removed will still be named by it. Rather than migrate the
 * setting, unknown ids are dropped and missing ones appended in their default
 * position — a new card shows up rather than silently never appearing.
 */
export function getLayout(): CardLayout {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return defaultLayout();

  let parsed: { order?: unknown; hidden?: unknown };
  try {
    parsed = JSON.parse(raw) as { order?: unknown; hidden?: unknown };
  } catch {
    return defaultLayout();
  }

  const storedOrder = Array.isArray(parsed.order)
    ? parsed.order.filter((id): id is CardId => typeof id === 'string' && isCardId(id))
    : [];
  const order = [...new Set(storedOrder)];
  for (const id of CARD_IDS) if (!order.includes(id)) order.push(id);

  const storedHidden = Array.isArray(parsed.hidden)
    ? parsed.hidden.filter((id): id is CardId => typeof id === 'string' && isCardId(id))
    : [];
  const hidden = new Set(storedHidden.filter((id) => !ALWAYS_SHOWN.includes(id)));

  return { order, hidden };
}

export function saveLayout(layout: CardLayout): void {
  setSetting(
    SETTING_KEY,
    JSON.stringify({
      order: layout.order,
      hidden: [...layout.hidden].filter((id) => !ALWAYS_SHOWN.includes(id)),
    }),
  );
}

export function canHide(id: CardId): boolean {
  return !ALWAYS_SHOWN.includes(id);
}

/** Moves one card one place, ignoring a move off either end. */
export function reorder(order: CardId[], id: CardId, direction: 'up' | 'down'): CardId[] {
  const from = order.indexOf(id);
  if (from === -1) return order;
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= order.length) return order;

  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
