import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

/**
 * Minimal ZIP writer for test fixtures.
 *
 * Hand-rolled rather than pulled from a dependency because the tests need
 * archives a well-behaved library refuses to emit: duplicate entry names, and
 * entries whose declared size contradicts their real inflated length.
 */
/**
 * A zip entry. `declaredSize` and `flags` exist so tests can forge a
 * decompression bomb: setting flags bit 3 (0x08) makes zip readers skip CRC
 * verification, letting a declared size differ from the real inflated length.
 */
type Entry = { name: string; data: Buffer; declaredSize?: number; flags?: number };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

/** CRC-32, as required by the ZIP local and central headers. */
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export function buildZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const declaredSize = entry.declaredSize ?? entry.data.length;
    const flags = entry.flags ?? 0;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

let fixtureDir: string | undefined;

/** Writes a jar fixture to a temp dir and returns its path. */
export function writeJar(name: string, entries: Entry[]): string {
  fixtureDir ??= mkdtempSync(join(tmpdir(), 'vault-fixtures-'));
  const path = join(fixtureDir, name);
  writeFileSync(path, buildZip(entries));
  return path;
}

/** Writes a file that is not a valid zip at all. */
export function writeCorruptJar(name: string): string {
  fixtureDir ??= mkdtempSync(join(tmpdir(), 'vault-fixtures-'));
  const path = join(fixtureDir, name);
  writeFileSync(path, Buffer.from('this is definitely not a zip archive'));
  return path;
}

export function text(content: string): Buffer {
  return Buffer.from(content, 'utf8');
}
