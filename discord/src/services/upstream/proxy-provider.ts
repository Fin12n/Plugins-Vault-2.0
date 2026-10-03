/**
 * Lấy một proxy xoay trước mỗi lần mở trình duyệt Spigot.
 *
 * Spigot đứng sau Cloudflare, và Cloudflare đánh dấu rất mạnh các IP máy chủ
 * (datacenter/VPS) mở hàng chục phiên đăng nhập liên tiếp. Chạy mỗi trình duyệt
 * qua một proxy xoay — mỗi lần một IP dân dụng khác nhau — là cách thực tế nhất để
 * giảm số lần bị chặn, thay vì cố làm cho cùng một IP máy chủ trông "người" hơn.
 *
 * Chỉ dùng cho các đường phải qua trình duyệt (đăng nhập, trang tài nguyên, tải
 * jar). Các đường tra cứu công khai vẫn fetch thẳng, nhanh hơn và không tốn quota
 * proxy.
 *
 * Giá trị trả về KHÔNG BAO GIỜ được in ra log: URL cấu hình chứa api_key, còn địa
 * chỉ proxy là thông tin của gói dịch vụ trả tiền. Báo lỗi chỉ nêu trạng thái.
 */

export type SpigotProxy = {
  /** Dạng `http://host:port` để truyền thẳng vào `--proxy-server` của Chrome. */
  server: string;
  /** Thời gian sống của proxy tính bằng giây (vd: 1800 = 30 phút). */
  timeLive?: number;
  /** Thời gian chờ tối thiểu trước khi được đổi IP tiếp theo (giây, vd: 15). */
  timeChangeRemain?: number;
  /** Thời điểm hết hạn sống của proxy (timestamp ms). */
  expireAt?: number;
  /** Thời điểm sớm nhất có thể đổi IP mới (timestamp ms). */
  nextChangeAt?: number;
};

export type ProxyFetch =
  | { ok: true; proxy: SpigotProxy }
  | { ok: false; reason: 'unset' | 'fetch_failed' | 'bad_shape' | 'refused'; detail?: string };

/** Thời gian chờ một lời gọi API proxy; quá hạn thì coi như không có proxy. */
const PROXY_FETCH_TIMEOUT_MS = 15_000;

/**
 * Xin một proxy mới từ nhà cung cấp.
 *
 * `apiUrl` là endpoint đầy đủ (đã kèm api_key trong query). Trả `unset` khi chưa
 * cấu hình — đây KHÔNG phải lỗi, chỉ nghĩa là chạy thẳng không proxy.
 *
 * Đáp ứng mong đợi là JSON `{ success, data: { proxyHttp: "host:port" } }`. Nếu
 * nhà cung cấp đổi cấu trúc, báo `bad_shape` thay vì âm thầm dùng một proxy hỏng.
 *
 * `refused` nghĩa là nhà cung cấp TRẢ LỜI ĐƯỢC nhưng từ chối phát proxy mới. Tách
 * riêng khỏi `fetch_failed` vì hai thứ này đòi hai cách xử lý khác nhau: gọi không
 * tới thì không biết gì về proxy đang dùng, còn bị từ chối thì proxy hiện hành gần
 * như chắc chắn vẫn sống — nhiều nhà cung cấp chỉ cho đổi IP mỗi N giây và trả lời
 * "chưa đến hạn" cho mọi lần gọi giữa hai lần đổi.
 */
export async function fetchSpigotProxy(
  apiUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyFetch> {
  if (!apiUrl) return { ok: false, reason: 'unset' };

  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Không in err.message: có thể chứa URL với api_key.
    return { ok: false, reason: 'fetch_failed', detail: 'không gọi được API proxy' };
  }

  // Đọc body TRƯỚC khi xét mã HTTP. Nhà cung cấp thật (suiproxy) trả 400 kèm câu
  // giải thích dùng được — "Proxy của bạn chưa đến hạn có thể đổi" — nên bỏ theo mã
  // trước khi đọc body sẽ đổi một lời từ chối tạm thời thành "không gọi được API",
  // và bể proxy tụt về IP máy chủ ở MỌI lần mở trình duyệt.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok
      ? { ok: false, reason: 'bad_shape', detail: 'API proxy không trả JSON' }
      : { ok: false, reason: 'fetch_failed', detail: `API proxy trả mã ${response.status}` };
  }

  const parsed = body as {
    success?: unknown;
    message?: unknown;
    data?: {
      proxyHttp?: unknown;
      timeLive?: unknown;
      timeChangeRemain?: unknown;
      endTime?: unknown;
      nextTimeChange?: unknown;
    };
    timeLive?: unknown;
    timeChangeRemain?: unknown;
    endTime?: unknown;
    nextTimeChange?: unknown;
  } | null;

  // Nhà cung cấp báo lỗi bằng `success: false` kèm `message` (vd hết hạn key, hết
  // quota, hoặc xoay quá nhanh). Trả nguyên câu đó ra để chủ bot biết PHẢI làm gì
  // — "thiếu proxyHttp" chung chung sẽ giấu mất "API key đã hết hạn".
  if (parsed?.success === false) {
    const message = typeof parsed.message === 'string' && parsed.message.trim() !== '' ? parsed.message.trim() : 'API proxy từ chối';
    return { ok: false, reason: 'refused', detail: message };
  }

  if (!response.ok) {
    return { ok: false, reason: 'fetch_failed', detail: `API proxy trả mã ${response.status}` };
  }

  const data = parsed?.data;
  const proxyHttp = typeof data?.proxyHttp === 'string' ? data.proxyHttp.trim() : '';
  if (!proxyHttp) {
    return { ok: false, reason: 'bad_shape', detail: 'API proxy thiếu trường data.proxyHttp' };
  }

  // Parse timeLive (giây, ví dụ 1800)
  const rawTimeLive = data?.timeLive ?? parsed?.timeLive;
  const timeLive = typeof rawTimeLive === 'number' && rawTimeLive > 0 ? rawTimeLive : undefined;

  // Parse timeChangeRemain (giây, ví dụ 15)
  const rawChangeRemain = data?.timeChangeRemain ?? parsed?.timeChangeRemain;
  const timeChangeRemain = typeof rawChangeRemain === 'number' && rawChangeRemain >= 0 ? rawChangeRemain : undefined;

  // Helper chuyển đổi mảng [year, month, day, hour, min, sec, ms] sang timestamp ms
  const parseApiTimeArray = (arr: unknown): number | undefined => {
    if (!Array.isArray(arr) || arr.length < 3) return undefined;
    const [y, m, d, h, min, s, ms] = arr.map(Number);
    if (!y || !m || !d) return undefined;
    const ts = new Date(y, m - 1, d, h ?? 0, min ?? 0, s ?? 0, ms ?? 0).getTime();
    return Number.isNaN(ts) ? undefined : ts;
  };

  const rawEndTime = data?.endTime ?? parsed?.endTime;
  const expireAt = parseApiTimeArray(rawEndTime) ?? (timeLive ? Date.now() + timeLive * 1000 : undefined);

  const rawNextChange = data?.nextTimeChange ?? parsed?.nextTimeChange;
  const nextChangeAt = parseApiTimeArray(rawNextChange) ?? (timeChangeRemain !== undefined ? Date.now() + timeChangeRemain * 1000 : undefined);

  // Chuẩn hoá thành dạng Chrome cần: có scheme thì giữ, không thì thêm http://.
  // Scheme hợp lệ bắt đầu bằng chữ rồi có thể chứa số/dấu (vd `socks5`).
  const server = /^[a-z][a-z0-9+.-]*:\/\//i.test(proxyHttp) ? proxyHttp : `http://${proxyHttp}`;
  return {
    ok: true,
    proxy: {
      server,
      timeLive,
      timeChangeRemain,
      expireAt,
      nextChangeAt,
    },
  };
}
