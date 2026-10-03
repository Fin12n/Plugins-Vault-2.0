import { describe, expect, it } from 'vitest';
import { isBenignBrowserCleanupError } from '../src/services/upstream/browser-cleanup-error.js';

describe('process error classification', () => {
  it('recognizes the tree-kill cleanup defect seen after Chrome closes', () => {
    const error = new TypeError("Cannot read properties of null (reading 'forEach')");
    error.stack = `${error.name}: ${error.message}\n    at ChildProcess.onClose (/app/node_modules/tree-kill/index.js:108:30)`;

    expect(isBenignBrowserCleanupError(error)).toBe(true);
  });

  it('does not suppress unrelated uncaught exceptions', () => {
    expect(isBenignBrowserCleanupError(new TypeError('database is closed'))).toBe(false);
    expect(isBenignBrowserCleanupError(new Error("Cannot read properties of null (reading 'forEach')"))).toBe(false);
  });
});
