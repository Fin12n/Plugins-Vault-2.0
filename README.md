# Kho Plugin — Discord Plugin Vault Bot

Hệ thống lưu trữ plugin Minecraft đã mua, cho phép admin tự lấy bất kỳ phiên bản nào qua Discord mà không cần chủ sở hữu có mặt và không phải chia sẻ tài khoản marketplace.

Mỗi lần tải thu một khoản tạm ứng qua chuyển khoản ngân hàng (SePay VietQR), dồn vào quỹ liên hoan cuối tháng kèm báo cáo.

## Hoạt động thế nào

```
Chủ sở hữu                          Kho                      Admin
─────────                          ───                      ─────
tải jar từ Spigot
  │
  └─ kéo thả vào dashboard ──▶ đọc descriptor trong jar
                                  tự phân loại theo plugin
                                  chống trùng bằng SHA-256
                                  lưu content-addressed
                                       │
                                       │              /find hoặc /menu
                                       │◀──────────────────┘
                                       │
                                  hiện QR nếu có giá cọc
                                       │
                                       │◀── chuyển khoản
                                       │
                                  webhook xác nhận
                                       │
                                       └──▶ DM kèm tệp hoặc liên kết
```

## Tự động tải từ Spigot

Mặc định **tắt**, và mặc định hệ thống chỉ tự động hoá phần **thông báo** và **phân phối** — phần **tải về** do bạn làm. Lý do: điều khoản SpigotMC cấm truy cập tự động và "giao diện không do họ cung cấp". Spiget đã xin quyền xử lý resource premium và bị từ chối. Tự động đăng nhập đặt toàn bộ tài khoản chứa plugin đã mua của bạn vào chỗ có thể bị khoá.

Thêm nữa, jar premium bị đóng dấu theo từng lần tải với ID tài khoản người tải — nên mọi jar đều truy được về bạn, dù tải tay hay tự động.

Nếu bạn chấp nhận những rủi ro đó, có thể bật dò phiên bản trong dashboard. Không có cơ chế vượt CAPTCHA/Cloudflare; profile Chrome riêng của từng account giữ phiên đăng nhập trên chính máy chạy browser.

Mặc định hệ thống chạy hoàn toàn không giám sát: account bị Cloudflare chặn được đóng browser, đưa vào cooldown 30 phút và bỏ qua để thử account khác. Cooldown được giữ qua restart; nếu account đăng nhập lại thành công thì được xoá ngay. Hàng đợi exact-version vẫn giữ nguyên và tôn trọng backoff. Chỉ khi chủ host chủ động đặt `SPIGOT_INTERACTIVE_CHALLENGE=true` thì dashboard mới giữ browser để xác minh thủ công. Không có worker/browser tải plugin nào chạy trên máy cá nhân.

VPS cần `xvfb` và `puppeteer-real-browser` — `xvfb` là màn hình ảo, không hiện cửa sổ nào và không cần ai bấm. Bắt buộc vì endpoint tải của Spigot chỉ trả file khi cả trang được điều hướng tới trong trình duyệt thật; `curl` và `fetch` đều nhận trang chặn Cloudflare kể cả khi có cookie hợp lệ. Xem [docs/deployment-guide.md](docs/deployment-guide.md).

Tệp mật khẩu ở dạng chữ, bắt buộc phải vậy để bot gõ vào form đăng nhập. Đã gitignore, nhưng ai đọc được tệp là chiếm được tài khoản.

Khi tắt, bot vẫn cho bạn biết khi có bản mới: Spiget có API đọc metadata hợp lệ, không cần đăng nhập.

## Tính năng

**Nạp kho** — kéo thả nhiều jar cùng lúc. Nhận dạng plugin bằng descriptor bên trong jar (`plugin.yml`, `paper-plugin.yml`, `velocity-plugin.json`, `bungee.yml`) chứ không dựa vào tên tệp, vì tên tệp cùng một plugin rất khác nhau. Trùng nội dung thì bỏ qua. Jar không đọc được vào hàng chờ gán tay, không bao giờ phân loại sai âm thầm.

**Bot Discord** — `/find` tìm mờ theo tên, `/menu` phân trang. Menu sống sót qua restart vì trạng thái nằm trong component ID chứ không trong bộ nhớ.

**Thanh toán** — QR VietQR với mã riêng cho từng đơn. Webhook khớp mã, bot giao tệp. Trả thiếu thì đơn treo lại chờ bạn quyết, trả thừa thì phần dư vào ví.

**Ví coin** — `/vi` xem số dư, `/nap` nạp bằng chuyển khoản hoặc thẻ cào. 1 coin = 1.000 ₫. Mua plugin tự trừ ví trước, thiếu bao nhiêu mới ra QR bấy nhiêu; đủ coin thì giao ngay không cần chuyển khoản. Mọi thay đổi số dư đều có dòng sổ cái, và dashboard cảnh báo nếu số dư lệch sổ.

**Nạp thẻ cào** — qua card2k, mặc định **tắt** cho tới khi điền đủ cấu hình. Phí thẻ bạn chịu: khách nạp thẻ 50k được đủ 50.000 ₫. Khai sai mệnh giá vẫn cộng theo giá trị thật của thẻ. card2k không có callback nên bot tự hỏi lại mỗi phút, tối đa 30 lần; thẻ nào không rõ kết quả thì vào tab Ví chờ bạn xử lý chứ không tự bỏ.

**Dashboard** — sửa giá cọc từng plugin, gắn mã resource Spigot, đánh dấu bản ổn định, xem lịch sử tải, thống kê quỹ theo tháng (tách theo plugin và theo admin), quản lý ví và xem phí thẻ đang gánh, cấu hình role admin.

**Bảo trì** — thông báo bản mới hàng giờ, prune hàng ngày giữ mọi bản ổn định cộng N bản mới nhất.

## Công nghệ

TypeScript, Node 24. Một tiến trình chạy cả Fastify và discord.js — webhook SePay đến qua HTTP nhưng phải gửi DM Discord, nên cả hai cần cùng một lớp service.

SQLite (`better-sqlite3`) với mọi bảng `STRICT`, `WAL`, `synchronous=FULL`. React + Vite cho dashboard.

## Bắt đầu

Dựng lên hosting: [docs/hosting-setup-guide.md](docs/hosting-setup-guide.md). Chi tiết từng tính năng: [docs/deployment-guide.md](docs/deployment-guide.md).

Cùng nội dung ở dạng web, mở bằng trình duyệt không cần máy chủ: `docs/web/index.html` — sinh lại bằng `npm run docs:web` sau khi sửa tệp Markdown.

Ngắn gọn:

```bash
npm ci && npm --prefix dashboard ci
npm --prefix dashboard run build && npm run build
cp .env.example .env    # điền giá trị thật; tiến trình không chạy nếu để trống
npm run deploy-commands
npm start
```

Hai điều dễ quên nhất:

1. **Bật Server Members Intent** trong Discord Developer Portal. Không bật thì kiểm tra role luôn thấy rỗng và mọi admin bị từ chối.
2. **Cấu hình template mã thanh toán ở cả Test mode và Live mode của SePay.** Hai môi trường tách biệt — chỉ cấu hình Test thì production nhận `code` rỗng và không đơn nào khớp.

## Phát triển

```bash
npm run dev          # backend, tự reload
npm --prefix dashboard run dev   # dashboard, proxy /api sang cổng 3000
npm test             # 681 test
npm run typecheck
```

## Giấy phép

Riêng tư. Không phân phối lại plugin của người khác.
