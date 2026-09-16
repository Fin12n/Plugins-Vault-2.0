/**
 * Resolves the `?version=` id that Spigot's own download URL needs.
 *
 * Exists because that id cannot be derived from the Spiget API for the resources
 * this bot actually cares about. Measured against api.spiget.org:
 *
 *   Vulcan 2.9.7.23 — Spiget version.id = 999252070, real Spigot id = 645021
 *
 * Feeding the Spiget id back to Spiget 404s, and Spiget's own download redirect
 * emits a `?version=` that does not exist on Spigot. For PREMIUM resources every
 * sampled version id sat in a synthetic 999xxxxxx band, and some were 0.
 *
 * The trap worth naming: 40/40 sampled FREE resources have version.id exactly
 * equal to the real id. So any test written against a free plugin passes while
 * every premium resource — the only kind this bot downloads — breaks.
 *
 * Two supported sources, in order of cost:
 *   1. Spiget's `resource.file.url` carries the genuine id, but only for the
 *      CURRENT latest version.
 *   2. Historical versions must be scraped from the resource's history page.
 */

/** Ids at or above this are Spiget-internal, never Spigot's. */
const SPIGET_SYNTHETIC_FLOOR = 999_000_000;

/**
 * True when an id came from Spiget's own numbering and must not be used.
 *
 * Rejecting rather than passing through: a synthetic id asks Spigot for a version
 * that does not exist, and Spigot's response to that is not reliably an error —
 * it may serve current latest, which would archive the wrong jar under the
 * requested version's name.
 */
export function isSpigetSyntheticId(id: number): boolean {
  return !Number.isFinite(id) || id <= 0 || id >= SPIGET_SYNTHETIC_FLOOR;
}

/**
 * Pulls the `version=` parameter out of a download URL or path.
 *
 * Parses the parameter rather than trusting the whole string, because Spiget
 * returns a relative path (`resources/<slug>.<id>/download?version=645021`) that
 * cannot be used as a URL directly.
 */
export function parseVersionParam(url: string): string | null {
  const match = /[?&]version=(\d+)/.exec(url);
  return match?.[1] ?? null;
}

export type VersionLink = { versionName: string; versionId: string };

/**
 * Every (version name, version id) pair on a resource history page.
 *
 * Reads the id out of each anchor's `href` and pairs it with the version name
 * from that anchor's own row. The row is bounded by the surrounding `<tr>` or
 * `<li>`, so a name from one release cannot be matched against another's link.
 */
export function parseHistoryLinks(html: string): VersionLink[] {
  const links: VersionLink[] = [];
  // Rows, not the whole document: pairing depends on locality.
  const rows = html.split(/<(?:tr|li)\b/i);

  for (const row of rows) {
    const versionId = parseVersionParam(row);
    if (versionId === null) continue;

    // Cell text, tags stripped. The version name is its own cell in every
    // XenForo theme observed; taking the whole row would drag in the date and
    // download count.
    const cells = [...row.matchAll(/<(?:td|dd|span|div|h\d|a)\b[^>]*>([^<]{1,80})</gi)]
      .map((m) => (m[1] ?? '').trim())
      .filter((text) => text !== '');

    // A plausible version name: contains a digit and no whitespace-heavy prose.
    const name = cells.find((text) => /\d/.test(text) && text.length <= 40 && !/\s{2,}/.test(text));
    if (name === undefined) continue;

    links.push({ versionName: name, versionId });
  }

  return links;
}

/**
 * The id for one named version, or null when the page does not carry it.
 *
 * EXACT string equality, never a substring test. Substring matching was a real
 * defect: `"1.0"` matched the row for `"1.0.5"`, and because history pages list
 * newest first, the newer jar was archived under the older version's name — the
 * silent vault corruption this whole module exists to prevent.
 *
 * Null means "not on this page", which the caller must treat as retryable. It is
 * NOT evidence the version was deleted: history pages paginate.
 */
export function findVersionId(html: string, versionName: string): string | null {
  const wanted = versionName.trim();
  const links = parseHistoryLinks(html);
  const exact = links.find((link) => link.versionName === wanted);
  if (exact) return exact.versionId;

  // Flexible match: ignore leading 'v' or 'V' (e.g. 'v2.9.0' matches '2.9.0')
  const cleanWanted = wanted.replace(/^v/i, '').trim();
  const flexible = links.find(
    (link) => link.versionName.replace(/^v/i, '').trim() === cleanWanted,
  );
  if (flexible) return flexible.versionId;

  // Flexible match: strip trailing parenthetical build info (e.g. '2.0.43 (BUILD #2)' matches '2.0.43')
  const baseWanted = cleanWanted.replace(/\s*\([^)]*\)/g, '').trim();
  if (baseWanted.length > 0) {
    const parentheticalMatch = links.find((link) => {
      const linkBase = link.versionName
        .replace(/^v/i, '')
        .replace(/\s*\([^)]*\)/g, '')
        .trim();
      return linkBase === baseWanted;
    });
    if (parentheticalMatch) return parentheticalMatch.versionId;
  }

  return null;
}

/**
 * Download URL for a specific version.
 *
 * Bare numeric id rather than the `<slug>.<id>` form: the slug is decorative and
 * changes when an author renames a resource, at the cost of one transparent
 * redirect.
 */
export function downloadUrlFor(resourceId: number, versionId: string): string {
  return `https://www.spigotmc.org/resources/${resourceId}/download?version=${versionId}`;
}
