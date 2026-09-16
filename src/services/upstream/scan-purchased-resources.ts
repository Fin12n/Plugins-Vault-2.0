import type { BrowserPage, ChallengeSolver } from './download-via-browser.js';

/**
 * Đọc danh sách plugin đã mua từ trang resources/purchased của Spigot.
 *
 * Đây là thứ giúp tính năng thật sự tự động: không có nó, chủ bot phải tự tìm và
 * dán mã resource cho từng plugin — đúng loại việc tay mà tự động hoá lẽ ra phải
 * xoá bỏ.
 *
 * Trang này chỉ mở được sau khi đăng nhập bằng trình duyệt thật: gọi thẳng bằng
 * fetch nhận 403 từ Cloudflare. Đã đo trên site thật.
 */

/**
 * Trích mã resource từ href.
 *
 * KHÔNG bắt buộc dấu `/` ở đầu: Spigot dùng href TƯƠNG ĐỐI trong trang này
 * (`resources/ten-plugin.83626/`), và một phiên bản trước của mẫu này yêu cầu
 * `/resources/` nên không khớp gì — báo cáo 0 plugin trên trang có plugin thật.
 *
 * Phần slug là tuỳ chọn vì `resources/83626/` cũng hợp lệ. Bắt buộc có ranh giới
 * sau số để `categories/premium.4/`, `authors/ai-do.12345/` và `members/x.163521/`
 * không bị nhận nhầm thành mã plugin.
 */
const RESOURCE_HREF = /(?:^|\/)resources\/(?:([^/?#]*?)\.)?(\d+)(?:\/|$|\?|#)/;

export type PurchasedResource = {
  resourceId: number;
  /** Tên hiển thị trên Spigot, để chủ bot nhận ra plugin nào. */
  title: string;
  /** Phần slug trong URL, hữu ích khi tra lại thủ công. */
  slug: string | null;
};

export type PurchasedScan =
  | { ok: true; resources: PurchasedResource[] }
  | { ok: false; reason: 'challenged' | 'logged_out' | 'error'; detail: string };

export type ScanPurchasedOptions = {
  solver?: ChallengeSolver;
  log?: (message: string) => void;
  timeoutMs?: number;
};

const PURCHASED_URL = 'https://www.spigotmc.org/resources/purchased';
const CHALLENGE_WAIT_MS = 8_000;

/** Đọc mã resource từ href, hoặc null nếu href không trỏ tới một resource. */
export function resourceIdFromHref(href: string): { resourceId: number; slug: string | null } | null {
  const match = RESOURCE_HREF.exec(href);
  if (!match) return null;
  return { resourceId: Number(match[2]), slug: match[1] ?? null };
}

/**
 * Quét trang đã mua bằng một page đã đăng nhập.
 *
 * Lấy từng mục `.resourceListItem` rồi mới trích href bên trong, thay vì quét
 * mọi link trên trang: thanh điều hướng cũng chứa link resource, và gộp chung sẽ
 * biến plugin được quảng cáo ở sidebar thành "đã mua".
 */
export async function scanPurchasedResources(
  page: BrowserPage,
  options?: ScanPurchasedOptions,
): Promise<PurchasedScan> {
  const log = options?.log ?? (() => undefined);
  try {
    if (options?.solver) {
      await options.solver.prime(page, PURCHASED_URL).catch(() => false);
    }
    await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);

    const deadline = Date.now() + (options?.timeoutMs ?? 30_000);
    let title = await page.title().catch(() => '');
    while (Date.now() < deadline && /just a moment|checking your browser/i.test(title)) {
      await new Promise((r) => setTimeout(r, 2_000));
      title = await page.title().catch(() => '');
    }

    if (/just a moment|checking your browser/i.test(title) && options?.solver) {
      log('Trang đã mua bị Cloudflare chặn, đang giải bằng YesCaptcha...');
      const solved = await options.solver.solve(page, PURCHASED_URL);
      if (solved.ok) {
        log(solved.reused ? 'Dùng lại cf_clearance cho trang đã mua' : 'Đã mua cf_clearance cho trang đã mua');
        await page.goto(PURCHASED_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 3_000));
        title = await page.title().catch(() => '');
      } else {
        log(`YesCaptcha không giải được trang đã mua: ${solved.detail}`);
      }
    }

    if (/just a moment|checking your browser/i.test(title)) {
      return { ok: false, reason: 'challenged', detail: 'Cloudflare chặn trang đã mua' };
    }

    const byId = new Map<number, PurchasedResource>();
    let currentPage = 1;
    const maxPages = 25; // Giới hạn tối đa 25 trang (~500 plugins)

    while (currentPage <= maxPages) {
      const raw = (await page.evaluate(
        `(() => {
          const items = [...document.querySelectorAll('.resourceListItem, ol.resourceList > li, .structItem')];
          const out = items.map((el) => {
            const link = el.querySelector('h3.title a, .title a, a.resourceIcon');
            const href = link ? link.getAttribute('href') || '' : '';
            const heading = el.querySelector('h3.title a, .title a');
            const text = heading ? (heading.textContent || '').trim() : '';
            return { href: href, title: text };
          });
          const loggedOut = !!document.querySelector('a[href*="login"]') && items.length === 0;

          // Tìm link trang kế tiếp (XenForo pagination)
          const nextBtn = document.querySelector('a.pageNav-jump--next, .PageNav a[rel="next"], a[rel="next"], .pageNav-next');
          const nextHref = nextBtn ? nextBtn.getAttribute('href') || '' : '';

          return JSON.stringify({ items: out, loggedOut: loggedOut, count: items.length, nextHref: nextHref });
        })()` as never,
      )) as string;

      const parsed = JSON.parse(raw) as {
        items: { href: string; title: string }[];
        loggedOut: boolean;
        count: number;
        nextHref: string;
      };

      if (parsed.count === 0 && parsed.loggedOut && currentPage === 1) {
        return { ok: false, reason: 'logged_out', detail: 'trang đã mua yêu cầu đăng nhập' };
      }

      for (const item of parsed.items) {
        const parsedHref = resourceIdFromHref(item.href);
        if (!parsedHref) continue;
        const existing = byId.get(parsedHref.resourceId);
        if (existing) {
          if (!existing.title && item.title) existing.title = item.title;
          continue;
        }
        byId.set(parsedHref.resourceId, {
          resourceId: parsedHref.resourceId,
          title: item.title,
          slug: parsedHref.slug,
        });
      }

      // Nếu không còn link trang kế tiếp hoặc trang hiện tại không có item nào mới
      if (!parsed.nextHref || parsed.items.length === 0) {
        break;
      }

      // Lật sang trang tiếp theo
      currentPage++;
      const nextUrl = parsed.nextHref.startsWith('http')
        ? parsed.nextHref
        : new URL(parsed.nextHref, PURCHASED_URL).toString();

      log(`Đang đọc tiếp trang ${currentPage} danh sách đã mua...`);
      await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2_000));
    }

    return { ok: true, resources: [...byId.values()] };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
