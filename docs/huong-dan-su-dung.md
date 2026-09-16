# Kho Plugin — Hướng dẫn cài đặt và sử dụng

Tài liệu này đi từ một máy chủ trắng tới hệ thống chạy thật, rồi hướng dẫn dùng hằng ngày. Làm theo đúng thứ tự là chạy được.

## 1. Hệ thống này làm gì

Kho lưu các plugin Minecraft bạn đã mua. Admin trong Discord tự lấy bất kỳ phiên bản nào bằng lệnh bot, không cần bạn có mặt và không phải đưa tài khoản marketplace cho ai.

Ba phần chạy trong **một tiến trình duy nhất**:

| Phần | Việc |
|---|---|
| Bot Discord | Nhận lệnh, hiện menu chọn plugin/phiên bản, gửi link tải |
| Dashboard web | Bạn tải jar lên, đặt giá cọc, xem ví coin, đối soát tiền |
| Bộ tải tự động | Đăng nhập Spigot bằng Chrome thật, tải các bản mới về kho |

Mỗi lần admin tải có thể thu một khoản cọc qua chuyển khoản (SePay VietQR) hoặc trừ ví coin. Tiền dồn vào quỹ, dashboard có mục thống kê.

## 2. Cần chuẩn bị

**Máy chủ**

| Hạng mục | Yêu cầu | Vì sao |
|---|---|---|
| Loại | VPS hoặc máy chủ riêng có quyền root | Cần tiến trình chạy thường trú và ghi tệp lên đĩa |
| Kiến trúc | **x86_64** | Google Chrome không có bản cho ARM |
| RAM | 1 GB nếu tắt tự động tải, **≥ 2 GB** nếu bật | Chrome là phần ăn RAM, không phải bot |
| Đĩa | ≥ 20 GB | Kho jar khoảng 1,5 GB cho 50 plugin × 15 bản |
| Phần mềm | Docker Engine ≥ 24 và Docker Compose v2 | `docker --version`, `docker compose version` |
| Tên miền | Bắt buộc khi chạy thật | SePay chỉ gửi webhook tới HTTPS công khai |
| Đồng hồ | Đồng bộ NTP | Webhook lệch quá **300 giây** bị từ chối: tiền vào mà đơn không giao |

Kiểm tra đồng hồ: `timedatectl` phải thấy `System clock synchronized: yes`. Chưa có thì `sudo timedatectl set-ntp true`.

**Không dùng được:** shared hosting/cPanel, serverless, hoặc bất kỳ nền tảng nào có filesystem tạm — mất thư mục `vault/` mỗi lần deploy là mất toàn bộ kho jar.

**Tài khoản dịch vụ ngoài**

1. **Discord application** — tạo ở https://discord.com/developers/applications. Lấy `token`, `client id`. Bật **Message Content Intent** nếu muốn bot đọc nội dung.
2. **SePay** — https://sepay.vn, để nhận webhook chuyển khoản. Cần số tài khoản và mã ngân hàng.
3. **YesCaptcha** (tuỳ chọn) — chỉ cần khi bật tự động tải Spigot và gặp Cloudflare.
4. **card2k** (tuỳ chọn) — chỉ cần khi muốn cho nạp ví bằng thẻ cào.

## 3. Cài đặt

**Bước 1 — giải nén**

```bash
unzip kho-plugin-*.zip -d /srv/kho-plugin
cd /srv/kho-plugin
```

**Bước 2 — tạo tệp cấu hình**

```bash
cp .env.example .env
nano .env
```

`.env.example` đã điền sẵn giá trị hợp lý cho gần hết các khoá. Chỉ **12 khoá** dưới đây bắt buộc phải tự điền:

| Khoá | Lấy ở đâu |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → Bot → Reset Token |
| `DISCORD_CLIENT_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | Bật Developer Mode trong Discord → chuột phải tên server → Copy Server ID |
| `DISCORD_ADMIN_ROLE_IDS` | Chuột phải role được phép tải → Copy Role ID. Nhiều role thì cách nhau bằng dấu phẩy |
| `DISCORD_OWNER_ID` | Chuột phải chính bạn → Copy User ID. Người này nhận báo lỗi |
| `DISCORD_NOTIFY_CHANNEL_ID` | Chuột phải kênh nhận thông báo → Copy Channel ID |
| `PUBLIC_BASE_URL` | Tên miền công khai, ví dụ `https://kho.tenmiencuaban.com`. **Phải là https** |
| `DASHBOARD_PASSWORD` | Bạn tự đặt. Đây là mật khẩu duy nhất mở dashboard — đặt dài |
| `SESSION_SECRET` | Sinh bằng `openssl rand -hex 32` |
| `SEPAY_WEBHOOK_SECRET` | Bạn tự đặt, rồi khai đúng chuỗi này bên SePay |
| `SEPAY_ACCOUNT_NUMBER` | Số tài khoản nhận tiền |
| `SEPAY_BANK_CODE` | Mã ngân hàng, ví dụ `MBBank`, `VCB`, `TPBank` |

Chạy sau reverse proxy (mục 4 — là cách duy nhất được khuyến nghị) thì phải sửa `TRUST_PROXY=false` thành `TRUST_PROXY=true`. Để `false` thì mọi request trông như đến từ chính nginx, và bộ giới hạn số lần đăng nhập sai sẽ tính chung tất cả mọi người vào một địa chỉ.

**Bước 3 — tạo thư mục dữ liệu**

```bash
mkdir -p data vault tmp
```

Ba thư mục này được gắn vào container và là toàn bộ dữ liệu của bạn: `data` chứa cơ sở dữ liệu, `vault` chứa jar, `tmp` là chỗ trung chuyển khi tải lên. **`vault` và `tmp` phải nằm cùng một ổ đĩa** — jar vào kho bằng lệnh `rename`, tách hai ổ là lỗi mỗi lần nhập kho.

**Bước 4 — dựng và chạy**

```bash
docker compose up -d --build
docker compose logs -f
```

Lần đầu mất khoảng 5-10 phút vì phải tải Chrome và biên dịch. Log chạy đúng sẽ có:

```
Schema đã ở phiên bản mới nhất (v9)
HTTP đang chạy tại cổng 3000
Bot đã đăng nhập: Tên#1234
Khởi động hoàn tất.
```

Thiếu biến trong `.env` thì tiến trình dừng ngay và in ra đúng tên các khoá còn thiếu.

**Bước 5 — đăng ký lệnh và mời bot**

```bash
docker compose exec kho-plugin node dist/scripts/deploy-commands.js
```

Rồi mời bot vào server bằng link sau, thay `CLIENT_ID` bằng của bạn:

```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=277025508352&scope=bot%20applications.commands
```

## 4. HTTPS — bắt buộc, không phải tuỳ chọn

Container chỉ mở cổng ra `127.0.0.1`, cố ý như vậy. Dashboard mở được ví coin, đơn hàng và toàn bộ kho jar bằng **một mật khẩu duy nhất**, nên nó không được phơi thẳng ra internet qua HTTP. Ngoài ra cookie phiên chỉ được gửi lại qua HTTPS khi `PUBLIC_BASE_URL` bắt đầu bằng `https://` — chạy HTTP trần thì đăng nhập xong sẽ bị đá về trang đăng nhập mãi.

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

Tạo `/etc/nginx/sites-available/kho-plugin`:

```nginx
server {
    listen 80;
    server_name kho.tenmiencuaban.com;

    # Một lượt tải lên hàng loạt là MỘT request chứa mọi jar, mỗi jar tới 300 MB.
    # Mức mặc định 1 MB của nginx sẽ trả 413 trước khi request tới được ứng dụng.
    client_max_body_size 1g;
    client_body_timeout  300s;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Tắt buffering hai chiều: chiều vào để lô jar không bị ghi xuống đĩa ở
        # đây trước khi chuyển tiếp, chiều ra để tải jar chảy thành dòng thay vì
        # bị giữ lại tới khi xong.
        proxy_request_buffering off;
        proxy_buffering         off;
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/kho-plugin /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d kho.tenmiencuaban.com
```

Certbot tự thêm phần HTTPS và tự gia hạn. Xong thì mở `https://kho.tenmiencuaban.com` phải thấy trang đăng nhập.

## 5. Dùng dashboard

Đăng nhập bằng `DASHBOARD_PASSWORD`. Chín mục:

| Mục | Dùng để |
|---|---|
| **Tải lên** | Kéo thả jar vào. Hệ thống đọc descriptor trong jar để tự nhận tên plugin và phiên bản, chống trùng bằng SHA-256 |
| **Plugin** | Danh sách plugin trong kho, đặt **giá cọc** từng plugin, sửa tên phiên bản sai, xoá bản không cần |
| **Chờ xử lý** | Jar không đọc được descriptor thì rơi vào đây để bạn gán tay vào plugin nào |
| **Tài khoản Spigot** | Khai tài khoản Spigot cho bộ tải tự động, xem tài khoản nào sở hữu plugin nào |
| **Đối soát** | Đơn hàng: ai tải gì, đã trả tiền chưa, giao tay hoặc hoàn ví khi cần |
| **Ví coin** | Số dư từng người, cộng/trừ tay, lịch sử giao dịch |
| **Thống kê quỹ** | Tổng tiền đã thu theo thời gian |
| **Lịch sử tải** | Ai tải bản nào, lúc nào |
| **Cấu hình** | Bật/tắt tự động tải Spigot, số bản giữ lại mỗi plugin, thời hạn link tải |

Đặt giá cọc bằng **0** thì plugin đó cho tải miễn phí, không hiện QR.

## 6. Dùng bot trong Discord

Chỉ thành viên có role khai ở `DISCORD_ADMIN_ROLE_IDS` dùng được. Quyền được kiểm lại ở **từng bước**, nên rút role giữa lúc đang chọn phiên bản là dừng ngay tại đó.

| Lệnh | Việc |
|---|---|
| `/menu` | Mở menu chọn plugin → chọn phiên bản → nhận link tải |
| `/find ten:<tên>` | Tìm nhanh theo tên plugin |
| `/panel` | Đặt một bảng thường trú trong kênh, có nút mở menu riêng cho từng người |
| `/vi` | Xem số dư ví coin và lịch sử |
| `/nap` | Nạp ví: chuyển khoản QR hoặc thẻ cào |

Luồng tải một plugin có giá cọc:

1. `/menu` → chọn plugin → chọn phiên bản
2. Bot hiện QR VietQR kèm số tiền và mã đơn
3. Người tải chuyển khoản đúng số tiền, nội dung giữ nguyên mã đơn
4. SePay gọi webhook, bot tự nhận và gửi link tải qua tin nhắn riêng
5. Link hết hạn sau `DOWNLOAD_TOKEN_TTL_MINUTES` phút (mặc định 15)

Có coin trong ví thì bot trừ ví luôn, không cần chuyển khoản.

Jar nhỏ hơn `ATTACH_MAX_BYTES` được gửi kèm thẳng vào tin nhắn; lớn hơn thì gửi link.

## 7. Webhook SePay

Vào bảng điều khiển SePay, thêm webhook:

- **URL**: `https://kho.tenmiencuaban.com/webhooks/sepay`
- **Secret**: đúng chuỗi bạn đặt ở `SEPAY_WEBHOOK_SECRET`

Ba lỗi làm tiền vào mà đơn không được giao:

| Triệu chứng | Nguyên nhân |
|---|---|
| `401 stale-timestamp` | Đồng hồ máy chủ lệch quá 300 giây — chạy `sudo timedatectl set-ntp true` |
| `401` chữ ký sai | Secret hai bên khác nhau |
| Không thấy request nào | URL sai, hoặc webhook trỏ vào HTTP thay vì HTTPS |

Thử không cần tiền thật:

```bash
docker compose exec kho-plugin node dist/scripts/simulate-sepay-payment.js
```

## 8. Tự động tải từ Spigot (tuỳ chọn)

Bật ở mục **Cấu hình** trên dashboard. Bộ tải mở Chrome thật trên màn hình ảo, đăng nhập bằng tài khoản Spigot của bạn và tải các bản đã mua về kho.

**Khai tài khoản.** Tạo `data/spigot-credentials.json`:

```json
[
  { "label": "tai-khoan-1", "username": "tenDangNhap", "password": "matKhau", "enabled": true }
]
```

Đặt quyền `chmod 600 data/spigot-credentials.json` — tệp này chứa mật khẩu dạng chữ thường. Kiểm tra hệ thống đọc đúng chưa (lệnh này **không** đăng nhập, chỉ soi tệp, và không in mật khẩu):

```bash
docker compose exec kho-plugin node dist/scripts/check-spigot-accounts.js
```

**Điều cần biết trước:** mỗi tài khoản Spigot chỉ tải được plugin **chính tài khoản đó đã mua**. Thiếu tài khoản chủ sở hữu thì trang lịch sử không có link tải nào và log ghi `không thấy bản X ở trang lịch sử` — đó là dấu hiệu thiếu tài khoản, không phải lỗi hệ thống.

**Cloudflare.** Spigot chặn bằng Cloudflare Turnstile. Khai `YESCAPTCHA_CLIENT_KEY` để tự giải. Bị chặn dày thì thêm proxy dân cư qua `SPIGOT_PROXY_*` trong `.env`.

**Chạy tay một lượt** thay vì chờ chu kỳ 60 phút: bấm *Kiểm tra cập nhật ngay* ở mục Cấu hình.

## 9. Sao lưu

Hai thứ cần sao lưu: `data/vault.db` (mọi thông tin) và `vault/` (mọi jar).

```bash
sudo apt-get install -y sqlite3
mkdir -p ~/backup
sqlite3 data/vault.db ".backup '$HOME/backup/vault-$(date +%F).db'"
tar czf ~/backup/vault-jars-$(date +%F).tar.gz vault/
```

Dùng `.backup` chứ **đừng** `cp` tệp `.db` khi hệ thống đang chạy: cơ sở dữ liệu ở chế độ WAL, bản copy thô có thể thiếu phần ghi mới nhất.

Đặt lịch hằng ngày bằng cron:

```bash
crontab -e
# thêm dòng — 3 giờ sáng mỗi ngày
0 3 * * * cd /srv/kho-plugin && sqlite3 data/vault.db ".backup '$HOME/backup/vault-$(date +\%F).db'"
```

## 10. Cập nhật lên bản mới

```bash
cd /srv/kho-plugin
sqlite3 data/vault.db ".backup '$HOME/backup/truoc-khi-cap-nhat.db'"   # sao lưu trước
unzip -o kho-plugin-ban-moi.zip -d /srv/kho-plugin
docker compose up -d --build
docker compose logs -f
```

Giải nén đè **không** chạm tới `.env`, `data/`, `vault/`, `tmp/`. Migration cơ sở dữ liệu tự chạy lúc khởi động và tự in ra phiên bản schema.

## 11. Lệnh vận hành thường dùng

```bash
docker compose ps                    # đang chạy hay không
docker compose logs -f               # xem log trực tiếp
docker compose logs --tail 200       # 200 dòng cuối
docker compose restart               # khởi động lại
docker compose down                  # dừng hẳn
docker compose up -d --build         # dựng lại sau khi cập nhật
docker stats kho-plugin              # RAM và CPU đang dùng
```

## 12. Xử lý sự cố

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Container khởi động rồi tắt ngay | Thiếu biến trong `.env` | `docker compose logs` in ra đúng tên khoá còn thiếu |
| `Bot Discord không đăng nhập được` | `DISCORD_TOKEN` sai hoặc đã bị reset | Lấy token mới ở Developer Portal. Dashboard vẫn chạy bình thường lúc này |
| Bot online nhưng không có lệnh nào | Chưa chạy `deploy-commands` | Chạy lại bước 5 mục 3 |
| Bấm lệnh báo `Bạn chưa có quyền tải plugin` | Role của bạn không nằm trong `DISCORD_ADMIN_ROLE_IDS` | Sửa `.env` rồi `docker compose restart` |
| Đăng nhập dashboard xong bị đá về trang đăng nhập | Đang vào bằng HTTP trần trong khi `PUBLIC_BASE_URL` là https | Vào bằng đúng tên miền HTTPS |
| Tải lên báo `413` hoặc mất kết nối | nginx thiếu `client_max_body_size` | Xem lại cấu hình ở mục 4 |
| Plugin có trong kho nhưng bot báo `chưa có bản nào` | Bot đang đọc cơ sở dữ liệu khác — thường là còn một bản cũ chạy song song | `docker compose ps` kiểm tra chỉ có một container, và chắc chắn không còn tiến trình cũ ngoài Docker |
| `Xong lượt quét. Còn N bản đang nợ` không giảm | Thiếu tài khoản Spigot sở hữu các plugin đó | Xem mục 8 |
| Tiền vào mà đơn không giao | Đồng hồ lệch hoặc secret sai | Xem mục 7 |
| Hết đĩa | Kho jar phình | Giảm `PRUNE_KEEP_COUNT` ở mục Cấu hình để giữ ít bản hơn mỗi plugin |

## 13. Những tệp không được để lộ

| Tệp | Chứa gì |
|---|---|
| `.env` | Token Discord, mật khẩu dashboard, khoá phiên, secret webhook |
| `data/spigot-credentials.json` | Mật khẩu Spigot dạng chữ thường |
| `data/spigot-accounts.json` | Cookie phiên Spigot — dùng được như mật khẩu |
| `data/vault.db` | Ví coin, đơn hàng, lịch sử tải |

Đặt `chmod 600` cho ba tệp đầu. Không đưa vào git, không gửi qua chat, không để trong thư mục web.

