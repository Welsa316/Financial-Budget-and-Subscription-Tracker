/**
 * Writes src/views/brand-icons.ts from simple-icons.
 *
 * Only the marks actually referenced by config/rules.json are copied, so the
 * app ships a handful of paths rather than a 3,400-icon dependency, and
 * simple-icons stays a devDependency that nothing imports at runtime. Re-run
 * after adding an `icon` to a rule:
 *
 *   node scripts/generate-brand-icons.mjs
 *
 * The SVGs are CC0. The trademarks are not — they belong to their owners, and
 * are used here only to label that brand's own charge, which is what every
 * finance app does.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const simpleIcons = require('simple-icons');

const bySlug = new Map();
for (const key of Object.keys(simpleIcons)) {
  const icon = simpleIcons[key];
  if (icon && icon.slug) bySlug.set(icon.slug, icon);
}

const rules = JSON.parse(readFileSync('config/rules.json', 'utf8'));
const wanted = new Set(
  [...(rules.subscriptions ?? []), ...(rules.essentials ?? [])]
    .map((rule) => rule.icon)
    .filter(Boolean),
);

const missing = [...wanted].filter((slug) => !bySlug.has(slug));
if (missing.length) {
  console.error(`Not in simple-icons: ${missing.join(', ')}`);
  process.exit(1);
}

const entries = [...wanted]
  .sort()
  .map((slug) => {
    const icon = bySlug.get(slug);
    return `  '${slug}': {\n    title: ${JSON.stringify(icon.title)},\n    path: ${JSON.stringify(icon.path)},\n  },`;
  })
  .join('\n');

writeFileSync(
  'src/views/brand-icons.ts',
  `/**
 * Brand marks, generated — do not edit by hand.
 *
 *   node scripts/generate-brand-icons.mjs
 *
 * Only the slugs referenced by config/rules.json are here. Paths come from
 * simple-icons (CC0); the trademarks belong to their owners and are used to
 * label that brand's own charge.
 *
 * Deliberately without brand colours. Apple's is #000000 and Railway's is
 * #0B0D0E, which on a true-black page are invisible - and a rainbow of eight
 * brand hues would undo the one-accent palette anyway. Rendered monochrome the
 * silhouette still does the recognising.
 */
export interface BrandIcon {
  title: string;
  /** 24x24 viewBox path. */
  path: string;
}

export const BRAND_ICONS: Record<string, BrandIcon> = {
${entries}
};
`,
);

console.log(`Wrote ${wanted.size} brand mark(s): ${[...wanted].sort().join(', ')}`);
