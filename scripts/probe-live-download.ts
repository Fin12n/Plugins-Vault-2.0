/**
 * Kiểm tra nhanh: ngay bây giờ, đường tải qua trình duyệt còn vượt được Cloudflare
 * không?
 *
 * Dùng một resource MIỄN PHÍ nên không cần tài khoản: câu hỏi duy nhất là Cloudflare
 * có cho một lần điều hướng thật tải jar về hay không. Đây là cách phân biệt "cấu
 * hình sai" với "Cloudflare vừa siết" mà không phải chạy cả lượt quét.
 *
 * Dùng: npm run spigot-probe-download -- [resourceId] [tenBanPhat]
 */
import { mkdirSync } from 'node:fs';
import { config } from '../src/config/index.js';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { downloadViaBrowser } from '../src/services/upstream/download-via-browser.js';

const resourceId = Number(process.argv[2] ?? 6245);
const versionName = process.argv[3];

async function main(): Promise<void> {
  const env = config();
  mkdirSync(env.TMP_DIR, { recursive: true, mode: 0o750 });

  const probe = await probeBrowserLauncher(process.env.CHROME_PATH);
  if (!probe.available) {
    console.error('launcher unavailable:', probe.reason);
    process.exit(1);
  }

  const started = Date.now();
  const session = await probe.launch({});
  console.log(`browser up in ${Date.now() - started}ms`);

  try {
    const outcome = await downloadViaBrowser(
      {
        tmpDir: env.TMP_DIR,
        maxBytes: 100 * 1024 * 1024,
        fetchImpl: fetch,
        log: (message) => console.log('  ', message),
      },
      session.page,
      resourceId,
      versionName,
    );
    console.log('OUTCOME:', JSON.stringify({ ...outcome, path: 'path' in outcome ? outcome.path : undefined }));
  } finally {
    await session.close();
  }
}

main().catch((err: unknown) => {
  console.error('probe failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
