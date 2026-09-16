import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  addStaff,
  findStaffById,
  isUserAuthorizedStaff,
  listStaff,
  removeStaff,
} from '../src/repositories/dashboard-staff.js';
import {
  createSessionCookie,
  verifySessionCookie,
} from '../src/http/auth/session-cookie.js';

describe('dashboard-staff repository & session auth', () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'staff-test-'));
    db = new Database(join(tmp, 'db.sqlite'));
    migrate(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it('adds, lists, finds, and removes staff members', () => {
    expect(listStaff(db)).toEqual([]);
    expect(isUserAuthorizedStaff(db, '123456789012345678')).toBe(false);

    const added = addStaff(db, {
      discordUserId: '123456789012345678',
      username: 'johndoe',
      displayName: 'John Doe',
      avatar: 'https://cdn.discordapp.com/avatars/123/abc.png',
      addedBy: '958254424231378964',
    });

    expect(added.discordUserId).toBe('123456789012345678');
    expect(added.username).toBe('johndoe');
    expect(added.displayName).toBe('John Doe');

    // list
    const list = listStaff(db);
    expect(list.length).toBe(1);
    expect(list[0].discordUserId).toBe('123456789012345678');

    // find
    const found = findStaffById(db, '123456789012345678');
    expect(found).not.toBeNull();
    expect(found?.displayName).toBe('John Doe');

    // is authorized
    expect(isUserAuthorizedStaff(db, '123456789012345678')).toBe(true);

    // remove
    const removed = removeStaff(db, '123456789012345678');
    expect(removed).toBe(true);
    expect(listStaff(db)).toEqual([]);
    expect(isUserAuthorizedStaff(db, '123456789012345678')).toBe(false);
  });

  it('supports session cookies with owner & staff roles', () => {
    const secret = 'test-secret-at-least-32-chars-long-12345';

    // Owner session
    const ownerCookie = createSessionCookie(
      secret,
      3600,
      {
        userId: '958254424231378964',
        role: 'owner',
        username: 'fin12n',
        displayName: 'Fin',
        avatar: null,
        authMethod: 'discord',
      },
    );

    const verifiedOwner = verifySessionCookie(secret, ownerCookie.value);
    expect(verifiedOwner).not.toBeNull();
    expect(verifiedOwner?.role).toBe('owner');
    expect(verifiedOwner?.userId).toBe('958254424231378964');
    expect(verifiedOwner?.authMethod).toBe('discord');

    // Staff session
    const staffCookie = createSessionCookie(
      secret,
      3600,
      {
        userId: '111222333444555666',
        role: 'staff',
        username: 'staffmember',
        displayName: 'Moderator',
        avatar: 'https://cdn.discordapp.com/avatars/111/xyz.png',
        authMethod: 'discord',
      },
    );

    const verifiedStaff = verifySessionCookie(secret, staffCookie.value);
    expect(verifiedStaff).not.toBeNull();
    expect(verifiedStaff?.role).toBe('staff');
    expect(verifiedStaff?.displayName).toBe('Moderator');

    // Password session backward compatibility
    const passwordCookie = createSessionCookie(
      secret,
      3600,
      {
        role: 'owner',
        authMethod: 'password',
        displayName: 'Chủ sở hữu',
      },
    );

    const verifiedPassword = verifySessionCookie(secret, passwordCookie.value);
    expect(verifiedPassword).not.toBeNull();
    expect(verifiedPassword?.role).toBe('owner');
    expect(verifiedPassword?.authMethod).toBe('password');
  });
});
