import Database from 'better-sqlite3';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPlugin } from '../src/repositories/plugins.js';
import { listPendingIngest } from '../src/repositories/pending-ingest.js';
import { deleteVersionAndCheckBlob, findVersionWithPlugin } from '../src/repositories/versions.js';
import {
  assignPendingIngest,
  discardPendingIngest,
  sweepOrphanedTemps,
} from '../src/services/ingest/assign-pending-ingest.js';
import { fileSource, ingestJarBatch, type IngestContext } from '../src/services/ingest/ingest-jar-batch.js';
import { text, writeCorruptJar, writeJar } from './helpers/jar-fixture-builder.js';

describe('pending ingest lifecycle', () => {
  let ctx: IngestContext;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-pending-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    ctx = { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') };
  });

  afterEach(async () => {
    ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function parkOne(): Promise<number> {
    const jar = writeCorruptJar(`park-${Math.random().toString(36).slice(2)}.jar`);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'mystery.jar')]);
    if (result?.status !== 'pending') throw new Error(`expected pending, got ${result?.status}`);
    return result.pendingId;
  }

  it('assigns a pending jar to a plugin and clears the queue', async () => {
    const pendingId = await parkOne();
    const plugin = createPlugin(ctx.db, {
      slug: 'manual-target',
      displayName: 'Manual Target',
      descriptorName: 'ManualTarget',
      platform: 'spigot',
    });

    const result = await assignPendingIngest(ctx, { pendingId, pluginId: plugin.id, version: '9.9.9' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.version).toMatchObject({ version: '9.9.9', versionFlag: 'manual', descriptorKind: 'manual' });
    expect(listPendingIngest(ctx.db)).toHaveLength(0);
    expect(existsSync(join(ctx.vaultDir, result.version.relPath))).toBe(true);
    // The temp was consumed by the move, not left behind.
    expect(readdirSync(ctx.tmpDir)).toEqual([]);
  });

  it('records an alias on assignment so the next upload self-files', async () => {
    const pendingId = await parkOne();
    const plugin = createPlugin(ctx.db, {
      slug: 'aliased',
      displayName: 'Aliased',
      descriptorName: 'Aliased',
      platform: 'spigot',
    });

    await assignPendingIngest(ctx, { pendingId, pluginId: plugin.id, version: '1.0.0', aliasName: 'WeirdName' });
    const aliases = ctx.db.prepare('SELECT alias FROM plugin_aliases WHERE plugin_id = ?').all(plugin.id) as {
      alias: string;
    }[];
    expect(aliases.map((a) => a.alias)).toContain('WeirdName');
  });

  it('refuses assignment to a plugin that does not exist', async () => {
    const pendingId = await parkOne();
    const result = await assignPendingIngest(ctx, { pendingId, pluginId: 9999, version: '1.0.0' });
    expect(result).toEqual({ ok: false, reason: 'plugin-not-found' });
    // The pending row survives so the owner can retry.
    expect(listPendingIngest(ctx.db)).toHaveLength(1);
  });

  it('discards a pending jar and its temp copy', async () => {
    const pendingId = await parkOne();
    expect(await discardPendingIngest(ctx.db, pendingId)).toBe(true);
    expect(listPendingIngest(ctx.db)).toHaveLength(0);
    expect(readdirSync(ctx.tmpDir)).toEqual([]);
  });

  it('sweeps crash leftovers while keeping temps a pending row still owns', async () => {
    const pendingId = await parkOne();
    const owned = listPendingIngest(ctx.db)[0]?.tmpPath;
    expect(owned).toBeDefined();

    // Simulate a temp stranded by a crash mid-ingest.
    const orphan = join(ctx.tmpDir, 'ingest-crashed-leftover.jar');
    writeFileSync(orphan, 'partial');

    const removed = await sweepOrphanedTemps(ctx.db, ctx.tmpDir);
    expect(removed).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(owned!)).toBe(true);
    expect(pendingId).toBeGreaterThan(0);
  });
});

describe('version repository helpers', () => {
  let ctx: IngestContext;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-repo-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    ctx = { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') };
  });

  afterEach(async () => {
    ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function ingestOne(name: string, version: string) {
    const jar = writeJar(`${name}-${version}.jar`, [
      { name: 'plugin.yml', data: text(`name: ${name}\nversion: ${version}\nmain: a.B\n`) },
    ]);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, `${name}.jar`)]);
    if (result?.status !== 'added') throw new Error(`expected added, got ${result?.status}`);
    return result;
  }

  it('returns the plugin fields the delivery flow needs alongside the version', async () => {
    const added = await ingestOne('Deliverable', '2.0.0');
    ctx.db.prepare('UPDATE plugins SET deposit_price = 20000 WHERE id = ?').run(added.pluginId);

    const joined = findVersionWithPlugin(ctx.db, added.versionId);
    expect(joined).toMatchObject({
      version: '2.0.0',
      pluginDisplayName: 'Deliverable',
      pluginSlug: 'deliverable',
      depositPrice: 20000,
    });
  });

  it('reports the blob as unreferenced once the last version using it is gone', async () => {
    const added = await ingestOne('Solo', '1.0.0');
    const outcome = deleteVersionAndCheckBlob(ctx.db, added.versionId);
    expect(outcome).toMatchObject({ deleted: true, blobUnreferenced: true });
  });

  it('cannot archive one blob under two versions, since sha256 is unique', async () => {
    // Worth pinning down: because sha256 is UNIQUE, a blob has at most one row,
    // so deleting that row always leaves the blob unreferenced. Any future
    // reference counting has to start by relaxing this constraint.
    const added = await ingestOne('Shared', '1.0.0');
    const row = ctx.db.prepare('SELECT sha256, rel_path, bytes FROM versions WHERE id = ?').get(added.versionId) as {
      sha256: string;
      rel_path: string;
      bytes: number;
    };

    const other = createPlugin(ctx.db, {
      slug: 'other-owner',
      displayName: 'Other Owner',
      descriptorName: 'OtherOwner',
      platform: 'spigot',
    });

    expect(() =>
      ctx.db
        .prepare(
          `INSERT INTO versions (plugin_id, version, sha256, rel_path, bytes, original_name,
                                 descriptor_kind, version_flag, uploaded_at)
           VALUES (?, '1.0.0', ?, ?, ?, 'copy.jar', 'manual', 'manual', 1)`,
        )
        .run(other.id, row.sha256, row.rel_path, row.bytes),
    ).toThrow(/UNIQUE/);
  });

  it('reports deleted: false for an id that does not exist', () => {
    expect(deleteVersionAndCheckBlob(ctx.db, 4242)).toMatchObject({ deleted: false, blobUnreferenced: false });
  });
});
