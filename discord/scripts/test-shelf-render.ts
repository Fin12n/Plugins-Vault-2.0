import { writeFileSync } from 'node:fs';
import { initDb } from '../src/db/connection.js';
import { listPlugins, countPlugins } from '../src/repositories/plugins.js';
import { listVersionsByPlugin, createVersion } from '../src/repositories/versions.js';
import { renderPluginShelfCanvas } from '../src/services/canvas/plugin-shelf-canvas.js';
import { renderPluginBannerCanvas } from '../src/services/canvas/plugin-banner-canvas.js';

async function main() {
  const db = initDb('./data/vault.db');
  const total = countPlugins(db);
  const plugins = listPlugins(db, 6, 0);
  console.log(`Tìm thấy ${total} plugins trong database.`);

  // Nếu plugin đầu tiên chưa có version, thêm 1 version test để kiểm tra định dạng "v{version} (Mới nhất)"
  if (plugins[0]) {
    const existingVersions = listVersionsByPlugin(db, plugins[0].id);
    if (existingVersions.length === 0) {
      console.log(`Plugin ${plugins[0].displayName} chưa có phiên bản, thêm bản thử nghiệm v3.4.1...`);
      createVersion(db, {
        pluginId: plugins[0].id,
        version: '3.4.1',
        rawVersion: 'v3.4.1-RELEASE',
        sha256: 'mock-sha256-test-' + Date.now(),
        relPath: 'test/sample.jar',
        bytes: 1450280,
        originalName: 'SamplePlugin-3.4.1.jar',
        descriptorKind: 'spigot',
        versionFlag: 'ok',
      });
    }
  }

  console.log('1. Đang kết xuất Kệ Hàng Plugins 3D Shelves Canvas với Lucide Icons...');
  const shelfBuf = await renderPluginShelfCanvas(db, plugins, {
    page: 0,
    totalPages: Math.ceil(total / 6),
    totalPlugins: total,
    assetsDir: './assets',
  });
  writeFileSync('./tmp/test-shelf.png', shelfBuf);
  console.log(`✅ Kết xuất thành công Kệ Hàng Plugins! Dung lượng ảnh: ${(shelfBuf.length / 1024).toFixed(1)} KB tại ./tmp/test-shelf.png`);

  if (plugins[0]) {
    console.log('2. Đang kết xuất Plugin Hero Banner Canvas với Lucide Icons...');
    const bannerBuf = await renderPluginBannerCanvas(db, plugins[0], {
      assetsDir: './assets',
    });
    writeFileSync('./tmp/test-banner.png', bannerBuf);
    console.log(`✅ Kết xuất thành công Plugin Hero Banner! Dung lượng ảnh: ${(bannerBuf.length / 1024).toFixed(1)} KB tại ./tmp/test-banner.png`);
  }
}

main().catch(console.error);
