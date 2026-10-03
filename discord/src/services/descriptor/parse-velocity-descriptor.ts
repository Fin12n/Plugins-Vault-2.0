import type { ParsedDescriptor } from './parse-yaml-descriptor.js';

/**
 * Parses velocity-plugin.json, generated at compile time from Velocity's
 * @Plugin annotation.
 *
 * Velocity differs from the Bukkit family in two ways that matter here: `id` is
 * the required identifier and `name` is genuinely often absent (an unset
 * annotation value is omitted from the JSON entirely), and `version` is
 * nullable rather than required.
 */
export function parseVelocityDescriptor(text: string): ParsedDescriptor | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  const id = typeof doc.id === 'string' ? doc.id.trim() : '';
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  const version = typeof doc.version === 'string' ? doc.version.trim() : '';

  // id is the only guaranteed identifier; name is a display nicety.
  const resolved = name || id;
  if (!resolved) return null;

  return {
    name: resolved,
    version: version || null,
    rawVersion: version,
    versionFlag: 'ok',
  };
}
