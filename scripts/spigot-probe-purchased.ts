/**
 * Dò trang "resources/purchased" của Spigot bằng phiên đăng nhập thật.
 *
 * Chỉ ĐỌC và báo cáo, không tải gì. Chạy trước khi viết parser: markup của
 * XenForo Resource Manager khác nhau theo phiên bản và theme, nên đoán selector
 * rồi viết parser là cách nhanh nhất để có một parser sai âm thầm.
 *
 * Thu href nguyên văn trong trang rồi phân tích ở Node, thay vì chạy regex bên
 * trong page.evaluate: chuỗi regex phải qua hai lần escape khi truyền vào trang,
 * và một lần thoát sai sẽ trả về 0 kết quả trông y như "không có gì".
 *
 *   npm run spigot-probe-purchased
 */
import { config } from '../src/config/index.js';
import { loadSpigotCredentials } from '../src/services/upstream/spigot-credential-store.js';
import { loginToSpigot } from '../src/services/upstream/download-via-browser.js';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';

/** Mọi dạng link resource, kể cả khi không có dấu / ở cuối. */
const RESOURCE_LINK = /\/resources\/(?:([^/?#]*?)\.)?(\d+)(?:\/|$|\?|#)/;

type PageDump = {
  title: string;
  bodyLength: number;
  hrefs: string[];
  itemHtml: string[];
  selectorCounts: string;
  messages: string[];
};

async function dump(page: { goto: Function; evaluate: Function }, url: string): Promise<PageDump> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => undefined);
  // Cloudflare cần vài giây trên trang lạnh.
  await new Promise((r) => setTimeout(r, 8_000));

  const raw = (await page.evaluate(`(() => {
    const sels = ['.resourceListItem', '.structItem', '.listItem', 'li.block-row', '.resourceList li', 'ol.resourceList > li'];
    const counts = sels.map((s) => s + '=' + document.querySelectorAll(s).length).join(', ');
    const hrefs = [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => h.indexOf('resources/') !== -1);
    const items = [...document.querySelectorAll('.resourceListItem, .structItem, ol.resourceList > li')]
      .slice(0, 2)
      .map((e) => e.outerHTML.slice(0, 1200));
    const msgs = [...document.querySelectorAll('.blockMessage, .errorPanel, .p-body-header h1, .titleBar h1')]
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    return JSON.stringify({
      title: document.title,
      bodyLength: document.body ? document.body.innerHTML.length : 0,
      hrefs: [...new Set(hrefs)],
      itemHtml: items,
      selectorCounts: counts,
      messages: msgs,
    });
  })()`)) as string;

  return JSON.parse(raw) as PageDump;
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'win32') {
    throw new Error('Lệnh này chỉ được chạy trong Linux hoặc Windows host/container; không hỗ trợ nền tảng này.');
  }

  // Cùng tệp bot dùng, lấy qua cấu hình đã kiểm: đọc process.env ở đầu module thì
  // .env chưa được nạp, nên một đường dẫn tự đặt trong .env sẽ bị bỏ qua.
  const credentialsFile = config().SPIGOT_CREDENTIALS_FILE;
  const creds = loadSpigotCredentials(credentialsFile);
  if (!creds.ok) {
    console.error(`Không đọc được ${credentialsFile}: ${creds.reason} — ${creds.detail}`);
    process.exit(1);
  }

  const probe = await probeBrowserLauncher(process.env.CHROME_PATH);
  if (!probe.available) {
    console.error(`Chưa chạy được trình duyệt: ${probe.reason}`);
    process.exit(1);
  }

  const session = await probe.launch();
  try {
    const first = creds.credentials[0]!;
    console.log(`Đang đăng nhập: ${first.label}`);
    const login = await loginToSpigot(session.page, first);
    if (!login.ok) {
      console.error(`Đăng nhập thất bại (${login.reason}): ${login.detail}`);
      process.exit(1);
    }
    console.log('Đăng nhập OK\n');

    const url = 'https://www.spigotmc.org/resources/purchased';
    const page = await dump(session.page as never, url);

    console.log(`--- ${url}`);
    console.log(`  title     : ${page.title}`);
    console.log(`  body      : ${page.bodyLength} ký tự`);
    console.log(`  selectors : ${page.selectorCounts}`);
    if (page.messages.length) console.log(`  tiêu đề   : ${page.messages.join(' | ')}`);

    console.log(`\n  === ${page.hrefs.length} href chứa "resources/" (nguyên văn) ===`);
    for (const h of page.hrefs.slice(0, 40)) {
      const m = RESOURCE_LINK.exec(h);
      const tag = m ? `  <== id=${m[2]}${m[1] ? ` slug=${m[1]}` : ''}` : '';
      console.log(`    ${h}${tag}`);
    }

    const ids = [...new Set(page.hrefs.map((h) => RESOURCE_LINK.exec(h)?.[2]).filter(Boolean))];
    console.log(`\n  === Mã resource trích được: ${ids.length} ===`);
    console.log(`    ${ids.join(', ') || '(không có)'}`);

    if (page.itemHtml.length) {
      console.log(`\n  === HTML của mục đầu tiên (1200 ký tự) ===`);
      console.log(page.itemHtml[0]);
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('Lỗi:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
