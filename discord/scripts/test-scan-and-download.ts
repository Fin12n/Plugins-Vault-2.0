import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from '../src/db/connection.js';
import {
  findSpigotAccountByLabel,
  upsertSpigotAccount,
  updateSpigotAccountSession,
} from '../src/repositories/spigot-accounts.js';
import { recordOwnership } from '../src/repositories/resource-ownership.js';
import { syncPurchasedResources, formatSyncOutcome } from '../src/services/upstream/sync-purchased-resources.js';
import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import {
  loginToSpigot,
  downloadViaBrowser,
  injectSpigotSessionCookies,
  type BrowserSession,
} from '../src/services/upstream/download-via-browser.js';
import { scanPurchasedResources } from '../src/services/upstream/scan-purchased-resources.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('🚀 KIỂM THỬ TÍCH HỢP CLOAKBROWSER: ĐĂNG NHẬP, QUÉT & TẢI PLUGIN');
  console.log('================================================================\n');

  const dbPath = resolve(process.cwd(), './data/vault.db');
  const db = openDb(dbPath);

  const testLabel = 'fluid46@gmail.com';
  const testUser = 'fluid46@gmail.com';
  const testPass = '007007win';

  console.log(`[Bước 1] Cập nhật tài khoản ${testLabel} vào cơ sở dữ liệu vault.db...`);
  upsertSpigotAccount(db, {
    label: testLabel,
    username: testUser,
    password: testPass,
    isEnabled: true,
    status: 'ok',
  });

  const account = findSpigotAccountByLabel(db, testLabel);
  if (!account) {
    throw new Error('Không tìm thấy tài khoản sau khi lưu vào DB');
  }

  console.log(`✓ Tài khoản: ${account.label} (ID: ${account.id})`);
  const initialCookie = account.xfUser.reveal();
  console.log(`  Trạng thái cookie ban đầu: ${initialCookie ? initialCookie.slice(0, 20) + '...' : 'Chưa có'}\n`);

  console.log('[Bước 2] Khởi tạo Browser Launcher (Cửa sổ Chrome có giao diện)...');
  const tempProfileDir = resolve(process.cwd(), './data/test-bot-profile');
  mkdirSync(tempProfileDir, { recursive: true });

  const probe = await probeBrowserLauncher(undefined, tempProfileDir, undefined, {
    headless: false,
    showWindow: true,
  });

  if (!probe.available) {
    throw new Error(`Không thể khởi tạo browser launcher: ${probe.reason}`);
  }

  let session: BrowserSession | null = null;

  try {
    session = await probe.launch({
      headless: false,
      profileDir: tempProfileDir,
    });
    console.log('✓ Khởi chạy CloakBrowser thành công!\n');

    // Bước 3: Đăng nhập hoặc tận dụng Cookie
    let loggedIn = false;
    if (initialCookie) {
      console.log('[Bước 3] Đã có cookie xf_user lưu trước đó, đang tiêm cookie vào phiên trình duyệt...');
      await injectSpigotSessionCookies(session.page, {
        xfUser: initialCookie,
        xfSession: account.xfSession.reveal(),
      });
      console.log('  Kiểm tra trang tài nguyên đã mua xem phiên còn sống không...');
      const checkScan = await scanPurchasedResources(session.page);
      if (checkScan.ok) {
        console.log(`⚡ Cookie sống! Đã nhận diện phiên thành công mà không cần đăng nhập lại!`);
        loggedIn = true;
      } else {
        console.log(`⚠️ Cookie cũ không mở được (${checkScan.detail}), tiến hành đăng nhập mới...`);
      }
    }

    if (!loggedIn) {
      console.log('[Bước 3] Thực hiện đăng nhập SpigotMC bằng quy trình CloakBrowser + Turnstile CDP...');
      const loginRes = await loginToSpigot(
        session.page,
        {
          label: account.label,
          username: account.username,
          password: account.password.reveal(),
        },
        { settleMs: 30_000, challengeBudgetMs: 60_000 },
      );

      if (!loginRes.ok) {
        throw new Error(`Đăng nhập thất bại (${loginRes.reason}): ${loginRes.detail}`);
      }

      console.log('🎉 Đăng nhập SpigotMC thành công!');

      // Trích xuất cookie từ loginRes hoặc từ trang
      let xfUser = loginRes.cookies?.xfUser;
      let xfSession = loginRes.cookies?.xfSession;

      if (!xfUser && typeof (session.page as any).cookies === 'function') {
        const pageCookies = await (session.page as any).cookies().catch(() => []);
        xfUser = pageCookies.find((c: any) => c.name === 'xf_user')?.value;
        xfSession = pageCookies.find((c: any) => c.name === 'xf_session')?.value;
      }

      if (xfUser) {
        console.log(`🔑 Tìm thấy Cookie xf_user mới: ${xfUser.slice(0, 25)}...`);
        updateSpigotAccountSession(db, account.label, {
          xfUser,
          xfSession: xfSession ?? '',
          issuedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          status: 'ok',
        });
        console.log('💾 ĐÃ LƯU COOKIE VÀO CƠ SỞ DỮ LIỆU VAULT.DB THÀNH CÔNG!\n');
      }
    }

    // Bước 4: Quét danh sách plugin đã mua
    console.log('[Bước 4] Quét danh sách plugin đã mua từ https://www.spigotmc.org/resources/purchased ...');
    const scan = await scanPurchasedResources(session.page, {
      log: (msg) => console.log(`  [ScanLog] ${msg}`),
    });

    if (!scan.ok) {
      console.warn(`⚠️ Quét thất bại: ${scan.detail}`);
    } else {
      console.log(`\n📦 KẾT QUẢ QUÉT TÀI NGUYÊN: Tìm thấy ${scan.resources.length} plugin đã mua:`);
      for (const res of scan.resources) {
        console.log(`  - [ID: ${res.resourceId}] ${res.title} (Slug: ${res.slug || 'n/a'})`);
        recordOwnership(db, res.resourceId, account.label, 'owned');
      }

      const sync = syncPurchasedResources(db, scan.resources, { createMissing: true });
      for (const line of formatSyncOutcome(sync)) {
        console.log(`  [Sync] ${line}`);
      }
      console.log('✓ Đã đồng bộ hóa quyền sở hữu vào database thành công!\n');

      // Bước 5: Thử nghiệm tải plugin mcMMO (ID: 64348)
      if (scan.resources.length > 0) {
        const activeRes = scan.resources.find((r) => r.resourceId === 64348) || scan.resources[0]!;
        console.log(`[Bước 5] Thử nghiệm tải Plugin: [ID: ${activeRes.resourceId}] ${activeRes.title}...`);
        const outcome = await downloadViaBrowser(
          {
            tmpDir: resolve(process.cwd(), './tmp'),
            maxBytes: 300_000_000,
            log: (msg) => console.log(`  [DownloadLog] ${msg}`),
          },
          session.page,
          activeRes.resourceId,
        );

        console.log('\n📥 KẾT QUẢ TẢI:');
        console.log('  Status:', outcome.status);
        if (outcome.status === 'ok') {
          console.log(`  🎉 TẢI THÀNH CÔNG TỆP JAR: ${outcome.fileName} (${(outcome.bytes / 1024 / 1024).toFixed(2)} MB)`);
          console.log(`  ✓ SHA256: ${outcome.sha256}`);
        } else {
          console.log(`  Detail: ${(outcome as any).detail || 'n/a'}`);
        }
      }
    }
  } finally {
    if (session) {
      console.log('\n[Cleanup] Đóng phiên trình duyệt...');
      await session.close().catch(() => {});
    }
    db.close();
    console.log('================================================================');
    console.log('✨ HOÀN TẤT KIỂM THỬ TÍCH HỢP!');
    console.log('================================================================');
  }
}

main().catch((err) => {
  console.error('\n❌ Lỗi trong quá trình kiểm thử:', err instanceof Error ? err.message : err);
  process.exit(1);
});
