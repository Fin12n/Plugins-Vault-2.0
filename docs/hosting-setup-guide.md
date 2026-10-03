# Dựng hệ thống lên hosting

Runbook đi từ một VPS trắng tới hệ thống chạy thật: HTTPS, systemd, tường lửa, sao lưu, và bảng kiểm tra cuối.

Đây là phần **triển khai**. Cách từng tính năng hoạt động (ví coin, card2k, luồng thanh toán, chi tiết tự động tải Spigot) nằm ở [deployment-guide.md](deployment-guide.md); chỗ nào cần thì có liên kết tới đúng mục chứ không viết lại.

Trạng thái mã nguồn lúc viết (22/08/2026, nhánh `feat/reconcile-dashboard-ui`): `npm test` 681/681 xanh, `npm run typecheck` sạch, `npm run build` và `npm --prefix dashboard run build` đều chạy. Mọi phản hồi HTTP trích dẫn ở mục 10 là kết quả chạy thật trên Ubuntu 22.04.

## 0. Hosting phải đáp ứng gì

| Hạng mục | Yêu cầu | Vì sao |
|---|---|---|
| Loại hosting | **VPS/dedicated có root** | Cần tiến trình chạy thường trú, ghi tệp lên đĩa, và cài được Chrome nếu bật tự động tải |
| Hệ điều hành | Ubuntu 22.04/24.04 hoặc Debian 12 | Các lệnh dưới đây theo `apt` |
| Kiến trúc | **x86_64** | Google Chrome không có `.deb` cho arm64 — xem mục 9 nếu buộc dùng ARM |
| Node.js | **24.x** | Mã dùng `process.loadEnvFile`; `better-sqlite3` có bản dựng sẵn theo từng major. CI ghim 24 |
| RAM | 1 GB nếu tắt tự động tải Spigot, **≥ 2 GB** nếu bật | Chrome + Xvfb là phần ăn RAM, không phải bot |
| Đĩa | ≥ 20 GB | Kho jar ~1,5 GB cho 50 plugin × 15 bản; mỗi tài khoản Spigot thêm ~50-100 MB profile Chrome |
| Tên miền + DNS | Bắt buộc khi chạy thật | SePay chỉ gửi webhook tới HTTPS công khai |
| Đồng hồ hệ thống | Đồng bộ NTP | Webhook lệch quá **300 giây** bị từ chối `401 stale-timestamp`: tiền vào mà đơn không được giao |

**Không dùng được:** shared hosting/cPanel (không chạy được tiến trình thường trú), serverless (SQLite WAL cần đĩa cục bộ và một tiến trình sống), nền tảng có filesystem tạm (mất `vault/` mỗi lần deploy).

**Panel kiểu Pterodactyl** chạy được nếu image cho phép `apt install`, mở được cổng, và volume bền qua restart — nhưng không có systemd, nên bỏ mục 4 và dùng cách khởi động của panel.

`VAULT_DIR` và `TMP_DIR` **phải cùng một filesystem**: jar vào kho bằng `rename`, chỉ nguyên tử trong cùng filesystem. Tách ra thì mọi lần nhập kho lỗi `EXDEV`.

## 1. Chuẩn bị máy chủ

```bash
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y curl git sqlite3 ca-certificates
```

`sqlite3` là để sao lưu (mục 11), không phải để chạy — bot dùng `better-sqlite3` gắn trong Node.

**Kiểm tra đồng hồ.** Webhook SePay ký kèm timestamp và bị từ chối nếu lệch quá 300 giây:

```bash
timedatectl        # cần thấy "System clock synchronized: yes"
```

Chưa đồng bộ thì `sudo apt-get install -y systemd-timesyncd && sudo timedatectl set-ntp true`.

**Node 24:**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v          # v24.x
```

Nếu `better-sqlite3` phải tự biên dịch (nền musl, kiến trúc lạ), thêm `build-essential python3`. Đường thông thường dùng bản dựng sẵn, không cần compiler.

**Tài khoản riêng cho service** — không đặt mật khẩu nên không đăng nhập trực tiếp được, nhưng vẫn `sudo -iu vault` được để chạy lệnh bảo trì:

```bash
sudo useradd --system --create-home --shell /bin/bash vault
sudo mkdir -p /srv/plugin-vault-bot
sudo chown vault:vault /srv/plugin-vault-bot
```

Đừng đặt shell là `/usr/sbin/nologin`: mọi lệnh vận hành ở mục 6, 9 và 13 đều chạy qua `sudo -iu vault`, và shell đó sẽ từ chối. Tài khoản không có mật khẩu thì vẫn không ai đăng nhập vào được từ ngoài.

**Tường lửa.** Tiến trình lắng nghe trên `0.0.0.0:PORT` và không có tuỳ chọn đổi thành `127.0.0.1`. Không có tường lửa thì dashboard mở được bằng `http://<ip>:3000`, bỏ qua toàn bộ HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ufw status        # 3000 KHÔNG được có trong danh sách allow
```

## 2. Lấy mã và build

```bash
sudo -iu vault
git clone https://github.com/SalyyS1/plugin-vault-bot.git /srv/plugin-vault-bot
cd /srv/plugin-vault-bot
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run build   # tạo dashboard/dist
npm run build                      # biên dịch sang dist/
exit
```

**Đừng dùng `npm ci --omit=dev` trên máy chủ.** `typescript` và `tsx` là devDependency, nên bỏ dev là mất luôn `npm run build` và **mọi lệnh vận hành**: `deploy-commands`, `spigot-login`, `check-accounts`, `rescan-purchased`, `set-price`, `reset-spigot-state`. Chúng chạy qua `tsx`, và triệu chứng là `tsx: not found` chứ không phải một thông báo dễ hiểu. Chỉ tiến trình chạy thật (`node dist/src/index.js`) là không cần devDependency.

Thiếu `dashboard/dist` thì tiến trình vẫn khởi động nhưng chỉ phục vụ API — log ghi `Không tìm thấy dashboard/dist — chỉ phục vụ API` và mở web ra sẽ 404. Đây là lỗi hay gặp nhất khi deploy lần đầu.

Nếu bạn deploy bằng `rsync` từ máy cá nhân thay vì `git clone`, hãy loại `node_modules/`, `.env`, `vault/`, `data/`, `tmp/` và các tệp rác trong thư mục gốc (`google-chrome-stable_current_amd64.deb` 139 MB, `node`, `tsc`, `plugin-vault-bot@0.1.0` — bốn tệp rỗng/lạc chỗ đang nằm ở repo).

## 3. Cấu hình `.env`

```bash
sudo -iu vault
cd /srv/plugin-vault-bot
cp .env.example .env
chmod 600 .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"  # DASHBOARD_PASSWORD
```

`.env.example` để trống các bí mật một cách có chủ đích: tiến trình **không khởi động** cho tới khi bạn điền giá trị thật, nên một bản `cp` chưa sửa không thể thành hệ thống chạy thật với mật khẩu công khai trong repo. Giá trị còn mang hình dáng mẫu (`changeme`, `your_...`, `password`, `secret`, `todo`) cũng bị từ chối.

Những biến quyết định việc chạy thật thành hay thất bại — phần còn lại xem chú thích trong `.env.example`:

| Biến | Giá trị khi chạy thật | Sai thì bị gì |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://vault.example.com` (không có `/` cuối) | Cookie đăng nhập dashboard bật cờ `Secure` **theo chính biến này**. Điền `https://` mà mới chạy `http://` thì trình duyệt nhận cookie rồi bỏ, đăng nhập xong lại về trang đăng nhập; điền `http://` mà đang chạy `https://` thì cookie đi qua đường không mã hoá |
| `TRUST_PROXY` | `true` khi có reverse proxy | Để `false` sau proxy thì mọi dòng audit ghi `127.0.0.1` và rate-limit đăng nhập gộp cả internet vào một khoá |
| `PORT` | `3000` | Phải khớp cấu hình proxy ở mục 5 |
| `DASHBOARD_PASSWORD` | ≥ 12 ký tự | Ngắn hơn thì tiến trình không khởi động |
| `SESSION_SECRET` | ≥ 32 ký tự (lệnh trên cho 64) | Như trên. Đổi giá trị này là đăng xuất mọi phiên |
| `SEPAY_WEBHOOK_SECRET` | ≥ 8 ký tự, đúng secret SePay đưa | Sai thì mọi webhook `401`, tiền vào mà đơn không giao |
| `SEPAY_CODE_PREFIX` | 2-5 **chữ cái**, khớp template ở my.sepay.vn | Lệch template thì `code` về rỗng, không đơn nào khớp |
| `SEPAY_CODE_SUFFIX_LENGTH` | Nằm trong khoảng min/max của template | Ngắn hơn min thì SePay trích ra `code` rỗng |
| `DISCORD_ADMIN_ROLE_IDS` | Chỉ dùng cho lần khởi động **đầu tiên** | Sau đó dashboard là nơi quản lý; sửa `.env` rồi restart không có tác dụng |
| `UPLOAD_MAX_FILE_BYTES` | Mặc định 300 MB | Phải nhỏ hơn `client_max_body_size` của proxy (mục 5) |
| `CHROME_PROFILE_DIR` | Mặc định `./data/chrome-profile` | Chỉ đổi khi muốn đưa profile Chrome sang đĩa khác; thư mục tạo với quyền `0700` vì chứa phiên đăng nhập Spigot |

Hai quy tắc đường dẫn **không giống nhau**, và đây là chỗ dễ mất dữ liệu nhất:

- `.env` được đọc theo **thư mục làm việc** của tiến trình. Chạy từ chỗ khác là không thấy `.env`, và tiến trình dừng với danh sách 13 biến thiếu. Vì vậy `WorkingDirectory` trong systemd là **bắt buộc**.
- Còn `VAULT_DIR`, `TMP_DIR`, `DB_PATH`, `SPIGOT_CREDENTIALS_FILE`, `CHROME_PROFILE_DIR` khi để tương đối thì giải theo **gốc dự án** (thư mục chứa `package.json`), không theo thư mục làm việc. Nên `./data/vault.db` luôn là `/srv/plugin-vault-bot/data/vault.db` dù chạy từ đâu — đã kiểm tra bằng cách chạy tiến trình từ `/tmp`.

Biến môi trường thật (systemd `Environment=`/`EnvironmentFile=`) **thắng** giá trị trong `.env`. Dùng cách nào cũng được, nhưng đừng khai một biến ở cả hai chỗ.

## 4. systemd

`/etc/systemd/system/plugin-vault.service`:

```ini
[Unit]
Description=Plugin Vault Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vault
Group=vault
# Bắt buộc: .env được đọc theo thư mục làm việc
WorkingDirectory=/srv/plugin-vault-bot
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=10
# Lượt quét Spigot đang chạy được cho 15 giây để dừng gọn
TimeoutStopSec=30
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/srv/plugin-vault-bot
ProtectKernelTunables=yes
ProtectControlGroups=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now plugin-vault
sudo journalctl -u plugin-vault -f
```

Ba tuỳ chọn siết chặt **đừng thêm** nếu bật tự động tải Spigot:

- `ProtectHome=` — Chrome cài bằng `npx puppeteer browsers install chrome` nằm trong `~/.cache/puppeteer`, khoá thư mục home là mất trình duyệt.
- `PrivateNetwork=`, `IPAddressDeny=` — Chrome cần ra internet.
- `MemoryMax=` đặt thấp — kernel giết Chrome giữa lượt tải, log chỉ thấy tiến trình con biến mất.

`PrivateTmp=yes` an toàn: Xvfb và Chrome đều là tiến trình con của service nên dùng chung `/tmp` riêng đó.

Log đi vào journald, đã tự luân chuyển — không cần logrotate. Giới hạn dung lượng bằng `SystemMaxUse=` trong `/etc/systemd/journald.conf` nếu đĩa nhỏ.

## 5. HTTPS và reverse proxy

Trỏ bản ghi A của tên miền về IP máy chủ trước, rồi chọn một trong hai cách.

### Cách 1 — Caddy (khuyến nghị: tự xin và tự gia hạn chứng chỉ)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
vault.example.com {
	encode zstd gzip
	request_body {
		max_size 1GB
	}
	reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

### Cách 2 — nginx + certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d vault.example.com     # tạo và gắn chứng chỉ vào config
```

Sau khi certbot xong, thêm phần dưới vào `location /` trong `/etc/nginx/sites-available/default` (hoặc file server block tương ứng):

```nginx
    client_max_body_size 1g;
    client_body_timeout  300s;

    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    proxy_request_buffering off;
    proxy_buffering         off;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Bốn dòng đó không phải trang trí:

- **`client_max_body_size 1g`** — dashboard gửi **cả lô jar trong MỘT request**, và mỗi tệp được phép tới 300 MB. Giới hạn mặc định 1 MB của nginx trả `413` trước khi request tới app, nên giao diện chỉ nói "Mất kết nối khi đang tải lên" mà log của bot hoàn toàn trống.
- **`proxy_request_buffering off`** — không thì nginx ghi cả lô lên đĩa trước khi chuyển tiếp, tốn gấp đôi I/O và làm thanh tiến trình nhảy tới 100% rồi đứng.
- **`proxy_buffering off`** — liên kết tải jar được stream; bật đệm thì tệp lớn bị giữ lại ở proxy.
- **`proxy_read_timeout 600s`** — mặc định 60 giây cắt đứt giữa một lượt tải lên chậm.

**Endpoint webhook không cần cấu hình riêng**, nhưng đừng thêm bất cứ thứ gì viết lại thân request cho `/webhooks/sepay`: chữ ký ký trên **đúng chuỗi byte nhận được**, đổi thứ tự khoá hay escape Unicode là chữ ký sai vĩnh viễn. Hai header `x-sepay-signature` và `x-sepay-timestamp` phải đi qua nguyên vẹn (nginx và Caddy đều làm mặc định).

Xong proxy thì sửa `.env` rồi khởi động lại:

```dotenv
PUBLIC_BASE_URL=https://vault.example.com
TRUST_PROXY=true
```

```bash
sudo systemctl restart plugin-vault
```

## 6. Discord

1. Tạo application ở https://discord.com/developers/applications
2. Tab **Bot** → bật **Server Members Intent**. Đây là privileged intent: **không bật thì mọi lần kiểm tra role đều thấy rỗng và mọi admin bị từ chối**, trong khi bot vẫn online như bình thường.
3. Mời bot vào server với scope `bot` và `applications.commands`.
4. Lấy ID role admin, ID kênh thông báo, ID chủ sở hữu (bật Developer Mode trong Discord → chuột phải → Copy ID) và điền vào `.env`.
5. Đăng ký lệnh — chạy **một lần khi phát hành**, không chạy mỗi lần khởi động (có giới hạn số lần tạo lệnh mỗi ngày):

```bash
sudo -iu vault bash -c 'cd /srv/plugin-vault-bot && npm run deploy-commands'
```

Năm lệnh được đăng ký: `/menu`, `/find`, `/panel`, `/vi`, `/nap`. Lệnh phạm vi guild có hiệu lực ngay nhưng **không dùng được trong DM** — mọi lệnh đều thiết kế để dùng trong server.

## 7. SePay

Đây là bước dễ sai nhất, vì **Test mode và Live mode tách biệt hoàn toàn**.

1. Tạo webhook: URL `https://vault.example.com/webhooks/sepay`, xác thực **HMAC-SHA256**, content-type **`application/json`**.
2. Secret chỉ hiện **một lần** — copy ngay vào `SEPAY_WEBHOOK_SECRET`, sau đó nó bị che và phải tạo lại.
3. **Cấu hình Công ty → Cấu hình chung → Cấu trúc mã thanh toán**: tiền tố khớp `SEPAY_CODE_PREFIX`, độ dài hậu tố bao trùm `SEPAY_CODE_SUFFIX_LENGTH`, loại ký tự chữ và số.
4. **Tạo template đó ở CẢ Test mode VÀ Live mode.** Chỉ cấu hình Test thì webhook production về với `code` rỗng và không đơn nào khớp — dù thử ở Test vẫn thành công.
5. Bật bộ lọc "Chỉ gửi khi có mã thanh toán" để giao dịch cá nhân không gọi vào endpoint.
6. Chuyển một khoản nhỏ **thật** ở Live trước khi mở cho admin. QR ở Test mode không gắn với tài khoản ngân hàng thật; chỉ nút mô phỏng trong dashboard SePay hoàn tất được luồng.

Ba thứ khiến webhook thất bại lặng lẽ khi lên hosting, theo thứ tự hay gặp:

| Log/phản hồi | Nguyên nhân |
|---|---|
| `401 {"success":false,"message":"missing-headers"}` | SePay chưa bật HMAC, hoặc có lớp trung gian lược header |
| `401` với `stale-timestamp` | Đồng hồ máy chủ lệch quá 300 giây — kiểm tra `timedatectl` |
| `200` nhưng `code` rỗng ở mọi giao dịch | Chưa tạo template mã thanh toán ở Live mode |

Script `npm run simulate-payment` chỉ dùng khi phát triển trên localhost (xem [Kiểm thử trên localhost](deployment-guide.md#kiểm-thử-trên-localhost)); trên hosting hãy thử bằng chuyển khoản thật giá trị nhỏ.

## 8. Ví coin và nạp thẻ cào

Ví coin **chạy sẵn**, không cần cấu hình gì. Nạp thẻ cào qua card2k mặc định **tắt** cho tới khi điền đủ `CARD2K_PARTNER_ID`, `CARD2K_PARTNER_KEY`, `CARD2K_SIGN_FIELDS`, `CARD2K_COMMAND_CHARGE`, `CARD2K_COMMAND_CHECK`.

Lúc khởi động, log nói rõ đang ở trạng thái nào:

```
Nạp thẻ cào: đã cấu hình card2k
Nạp thẻ cào: TẮT — thiếu CARD2K_PARTNER_ID/KEY, CARD2K_SIGN_FIELDS hoặc CARD2K_COMMAND_*
```

Cách lấy hai giá trị không có tài liệu công khai, bảng phí bạn đang gánh, và cách xử lý thẻ treo: [mục 5b của deployment-guide](deployment-guide.md#5b-ví-coin-và-nạp-thẻ-cào-card2k). Đừng đoán `CARD2K_SIGN_FIELDS` — ký sai trả về lỗi giống hệt mọi lỗi khác, mà mỗi lần thử sai có thể mất một thẻ thật.

## 9. Tự động tải từ Spigot (không bắt buộc)

Mặc định tắt. Bật là chấp nhận: điều khoản SpigotMC cấm truy cập tự động, và tài khoản bị khoá chính là tài khoản đang giữ toàn bộ plugin bạn đã mua. Rủi ro và cách hệ thống tự xử lý khi bị Cloudflare chặn: [mục 9 của deployment-guide](deployment-guide.md#9-tự-động-tải-từ-spigot-không-bắt-buộc).

### Cài đặt môi trường trình duyệt Stealth (CloakBrowser)

Hệ thống sử dụng **CloakBrowser + Puppeteer-core** với 87 bản vá C++ chống bot và mô phỏng chuột Bézier/gõ phím người thật. CloakBrowser tự động tải và quản lý Chromium Stealth vào `~/.cloakbrowser/`, do đó **không cần cài đặt Google Chrome hay Chromium** của hệ điều hành.

Chỉ cần cài đặt `xvfb` (màn hình ảo) và các thư viện runtime Linux:

```bash
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb fonts-liberation libnss3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0 \
  libx11-xcb1 libxcb-dri3-0 libxshmfence1 libappindicator3-1 xdg-utils
```

Nếu muốn chạy bằng một file nhị phân Chrome/Chromium tùy chỉnh có sẵn, bạn có thể đặt `CHROME_PATH=/đường/dẫn/tới/chrome` trong `.env`. Mặc định để trống để CloakBrowser tự tối ưu chống Cloudflare.

`headless: false` là bắt buộc, không phải lựa chọn: endpoint tải của Spigot chỉ trả file khi cả trang được điều hướng tới trong trình duyệt thật. Đã đo — `curl`, `fetch`, và headless thuần đều nhận trang chặn Cloudflare kể cả khi mang cookie hợp lệ.

### Nạp tài khoản

Cách gọn nhất trên hosting: mở dashboard → tab **Tài khoản Spigot** → dán danh sách → xem bản xem trước → **Lưu**. Server tự ghi vào `spigot-credentials.json` với quyền hẹp, không cần SSH.

Ba định dạng được nhận, tự đoán:

```text
acc-chinh  TEN_DANG_NHAP  MAT_KHAU        # 3 cột: tên gợi nhớ, tên đăng nhập, mật khẩu
TEN_DANG_NHAP  MAT_KHAU                   # 2 cột: tên đăng nhập làm luôn tên gợi nhớ
```

```json
[{ "label": "acc-chinh", "username": "ten", "password": "mat khau co dau cach" }]
```

Định dạng thứ ba là báo cáo có dòng `User:` / `Password:` / `Purchased resources:` — dán nguyên báo cáo cũng được, bot đọc luôn danh sách plugin đã mua và tự loại tài khoản trùng phủ.

Mật khẩu có dấu cách thì buộc dùng JSON. Đừng copy từ Word/Zalo/Discord: các ứng dụng đó tự đổi dấu nháy thẳng `'` thành dấu nháy cong `’`, và bot gửi đúng ký tự lạ đó vào form đăng nhập. Kiểm tra bot đọc được đúng chưa (in tên đăng nhập và độ dài mật khẩu, **không in mật khẩu**):

```bash
sudo -iu vault bash -c 'cd /srv/plugin-vault-bot && npm run check-accounts'
```

Cuối cùng bật công tắc **Tự động tải bản mới từ Spigot** ở tab **Cấu hình**. Cần **cả** tệp tài khoản **và** công tắc; thiếu một trong hai là tính năng nằm im.

Tệp này chứa **mật khẩu dạng chữ** — bắt buộc, vì bot phải gõ chúng vào form đăng nhập. Đã gitignore, quyền hẹp, và bot cảnh báo nếu quyền rộng hơn `0600`; nhưng ai đọc được tệp là chiếm được tài khoản Spigot của bạn.

### Proxy xoay (tuỳ chọn nhưng nên có)

IP một VPS mở hàng chục phiên đăng nhập liên tiếp là thứ Cloudflare đánh dấu mạnh nhất. Ba biến, dùng riêng hoặc chung: `SPIGOT_PROXY_LIST` (danh sách, phân cách bằng phẩy hoặc xuống dòng), `SPIGOT_PROXY_FILE` (mỗi dòng một proxy — tiện khi có vài chục cái), `SPIGOT_PROXY_API_URL` (dịch vụ xoay theo lượt gọi). Chi tiết cách bể proxy chọn/nghỉ/phân biệt lỗi: [mục proxy xoay](deployment-guide.md#proxy-xoay-tuỳ-chọn).

Nếu dùng `SPIGOT_PROXY_FILE`, đặt tệp tên `spigot-proxies.txt` ở gốc dự án — `.gitignore` đã chặn đúng tên đó — và `chmod 600`.

### Đĩa và RAM khi bật

Mỗi tài khoản có một profile Chrome riêng dưới `CHROME_PROFILE_DIR` để giữ phiên và `cf_clearance`. Đo trên máy đang chạy: ~42 MB sau vài lượt, tính **50-100 MB mỗi tài khoản** khi lập kế hoạch đĩa. Profile của tài khoản bị xoá khỏi danh sách sẽ tự bị dọn.

Muốn kiểm tra ngay mà không chờ: bấm **Chạy tải ngay** ở tab Tài khoản Spigot, hoặc restart service rồi xem log — lượt quét đầu chạy 30 giây sau khi khởi động.

## 10. Kiểm tra sau khi dựng

Chạy hết bảng này trước khi giao cho admin dùng. Cột phải là phản hồi **đã chạy thật**, không phải mong đợi trên giấy.

```bash
sudo systemctl status plugin-vault --no-pager
sudo journalctl -u plugin-vault -n 40 --no-pager
```

Log lúc khởi động đúng phải có, theo thứ tự: `Đã áp dụng migration: … (schema v9)` (lần đầu) hoặc `Schema đã ở phiên bản mới nhất (v9)`, `Cấu hình: N role admin…`, dòng trạng thái card2k, `HTTP đang chạy tại cổng 3000`, và `Khởi động hoàn tất.`

Đặt `H=https://vault.example.com` rồi chạy lần lượt:

| Lệnh | Phải nhận được |
|---|---|
| `curl -so /dev/null -w '%{http_code} %{content_type}\n' $H/` | `200 text/html; charset=utf-8` — thiếu `dashboard/dist` thì ra `404` |
| `curl -so /dev/null -w '%{http_code}\n' $H/api/session` | `401` (chưa đăng nhập) |
| `curl -s -X POST -H 'content-type: application/json' -d '{"password":"sai"}' $H/api/login` | `{"error":"Mật khẩu không đúng"}` |
| `curl -s -c /tmp/c.txt -X POST -H 'content-type: application/json' -d '{"password":"<MẬT_KHẨU>"}' $H/api/login` | `{"ok":true}`, và `/tmp/c.txt` có cookie `vault_session` |
| `curl -s -b /tmp/c.txt $H/api/settings` | JSON có `adminRoleIds`, `pruneKeepCount`, `autoDownloadEnabled` |
| `curl -s $H/download/bogus` | `{"error":"Liên kết không hợp lệ, đã dùng hoặc đã hết hạn"}` (410) |
| `curl -s -X POST -H 'content-type: application/json' -d '{"id":1}' $H/webhooks/sepay` | `{"success":false,"message":"missing-headers"}` (401) — endpoint sống và đang kiểm chữ ký |
| `curl -sI http://vault.example.com/` | Dòng đầu là `301`/`308` chuyển sang HTTPS (Caddy và `certbot --nginx` đều tự dựng phần này) |

Sau đó kiểm tra bằng tay bốn việc mà `curl` không thay được:

1. **Đăng nhập dashboard bằng trình duyệt.** Vào được và F5 vẫn ở đúng tab (điều hướng bằng hash) là cookie `Secure` khớp `PUBLIC_BASE_URL`.
2. **Kéo thả một jar nhỏ** ở tab Tải lên. Xong thì `ls /srv/plugin-vault-bot/vault/` phải xuất hiện một thư mục 2 ký tự hex chứa tệp tên là chuỗi sha256. Thử luôn một jar ~50 MB nếu muốn chắc phần proxy không cắt.
3. **Trong Discord gõ `/menu`.** Ra được danh sách plugin nghĩa là bot online, role admin đúng, và Server Members Intent đã bật. Bị từ chối dù đúng role → gần như chắc chắn chưa bật intent.
4. **Đặt giá cọc 0 cho một plugin** rồi tải qua bot: kiểm tra trọn đường giao hàng mà không cần chờ SePay. Tệp lớn hơn `ATTACH_MAX_BYTES` (mặc định 8 MB) sẽ về dạng liên kết dựng từ `PUBLIC_BASE_URL` — nhấn thử để chắc tên miền đúng.

Xoá `/tmp/c.txt` sau khi xong; nó là một phiên đăng nhập hợp lệ trong 12 giờ.

## 11. Sao lưu

Hai thứ cần sao lưu, và `data/vault.db` là thứ **không thể tái tạo**: mất nó là mất toàn bộ lịch sử tải, sổ thanh toán, số dư ví và số liệu quỹ. Mất `vault/` thì còn tải lại được từ Spigot.

```bash
sudo mkdir -p /srv/backup && sudo chown vault:vault /srv/backup
sudo -iu vault
sqlite3 /srv/plugin-vault-bot/data/vault.db ".backup '/srv/backup/vault-$(date +%F).db'"
rsync -a --delete /srv/plugin-vault-bot/vault/ /srv/backup/vault/
exit
```

**Đừng `cp` tệp `.db` đang mở.** Database chạy chế độ WAL: bản copy trần có thể thiếu những gì còn nằm trong `vault.db-wal`, và đó thường là những giao dịch mới nhất — đúng phần bạn cần nhất. `.backup` của `sqlite3` là cách duy nhất đúng khi tiến trình đang chạy.

Tự động, `crontab -e` của user `vault` (dấu `%` phải escape trong crontab):

```cron
15 3 * * * sqlite3 /srv/plugin-vault-bot/data/vault.db ".backup '/srv/backup/vault-$(date +\%F).db'" && find /srv/backup -name 'vault-*.db' -mtime +14 -delete
30 3 * * * rsync -a --delete /srv/plugin-vault-bot/vault/ /srv/backup/vault/
```

`/srv/backup` trên cùng một đĩa chỉ chống lỗi phần mềm, không chống chết máy — đẩy thêm một bản ra ngoài (rclone, S3, máy khác) nếu số tiền trong sổ đáng giá hơn phí lưu trữ.

**`.env` và `spigot-credentials.json` sao lưu riêng, không để chung chỗ với database.** Đó là bí mật, không phải dữ liệu: mất thì gõ lại được từ SePay/Discord/card2k, còn rò rỉ là mất tài khoản.

### Diễn tập phục hồi

Làm thử một lần khi mới dựng, đừng để lần đầu là lúc đang mất dữ liệu:

```bash
sudo systemctl stop plugin-vault
sudo -iu vault
cd /srv/plugin-vault-bot/data
rm -f vault.db vault.db-wal vault.db-shm      # WAL cũ áp vào db mới sẽ làm hỏng dữ liệu
cp /srv/backup/vault-2026-08-22.db vault.db
exit
sudo systemctl start plugin-vault
sudo journalctl -u plugin-vault -n 20 --no-pager   # phải thấy "Schema đã ở phiên bản mới nhất"
```

## 12. Cập nhật phiên bản mới

Migration chỉ chạy một chiều, không có lệnh hạ cấp — **sao lưu database trước khi cập nhật**, đó là đường lùi duy nhất.

```bash
sudo -u vault sqlite3 /srv/plugin-vault-bot/data/vault.db ".backup '/srv/backup/pre-update-$(date +%F).db'"
sudo systemctl stop plugin-vault
sudo -iu vault bash -c '
  cd /srv/plugin-vault-bot &&
  git pull &&
  npm ci &&
  npm --prefix dashboard ci &&
  npm --prefix dashboard run build &&
  npm run build'
sudo systemctl start plugin-vault
sudo journalctl -u plugin-vault -f
```

Có thể `restart` mà không `stop` trước, nhưng dừng hẳn thì migration chạy trên một database không có ai đọc — an toàn hơn và chỉ tốn vài giây gián đoạn.

`npm run deploy-commands` chỉ chạy lại khi bản mới thêm/đổi lệnh Discord. Build lại dashboard là **bắt buộc** mỗi lần cập nhật: `dashboard/dist` không nằm trong git, nên bỏ bước này là giao diện cũ chạy với API mới.

## 13. Theo dõi khi đã chạy

```bash
sudo journalctl -u plugin-vault -f                      # đuôi log
sudo journalctl -u plugin-vault --since '1 hour ago' | grep -i 'lỗi\|error'
df -h /srv                                              # kho jar + profile Chrome chỉ tăng
du -sh /srv/plugin-vault-bot/{vault,data}
```

Nhịp các việc tự chạy — biết để không nghi oan là hệ thống treo:

| Việc | Nhịp |
|---|---|
| Quét đơn hết hạn (hoàn coin) | 60 giây |
| Dọn token tải đã hết hạn | 15 phút |
| Dò kết quả thẻ cào | 60 giây, tối đa 30 lần mỗi phiếu |
| Kiểm tra bản mới | 60 phút — **lần đầu 30 giây sau khi khởi động** |
| Quét lại khi còn bản đang nợ | `SPIGOT_BACKLOG_RESWEEP_MS`, mặc định 5 phút |
| Prune bản cũ | 24 giờ |
| Quét lại danh sách "đã mua" | 24 giờ mỗi tài khoản, tối đa 5 tài khoản một lượt |
| Nhắc cookie sắp hết hạn | sau 20 ngày, chỉ ở chế độ cookie (XenForo hết hạn ở 30; dùng mật khẩu thì bot tự đăng nhập lại mỗi lượt) |
| Chờ lượt quét dừng gọn khi shutdown | 15 giây |

Ba chỗ cần mắt người, không có báo động tự động:

- **Tab Đối soát** — đơn đã nhận tiền mà chưa giao được (bot mất kết nối, DM bị chặn, giao lỗi). Đây là đường phục hồi duy nhất vì SePay không có API tra cứu giao dịch.
- **Tab Ví coin** — cảnh báo đỏ khi số dư lệch tổng sổ cái phải luôn rỗng. Thấy nó thì đọc log trước, đừng chỉnh tay. Cùng chỗ này có thẻ cào treo chờ quyết định.
- **Đĩa** — prune giữ mọi bản đánh dấu ổn định cộng N bản mới nhất, nên `vault/` không tự dừng tăng nếu bạn đánh dấu ổn định nhiều.

Lệnh vận hành khi dữ liệu sai — chạy bằng `sudo -iu vault bash -c 'cd /srv/plugin-vault-bot && <lệnh>'`:

| Lệnh | Dùng khi |
|---|---|
| `npm run check-accounts` | Nghi tệp tài khoản Spigot sai định dạng. Chỉ đọc và in ra, không sửa gì |
| `npm run rescan-purchased [tên]` | Vừa sửa mật khẩu hoặc mới cài Chrome, muốn quét lại danh sách đã mua ngay thay vì chờ hết ngày. Chỉ xoá dấu "đã quét hôm nay", không đụng plugin/jar |
| `npm run reset-spigot-state` | Dữ liệu "tài khoản nào sở hữu plugin nào" bị sai. **Xem trước**; thêm `-- --yes` mới xoá thật. Giữ nguyên plugin, jar, đơn hàng |
| `npm run tidy-names` | Menu Discord lộn xộn vì tên plugin mang emoji và khoảng phiên bản. **Xem trước**; `-- --yes` để đổi thật |
| `npm run set-price -- 1000 [tên]` | Sửa giá cọc từ dòng lệnh. Có hiệu lực ngay, không có bước xem trước |
| `npm run spigot-login -- <tên>` | Log báo `cookie hết hiệu lực` / `needs_login` cho một tài khoản |

## 14. Xử lý sự cố

| Triệu chứng | Nguyên nhân thật | Cách sửa |
|---|---|---|
| `Cấu hình không hợp lệ (13 lỗi)` rồi tiến trình dừng | Không đọc được `.env` — hầu như luôn là `WorkingDirectory` sai, hoặc chạy `node` từ thư mục khác | Đặt `WorkingDirectory=/srv/plugin-vault-bot`, hoặc chuyển sang `EnvironmentFile=` |
| Chạy bằng tay thì được, qua systemd thì thiếu biến | Cùng nguyên nhân trên | Như trên |
| Mở web ra `404`, API vẫn trả JSON | Chưa build dashboard; log có `Không tìm thấy dashboard/dist` | `npm --prefix dashboard ci && npm --prefix dashboard run build` |
| Đăng nhập xong lại quay về trang đăng nhập | `PUBLIC_BASE_URL` là `https://` nhưng đang truy cập qua `http://` (cookie `Secure` bị trình duyệt bỏ), hoặc ngược lại | Cho `PUBLIC_BASE_URL` khớp đúng giao thức đang dùng, restart |
| `tsx: not found` khi chạy lệnh npm | Đã cài bằng `npm ci --omit=dev` | `npm ci` lại đầy đủ |
| Tải lên báo "Mất kết nối khi đang tải lên", log bot trống | Proxy trả `413` trước khi request tới app | `client_max_body_size 1g` (nginx) hoặc `request_body max_size 1GB` (Caddy) |
| Một tệp trong lô bị đánh dấu thất bại kèm `vượt quá … bytes` | Vượt `UPLOAD_MAX_FILE_BYTES` | Nâng biến đó rồi nâng luôn giới hạn của proxy |
| Webhook `401 missing-headers` | SePay chưa bật HMAC-SHA256, hoặc có lớp trung gian lược header | Bật HMAC; kiểm tra proxy không lọc `x-sepay-*` |
| Webhook `401` kèm `stale-timestamp` | Đồng hồ máy chủ lệch quá 300 giây | `timedatectl set-ntp true` |
| Mọi webhook về với `code` rỗng | Chưa tạo template mã thanh toán ở **Live mode** | Tạo template ở cả hai môi trường |
| Đơn thành `paid` nhưng không ai nhận được tệp | Bot chưa đăng nhập được, hoặc DM bị chặn. Log ghi `đã nhận thanh toán nhưng bot chưa sẵn sàng` | Sửa `DISCORD_TOKEN`, rồi giao lại ở tab **Đối soát** |
| Bot online nhưng mọi admin bị từ chối | Chưa bật **Server Members Intent** | Bật ở Developer Portal rồi restart |
| Nhập kho lỗi `EXDEV` | `TMP_DIR` và `VAULT_DIR` khác filesystem | Đưa cả hai về cùng một volume |
| `E: Unable to locate package chromium` (Ubuntu) | Ubuntu không có gói `chromium` dạng deb | Cài `.deb` Google Chrome — mục 9 |
| `The CHROME_PATH environment variable must be set…` | Máy chưa có Chrome, hoặc `CHROME_PATH` trỏ vào tệp không tồn tại | Cài Chrome, hoặc `which google-chrome-stable` rồi đặt `CHROME_PATH` |
| Log Spigot báo `chỉ được phép chạy trong Linux host/container` | Đang chạy trên Windows/macOS | Đúng như thiết kế: browser và tải jar chỉ chạy trên host Linux |
| Tài khoản Spigot liên tục vào cooldown 30 phút | Cloudflare chặn IP máy chủ | Thêm proxy xoay (mục 9); giữ `SPIGOT_DOWNLOAD_MIN_INTERVAL_MS` ≥ 20000 |
| Dashboard mở được bằng `http://<ip>:3000` | Chưa bật tường lửa; app lắng nghe `0.0.0.0` và không đổi được | `ufw enable` với chỉ 22/80/443 |
| Cảnh báo đỏ "số dư lệch sổ" ở tab Ví coin | Có thay đổi số dư không đi qua sổ cái | Đọc log quanh thời điểm đó; **đừng** chỉnh số dư bằng tay trước khi biết nguyên nhân |

Thống kê quỹ theo tháng cắt mốc theo **UTC**, không theo múi giờ máy chủ (cố ý: đổi timezone máy chủ không được phép làm dữ liệu nhảy tháng). Với giờ Việt Nam, giao dịch từ 00:00 đến 07:00 ngày 1 sẽ nằm ở báo cáo tháng trước — bình thường, không phải mất dữ liệu.

## 15. Bảo mật — bảng kiểm cuối

- [ ] `.env` quyền `600`, chủ sở hữu `vault`. Không bao giờ commit (`.gitignore` đã chặn).
- [ ] `spigot-credentials.json` quyền `600`. Tệp này chứa **mật khẩu dạng chữ**; ai đọc được là chiếm được tài khoản Spigot.
- [ ] Tường lửa chỉ mở 22/80/443. Cổng ứng dụng không được ra internet.
- [ ] Dashboard chạy qua HTTPS. Cookie quản trị và ảnh phiên browser đi qua HTTP là gửi trần trên đường truyền.
- [ ] `DASHBOARD_PASSWORD` ≥ 12 ký tự và không nằm trong password manager của người khác. Đăng nhập bị giới hạn 8 lần mỗi 15 phút theo IP; phiên sống 12 giờ.
- [ ] `SESSION_SECRET` là chuỗi ngẫu nhiên 64 ký tự, khác hẳn mật khẩu dashboard.
- [ ] Sao lưu bí mật (`.env`, tệp tài khoản Spigot) để **khác chỗ** với sao lưu database.
- [ ] Thư mục `vault/`, `data/`, `tmp/` tạo với quyền `0750`, profile Chrome `0700` — trên VPS dùng chung, người dùng khác không đọc được.
- [ ] Biết rằng jar premium **mang dấu vết tài khoản của bạn**. Mọi lần giao đều ghi vào sổ audit; đó là thứ bảo vệ bạn nếu jar bị rò rỉ.
- [ ] `SPIGOT_PROXY_API_URL` mang api_key nên chỉ nằm trong `.env`, không dán vào chat hay issue. Log chỉ in id ngắn của proxy, không in địa chỉ.

