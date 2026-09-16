import type { Db } from '../../db/connection.js';
import { createPlugin, listPlugins, countPlugins, updatePlugin } from '../../repositories/plugins.js';
import type { PurchasedResource } from './scan-purchased-resources.js';

/**
 * Gắn mã resource cho plugin trong kho từ danh sách đã mua trên Spigot.
 *
 * Không có bước này, chủ bot phải tự tra mã từng plugin và dán vào dashboard —
 * việc tay mà tính năng tự động lẽ ra phải xoá bỏ.
 *
 * Ghép theo TÊN, và chỉ khi khớp chắc chắn. Tên trên Spigot dài và nhiều trang
 * trí ("Vulcan Anti-Cheat | Advanced Cheat Detection | 1.8-26.2 | Folia
 * Supported!") còn tên trong kho lấy từ descriptor của jar ("Vulcan"), nên so
 * sánh nguyên văn sẽ không bao giờ khớp.
 */

export type SyncOutcome = {
  /** Plugin có sẵn trong kho, vừa được gắn mã. */
  linked: { pluginName: string; resourceId: number }[];
  /** Plugin mới tạo từ danh sách đã mua, chưa có jar nào. */
  created: { pluginName: string; resourceId: number }[];
  /** Đã có mã từ trước, không đụng tới. */
  alreadyLinked: number;
  /**
   * Mua trên Spigot nhưng không ghép được với plugin nào trong kho, và cũng
   * không tự tạo được. Báo ra để chủ bot xử lý thay vì im lặng bỏ qua.
   */
  unmatched: { title: string; resourceId: number }[];
};

const VERSION_PREFIX =
  /^\s*(?:v\s*)?\d+\.\d+(?:\.[\dxX]+)?\+?(?:\s*(?:-|–|—|->|to|\/)\s*(?:v\s*)?\d+\.\d+(?:\.[\dxX]+)?\+?)?(?:\s*[,/&]\s*(?:v\s*)?\d+\.\d+(?:\.[\dxX]+)?\+?)*(?:\s+(?:tested|supported|support|ready|compatible|native|only|servers?|builds?))?\b/iu;
const BRACKET_PREFIX = /^\s*(?:[[(【][^\])】]*[\])】]\s*)+/u;
const SYMBOL_PREFIX =
  /^[\s\p{Extended_Pictographic}\p{So}\p{Sm}\p{Sk}\uFE00-\uFE0F\u200D\u200B|–—\-:»«•✦★►▶▲◆■~/\\]+/u;

/**
 * Chuẩn hoá tên để so sánh.
 * Dùng displayFrom để bóc tên thực tế, rồi bỏ mọi ký tự không phải chữ/số
 * để "AdvancedJobs", "Advanced Jobs" và "advanced-jobs" cùng về một dạng.
 */
export function normalizeName(raw: string): string {
  const clean = displayFrom(raw);
  return clean
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

/** Tên rút gọn dùng làm slug khi phải tạo plugin mới. */
function slugFrom(raw: string): string {
  const clean = displayFrom(raw);
  const slug = clean
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'plugin';
}

/**
 * Tên hiển thị gọn, lấy từ tiêu đề quảng cáo của Spigot.
 *
 * Tiêu đề trên Spigot thường mang khoảng phiên bản đứng đầu (`[1.8 - 26.2]` hoặc `1.17 - 26.2`),
 * emoji trang trí (⭐ ⭕ ✅), và một chuỗi khẩu hiệu tiếp thị.
 *
 * Cắt theo thứ tự:
 * 1. Bóc các tiền tố trong ngoặc, khoảng phiên bản không ngoặc, và emoji/biểu tượng dẫn đầu.
 * 2. Cắt tại emoji/biểu tượng tiếp theo (ranh giới giữa tên plugin và khẩu hiệu).
 * 3. Cắt tại dấu phân cách văn bản (pipe, dash với khoảng trắng).
 */
export function displayFrom(raw: string): string {
  const stripLead = (s: string): string => {
    let prev = '';
    let curr = s;
    while (curr !== prev) {
      prev = curr;
      curr = curr.replace(BRACKET_PREFIX, '');
      curr = curr.replace(VERSION_PREFIX, '');
      curr = curr.replace(SYMBOL_PREFIX, '');
      curr = curr.trim();
    }
    return curr;
  };

  let head = stripLead(raw);
  if (!head) {
    return raw.replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // Cắt TẠI emoji hoặc symbol phân cách tiếp theo
  head = head.split(/[\p{Extended_Pictographic}\p{So}\uFE00-\uFE0F\u200D]/u)[0] ?? head;
  // Cắt tại dấu phân cách văn bản (pipes, arrows, bullets — NOT dashes: tên plugin hợp lệ
  // như "mcMMO - Original Author Returns" dùng dash làm phần tên, không phải phân cách).
  head = head.split(/\s+[|–—»«•✦★~]\s+|[|–—]/)[0] ?? head;

  // Bỏ dấu câu lửng còn sót
  const trimmed = head.replace(/[\s\-–—:,.!|»«•✦★~]+$/, '').replace(/\s+/g, ' ').trim();

  return (trimmed || raw.replace(/\s+/g, ' ').trim()).slice(0, 60);
}

export type SyncOptions = {
  /**
   * Tạo plugin mới cho những mã chưa có trong kho.
   *
   * Mặc định TẮT. Bật lên thì mỗi plugin đã mua đều được theo dõi ngay, kể cả
   * khi chưa có jar — nhưng cũng tạo ra các mục rỗng trong kho, nên để chủ bot
   * chọn.
   */
  createMissing?: boolean;
};

/**
 * Ghép danh sách đã mua với kho.
 *
 * Không bao giờ ghi đè mã đã có: chủ bot có thể đã sửa tay, và một lần ghép sai
 * sẽ khiến bot theo dõi nhầm plugin mà không ai nhận ra.
 */
export function syncPurchasedResources(
  db: Db,
  purchased: PurchasedResource[],
  options: SyncOptions = {},
): SyncOutcome {
  const outcome: SyncOutcome = { linked: [], created: [], alreadyLinked: 0, unmatched: [] };

  const total = countPlugins(db);
  const plugins = listPlugins(db, total, 0);

  // Mã đã dùng ở bất kỳ plugin nào, để không gắn cùng một mã cho hai plugin.
  const takenIds = new Set(plugins.map((p) => p.resourceId).filter((id): id is number => id !== null));

  // Chỉ số theo tên chuẩn hoá. Tên trùng nhau bị loại khỏi chỉ số: ghép mò giữa
  // hai plugin cùng tên tệ hơn là báo cho chủ bot biết.
  const byName = new Map<string, { id: number; displayName: string; hasId: boolean } | 'ambiguous'>();
  for (const plugin of plugins) {
    for (const candidate of [plugin.displayName, plugin.descriptorName]) {
      const key = normalizeName(candidate);
      if (!key) continue;
      const existing = byName.get(key);
      if (existing && existing !== 'ambiguous' && existing.id !== plugin.id) {
        byName.set(key, 'ambiguous');
        continue;
      }
      if (!existing) {
        byName.set(key, {
          id: plugin.id,
          displayName: plugin.displayName,
          hasId: plugin.resourceId !== null,
        });
      }
    }
  }

  for (const item of purchased) {
    if (takenIds.has(item.resourceId)) {
      outcome.alreadyLinked++;
      continue;
    }

    const key = normalizeName(item.title);
    const match = key ? byName.get(key) : undefined;

    if (match && match !== 'ambiguous') {
      // Never repoint a plugin that already has an id. The owner may have set it
      // by hand, and a silent overwrite would make the bot track the wrong
      // upstream plugin with nothing in the log to explain it.
      if (match.hasId) {
        outcome.alreadyLinked++;
        continue;
      }
      const patch: { resourceId: number; externalLink?: string } = { resourceId: item.resourceId };
      const current = plugins.find((p) => p.id === match.id);
      if (!current?.externalLink || current.externalLink.trim() === '') {
        patch.externalLink = `https://www.spigotmc.org/resources/${item.resourceId}/`;
      }
      updatePlugin(db, match.id, patch);
      takenIds.add(item.resourceId);
      outcome.linked.push({ pluginName: match.displayName, resourceId: item.resourceId });
      continue;
    }

    if (options.createMissing && item.title) {
      const displayName = displayFrom(item.title);
      // Slug phải là duy nhất; thêm mã resource vào khi trùng.
      let slug = slugFrom(item.title);
      if (plugins.some((p) => p.slug === slug)) slug = `${slug}-${item.resourceId}`;
      const spigotLink = `https://www.spigotmc.org/resources/${item.resourceId}/`;
      const created = createPlugin(db, {
        slug,
        displayName,
        // Chưa có jar nên chưa biết tên descriptor thật; dùng tên hiển thị làm
        // tạm, ingest sẽ sửa lại khi jar đầu tiên được nạp.
        descriptorName: displayName,
        platform: 'spigot',
        externalLink: spigotLink,
      });
      updatePlugin(db, created.id, { resourceId: item.resourceId, externalLink: spigotLink });
      takenIds.add(item.resourceId);
      outcome.created.push({ pluginName: displayName, resourceId: item.resourceId });
      continue;
    }

    outcome.unmatched.push({ title: item.title, resourceId: item.resourceId });
  }

  return outcome;
}

/** Dòng log cho một lần ghép, hoặc rỗng khi không có gì đáng nói. */
export function formatSyncOutcome(outcome: SyncOutcome): string[] {
  const lines: string[] = [];
  for (const item of outcome.linked) {
    lines.push(`🔗 ${item.pluginName} — đã gắn mã resource ${item.resourceId} từ danh sách đã mua`);
  }
  for (const item of outcome.created) {
    lines.push(`➕ ${item.pluginName} — thêm vào kho từ danh sách đã mua (mã ${item.resourceId})`);
  }
  if (outcome.unmatched.length > 0) {
    const names = outcome.unmatched.map((u) => `${u.title || '(không tên)'} [${u.resourceId}]`).join(', ');
    lines.push(`❓ Đã mua nhưng chưa có trong kho: ${names}`);
  }
  return lines;
}
