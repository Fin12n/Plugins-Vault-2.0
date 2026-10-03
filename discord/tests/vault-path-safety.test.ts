import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeJoin, shaToRelPath, slugifyPluginName } from '../src/services/vault/content-addressed-paths.js';

describe('shaToRelPath', () => {
  it('splits a digest into a two-level path', () => {
    const sha = 'ab' + 'c'.repeat(62);
    expect(shaToRelPath(sha)).toBe(`ab/${sha}`);
  });

  it('rejects anything that is not a hex digest', () => {
    expect(() => shaToRelPath('../../etc/passwd')).toThrow();
    expect(() => shaToRelPath('ABC')).toThrow();
    expect(() => shaToRelPath('g'.repeat(64))).toThrow();
  });
});

describe('safeJoin', () => {
  const root = resolve('/srv/vault');

  it('joins a normal relative path', () => {
    expect(safeJoin(root, 'ab', 'file.jar')).toBe(resolve(root, 'ab/file.jar'));
  });

  it('blocks traversal out of the root', () => {
    expect(() => safeJoin(root, '../../etc/passwd')).toThrow(/thoát/);
    expect(() => safeJoin(root, 'a/../../../x')).toThrow(/thoát/);
  });

  it('blocks an absolute segment that would override the root', () => {
    // path.resolve silently discards everything before an absolute segment.
    expect(() => safeJoin(root, resolve('/etc/shadow'))).toThrow(/thoát/);
  });

  it('blocks a sibling directory whose name merely starts with the root', () => {
    // A bare startsWith(root) check would let this through.
    expect(() => safeJoin(root, `..${sep}vault-evil`, 'x')).toThrow(/thoát/);
  });

  it('allows the root itself', () => {
    expect(safeJoin(root)).toBe(root);
  });
});

describe('slugifyPluginName', () => {
  it('normalizes spaces and punctuation', () => {
    expect(slugifyPluginName('ItemsAdder Emotes, Mobs')).toBe('itemsadder-emotes-mobs');
  });

  it('strips diacritics', () => {
    expect(slugifyPluginName('Café Plugin')).toBe('cafe-plugin');
  });

  it('neutralizes traversal attempts', () => {
    expect(slugifyPluginName('../../etc/passwd')).toBe('etc-passwd');
    expect(slugifyPluginName('....//....//x')).toBe('x');
  });

  it('returns null when nothing usable remains', () => {
    for (const input of ['..', '.', '   ', '', '---']) {
      expect(slugifyPluginName(input), `for ${JSON.stringify(input)}`).toBeNull();
    }
  });

  it('truncates long names without leaving a trailing dash', () => {
    const slug = slugifyPluginName('a'.repeat(70) + ' tail');
    expect(slug).toHaveLength(64);
    expect(slug?.endsWith('-')).toBe(false);
  });

  it('drops a leading dot so no hidden file is produced', () => {
    expect(slugifyPluginName('.hidden')).toBe('hidden');
  });
});
