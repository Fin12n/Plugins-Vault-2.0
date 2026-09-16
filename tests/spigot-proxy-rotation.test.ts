import { describe, expect, it } from 'vitest';
import {
  buildSpigotProxyPool,
  isProxyFailure,
  parseProxyEndpoint,
  parseProxyList,
  SpigotProxyPool,
} from '../src/services/upstream/spigot-proxy-pool.js';

/** Đồng hồ điều khiển được, để kiểm khoảng nghỉ mà không phải chờ thật. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return { now: () => value, advance: (ms) => void (value += ms) };
}

describe('parseProxyEndpoint', () => {
  it('đúc proxy mới khi endpoint giữ báo hết proxy, thay vì đứng hẳn sau 30 phút', async () => {
    // Đo thật trên suiproxy: `get-current-proxy` trả đúng proxy đang có và không đổi IP —
    // thứ mà cf_clearance cần — nhưng proxy chỉ sống 30 phút, và hết hạn thì endpoint đó
    // từ chối vĩnh viễn. Không có đường đúc lại thì bot đứng hẳn.
    const calls: string[] = [];
    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        const refused = String(url).includes('get-current-proxy');
        return {
          ok: true,
          status: 200,
          json: async () =>
            refused
              ? { success: false, message: 'Xoay key để lấy proxy' }
              : { success: true, data: { proxyHttp: '42.112.195.82:26436' } },
        } as Response;
      }) as unknown as typeof fetch,
    });

    const lease = await pool.next();
    expect(lease?.endpoint.server).toBe('http://42.112.195.82:26436');
    // Endpoint đúc chỉ được gọi SAU khi endpoint giữ đã nói là không còn gì.
    expect(calls.filter((u) => u.includes('get-current-proxy'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('get-new-proxy'))).toHaveLength(1);
  });

  it('KHÔNG đúc lại khi vẫn còn proxy dùng được, vì mỗi lần đổi IP là một vé chết theo', async () => {
    let currentAlive = true;
    const calls: string[] = [];
    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        const isCurrent = String(url).includes('get-current-proxy');
        return {
          ok: true,
          status: 200,
          json: async () =>
            isCurrent && !currentAlive
              ? { success: false, message: 'chưa đến hạn đổi' }
              : { success: true, data: { proxyHttp: '1.2.3.4:8000' } },
        } as Response;
      }) as unknown as typeof fetch,
    });

    await pool.next();
    // Nhà cung cấp bắt đầu từ chối, nhưng proxy phát lần trước vẫn còn hạn: phải DÙNG LẠI
    // nó, không được đúc cái mới.
    currentAlive = false;
    const second = await pool.next();

    expect(second?.endpoint.server).toBe('http://1.2.3.4:8000');
    expect(calls.filter((u) => u.includes('get-new-proxy'))).toHaveLength(0);
  });

  it('che api_key khi nhà cung cấp đọc lại nó trong câu từ chối', async () => {
    // Đo thật trên suiproxy: câu từ chối là `Xoay key <API_KEY> để lấy proxy` — chữ "key"
    // trần, không có `api_key=` phía trước, nên lọc theo MẪU không bắt được và khoá đã lọt
    // nguyên văn vào một dòng log. Đây là ca chống việc đó tái diễn.
    const key = 'c96RwJ88VWgtMNhvnQrd6MXM6Ozly911FNxjcFHS';
    const pool = new SpigotProxyPool({
      apiUrl: `https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=${key}`,
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ success: false, message: `Xoay key ${key} để lấy proxy` }),
        }) as Response) as unknown as typeof fetch,
    });

    expect(await pool.next()).toBeNull();
    const error = pool.takeApiError() ?? '';
    expect(error).not.toContain(key);
    // Vẫn phải đọc được: một câu bị che sạch thì không ai chẩn đoán được gì.
    expect(error).toContain('Xoay key');
  });
  it('thêm http:// cho dạng host:port trần, vì Chrome cần có scheme', () => {
    expect(parseProxyEndpoint('103.20.30.40:8080')).toMatchObject({ server: 'http://103.20.30.40:8080' });
  });

  it('giữ nguyên scheme khi đã có', () => {
    expect(parseProxyEndpoint('socks5://1.2.3.4:1080')).toMatchObject({ server: 'socks5://1.2.3.4:1080' });
  });

  it('tách user:pass@host:port, vì Chrome bỏ qua phần đăng nhập trong --proxy-server', () => {
    expect(parseProxyEndpoint('http://bob:s3cret@1.2.3.4:8000')).toMatchObject({
      server: 'http://1.2.3.4:8000',
      username: 'bob',
      password: 's3cret',
    });
  });

  it('đọc được dạng host:port:user:pass của nhiều nhà cung cấp', () => {
    expect(parseProxyEndpoint('1.2.3.4:8000:bob:s3cret')).toMatchObject({
      server: 'http://1.2.3.4:8000',
      username: 'bob',
      password: 's3cret',
    });
  });

  it('không để mật khẩu hay host lọt vào id dùng để log', () => {
    const endpoint = parseProxyEndpoint('1.2.3.4:8000:bob:s3cret')!;
    expect(endpoint.id).not.toContain('1.2.3.4');
    expect(endpoint.id).not.toContain('s3cret');
    expect(endpoint.id).toMatch(/^p-[0-9a-z]+$/);
  });

  it('trả null cho dòng rác thay vì ném lỗi, để một dòng sai không mất cả danh sách', () => {
    for (const bad of ['', '   ', '# ghi chú', 'khong-co-cong', '1.2.3.4:abc', '1.2.3.4:0', '1.2.3.4:70000']) {
      expect(parseProxyEndpoint(bad)).toBeNull();
    }
  });

  it('bỏ phần đăng nhập thiếu mật khẩu, vì gửi tên không kèm mật khẩu chỉ nhận 407', () => {
    const endpoint = parseProxyEndpoint('bob@1.2.3.4:8000')!;
    expect(endpoint.username).toBeUndefined();
    expect(endpoint.password).toBeUndefined();
  });

  it('mật khẩu có @ hoặc : trong dạng host:port:user:pass vẫn đọc được', () => {
    // Tách theo dấu @ trước sẽ phá dạng này: địa chỉ biến thành "ssword".
    expect(parseProxyEndpoint('1.2.3.4:8000:user:p@ssword')).toMatchObject({
      server: 'http://1.2.3.4:8000',
      username: 'user',
      password: 'p@ssword',
    });
    expect(parseProxyEndpoint('1.2.3.4:8000:user:pa:ss')).toMatchObject({
      server: 'http://1.2.3.4:8000',
      username: 'user',
      password: 'pa:ss',
    });
  });

  it('dấu % lẻ trong mật khẩu không được làm sập tiến trình', () => {
    // decodeURIComponent ném URIError với "100%pass"; ném ở đây là sập lúc khởi động
    // SAU khi bot Discord đã đăng nhập.
    expect(parseProxyEndpoint('1.2.3.4:8000:user:100%pass')).toMatchObject({ password: '100%pass' });
    expect(() => buildSpigotProxyPool({ list: '1.2.3.4:8000:user:100%pass' })).not.toThrow();
  });
});

describe('parseProxyList', () => {
  it('đọc danh sách phân cách bằng phẩy hoặc xuống dòng và bỏ trùng', () => {
    const list = parseProxyList('1.1.1.1:80, 2.2.2.2:80\n1.1.1.1:80\n#chú thích\nrác');
    expect(list.map((e) => e.server)).toEqual(['http://1.1.1.1:80', 'http://2.2.2.2:80']);
  });
});

describe('isProxyFailure', () => {
  it('nhận ra lỗi của proxy, để không quy oan cho Cloudflare', () => {
    expect(isProxyFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED at about:blank'))).toBe(true);
    expect(isProxyFailure(new Error('net::ERR_TUNNEL_CONNECTION_FAILED'))).toBe(true);
  });

  it('không nhận vơ lỗi khác thành lỗi proxy', () => {
    expect(isProxyFailure(new Error('Navigation timeout of 90000 ms exceeded'))).toBe(false);
    expect(isProxyFailure(undefined)).toBe(false);
  });
});

describe('SpigotProxyPool — chọn và cho nghỉ', () => {
  const list = '1.1.1.1:80,2.2.2.2:80,3.3.3.3:80';

  it('không cấu hình gì thì báo là chạy IP máy chủ, không trả proxy nào', async () => {
    const pool = new SpigotProxyPool();
    expect(pool.configured).toBe(false);
    expect(await pool.next()).toBeNull();
    expect(pool.describe()).toContain('không dùng proxy');
  });

  it('rải đều: proxy lâu chưa dùng nhất được chọn trước', async () => {
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list, now: time.now });

    const first = await pool.next();
    time.advance(1_000);
    const second = await pool.next();
    time.advance(1_000);
    const third = await pool.next();
    time.advance(1_000);
    const fourth = await pool.next();

    expect(new Set([first!.endpoint.id, second!.endpoint.id, third!.endpoint.id]).size).toBe(3);
    // Hết một vòng thì quay lại cái dùng lâu nhất, tức cái đầu tiên.
    expect(fourth!.endpoint.id).toBe(first!.endpoint.id);
  });

  it('proxy hỏng được cho nghỉ nên vòng chọn tiếp theo bỏ qua nó', async () => {
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list, cooldownMs: 60_000, now: time.now });

    const bad = (await pool.next())!;
    pool.markBad(bad.endpoint.id);

    for (let i = 0; i < 4; i++) {
      time.advance(1_000);
      const lease = await pool.next();
      expect(lease!.endpoint.id).not.toBe(bad.endpoint.id);
    }

    // Nghỉ xong thì được dùng lại.
    time.advance(60_000);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      ids.add((await pool.next())!.endpoint.id);
      time.advance(1);
    }
    expect(ids.has(bad.endpoint.id)).toBe(true);
  });

  it('hỏng lần nữa thì nghỉ gấp đôi, nên proxy hết hạn tự rơi khỏi vòng chọn', async () => {
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list: '9.9.9.9:80', cooldownMs: 10_000, now: time.now });

    const lease = (await pool.next())!;
    pool.markBad(lease.endpoint.id);
    time.advance(10_001);
    expect(await pool.next()).not.toBeNull();

    pool.markBad(lease.endpoint.id);
    time.advance(10_001);
    // Lần hỏng thứ hai nghỉ 20 giây, nên 10 giây vẫn chưa tới lượt.
    expect(await pool.next()).toBeNull();
    time.advance(10_001);
    expect(await pool.next()).not.toBeNull();
  });

  it('dùng tốt thì xoá lịch sử hỏng, để một lần chập không phạt proxy mãi', async () => {
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list: '9.9.9.9:80', cooldownMs: 10_000, now: time.now });

    const lease = (await pool.next())!;
    pool.markBad(lease.endpoint.id);
    pool.markGood(lease.endpoint.id);
    expect(await pool.next()).not.toBeNull();
  });

  it('trần nghỉ không bao giờ thấp hơn khoảng nghỉ cơ sở đã cấu hình', async () => {
    // env cho phép tới 24 giờ; trần cứng 1 giờ sẽ cắt ngay lần hỏng đầu, tức cấu
    // hình bị bỏ qua trong im lặng.
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list: '9.9.9.9:80', cooldownMs: 2 * 60 * 60_000, now: time.now });
    const lease = (await pool.next())!;
    pool.markBad(lease.endpoint.id);

    time.advance(60 * 60_000 + 1);
    expect(await pool.next()).toBeNull();
    time.advance(60 * 60_000);
    expect(await pool.next()).not.toBeNull();
  });

  it('hết proxy rảnh thì trả null để lượt quét chạy thẳng thay vì bỏ tài khoản', async () => {
    const time = clock();
    const { pool } = buildSpigotProxyPool({ list: '9.9.9.9:80', cooldownMs: 60_000, now: time.now });
    const lease = (await pool.next())!;
    pool.markBad(lease.endpoint.id);

    expect(await pool.next()).toBeNull();
    expect(pool.hasAlternative()).toBe(false);
    expect(pool.describe()).toContain('đang nghỉ');
  });
});

describe('SpigotProxyPool — nguồn API xoay', () => {
  /** fetch giả trả proxy theo thứ tự đã định, ghi lại số lần được gọi. */
  function stubApi(servers: string[]): { impl: typeof fetch; calls: () => number } {
    let calls = 0;
    const impl = (async () => {
      const proxyHttp = servers[Math.min(calls, servers.length - 1)];
      calls++;
      return new Response(JSON.stringify({ success: true, data: { proxyHttp } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls: () => calls };
  }

  it('xin proxy mới mỗi lần khi chỉ có API', async () => {
    const api = stubApi(['5.5.5.5:8000', '6.6.6.6:8000']);
    const pool = new SpigotProxyPool({ apiUrl: 'https://proxy.example/get?api_key=k', fetchImpl: api.impl });

    const first = await pool.next();
    const second = await pool.next();
    expect(first!.source).toBe('api');
    expect(first!.endpoint.server).toBe('http://5.5.5.5:8000');
    expect(second!.endpoint.server).toBe('http://6.6.6.6:8000');
  });

  it('xin lại khi API phát đúng proxy đang nghỉ', async () => {
    const api = stubApi(['5.5.5.5:8000', '5.5.5.5:8000', '7.7.7.7:8000']);
    const pool = new SpigotProxyPool({
      apiUrl: 'https://proxy.example/get?api_key=k',
      fetchImpl: api.impl,
      cooldownMs: 60_000,
    });

    const first = (await pool.next())!;
    pool.markBad(first.endpoint.id);

    const second = await pool.next();
    expect(second!.endpoint.server).toBe('http://7.7.7.7:8000');
    // Lần gọi thứ hai trả lại proxy đang nghỉ nên phải gọi thêm một lần nữa.
    expect(api.calls()).toBe(3);
  });

  it('không hứa còn IP khác khi API vừa phát lại đúng proxy đang nghỉ', async () => {
    const api = stubApi(['5.5.5.5:8000']);
    const pool = new SpigotProxyPool({
      apiUrl: 'https://proxy.example/get?api_key=k',
      fetchImpl: api.impl,
      cooldownMs: 60_000,
    });

    const first = (await pool.next())!;
    pool.markBad(first.endpoint.id);

    // Nhà cung cấp xoay theo thời gian: xin bao nhiêu lần cũng ra đúng IP đó.
    const again = (await pool.next())!;
    expect(again.endpoint.id).toBe(first.endpoint.id);
    // Hứa "còn IP khác" ở đây là mở Chrome ba lần trên cùng một IP đã bị chặn.
    expect(pool.hasAlternative(first.endpoint.id)).toBe(false);
  });

  it('danh sách tĩnh dùng trước, API chỉ để dành khi danh sách hết proxy rảnh', async () => {
    const time = clock();
    const api = stubApi(['8.8.8.8:8000']);
    const { pool } = buildSpigotProxyPool({
      list: '4.4.4.4:80',
      apiUrl: 'https://proxy.example/get?api_key=k',
      fetchImpl: api.impl,
      cooldownMs: 60_000,
      now: time.now,
    });

    const first = (await pool.next())!;
    expect(first.source).toBe('static');
    expect(api.calls()).toBe(0);

    pool.markBad(first.endpoint.id);
    const second = (await pool.next())!;
    expect(second.source).toBe('api');
  });

  it('API lỗi thì trả null và giữ lại lý do, không để lộ api_key', async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ success: false, message: 'API key đã hết hạn' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const pool = new SpigotProxyPool({ apiUrl: 'https://proxy.example/get?api_key=SECRET', fetchImpl: impl });

    expect(await pool.next()).toBeNull();
    const error = pool.takeApiError();
    expect(error).toBe('API key đã hết hạn');
    expect(error).not.toContain('SECRET');
    // Đọc một lần rồi xoá, để không in lại cùng một lỗi mỗi lượt quét.
    expect(pool.takeApiError()).toBeNull();
  });

  it('che khoá khi chính nhà cung cấp đọc lại nó trong câu từ chối', async () => {
    // Câu này do bên thứ ba viết và được in nguyên văn để chủ bot biết phải làm gì,
    // nên nó là đường duy nhất một api_key có thể rơi vào log.
    const impl = (async () =>
      new Response(
        JSON.stringify({
          success: false,
          message: 'api_key=abcdef123456 khong ton tai\nDONG GIA MAO',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const pool = new SpigotProxyPool({ apiUrl: 'https://proxy.example/get?api_key=abcdef123456', fetchImpl: impl });

    expect(await pool.next()).toBeNull();
    const error = pool.takeApiError()!;
    expect(error).not.toContain('abcdef123456');
    expect(error).toContain('<đã che>');
    // Gộp dòng mới: một câu nhiều dòng có thể dựng ra dòng log giả.
    expect(error).not.toContain('\n');
  });

  /**
   * fetch giả bắt chước endpoint đổi IP thật: lần đầu phát proxy, những lần sau trả
   * HTTP 400 kèm câu "chưa đến hạn có thể đổi".
   */
  function stubRotateOncePerWindow(server: string): typeof fetch {
    let calls = 0;
    return (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ success: true, data: { proxyHttp: server } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ success: false, message: 'Proxy của bạn chưa đến hạn có thể đổi. Vui lòng thử lại sau 49 giây' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  it('dùng lại proxy vừa phát khi nhà cung cấp nói chưa đến hạn đổi', async () => {
    // Một lượt quét mở hàng chục trình duyệt còn nhà cung cấp chỉ cho đổi mỗi phút,
    // nên hầu hết lần gọi đều bị từ chối. Bỏ proxy ở đó là chạy IP máy chủ gần như
    // mọi lần mở, đúng thứ mà trả tiền cho proxy nhằm tránh.
    const pool = new SpigotProxyPool({
      apiUrl: 'https://proxy.example/change?api_key=k',
      fetchImpl: stubRotateOncePerWindow('183.80.104.218:34390'),
    });

    const first = (await pool.next())!;
    const second = (await pool.next())!;
    const third = (await pool.next())!;

    expect(second.endpoint.id).toBe(first.endpoint.id);
    expect(third.endpoint.server).toBe('http://183.80.104.218:34390');
    // Dùng lại được thì không có lỗi nào để in: đây là hoạt động bình thường.
    expect(pool.takeApiError()).toBeNull();
  });

  it('không hứa còn IP khác khi vừa phải dùng lại proxy cũ', async () => {
    const pool = new SpigotProxyPool({
      apiUrl: 'https://proxy.example/change?api_key=k',
      fetchImpl: stubRotateOncePerWindow('183.80.104.218:34390'),
    });

    const first = (await pool.next())!;
    expect(pool.hasAlternative(first.endpoint.id)).toBe(true);

    await pool.next();
    // Nhà cung cấp đã nói thẳng là chưa đến hạn: thử lại chỉ mở lại đúng IP đó.
    expect(pool.hasAlternative(first.endpoint.id)).toBe(false);
  });

  it('không dùng lại proxy cũ khi chính nó vừa hỏng và đang nghỉ', async () => {
    const pool = new SpigotProxyPool({
      apiUrl: 'https://proxy.example/change?api_key=k',
      fetchImpl: stubRotateOncePerWindow('183.80.104.218:34390'),
      cooldownMs: 60_000,
    });

    const first = (await pool.next())!;
    pool.markBad(first.endpoint.id);

    // Một exit node đã chết còn tệ hơn IP máy chủ: chạy thẳng và nói rõ lý do.
    expect(await pool.next()).toBeNull();
    expect(pool.takeApiError()).toContain('chưa đến hạn');
  });
});

describe('buildSpigotProxyPool', () => {
  it('đếm số dòng bị bỏ, vì dán mười proxy mà chỉ nhận ba là điều phải biết ngay', () => {
    const { pool, warnings } = buildSpigotProxyPool({ list: '1.1.1.1:80, rác, 2.2.2.2:99999' });
    expect(pool.size).toBe(1);
    expect(warnings.join(' ')).toContain('bỏ 2 dòng');
  });

  it('proxy trùng và dòng chú thích không bị đếm thành dòng sai', () => {
    const { pool, warnings } = buildSpigotProxyPool({
      list: '1.1.1.1:80',
      file: 'proxies.txt',
      readFile: () => '# danh sách tháng 8\n1.1.1.1:80\n2.2.2.2:80\n',
      checkPermissions: () => null,
    });
    expect(pool.size).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('hai phiên sticky cùng host:port khác tên đăng nhập vẫn là hai proxy', () => {
    // Nhà cung cấp sticky-session bán nhiều phiên trên cùng một cổng và phân biệt
    // bằng user; gộp chúng lại là mất cả gói chỉ còn một IP.
    const { pool } = buildSpigotProxyPool({
      list: 'u1:p1@1.1.1.1:80,u2:p2@1.1.1.1:80',
    });
    expect(pool.size).toBe(2);
  });

  it('cảnh báo khi tệp proxy để người khác đọc được, như tệp mật khẩu Spigot', () => {
    const { warnings } = buildSpigotProxyPool({
      file: 'proxies.txt',
      readFile: () => '1.1.1.1:80:user:pass\n',
      checkPermissions: (path) => `${path} có quyền 644 — nên đặt 0600, tệp này chứa thông tin proxy trả tiền`,
    });
    expect(warnings.join(' ')).toContain('nên đặt 0600');
  });

  it('đọc thêm từ tệp và gộp với danh sách trong .env', () => {
    const { pool } = buildSpigotProxyPool({
      list: '1.1.1.1:80',
      file: '/khong/ton/tai/proxies.txt',
      readFile: () => '2.2.2.2:80\n3.3.3.3:80\n',
    });
    expect(pool.size).toBe(3);
  });

  it('tệp proxy thiếu chỉ là cảnh báo, không được làm sập tiến trình', () => {
    const { pool, warnings } = buildSpigotProxyPool({
      file: '/khong/ton/tai/proxies.txt',
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    expect(pool.size).toBe(0);
    expect(warnings.join(' ')).toContain('không đọc được tệp proxy');
  });

  it('phân bổ đều các instances và giới hạn tối đa 2-3 instances cho mỗi proxy IP', async () => {
    const { pool } = buildSpigotProxyPool({
      list: '1.1.1.1:8000, 2.2.2.2:8000',
    });
    // Worker 1 xin proxy -> nhận proxy A (1 instance)
    const l1 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(l1).not.toBeNull();
    pool.acquire(l1!.endpoint.id);
    expect(pool.getActiveInstances(l1!.endpoint.id)).toBe(1);

    // Worker 2 xin proxy -> phải nhận proxy B (vì proxy A đã có 1, proxy B có 0)
    const l2 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(l2).not.toBeNull();
    expect(l2!.endpoint.id).not.toBe(l1!.endpoint.id);
    pool.acquire(l2!.endpoint.id);

    // Worker 3 xin proxy -> cả 2 đều có 1, nhận 1 trong 2
    const l3 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(l3).not.toBeNull();
    pool.acquire(l3!.endpoint.id);

    // Worker 4 xin proxy -> nhận proxy còn lại (cả 2 đều có 2 instances)
    const l4 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(l4).not.toBeNull();
    pool.acquire(l4!.endpoint.id);

    expect(pool.getActiveInstances(l1!.endpoint.id)).toBe(2);
    expect(pool.getActiveInstances(l2!.endpoint.id)).toBe(2);

    // Worker 1 đóng -> giải phóng
    pool.release(l1!.endpoint.id);
    expect(pool.getActiveInstances(l1!.endpoint.id)).toBe(1);
  });

  it('tái sử dụng lastApiEndpoint khi proxy vẫn sống nhưng đạt maxInstances và renew bị từ chối do cooldown', async () => {
    let renewCalled = false;
    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      fetchImpl: (async (url: string) => {
        if (String(url).includes('get-new-proxy')) {
          renewCalled = true;
          return {
            ok: true,
            status: 400,
            json: async () => ({
              success: false,
              message: 'Proxy của bạn chưa đến hạn có thể đổi. Vui lòng thử lại sau 10 giây',
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { proxyHttp: '1.2.3.4:8000' } }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    // Worker 1, 2, 3 xin proxy
    const l1 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(l1?.endpoint.server).toBe('http://1.2.3.4:8000');
    pool.acquire(l1!.endpoint.id);
    pool.acquire(l1!.endpoint.id);
    pool.acquire(l1!.endpoint.id);
    expect(pool.getActiveInstances(l1!.endpoint.id)).toBe(3);

    // Worker 4 xin proxy: vượt quá maxInstancesPerProxy (3), pool gọi renew()
    // renew() bị Suiproxy từ chối với cooldown -> pool PHẢI tái sử dụng proxy cũ thay vì trả về null
    const l4 = await pool.next({ maxInstancesPerProxy: 3 });
    expect(renewCalled).toBe(true);
    expect(l4).not.toBeNull();
    expect(l4?.endpoint.server).toBe('http://1.2.3.4:8000');
  });

  it('Cho cả 5 worker cùng ăn 1 IP proxy đồng thời mà không bị từ chối', async () => {
    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { proxyHttp: '10.0.0.99:8000' } }),
      })) as unknown as typeof fetch,
    });

    // 5 worker cùng xin proxy (mặc định maxInstancesPerProxy = 5)
    const leases: (ProxyLease | null)[] = [];
    for (let i = 1; i <= 5; i++) {
      const lease = await pool.next();
      expect(lease).not.toBeNull();
      expect(lease?.endpoint.server).toBe('http://10.0.0.99:8000');
      pool.acquire(lease!.endpoint.id);
      leases.push(lease);
    }

    // Xác nhận cả 5 worker cùng kết nối trên 1 proxy endpoint duy nhất
    expect(pool.getActiveInstances(leases[0]!.endpoint.id)).toBe(5);

    // Giải phóng dần các worker
    for (const lease of leases) {
      pool.release(lease!.endpoint.id);
    }
    expect(pool.getActiveInstances(leases[0]!.endpoint.id)).toBe(0);
  });

  it('KHÔNG đổi IP mỗi 30s; chỉ đổi khi proxy dead (bị đánh dấu hỏng) hoặc hết hạn 30 phút (Epoch tăng, cả 5 worker chuyển IP)', async () => {
    let newIpIndex = 1;
    let mockTime = 1_000_000;
    const cooldownMs = 31_000;

    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      cooldownMs,
      now: () => mockTime,
      fetchImpl: (async (url: string) => {
        if (String(url).includes('get-new-proxy')) {
          newIpIndex++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                proxyHttp: `10.0.0.${newIpIndex}:8000`,
                timeLive: 1800,
                timeChangeRemain: 15,
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              proxyHttp: '10.0.0.1:8000',
              timeLive: 1800,
              timeChangeRemain: 15,
            },
          }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    // 1. Worker lấy IP ban đầu (Epoch 1)
    const lease1 = await pool.next();
    expect(lease1?.endpoint.server).toBe('http://10.0.0.1:8000');
    expect(pool.getRotationEpoch()).toBe(1);
    expect(pool.isCurrentIpExpired()).toBe(false);
    pool.acquire(lease1!.endpoint.id);

    // 2. Thời gian trôi qua 31 giây: proxy VẪN SỐNG và KHÔNG HẾT HẠN!
    mockTime += cooldownMs + 1000;
    expect(pool.isCurrentIpExpired()).toBe(false);

    // Cron tick tại thời điểm này: KHÔNG ĐƯỢC PHÉP ĐỔI IP!
    const ignoredTick = await pool.autoRotateTick();
    expect(ignoredTick).toBeNull();
    expect(pool.getActiveProxyServer()).toBe('10.0.0.1:8000');
    expect(pool.getRotationEpoch()).toBe(1);

    // 3. Khi proxy bị dead (ví dụ gặp lỗi kết nối hoặc bị Cloudflare chặn -> markBad):
    pool.markBad(lease1!.endpoint.id);
    expect(pool.isCurrentIpExpired()).toBe(true);

    // Lúc này Cron tick hoặc worker nhận biết proxy dead và kích hoạt IP mới ngay lập tức
    let logMsg = '';
    await pool.autoRotateTick({
      log: (msg) => {
        logMsg = msg;
      },
    });

    // Xác nhận: IP mới được áp dụng, Epoch tăng lên 2
    expect(pool.getActiveProxyServer()).toBe('10.0.0.2:8000');
    expect(pool.getRotationEpoch()).toBe(2);
    expect(pool.isCurrentIpExpired()).toBe(false);
    expect(logMsg).toContain('Đã đổi sang IP mới: 10.0.0.2:8000');

    // 4. Các lượt sau gọi next() đều nhận IP mới
    const lease2 = await pool.next();
    expect(lease2?.endpoint.server).toBe('http://10.0.0.2:8000');
  });

  it('Tự động đổi IP khi proxy hết hạn timeLive (1800 giây = 30 phút)', async () => {
    let newIpIndex = 1;
    let mockTime = 1_000_000;

    const pool = new SpigotProxyPool({
      apiUrl: 'https://api.suiproxy.com/api/proxy/get-current-proxy?api_key=k123456',
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      now: () => mockTime,
      fetchImpl: (async (url: string) => {
        if (String(url).includes('get-new-proxy')) {
          newIpIndex++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              data: {
                proxyHttp: `10.0.0.${newIpIndex}:8000`,
                timeLive: 1800,
                timeChangeRemain: 15,
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              proxyHttp: '10.0.0.1:8000',
              timeLive: 1800,
              timeChangeRemain: 15,
            },
          }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    const lease1 = await pool.next();
    expect(lease1?.endpoint.server).toBe('http://10.0.0.1:8000');
    expect(pool.isCurrentIpExpired()).toBe(false);

    // Thời gian trôi qua 25 phút: vẫn chưa hết 30 phút
    mockTime += 25 * 60 * 1000;
    expect(pool.isCurrentIpExpired()).toBe(false);

    // Thời gian trôi qua đủ 30 phút + 1s (1801 giây)
    mockTime += 5 * 60 * 1000 + 1000;
    expect(pool.isCurrentIpExpired()).toBe(true);

    // Cron tick sẽ đổi sang IP mới
    await pool.autoRotateTick();
    expect(pool.getActiveProxyServer()).toBe('10.0.0.2:8000');
  });

  it('fetchSpigotProxy đọc đầy đủ các trường Suiproxy: timeLive, timeChangeRemain, endTime, nextTimeChange', async () => {
    const { fetchSpigotProxy } = await import('../src/services/upstream/proxy-provider.js');
    const mockRes = {
      code: 200,
      message: 'Success',
      data: {
        proxyHttp: '1.53.184.119:19331',
        nextTimeChange: [2026, 9, 7, 16, 56, 50, 427],
        endTime: [2026, 9, 7, 17, 26, 20, 427],
        timeLive: 1800,
        timeChangeRemain: 15,
      },
    };

    const res = await fetchSpigotProxy('https://api.suiproxy.com/get', (async () => ({
      ok: true,
      status: 200,
      json: async () => mockRes,
    })) as unknown as typeof fetch);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.proxy.server).toBe('http://1.53.184.119:19331');
      expect(res.proxy.timeLive).toBe(1800);
      expect(res.proxy.timeChangeRemain).toBe(15);
      expect(typeof res.proxy.expireAt).toBe('number');
      expect(typeof res.proxy.nextChangeAt).toBe('number');
    }
  });

  it('forceRotate() sử dụng single-flight promise để ngăn việc 5 worker cùng spam API', async () => {
    let callCount = 0;
    const pool = new SpigotProxyPool({
      renewUrl: 'https://api.suiproxy.com/api/proxy/get-new-proxy?api_key=k123456',
      fetchImpl: (async () => {
        callCount++;
        // Giả lập độ trễ mạng
        await new Promise((r) => setTimeout(r, 10));
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { proxyHttp: `10.0.0.${callCount}:8000` } }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    // Cả 5 worker cùng gọi forceRotate() đồng thời
    const results = await Promise.all([
      pool.forceRotate(),
      pool.forceRotate(),
      pool.forceRotate(),
      pool.forceRotate(),
      pool.forceRotate(),
    ]);

    // Chỉ có đúng 1 API request được gửi đi (single-flight)
    expect(callCount).toBe(1);
    // Cả 5 worker đều nhận chung 1 IP mới
    for (const res of results) {
      expect(res?.endpoint.server).toBe('http://10.0.0.1:8000');
    }
  });
});

