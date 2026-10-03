export type ImportedCredential = {
  label: string;
  username: string;
  password: string;
  purchasedResources?: string[];
  importedStatus?: string;
  enabled?: boolean;
  exclusionReason?: string;
};

export type CredentialParse =
  | { ok: true; credentials: ImportedCredential[] }
  | { ok: false; reason: 'malformed'; detail: string };

const field = (line: string, name: string): string | null => {
  const match = line.match(new RegExp(`^\\s*.*?${name}:\\s*(.*?)\\s*$`, 'i'));
  return match?.[1] ?? null;
};

export function normalizeImportedResource(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

function optimize(credentials: ImportedCredential[]): ImportedCredential[] {
  const covered = new Set<string>();
  const result = [...credentials];

  // Later rows win. A:{Vault}, B:{Vault,Enchant} keeps B and skips A.
  for (let index = result.length - 1; index >= 0; index--) {
    const credential = result[index]!;
    const resources = [...new Set((credential.purchasedResources ?? []).map(normalizeImportedResource).filter(Boolean))];
    const reliable = credential.importedStatus?.toLowerCase() === 'success' && resources.length > 0;
    if (!reliable) {
      result[index] = { ...credential, enabled: true };
    } else if (resources.every((resource) => covered.has(resource))) {
      result[index] = {
        ...credential,
        enabled: false,
        exclusionReason: 'Toàn bộ resource đã được tài khoản phía sau bao phủ',
      };
    } else {
      result[index] = { ...credential, enabled: true };
      for (const resource of resources) covered.add(resource);
    }
  }
  return result;
}

const uniqueResources = (items: string[]): string[] =>
  [...new Set(items.map((item) => item.trim()).filter(Boolean))];

function expandLanguagePrefixedResource(item: string): string[] {
  const parts = item.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 && /^(?:DE|EN|FR|ES|IT|NL|PL|PT|RU)$/i.test(parts[0]!) ? parts.slice(1) : [item];
}

function reconcileReportedResources(items: string[], declaredCount: number | null): string[] {
  const resources = uniqueResources(items);
  if (declaredCount === null || resources.length === declaredCount) return resources;

  const pipeParts = items.flatMap((item) => item.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean));
  const withoutLanguagePrefixes = items.flatMap((item) => {
    const parts = item.split(/\s*\|\s*/).map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 && /^(?:DE|EN|FR|ES|IT|NL|PL|PT|RU)$/i.test(parts[0]!) ? parts.slice(1) : parts;
  });

  // Some exported reports flatten several plugin names onto one line. Only
  // split pipes when the result agrees with the authoritative Plugins found
  // count, so a normal title such as "Plugin | GUI | Database" stays intact.
  for (const candidate of [withoutLanguagePrefixes, pipeParts]) {
    const reconciled = uniqueResources(candidate);
    if (reconciled.length === declaredCount) return reconciled;
  }
  return resources;
}

function parseReport(text: string): CredentialParse {
  const credentials: ImportedCredential[] = [];
  let current: ImportedCredential | null = null;
  let readingResources = false;
  let declaredCount: number | null = null;

  const finish = (): CredentialParse | null => {
    if (!current) return null;
    if (current.username === '') return { ok: false, reason: 'malformed', detail: 'Có tài khoản thiếu User' };
    if (current.password === '') return { ok: false, reason: 'malformed', detail: `Tài khoản "${current.username}" thiếu Password` };
    const resources = reconcileReportedResources(current.purchasedResources ?? [], declaredCount);
    if (declaredCount !== null && declaredCount !== resources.length) {
      return {
        ok: false,
        reason: 'malformed',
        detail: `Tài khoản "${current.username}" khai ${declaredCount} plugin nhưng đọc được ${resources.length}`,
      };
    }
    credentials.push({ ...current, purchasedResources: resources });
    current = null;
    readingResources = false;
    declaredCount = null;
    return null;
  };

  for (const line of text.split(/\r?\n/)) {
    const username = field(line, 'User');
    if (username !== null) {
      const error = finish();
      if (error) return error;
      current = { label: username.trim(), username: username.trim(), password: '', purchasedResources: [] };
      continue;
    }
    if (!current) continue;
    const password = field(line, 'Password');
    const count = field(line, 'Plugins found');
    const status = field(line, 'Status');
    if (password !== null) current.password = password;
    else if (count !== null) {
      declaredCount = Number(count);
      if (!Number.isInteger(declaredCount) || declaredCount < 0) {
        return { ok: false, reason: 'malformed', detail: `Plugins found không hợp lệ ở "${current.username}"` };
      }
    } else if (status !== null) current.importedStatus = status.trim().toLowerCase();
    else if (field(line, 'Purchased resources') !== null) readingResources = true;
    else if (readingResources) {
      const value = line.trim();
      if (value !== '' && !/^-{5,}$/.test(value)) current.purchasedResources!.push(value);
    }
  }

  const error = finish();
  if (error) return error;
  if (credentials.length === 0) return { ok: false, reason: 'malformed', detail: 'Không tìm thấy dòng User nào' };
  const seen = new Set<string>();
  for (const credential of credentials) {
    const key = credential.label.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: 'malformed', detail: `User "${credential.label}" bị trùng` };
    seen.add(key);
  }
  return { ok: true, credentials: optimize(credentials) };
}

function parseJson(text: string): CredentialParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse can quote source text near the error, including a password.
    return { ok: false, reason: 'malformed', detail: 'JSON không hợp lệ' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'malformed', detail: 'Phải là một mảng tài khoản' };
  const credentials: ImportedCredential[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, reason: 'malformed', detail: `Phần tử ${index} không phải object` };
    const raw = entry as Record<string, unknown>;
    const username = typeof raw.username === 'string' ? raw.username.trim() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : username;
    if (username === '') return { ok: false, reason: 'malformed', detail: `Tài khoản ${index + 1} thiếu username` };
    if (password === '') return { ok: false, reason: 'malformed', detail: `Tài khoản "${label}" thiếu password` };
    const key = label.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: 'malformed', detail: `Tên gợi nhớ "${label}" bị trùng` };
    seen.add(key);
    const resources = Array.isArray(raw.purchasedResources)
      ? uniqueResources(raw.purchasedResources
          .filter((item): item is string => typeof item === 'string')
          .flatMap(expandLanguagePrefixedResource))
      : undefined;
    credentials.push({
      label, username, password,
      ...(resources ? { purchasedResources: resources } : {}),
      ...(typeof raw.importedStatus === 'string' ? { importedStatus: raw.importedStatus } : {}),
    });
  }
  if (credentials.length === 0) return { ok: false, reason: 'malformed', detail: 'Không có tài khoản nào' };

  const optimized = optimize(credentials).map((credential, index) => {
    // Preserve the old credential-file shape when JSON only contains login
    // fields. Runtime treats undefined as enabled; adding `enabled: true` here
    // would unnecessarily rewrite every existing file on its next save.
    const original = credentials[index]!;
    if (original.importedStatus === undefined && original.purchasedResources === undefined) {
      const { enabled: _enabled, exclusionReason: _reason, ...loginOnly } = credential;
      return loginOnly;
    }
    return credential;
  });
  return { ok: true, credentials: optimized };
}

function parsePlain(text: string): CredentialParse {
  const credentials: ImportedCredential[] = [];
  const seen = new Set<string>();
  for (const [lineNo, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) return { ok: false, reason: 'malformed', detail: `Dòng ${lineNo + 1}: thiếu cột` };
    if (parts.length > 3) return { ok: false, reason: 'malformed', detail: `Dòng ${lineNo + 1}: mật khẩu có dấu cách thì dùng JSON hoặc format User/Password` };
    const [a, b, c] = parts as [string, string, string?];
    const credential = c === undefined ? { label: a, username: a, password: b } : { label: a, username: b, password: c };
    const key = credential.label.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: 'malformed', detail: `Tên gợi nhớ "${credential.label}" bị trùng` };
    seen.add(key);
    credentials.push(credential);
  }
  return credentials.length > 0
    ? { ok: true, credentials }
    : { ok: false, reason: 'malformed', detail: 'Không có tài khoản nào' };
}

export function parseSpigotCredentialText(raw: string): CredentialParse {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (text === '') return { ok: false, reason: 'malformed', detail: 'Tệp rỗng' };
  if (text.startsWith('[')) return parseJson(text);
  return /^\s*.*?User:/im.test(text) ? parseReport(text) : parsePlain(text);
}
