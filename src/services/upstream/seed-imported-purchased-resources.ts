import type { Db } from '../../db/connection.js';
import { createPlugin, listAliases, listPlugins } from '../../repositories/plugins.js';
import { recordOwnership } from '../../repositories/resource-ownership.js';
import type { ImportedCredential } from './spigot-credential-import.js';
import { displayFrom, normalizeName } from './sync-purchased-resources.js';

function slugFrom(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'plugin';
}

/** Seeds visible vault rows from a trusted imported purchase report. */
export function seedImportedPurchasedResources(db: Db, credentials: ImportedCredential[]): number {
  const currentPlugins = listPlugins(db, 100_000, 0);
  const knownNames = new Set<string>();
  const pluginsByName = new Map<string, (typeof currentPlugins)[number] | null>();
  const usedSlugs = new Set(currentPlugins.map((plugin) => plugin.slug));

  for (const plugin of currentPlugins) {
    for (const name of [plugin.displayName, plugin.descriptorName, ...listAliases(db, plugin.id)]) {
      const normalized = normalizeName(name);
      if (!normalized) continue;
      knownNames.add(normalized);
      const existing = pluginsByName.get(normalized);
      pluginsByName.set(normalized, existing && existing.id !== plugin.id ? null : plugin);
    }
  }

  let created = 0;
  for (const credential of credentials) {
    const status = credential.importedStatus?.toLowerCase();
    if (status && status !== 'success') continue;
    for (const title of credential.purchasedResources ?? []) {
      const displayName = displayFrom(title);
      const normalizedTitle = normalizeName(title);
      const normalizedDisplay = normalizeName(displayName);
      let matched = pluginsByName.get(normalizedTitle) ?? pluginsByName.get(normalizedDisplay);
      if (!matched) {
        for (const [knownName, plugin] of pluginsByName.entries()) {
          if (!plugin) continue;
          if (
            knownName.length >= 4 &&
            (normalizedDisplay.startsWith(knownName) ||
              normalizedTitle.startsWith(knownName) ||
              normalizedDisplay.includes(knownName))
          ) {
            matched = plugin;
            break;
          }
        }
      }
      if (matched?.resourceId !== null && matched?.resourceId !== undefined) {
        recordOwnership(db, matched.resourceId, credential.label, 'owned');
      }
      if (!normalizedDisplay || knownNames.has(normalizedTitle) || knownNames.has(normalizedDisplay)) continue;

      let slug = slugFrom(displayName);
      let suffix = 2;
      while (usedSlugs.has(slug)) slug = `${slugFrom(displayName).slice(0, 55)}-${suffix++}`;

      const createdPlugin = createPlugin(db, { slug, displayName, descriptorName: displayName, platform: 'spigot' });
      knownNames.add(normalizedTitle);
      knownNames.add(normalizedDisplay);
      pluginsByName.set(normalizedTitle, createdPlugin);
      pluginsByName.set(normalizedDisplay, createdPlugin);
      usedSlugs.add(slug);
      created++;
    }
  }
  return created;
}
