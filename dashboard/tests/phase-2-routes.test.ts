import assert from 'node:assert/strict';
import { buildDashboardServer } from '../server/index.js';
import { createSessionCookie } from '../server/auth/session.js';
import { env } from '../server/config/env.js';

async function runTests() {
  console.log('🧪 Bắt đầu kiểm tra Phase 2 Dashboard Routes & RBAC Acceptance Tests...');
  const app = await buildDashboardServer();

  function getCookieHeader(role: 'owner' | 'admin' | 'moderator' | 'support' | 'staff') {
    const session = createSessionCookie(env.SESSION_SECRET, 3600, {
      userId: `test_${role}`,
      role,
      username: `User_${role}`,
      displayName: `Display ${role}`,
      authMethod: 'password',
    });
    return `${session.name}=${session.value}`;
  }

  try {
    // 1. GET /api/orders/undelivered: { items: [...] }
    console.log('1. Kiểm tra contract GET /api/orders/undelivered...');
    const undeliveredRes = await app.inject({
      method: 'GET',
      url: '/api/orders/undelivered',
      headers: { cookie: getCookieHeader('staff') },
    });
    assert.equal(undeliveredRes.statusCode, 200);
    const undeliveredJson = JSON.parse(undeliveredRes.body);
    assert.ok(Array.isArray(undeliveredJson.items), 'Kỳ vọng undelivered trả về { items: [...] }');
    console.log('   ✅ PASS');

    // 2. GET /api/pending: { items: [...] }
    console.log('2. Kiểm tra contract GET /api/pending...');
    const pendingRes = await app.inject({
      method: 'GET',
      url: '/api/pending',
      headers: { cookie: getCookieHeader('staff') },
    });
    assert.equal(pendingRes.statusCode, 200);
    const pendingJson = JSON.parse(pendingRes.body);
    assert.ok(Array.isArray(pendingJson.items), 'Kỳ vọng pending trả về { items: [...] }');
    console.log('   ✅ PASS');

    // 3. GET /api/log: paginated { items, page, pageSize, total, totalPages }
    console.log('3. Kiểm tra contract GET /api/log...');
    const logRes = await app.inject({
      method: 'GET',
      url: '/api/log?page=1&pageSize=10',
      headers: { cookie: getCookieHeader('staff') },
    });
    assert.equal(logRes.statusCode, 200);
    const logJson = JSON.parse(logRes.body);
    assert.ok(Array.isArray(logJson.items), 'Kỳ vọng log trả về mảng items');
    assert.equal(typeof logJson.total, 'number');
    assert.equal(logJson.page, 1);
    assert.equal(logJson.pageSize, 10);
    console.log('   ✅ PASS');

    // 4. GET /api/leaderboard: { items, stats, total, page, pageSize, totalPages }
    console.log('4. Kiểm tra contract GET /api/leaderboard...');
    const lbRes = await app.inject({
      method: 'GET',
      url: '/api/leaderboard?timeframe=all&page=1&pageSize=10',
      headers: { cookie: getCookieHeader('staff') },
    });
    assert.equal(lbRes.statusCode, 200);
    const lbJson = JSON.parse(lbRes.body);
    assert.ok(Array.isArray(lbJson.items), 'Kỳ vọng leaderboard trả về mảng items');
    assert.ok(lbJson.stats && typeof lbJson.stats.overallTotal === 'number');
    console.log('   ✅ PASS');

    // 5. PATCH /api/orders/:id/status Safety Gate: Chặn mọi status khác ngoài 'cancelled'
    console.log('5. Kiểm tra chốt chặn an toàn PATCH /api/orders/:id/status...');
    for (const badStatus of ['paid', 'delivered', 'refunded', 'active', 'random']) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/orders/999999/status',
        headers: { cookie: getCookieHeader('owner') },
        payload: { status: badStatus },
      });
      assert.equal(res.statusCode, 400, `Trạng thái ${badStatus} phải bị từ chối 400`);
      const body = JSON.parse(res.body);
      assert.match(body.error, /Chỉ cho phép hủy đơn từ pending sang cancelled/);
    }
    console.log('   ✅ PASS');

    // 6. PATCH /api/orders/:id/status RBAC: Chặn các role không phải owner (403)
    console.log('6. Kiểm tra RBAC PATCH /api/orders/:id/status (chỉ Owner)...');
    for (const role of ['admin', 'moderator', 'support', 'staff'] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/orders/999999/status',
        headers: { cookie: getCookieHeader(role) },
        payload: { status: 'cancelled' },
      });
      assert.equal(res.statusCode, 403, `Role ${role} phải bị chặn 403`);
    }
    console.log('   ✅ PASS');

    // 7. POST /api/wallets/:id/adjust: Chỉ cho phép OWNER (403 cho admin/moderator/support/staff)
    console.log('7. Kiểm tra RBAC POST /api/wallets/:id/adjust (chỉ Owner)...');
    for (const role of ['admin', 'moderator', 'support', 'staff'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/wallets/1234567890/adjust',
        headers: { cookie: getCookieHeader(role) },
        payload: { delta: 10000, note: 'Test' },
      });
      assert.equal(res.statusCode, 403, `Role ${role} phải bị chặn 403 khi điều chỉnh ví`);
    }
    console.log('   ✅ PASS');

    // 8. POST /api/orders/:id/refund: Cho phép OWNER và ADMIN, chặn MODERATOR/SUPPORT (403)
    console.log('8. Kiểm tra RBAC POST /api/orders/:id/refund (Owner & Admin)...');
    for (const role of ['moderator', 'support', 'staff'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orders/999999/refund',
        headers: { cookie: getCookieHeader(role) },
        payload: { reason: 'Test' },
      });
      assert.equal(res.statusCode, 403, `Role ${role} phải bị chặn 403 khi hoàn tiền`);
    }
    console.log('   ✅ PASS');

    // 9. POST /api/orders/:id/release: Cho phép cả 4 vai trò staff (Owner, Admin, Moderator, Support)
    console.log('9. Kiểm tra RBAC POST /api/orders/:id/release (Tất cả 4 vai trò Staff)...');
    for (const role of ['owner', 'admin', 'moderator', 'support'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/orders/99999999/release',
        headers: { cookie: getCookieHeader(role) },
      });
      assert.equal(res.statusCode, 404, `Role ${role} phải vượt qua RBAC và nhận 404 Order Not Found`);
    }
    console.log('   ✅ PASS');

    // 10. POST /api/leaderboard/reset: Chỉ cho phép OWNER (403 cho admin/moderator/support/staff)
    console.log('10. Kiểm tra RBAC POST /api/leaderboard/reset (chỉ Owner)...');
    for (const role of ['admin', 'moderator', 'support', 'staff'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/leaderboard/reset',
        headers: { cookie: getCookieHeader(role) },
        payload: { reset: true },
      });
      assert.equal(res.statusCode, 403, `Role ${role} phải bị chặn 403 khi reset leaderboard`);
    }
    console.log('   ✅ PASS');

    console.log('\n🎉 TẤT CẢ 10/10 ACCEPTANCE TESTS CHO DASHBOARD ROUTES & RBAC ĐÃ PASS HOÀN TOÀN!');
  } finally {
    await app.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Lỗi Test:', err);
  process.exit(1);
});
