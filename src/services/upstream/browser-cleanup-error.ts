export function isBenignBrowserCleanupError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const stack = error.stack ?? '';
  return error.message.includes("Cannot read properties of null (reading 'forEach')") && stack.includes('tree-kill');
}
