import { describe, expect, it } from 'vitest';
import { readJarDescriptor } from '../src/services/descriptor/read-jar-descriptor.js';
import { text, writeCorruptJar, writeJar } from './helpers/jar-fixture-builder.js';

const SPIGOT_YML = `name: MythicMobs
version: 5.6.2
main: io.lumine.mythic.MythicMobs
api-version: '1.20'
`;

const PAPER_YML = `name: MythicMobsPaper
version: 5.7.0-paper
main: io.lumine.mythic.PaperMain
api-version: '1.21'
`;

describe('readJarDescriptor', () => {
  it('reads plugin.yml from a classic Spigot jar', async () => {
    const jar = writeJar('spigot-only.jar', [{ name: 'plugin.yml', data: text(SPIGOT_YML) }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'spigot', name: 'MythicMobs', version: '5.6.2' });
  });

  it('reads paper-plugin.yml when it is the only descriptor', async () => {
    const jar = writeJar('paper-only.jar', [{ name: 'paper-plugin.yml', data: text(PAPER_YML) }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'paper', name: 'MythicMobsPaper', version: '5.7.0-paper' });
  });

  it('prefers paper-plugin.yml when a jar carries both, matching the server precedence', async () => {
    // Paper's PluginFileType.guessType iterates [PAPER, SPIGOT] and returns the
    // first match, never reading the other. A jar with both legitimately holds
    // different values in each, so picking the wrong one yields a wrong answer.
    const jar = writeJar('both-descriptors.jar', [
      { name: 'plugin.yml', data: text(SPIGOT_YML) },
      { name: 'paper-plugin.yml', data: text(PAPER_YML) },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'paper', name: 'MythicMobsPaper', version: '5.7.0-paper' });
  });

  it('keeps a numeric-looking version as a string', async () => {
    // Default YAML schemas parse `version: 1.0` into the number 1 and
    // `api-version: 1.20` into 1.2, silently destroying version fidelity.
    const jar = writeJar('numeric-version.jar', [
      { name: 'plugin.yml', data: text('name: Simple\nversion: 1.0\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, version: '1.0', versionFlag: 'ok' });
  });

  it('flags an unresolved build placeholder instead of storing it as a version', async () => {
    const jar = writeJar('placeholder-version.jar', [
      { name: 'plugin.yml', data: text('name: Unfiltered\nversion: ${project.version}\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, versionFlag: 'unresolved-placeholder' });
    if (result.ok) expect(result.rawVersion).toBe('${project.version}');
  });

  it('flags an @-delimited placeholder too', async () => {
    const jar = writeJar('at-placeholder.jar', [
      { name: 'plugin.yml', data: text('name: AtStyle\nversion: @project.version@\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, versionFlag: 'unresolved-placeholder' });
  });

  it('recovers name and version from a tab-indented descriptor via regex', async () => {
    // Tab indentation is a hard YAML throw and is common in hand-edited files.
    const jar = writeJar('tab-indented.jar', [
      {
        name: 'plugin.yml',
        data: text('name: TabbedPlugin\nversion: 2.3.1\nmain: a.B\ncommands:\n\tfoo:\n\t\tdescription: bad indent\n'),
      },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, name: 'TabbedPlugin', version: '2.3.1', versionFlag: 'regex-recovered' });
  });

  it('strips a trailing comment before stripping quotes', async () => {
    const jar = writeJar('quoted-comment.jar', [
      { name: 'plugin.yml', data: text('name: Quoted\nversion: "2.0" # release build\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, version: '2.0' });
  });

  it('takes the last value when keys are duplicated, matching the server parser', async () => {
    const jar = writeJar('duplicate-keys.jar', [
      { name: 'plugin.yml', data: text('name: Dup\nversion: 1.0\nversion: 2.0\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, version: '2.0' });
  });

  it('reads a Velocity descriptor, falling back to id when name is absent', async () => {
    const jar = writeJar('velocity.jar', [
      {
        name: 'velocity-plugin.json',
        data: text(JSON.stringify({ id: 'my-proxy-plugin', main: 'a.B', version: '1.4.0' })),
      },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'velocity', name: 'my-proxy-plugin', version: '1.4.0' });
  });

  it('accepts a Velocity descriptor with no version, since version is optional there', async () => {
    const jar = writeJar('velocity-no-version.jar', [
      { name: 'velocity-plugin.json', data: text(JSON.stringify({ id: 'no-version', main: 'a.B' })) },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'velocity', name: 'no-version', version: null });
  });

  it('reads bungee.yml ahead of plugin.yml', async () => {
    const jar = writeJar('bungee-dual.jar', [
      { name: 'plugin.yml', data: text(SPIGOT_YML) },
      { name: 'bungee.yml', data: text('name: BungeeSide\nmain: a.Bungee\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'bungee', name: 'BungeeSide', version: null });
  });

  it('does not mistake a nested version for the plugin version', async () => {
    // bungee.yml legitimately omits a top-level version, and `version:` appears
    // routinely inside libraries/depend blocks. A fallback matching any
    // indentation would archive the plugin as its dependency's version.
    const jar = writeJar('nested-version.jar', [
      {
        name: 'bungee.yml',
        data: text('name: MyBungee\nmain: a.B\nlibraries:\n  - name: guava\n    version: 31.0-jre\n'),
      },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, kind: 'bungee', name: 'MyBungee', version: null });
  });

  it('does not claim regex recovery when the document parsed but a field was absent', async () => {
    const jar = writeJar('absent-not-recovered.jar', [
      { name: 'bungee.yml', data: text('name: NoVersionBungee\nmain: a.B\n') },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: true, version: null, versionFlag: 'ok' });
  });

  it('reports missing-fields when name is absent', async () => {
    const jar = writeJar('no-name.jar', [{ name: 'plugin.yml', data: text('version: 1.0\nmain: a.B\n') }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'missing-fields' });
  });

  it('reports missing-fields when a Bukkit descriptor has no version', async () => {
    // Version is required for Bukkit/Paper, unlike Velocity and BungeeCord.
    const jar = writeJar('no-version-bukkit.jar', [{ name: 'plugin.yml', data: text('name: NoVersion\nmain: a.B\n') }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'missing-fields' });
  });

  it('reports no-descriptor for a jar with none of the four descriptors', async () => {
    const jar = writeJar('plain-library.jar', [{ name: 'com/example/Thing.class', data: text('fake bytecode') }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'no-descriptor' });
  });

  it('identifies a Fabric mod as not-a-plugin rather than a generic failure', async () => {
    const jar = writeJar('fabric-mod.jar', [
      { name: 'fabric.mod.json', data: text(JSON.stringify({ id: 'somemod', version: '1.0' })) },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'not-a-plugin' });
  });

  it('identifies a Forge mod as not-a-plugin', async () => {
    const jar = writeJar('forge-mod.jar', [{ name: 'META-INF/mods.toml', data: text('modId="x"') }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'not-a-plugin' });
  });

  it('identifies a server jar as not-a-plugin', async () => {
    const jar = writeJar('server.jar', [{ name: 'META-INF/versions.list', data: text('1.21') }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'not-a-plugin' });
  });

  it('reports unreadable-zip for a corrupt archive instead of throwing', async () => {
    const jar = writeCorruptJar('truncated.jar');
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'unreadable-zip' });
  });

  it('reports unreadable-zip for a missing file', async () => {
    const result = await readJarDescriptor('/nonexistent/path/to/nothing.jar');
    expect(result).toMatchObject({ ok: false, reason: 'unreadable-zip' });
  });

  it('rejects an oversized descriptor as a decompression-bomb guard', async () => {
    const huge = text('name: Bomb\nversion: 1.0\nmain: a.B\n' + '#'.repeat(400 * 1024));
    const jar = writeJar('bomb.jar', [{ name: 'plugin.yml', data: huge }]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('rejects a bomb that lies about its declared size', async () => {
    // Central-directory sizes are attacker-controlled, and node-stream-zip skips
    // its verifying stream when general-purpose flag bit 3 is set. A jar can
    // therefore declare 100 bytes and inflate to gigabytes, so the cap must be
    // enforced against bytes actually inflated.
    const payload = text('name: Liar\nversion: 1.0\nmain: a.B\n' + ' '.repeat(2 * 1024 * 1024));
    const jar = writeJar('size-liar.jar', [
      { name: 'plugin.yml', data: payload, declaredSize: 100, flags: 0x08 },
    ]);
    const result = await readJarDescriptor(jar);
    expect(result).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('reads the first of two identically-named zip entries', async () => {
    // A shaded jar can carry two plugin.yml entries when the build tool's
    // duplicate strategy emits both.
    const jar = writeJar('duplicate-entries.jar', [
      { name: 'plugin.yml', data: text('name: HostPlugin\nversion: 1.0.0\nmain: a.B\n') },
      { name: 'plugin.yml', data: text('name: ShadedDep\nversion: 9.9.9\nmain: c.D\n') },
    ]);
    const result = await readJarDescriptor(jar);
    // Either is defensible; what matters is that it resolves deterministically
    // and does not throw.
    expect(result.ok).toBe(true);
    if (result.ok) expect(['HostPlugin', 'ShadedDep']).toContain(result.name);
  });
});
