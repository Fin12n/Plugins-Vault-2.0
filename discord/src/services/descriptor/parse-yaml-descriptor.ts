import YAML from 'yaml';
import type { VersionFlag } from '../../domain/plugin.js';

/**
 * Fields a descriptor parser extracts. Version is nullable because it is
 * required for Bukkit/Paper but optional for Velocity and unvalidated for
 * BungeeCord.
 */
export type ParsedDescriptor = {
  name: string | null;
  version: string | null;
  rawVersion: string;
  versionFlag: VersionFlag;
};

/**
 * Matches an unresolved build placeholder: Maven's `${project.version}` when
 * resource filtering was never enabled, or Gradle's `@version@` form. Bukkit does
 * no validation on version, so such jars ship and load normally.
 */
const PLACEHOLDER = /\$\{[^}]*\}|@[\w.]+@/;

/** Strips a trailing `#` comment, then surrounding quotes — order matters. */
function cleanScalar(raw: string): string {
  // Comment first: stripping quotes from `"2.0" # note` would otherwise leave
  // `2.0" # note` and then mangle into `2.0"`.
  const withoutComment = raw.replace(/\s+#.*$/, '').trim();
  const quoted = /^(['"])(.*)\1$/.exec(withoutComment);
  return quoted?.[2] ?? withoutComment;
}

/**
 * Reads a TOP-LEVEL scalar by line anchor, for use only when YAML parsing threw.
 *
 * The key must start at column 0. Allowing leading whitespace would match nested
 * keys, and `version:` appears routinely inside `libraries:` and `depend:`
 * blocks — a bungee.yml declaring a Guava dependency would otherwise report the
 * plugin's version as Guava's.
 */
function regexTopLevelScalar(text: string, key: string): string | null {
  const pattern = new RegExp(`^${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm');
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  const value = cleanScalar(match[1]);
  return value === '' ? null : value;
}

/**
 * Parses a YAML plugin descriptor (plugin.yml, paper-plugin.yml, bungee.yml).
 *
 * The failsafe schema is mandatory, not stylistic: the default schema parses
 * `version: 1.0` into the number 1 and `api-version: 1.20` into 1.2, so a
 * plugin's real version is silently destroyed. Failsafe types every scalar as a
 * string, preserving source fidelity exactly.
 *
 * `uniqueKeys: false` matches SnakeYAML's last-wins behavior rather than
 * throwing, which is what the server itself does.
 */
export function parseYamlDescriptor(text: string): ParsedDescriptor {
  let name: string | null = null;
  let rawVersion: string | null = null;
  let flag: VersionFlag = 'ok';

  try {
    const doc = YAML.parse(text, { schema: 'failsafe', uniqueKeys: false }) as Record<string, unknown> | null;
    if (doc && typeof doc === 'object') {
      name = typeof doc.name === 'string' ? doc.name.trim() || null : null;
      rawVersion = typeof doc.version === 'string' ? doc.version.trim() || null : null;
    }
  } catch {
    // Tab indentation is a hard throw and common in hand-edited descriptors.
    // Only in this branch is a regex fallback justified: if the document parsed,
    // an absent field is genuinely absent (legitimately so for bungee.yml, where
    // version is not required) and guessing would invent data.
    flag = 'regex-recovered';
    name = regexTopLevelScalar(text, 'name');
    rawVersion = regexTopLevelScalar(text, 'version');
    // Nothing recoverable means the fallback added no information.
    if (name === null && rawVersion === null) flag = 'ok';
  }

  const version = rawVersion;
  const versionFlag: VersionFlag =
    version !== null && PLACEHOLDER.test(version) ? 'unresolved-placeholder' : flag;

  return {
    name,
    version,
    rawVersion: rawVersion ?? '',
    versionFlag,
  };
}
