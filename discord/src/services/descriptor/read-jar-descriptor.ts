import StreamZip from 'node-stream-zip';
import type { Readable } from 'node:stream';
import type { DescriptorResult } from '../../domain/ingest.js';
import type { DescriptorKind } from '../../domain/plugin.js';
import { parseVelocityDescriptor } from './parse-velocity-descriptor.js';
import { parseYamlDescriptor } from './parse-yaml-descriptor.js';

/**
 * Probe order is load-bearing, not cosmetic.
 *
 * Paper's PluginFileType.guessType() iterates [PAPER, SPIGOT] and returns the
 * FIRST match, never reading the other. A jar carrying both descriptors
 * legitimately holds different name/version in each — that is the whole point of
 * the feature — so a naive `plugin.yml || paper-plugin.yml` fallback reports the
 * wrong answer for exactly the jars the feature exists for.
 *
 * Velocity is probed first because its JSON format is unambiguous, and bungee.yml
 * ahead of plugin.yml because BungeeCord's own loader checks it first.
 */
const PROBES: { entry: string; kind: DescriptorKind; format: 'yaml' | 'json' }[] = [
  { entry: 'velocity-plugin.json', kind: 'velocity', format: 'json' },
  { entry: 'paper-plugin.yml', kind: 'paper', format: 'yaml' },
  { entry: 'bungee.yml', kind: 'bungee', format: 'yaml' },
  { entry: 'plugin.yml', kind: 'spigot', format: 'yaml' },
];

/** Non-plugin archives that regularly land in a plugins folder by mistake. */
const NOT_A_PLUGIN_MARKERS: { entry: string; what: string }[] = [
  { entry: 'META-INF/versions.list', what: 'server jar' },
  { entry: 'fabric.mod.json', what: 'Fabric mod' },
  { entry: 'META-INF/mods.toml', what: 'Forge mod' },
  { entry: 'META-INF/neoforge.mods.toml', what: 'NeoForge mod' },
];

/**
 * A descriptor larger than this is malformed or hostile.
 *
 * The cap is enforced against bytes actually inflated, not against the size the
 * archive declares. Central-directory sizes are attacker-controlled, and
 * node-stream-zip skips its verifying stream entirely when general-purpose flag
 * bit 3 is set, so a jar can declare 100 bytes and inflate to gigabytes.
 */
const MAX_DESCRIPTOR_BYTES = 256 * 1024;

/** Version is mandatory for the Bukkit family, optional elsewhere. */
const VERSION_REQUIRED: ReadonlySet<DescriptorKind> = new Set<DescriptorKind>(['paper', 'spigot']);

/**
 * Reads an entry, aborting once more than `limit` bytes have been inflated.
 *
 * Returns null when the limit is exceeded so the caller can report a size
 * rejection rather than allocating whatever the archive wanted.
 */
async function readEntryCapped(
  zip: StreamZip.StreamZipAsync,
  entryName: string,
  limit: number,
): Promise<Buffer | null> {
  const stream = (await zip.stream(entryName)) as unknown as Readable;
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > limit) return null;
      chunks.push(chunk);
    }
  } finally {
    // Abandoning the iteration early leaves the inflate stream open; destroying
    // it releases the underlying handle.
    stream.destroy();
  }

  return Buffer.concat(chunks);
}

/**
 * Reads plugin identity from a jar without inflating the whole archive.
 *
 * Returns a union rather than throwing: one malformed jar in a twenty-file batch
 * must not stop the other nineteen.
 */
export async function readJarDescriptor(jarPath: string): Promise<DescriptorResult> {
  let zip: StreamZip.StreamZipAsync | undefined;
  try {
    zip = new StreamZip.async({ file: jarPath, storeEntries: true });
    const entries = await zip.entries();

    for (const probe of PROBES) {
      const entry = entries[probe.entry];
      if (!entry) continue;

      const raw = await readEntryCapped(zip, probe.entry, MAX_DESCRIPTOR_BYTES);
      if (raw === null) {
        return {
          ok: false,
          reason: 'too-large',
          detail: `${probe.entry} vượt quá ${MAX_DESCRIPTOR_BYTES} bytes khi giải nén`,
        };
      }

      const text = raw.toString('utf8');
      const parsed = probe.format === 'json' ? parseVelocityDescriptor(text) : parseYamlDescriptor(text);

      if (!parsed) {
        return { ok: false, reason: 'invalid-yaml', detail: `${probe.entry} không đọc được` };
      }
      if (!parsed.name) {
        return { ok: false, reason: 'missing-fields', detail: `${probe.entry} thiếu trường name` };
      }
      if (parsed.version === null && VERSION_REQUIRED.has(probe.kind)) {
        return { ok: false, reason: 'missing-fields', detail: `${probe.entry} thiếu trường version` };
      }

      return {
        ok: true,
        kind: probe.kind,
        name: parsed.name,
        version: parsed.version,
        rawVersion: parsed.rawVersion,
        descriptorEntry: probe.entry,
        versionFlag: parsed.versionFlag,
      };
    }

    for (const marker of NOT_A_PLUGIN_MARKERS) {
      if (entries[marker.entry]) {
        return { ok: false, reason: 'not-a-plugin', detail: `đây là ${marker.what}, không phải plugin` };
      }
    }

    return { ok: false, reason: 'no-descriptor', detail: 'không tìm thấy descriptor nào' };
  } catch (err) {
    return { ok: false, reason: 'unreadable-zip', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    // A leaked handle locks the jar on Windows, breaking any later move or
    // delete pass over the same file.
    await zip?.close().catch(() => undefined);
  }
}
