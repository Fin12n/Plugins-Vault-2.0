import { buildDashboardServer } from '../server/index.js';

async function runSmokeTest() {
  console.log('🧪 Bắt đầu kiểm tra Dashboard Fastify Server...');
  const app = await buildDashboardServer();

  try {
    // 1. Kiểm tra health check
    const healthRes = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    console.log('Health check status:', healthRes.statusCode);
    console.log('Health check body:', healthRes.body);

    if (healthRes.statusCode !== 200) {
      throw new Error(`Health check trả về status ${healthRes.statusCode}`);
    }

    // 2. Kiểm tra chặn truy cập khi chưa đăng nhập
    const pluginsRes = await app.inject({
      method: 'GET',
      url: '/api/plugins',
    });

    console.log('Protected /api/plugins status:', pluginsRes.statusCode);
    if (pluginsRes.statusCode !== 401) {
      throw new Error(`Kỳ vọng 401 Unauthorized nhưng nhận ${pluginsRes.statusCode}`);
    }

    console.log('✅ SMOKE TEST FASTIFY DASHBOARD SERVER HOÀN TẤT THÀNH CÔNG 100%!');
  } finally {
    await app.close();
  }
}

runSmokeTest().catch((err) => {
  console.error('❌ Lỗi Smoke Test:', err);
  process.exit(1);
});
