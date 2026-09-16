import { config } from '../src/config/index.js';
import { openDb } from '../src/db/connection.js';
import { countPlugins, listPlugins, updatePlugin } from '../src/repositories/plugins.js';
import { displayFrom } from '../src/services/upstream/sync-purchased-resources.js';

/**
 * Rewrites plugin display names into the short form, so the Discord menu sorts
 * alphabetically and each row is readable.
 *
 * Needed because a name learned from Spigot's purchased list is a marketing
 * headline, not a name: it opens with a version range (`[1.8 - 26.2]`), carries
 * decorative emoji, and runs to a tagline. Those sort by bracket and emoji rather
 * than by letter, and Discord truncates the row before the useful part.
 *
 * Only display names change. Slugs, resource ids, descriptor names, aliases,
 * archived versions and the vault are untouched — so the bot keeps matching jars
 * to plugins exactly as before.
 *
 * Usage:
 *   npm run tidy-names              # preview
 *   npm run tidy-names -- --yes     # apply
 */
function main(): void {
  const env = config();
  const confirmed = process.argv.includes('--yes');

  const db = openDb(env.DB_PATH);
  try {
    const total = countPlugins(db);
    const plugins = listPlugins(db, total, 0);

    const changes = plugins
      .map((plugin) => ({ plugin, tidy: displayFrom(plugin.displayName) }))
      .filter((c) => c.tidy !== c.plugin.displayName && c.tidy !== '');

    if (changes.length === 0) {
      console.log(`${total} plugin, tên đã gọn — không cần đổi gì.`);
      return;
    }

    console.log(`Sẽ đổi tên ${changes.length}/${total} plugin:\n`);
    for (const { plugin, tidy } of changes) {
      console.log(`  "${plugin.displayName}"`);
      console.log(`    → "${tidy}"`);
    }

    if (!confirmed) {
      console.log('\nĐây chỉ là xem trước. Chạy lại kèm --yes để đổi thật:');
      console.log('  npm run tidy-names -- --yes');
      return;
    }

    // One transaction: a half-renamed menu is harder to reason about than either
    // end of the change.
    const apply = db.transaction(() => {
      for (const { plugin, tidy } of changes) updatePlugin(db, plugin.id, { displayName: tidy });
    });
    apply();

    console.log(`\nĐã đổi ${changes.length} tên. Menu giờ sắp theo thứ tự chữ cái.`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error('Đổi tên thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
}
