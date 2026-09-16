import Database from 'better-sqlite3';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { fileSource, ingestJarBatch, type IngestContext } from '../src/services/ingest/ingest-jar-batch.js';
import { listAliases } from '../src/repositories/plugins.js';
import { listVersionsByPlugin } from '../src/repositories/versions.js';
import { shaToRelPath } from '../src/services/vault/content-addressed-paths.js';
import { text, writeCorruptJar, writeJar } from './helpers/jar-fixture-builder.js';

function yml(name: string, version: string): Buffer {
  return text(`name: ${name}\nversion: ${version}\nmain: a.B\n`);
}

describe('ingestJarBatch', () => {
  let ctx: IngestContext;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-ingest-'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db);
    ctx = { db, vaultDir: join(root, 'vault'), tmpDir: join(root, 'tmp') };
  });

  afterEach(async () => {
    ctx.db.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates a plugin and version for a new jar', async () => {
    const jar = writeJar('new-plugin.jar', [{ name: 'plugin.yml', data: yml('MythicMobs', '5.6.2') }]);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'MythicMobs-5.6.2.jar')]);

    expect(result).toMatchObject({
      status: 'added',
      pluginName: 'MythicMobs',
      version: '5.6.2',
      createdPlugin: true,
    });
  });

  it('stores the blob content-addressed, with no plugin name in the path', async () => {
    const jar = writeJar('addressed.jar', [{ name: 'plugin.yml', data: yml('PathTest', '1.0.0') }]);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'PathTest.jar')]);
    expect(result?.status).toBe('added');

    const row = ctx.db.prepare('SELECT sha256, rel_path FROM versions').get() as { sha256: string; rel_path: string };
    expect(row.rel_path).toBe(shaToRelPath(row.sha256));
    expect(row.rel_path).not.toMatch(/pathtest/i);
    expect(existsSync(join(ctx.vaultDir, row.rel_path))).toBe(true);
  });

  it('attaches a second version to the existing plugin rather than creating another', async () => {
    const v1 = writeJar('multi-v1.jar', [{ name: 'plugin.yml', data: yml('MultiVer', '1.0.0') }]);
    const v2 = writeJar('multi-v2.jar', [{ name: 'plugin.yml', data: yml('MultiVer', '1.1.0') }]);

    const results = await ingestJarBatch(ctx, [fileSource(v1, 'v1.jar'), fileSource(v2, 'v2.jar')]);
    expect(results.map((r) => r.status)).toEqual(['added', 'added']);

    expect((ctx.db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);
    const pluginId = (ctx.db.prepare('SELECT id FROM plugins').get() as { id: number }).id;
    expect(listVersionsByPlugin(ctx.db, pluginId)).toHaveLength(2);
  });

  it('creates exactly one plugin when two files in one batch share a new name', async () => {
    // A per-file lookup-then-insert would race here and produce two plugins.
    const a = writeJar('same-a.jar', [{ name: 'plugin.yml', data: yml('SameName', '1.0.0') }]);
    const b = writeJar('same-b.jar', [{ name: 'plugin.yml', data: yml('SameName', '2.0.0') }]);

    await ingestJarBatch(ctx, [fileSource(a, 'a.jar'), fileSource(b, 'b.jar')]);
    expect((ctx.db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c).toBe(1);
  });

  it('skips a byte-identical re-upload and reports it as a duplicate', async () => {
    const jar = writeJar('dup.jar', [{ name: 'plugin.yml', data: yml('DupPlugin', '3.0.0') }]);

    const first = await ingestJarBatch(ctx, [fileSource(jar, 'dup.jar')]);
    expect(first[0]?.status).toBe('added');

    const second = await ingestJarBatch(ctx, [fileSource(jar, 'dup-renamed.jar')]);
    expect(second[0]).toMatchObject({ status: 'duplicate', existingPluginName: 'DupPlugin', existingVersion: '3.0.0' });

    expect((ctx.db.prepare('SELECT count(*) AS c FROM versions').get() as { c: number }).c).toBe(1);
  });

  it('parks an unreadable jar in the pending queue and keeps its temp file', async () => {
    const jar = writeCorruptJar('broken.jar');
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'broken.jar')]);

    expect(result).toMatchObject({ status: 'pending', reason: 'unreadable-zip' });

    const pending = ctx.db.prepare('SELECT tmp_path FROM pending_ingest').get() as { tmp_path: string };
    expect(existsSync(pending.tmp_path)).toBe(true);
  });

  it('lets the rest of a batch through when one file is broken', async () => {
    const good1 = writeJar('ok1.jar', [{ name: 'plugin.yml', data: yml('GoodOne', '1.0.0') }]);
    const bad = writeCorruptJar('bad.jar');
    const good2 = writeJar('ok2.jar', [{ name: 'plugin.yml', data: yml('GoodTwo', '1.0.0') }]);

    const results = await ingestJarBatch(ctx, [
      fileSource(good1, 'ok1.jar'),
      fileSource(bad, 'bad.jar'),
      fileSource(good2, 'ok2.jar'),
    ]);

    expect(results.map((r) => r.status)).toEqual(['added', 'pending', 'added']);
    expect((ctx.db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c).toBe(2);
  });

  it('records an alias when a jar matches an existing plugin under a different name', async () => {
    const original = writeJar('alias-base.jar', [{ name: 'plugin.yml', data: yml('CoreProtect', '21.2') }]);
    await ingestJarBatch(ctx, [fileSource(original, 'CoreProtect.jar')]);

    const pluginId = (ctx.db.prepare('SELECT id FROM plugins').get() as { id: number }).id;
    ctx.db.prepare('INSERT INTO plugin_aliases (plugin_id, alias) VALUES (?, ?)').run(pluginId, 'CoreProtectPro');

    const aliased = writeJar('alias-hit.jar', [{ name: 'plugin.yml', data: yml('CoreProtectPro', '22.0') }]);
    const [result] = await ingestJarBatch(ctx, [fileSource(aliased, 'CoreProtectPro.jar')]);

    expect(result).toMatchObject({ status: 'added', pluginName: 'CoreProtect', createdPlugin: false });
    expect(listAliases(ctx.db, pluginId)).toContain('CoreProtectPro');
  });

  it('does not let an alias substring-match an unrelated plugin', async () => {
    const base = writeJar('core.jar', [{ name: 'plugin.yml', data: yml('Core', '1.0.0') }]);
    await ingestJarBatch(ctx, [fileSource(base, 'Core.jar')]);

    const other = writeJar('coreprotect.jar', [{ name: 'plugin.yml', data: yml('CoreProtect', '21.0') }]);
    const [result] = await ingestJarBatch(ctx, [fileSource(other, 'CoreProtect.jar')]);

    expect(result).toMatchObject({ status: 'added', pluginName: 'CoreProtect', createdPlugin: true });
    expect((ctx.db.prepare('SELECT count(*) AS c FROM plugins').get() as { c: number }).c).toBe(2);
  });

  it('stores a placeholder version flagged rather than as truth', async () => {
    const jar = writeJar('placeholder.jar', [
      { name: 'plugin.yml', data: text('name: Unfiltered\nversion: ${project.version}\nmain: a.B\n') },
    ]);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'Unfiltered.jar')]);
    expect(result).toMatchObject({ status: 'added', versionFlag: 'unresolved-placeholder' });
  });

  it('keeps a numeric-looking version as text end to end', async () => {
    const jar = writeJar('numeric-e2e.jar', [{ name: 'plugin.yml', data: text('name: Num\nversion: 1.0\nmain: a.B\n') }]);
    await ingestJarBatch(ctx, [fileSource(jar, 'Num.jar')]);
    const row = ctx.db.prepare('SELECT version, typeof(version) AS ty FROM versions').get() as {
      version: string;
      ty: string;
    };
    expect(row).toEqual({ version: '1.0', ty: 'text' });
  });

  it('leaves no temp file behind after a successful batch', async () => {
    const jar = writeJar('cleanup.jar', [{ name: 'plugin.yml', data: yml('Cleanup', '1.0.0') }]);
    await ingestJarBatch(ctx, [fileSource(jar, 'Cleanup.jar')]);
    const leftovers = existsSync(ctx.tmpDir) ? readdirSync(ctx.tmpDir) : [];
    expect(leftovers).toEqual([]);
  });

  it('reports a failure without throwing when the source cannot be read', async () => {
    const [result] = await ingestJarBatch(ctx, [fileSource('/nonexistent/nope.jar', 'nope.jar')]);
    expect(result?.status).toBe('failed');
  });

  it('files a Velocity plugin with a null version', async () => {
    const jar = writeJar('velocity-ingest.jar', [
      { name: 'velocity-plugin.json', data: text(JSON.stringify({ id: 'proxy-thing', main: 'a.B' })) },
    ]);
    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'proxy-thing.jar')]);
    expect(result).toMatchObject({ status: 'added', pluginName: 'proxy-thing', version: null });

    const plugin = ctx.db.prepare('SELECT platform FROM plugins').get() as { platform: string };
    expect(plugin.platform).toBe('velocity');
  });

  it('leaves no temp file when the pending insert itself fails', async () => {
    // keepTemp must be set only after the row is committed, or a failed insert
    // strands a file with nothing referencing it.
    ctx.db.exec('DROP TABLE pending_ingest');
    const jar = writeCorruptJar('insert-will-fail.jar');

    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'insert-will-fail.jar')]);
    expect(result).toMatchObject({ status: 'failed', code: 'db-failed' });
    expect(existsSync(ctx.tmpDir) ? readdirSync(ctx.tmpDir) : []).toEqual([]);
  });

  it('allocates a distinct slug when a name already at the length limit collides', async () => {
    // Truncating without reserving room for the suffix yields candidates equal to
    // the taken slug, so no suffix ever frees it.
    const long = 'a'.repeat(64);
    const first = writeJar('long-1.jar', [{ name: 'plugin.yml', data: yml(`${long}One`, '1.0.0') }]);
    const second = writeJar('long-2.jar', [{ name: 'plugin.yml', data: yml(`${long}Two`, '1.0.0') }]);

    const results = await ingestJarBatch(ctx, [fileSource(first, '1.jar'), fileSource(second, '2.jar')]);
    expect(results.map((r) => r.status)).toEqual(['added', 'added']);

    const slugs = (ctx.db.prepare('SELECT slug FROM plugins').all() as { slug: string }[]).map((r) => r.slug);
    expect(new Set(slugs).size).toBe(2);
    expect(slugs.every((s) => s.length <= 64)).toBe(true);
  });

  it('reports a duplicate rather than a raw constraint error under concurrency', async () => {
    // The dedupe read and the insert straddle awaits, so two concurrent ingests
    // of identical content race; the loser must surface as a duplicate.
    const jar = writeJar('race.jar', [{ name: 'plugin.yml', data: yml('RacePlugin', '1.0.0') }]);

    const [a, b] = await Promise.all([
      ingestJarBatch(ctx, [fileSource(jar, 'race-a.jar')]),
      ingestJarBatch(ctx, [fileSource(jar, 'race-b.jar')]),
    ]);

    const statuses = [a[0]?.status, b[0]?.status].sort();
    expect(statuses).toEqual(['added', 'duplicate']);
    expect((ctx.db.prepare('SELECT count(*) AS c FROM versions').get() as { c: number }).c).toBe(1);
  });

  it('reuses one pending row when the same unreadable jar is uploaded twice', async () => {
    const jar = writeCorruptJar('retry-me.jar');

    await ingestJarBatch(ctx, [fileSource(jar, 'retry-me.jar')]);
    await ingestJarBatch(ctx, [fileSource(jar, 'retry-me.jar')]);

    expect((ctx.db.prepare('SELECT count(*) AS c FROM pending_ingest').get() as { c: number }).c).toBe(1);
    // One temp for the surviving row, none for the retry.
    expect(readdirSync(ctx.tmpDir)).toHaveLength(1);
  });

  it('restores a missing blob instead of discarding the re-upload as a duplicate', async () => {
    // A row without its blob would otherwise make the version permanently
    // undeliverable, and the re-upload is the only remaining copy.
    const jar = writeJar('heal.jar', [{ name: 'plugin.yml', data: yml('HealMe', '1.0.0') }]);
    await ingestJarBatch(ctx, [fileSource(jar, 'heal.jar')]);

    const row = ctx.db.prepare('SELECT rel_path FROM versions').get() as { rel_path: string };
    const blobPath = join(ctx.vaultDir, row.rel_path);
    rmSync(blobPath);
    expect(existsSync(blobPath)).toBe(false);

    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'heal.jar')]);
    expect(result?.status).toBe('duplicate');
    expect(existsSync(blobPath)).toBe(true);
  });

  it('leaves no blob in the vault when the version insert fails', async () => {
    // The row is registered before the blob moves, so prune — which only walks
    // rows — can never be left with an unreachable file.
    const jar = writeJar('no-orphan.jar', [{ name: 'plugin.yml', data: yml('NoOrphan', '1.0.0') }]);
    ctx.db.exec('DROP TABLE versions');

    const [result] = await ingestJarBatch(ctx, [fileSource(jar, 'no-orphan.jar')]);
    expect(result?.status).toBe('failed');

    const vaultFiles = existsSync(ctx.vaultDir) ? readdirSync(ctx.vaultDir, { recursive: true }) : [];
    expect(vaultFiles.filter((f) => String(f).length === 64)).toEqual([]);
  });
});
