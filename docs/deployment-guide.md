# Hướng dẫn triển khai

Tài liệu này dành cho chủ sở hữu kho plugin. Mọi lệnh chạy trên VPS Linux, Node 24.

Nếu bạn đang dựng máy chủ từ đầu — tường lửa, HTTPS, systemd, sao lưu tự động, bảng kiểm sau khi dựng — hãy theo [hosting-setup-guide.md](hosting-setup-guide.md) trước, rồi quay lại đây khi cần chi tiết từng tính năng.

## 1. Yêu cầu

| Thành phần | Yêu cầu | Lý do |
|---|---|---|
| Node.js | **24.x** | Mã dùng `process.loadEnvFile`, và `better-sqlite3` có bản dựng sẵn theo từng phiên bản chính |
| Đĩa trống | ≥ 20 GB | Ước tính: 2 MB/jar × 50 plugin × 15 phiên bản ≈ 1,5 GB; backfill sâu 30-50 phiên bản ≈ 3-5 GB |
| HTTPS công khai | Bắt buộc khi chạy thật | SePay chỉ gửi webhook tới HTTPS ở môi trường Live. Trên localhost, xem [Kiểm thử trên localhost](#kiểm-thử-trên-localhost) |

`TMP_DIR` và `VAULT_DIR` **phải nằm trên cùng một filesystem**. Việc chuyển tệp vào kho dùng `rename`, chỉ nguyên tử trong cùng filesystem — nếu tách ra (ví dụ `vault/` là volume Docker, `tmp/` ở lớp container) thì mọi lần ingest sẽ lỗi `EXDEV`.

## 2. Cài đặt

```bash
git clone https://github.com/SalyyS1/plugin-vault-bot.git
cd plugin-vault-bot
npm ci
npm --prefix dashboard ci
npm --prefix dashboard run build   # tạo dashboard/dist
npm run build                      # biên dịch sang dist/
```

Nếu `better-sqlite3` phải tự biên dịch (nền tảng musl hoặc kiến trúc lạ), cần thêm `build-essential` và `python3`. Đường thông thường dùng bản dựng sẵn, không cần compiler.

## 3. Cấu hình

```bash
cp .env.example .env
```

`.env.example` để trống các giá trị bí mật một cách có chủ đích: tiến trình sẽ **không khởi động** cho tới khi bạn điền giá trị thật. Điều này ngăn việc `cp` rồi chạy luôn với mật khẩu công khai trong repo.

Sinh `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Biến quan trọng

| Biến | Ghi chú |
|---|---|
| `PUBLIC_BASE_URL` | Chỉ dùng để dựng liên kết tải tệp, **không** liên quan tới mã QR (QR do SePay dựng). Để `localhost` thì liên kết chỉ mở được trên chính máy chạy server; tệp nhỏ gửi đính kèm nên không bị ảnh hưởng. Dùng `http://` khi chưa có TLS — điền `https://` mà không có TLS thì trình duyệt không nhận cookie và không đăng nhập được |
| `TRUST_PROXY` | Đặt `true` **chỉ khi** chạy sau reverse proxy bạn kiểm soát. Sai giá trị làm mọi dòng log ghi cùng một IP và rate-limit đăng nhập gộp thành một khoá |
| `DISCORD_ADMIN_ROLE_IDS` | Chỉ là giá trị khởi tạo lần đầu. Sau đó dashboard là nơi quản lý — sửa `.env` rồi restart **sẽ không** thay đổi được |
| `SEPAY_CODE_SUFFIX_LENGTH` | Phải nằm trong khoảng min/max bạn cấu hình ở my.sepay.vn |
| `DASHBOARD_PASSWORD` | Tối thiểu 12 ký tự, ngắn hơn thì tiến trình không khởi động |
| `SESSION_SECRET` | Tối thiểu 32 ký tự (lệnh sinh ở trên cho 64) |
| `SEPAY_WEBHOOK_SECRET` | Tối thiểu 8 ký tự |

Ba giá trị `admin_role_ids`, `prune_keep_count`, `attach_max_bytes` chuyển sang bảng `config` sau lần khởi động đầu. Sửa chúng ở tab **Cấu hình** của dashboard.

## 4. Cấu hình Discord

1. Tạo application tại https://discord.com/developers/applications
2. Trong **Bot** → bật **Server Members Intent**. Đây là privileged intent; **không bật thì kiểm tra role luôn thấy rỗng và mọi admin bị từ chối**.
3. Mời bot vào server với scope `bot` và `applications.commands`.
4. Đăng ký lệnh:

```bash
npm run deploy-commands
```

Chạy thủ công khi phát hành, không chạy mỗi lần khởi động — có giới hạn số lần tạo lệnh mỗi ngày. Lệnh phạm vi guild có hiệu lực ngay.

Lệnh phạm vi guild **không dùng được trong DM**. Hiện tại mọi lệnh đều dùng trong server nên không sao.

## 5. Cấu hình SePay

**Đây là bước dễ sai nhất.** Test mode và Live mode tách biệt hoàn toàn.

1. Tạo webhook, chọn xác thực **HMAC-SHA256**. Secret chỉ hiện **một lần** — copy ngay vào `SEPAY_WEBHOOK_SECRET`, sau đó nó bị che và phải tạo lại.
2. Ghim content-type là `application/json`. Nếu để form-encoded thì cả hình dạng body lẫn dữ liệu ký đều khác.
3. URL webhook: `https://<tên-miền>/webhooks/sepay`
4. Vào **Cấu hình Công ty → Cấu hình chung → Cấu trúc mã thanh toán**, tạo template:
   - Tiền tố: khớp `SEPAY_CODE_PREFIX` (2-5 **chữ cái**, không có số)
   - Độ dài hậu tố: phải bao trùm `SEPAY_CODE_SUFFIX_LENGTH`
   - Loại ký tự: chữ và số
5. **Tạo template này ở CẢ Test mode VÀ Live mode.** Hai môi trường độc lập — chỉ cấu hình Test thì mọi webhook ở production sẽ về với `code` rỗng và không đơn nào khớp được, dù thử ở Test vẫn thành công.
6. Bật bộ lọc "Chỉ gửi khi có mã thanh toán" để giao dịch cá nhân không liên quan không gọi vào endpoint.

Nên chuyển một khoản nhỏ thật ở Live trước khi mở cho admin. Mã QR ở Test mode không gắn với tài khoản ngân hàng thật — app ngân hàng sẽ báo lỗi; chỉ nút mô phỏng trong dashboard SePay hoàn tất được luồng.

### Kiểm thử trên localhost

SePay **không gửi được webhook tới localhost**. Khi chưa có tên miền HTTPS công khai, luồng đặt cọc phải được kiểm thử theo hai cách dưới đây.

**Cách 1 — không cần SePay: đặt giá cọc 0.** Ở tab **Plugin**, sửa giá cọc của plugin về `0`. Bot bỏ qua toàn bộ phần thanh toán và giao tệp ngay, không hiện QR. Đây là cách đơn giản nhất để kiểm tra luồng giao hàng khi SePay chưa cấu hình xong. Đơn chỉ được mở khi giá cọc lớn hơn 0.

**Cách 2 — kiểm thử trọn luồng đặt cọc bằng webhook mô phỏng.** Cần server đang chạy (`npm run dev` hoặc `npm start`) và một plugin có giá cọc lớn hơn 0.

1. Trong Discord, chọn plugin và phiên bản để bot trả về mã QR kèm **mã thanh toán** (ví dụ `VNAB12CD`).
2. Ở terminal khác, gửi webhook mô phỏng:

```bash
npm run simulate-payment -- VNAB12CD 20000
```

Tham số thứ nhất là mã thanh toán, thứ hai là số tiền (mặc định `20000`). Script đọc `SEPAY_WEBHOOK_SECRET` thật trong `.env`, ký payload theo đúng cấu trúc `{timestamp}.{rawBody}` mà SePay dùng, rồi POST tới `http://127.0.0.1:<PORT>/webhooks/sepay`. Nó đi qua **đúng đường xác thực chữ ký thật**, không phải một cửa sau.

Kết quả mong đợi:

| Trường hợp | Kết quả |
|---|---|
| Đủ số tiền | Đơn chuyển `pending` → `paid`, phản hồi `200 {"success":true}`, bot DM tệp |
| Chạy lại cùng mã | Ghi giao dịch mới nhưng **không** cộng tiền lần hai, vì đơn đã `paid` |
| Mã không tồn tại | Giao dịch được ghi với `order_id` rỗng, không đơn nào được cộng |
| Số tiền thiếu | Đơn vẫn `pending`, hiện ở tab **Đối soát** để bạn quyết định |
| Sai secret | `401` chữ ký không hợp lệ |

Số tiền thiếu và mã không tồn tại đều là hành vi đúng, không phải lỗi.

**Nếu bot chưa đăng nhập được** (token sai, hoặc chưa bật Server Members Intent): webhook vẫn trả `200 {"success":true}` và đơn vẫn chuyển sang `paid`, nhưng **không có DM nào được gửi**. Log ghi `đã nhận thanh toán nhưng bot chưa sẵn sàng — cần giao thủ công`, và đơn nằm ở tab **Đối soát** để bạn bấm giao lại. Đây là thiết kế có chủ đích: mất phần giao tự động vẫn tốt hơn là trả lỗi cho một khoản tiền đã nhận. Nếu thấy "thành công" mà không có tệp, hãy kiểm tra log bot trước khi nghi ngờ luồng thanh toán.

**Mỗi lần chạy là một giao dịch riêng.** Script sinh `id` giao dịch theo mili-giây, nên chạy liên tiếp vẫn ra `id` khác nhau. Bản thân `id` là khoá chống trùng lặp: nếu gửi lại **cùng một `id`** (điều SePay làm khi retry) thì lần sau bị bỏ qua có chủ đích.

**Liên kết tải trên localhost:** tệp lớn hơn `ATTACH_MAX_BYTES` (mặc định 8 MB) được giao bằng liên kết dựng từ `PUBLIC_BASE_URL`, tức `http://localhost:3000/download/...` — chỉ mở được trên chính máy đó. Tệp nhỏ hơn ngưỡng vẫn gửi đính kèm bình thường, không bị ảnh hưởng. Để kiểm thử trên localhost, hãy dùng jar nhỏ.

## 5b. Ví coin và nạp thẻ cào (card2k)

### Ví coin — chạy được ngay, không cần cấu hình gì thêm

1 coin = 1.000 ₫. **Số dư lưu bằng đồng**, coin chỉ là cách hiển thị; nạp 1.500 ₫
thì ví hiện "1 coin" nhưng vẫn giữ đủ 1.500 ₫.

| Lệnh | Việc |
|---|---|
| `/vi` | Xem số dư và 5 giao dịch gần nhất |
| `/nap` | Mở nút nạp (chuyển khoản, và thẻ cào nếu đã cấu hình) |

Khi mua plugin, ví được trừ trước, phần thiếu mới ra QR:

| Số dư ví | Kết quả |
|---|---|
| Đủ giá cọc | Trừ ví, **giao ngay**, không có QR |
| Ít hơn giá cọc | Trừ hết ví, QR chỉ mang phần còn thiếu |
| Bằng 0 | Như trước, QR mang toàn bộ giá cọc |

Coin bị trừ **ngay lúc mở đơn**, không phải lúc giao — nếu không, mở hai đơn cùng
lúc sẽ tiêu một số dư hai lần. Đơn hết hạn thì coin được hoàn tự động. Chuyển khoản
thừa cũng vào ví thay vì mất.

**Giao thất bại thì coin vẫn được giữ, không tự hoàn.** Lỗi giao hàng phần lớn là
tạm thời (tệp chưa mount xong, Discord lỗi), nên đơn nằm lại ở tab **Đối soát** để
bấm giao lại. Tự hoàn ngay sẽ thành trả lại coin **rồi** vẫn giao được tệp — mà với
đơn trả trọn bằng ví thì liên kết tải vừa tạo vẫn còn hiệu lực. Khi bạn quyết định bỏ
đơn, bấm **Hoàn coin** ở tab Đối soát: coin về ví và đơn đóng lại, không giao được nữa.

Tab Đối soát hiện cả cột **Giữ coin** và cả đơn trả trọn bằng ví — với đơn loại này
không có webhook nào tới nữa, nên đây là chỗ duy nhất còn thấy được nó.

Mọi thay đổi số dư đều đi qua một hàm duy nhất và luôn kèm một dòng sổ cái. Tab
**Ví coin** hiện cảnh báo đỏ nếu số dư lệch tổng sổ cái — bình thường phải luôn
rỗng; nếu thấy nó, đừng chỉnh tay mà kiểm tra log trước.

### Nạp thẻ cào — mặc định TẮT

Cần các biến sau. **Thiếu bất kỳ biến nào là tính năng tắt**, nút "Nạp bằng thẻ cào"
không xuất hiện, và log lúc khởi động nói rõ đang thiếu gì.

```dotenv
CARD2K_PARTNER_ID=
CARD2K_PARTNER_KEY=
# Thứ tự nối chuỗi để ký md5, ví dụ: partner_key,code,serial
CARD2K_SIGN_FIELDS=
CARD2K_COMMAND_CHARGE=
CARD2K_COMMAND_CHECK=
```

**Hai giá trị `CARD2K_SIGN_FIELDS` và `CARD2K_COMMAND_*` không có tài liệu công
khai.** Tài liệu API của card2k nằm sau đăng nhập, và plugin chính chủ của họ mã hoá
toàn bộ chuỗi trong jar. Chúng cố tình **không có giá trị mặc định**: ký sai thứ tự
trả về lỗi giống hệt mọi lỗi khác nên không dò ngược được, mà mỗi lần thử sai có thể
mất một thẻ thật.

Cách lấy:

1. Đăng ký ở `card2k.com`, tạo kết nối **"Đổi thẻ cào"** ở `card2k.com/partner`.
2. Mở ticket ở `discord.card2k.com` kèm Partner ID để **kích hoạt** — khoá mới mặc
   định chưa hoạt động, chưa kích hoạt thì gọi API nào cũng bị từ chối.
3. Hỏi thẳng trong ticket: công thức `sign` và thứ tự trường (cho **cả** lệnh nạp và
   lệnh kiểm tra), danh sách giá trị `command`, bảng mã `status` đầy đủ, **bảng phí
   chiều đổi thẻ**, có hỗ trợ callback không, và `sandbox.card2k.com` còn sống không.

`sandbox.card2k.com` hiện **không phân giải DNS**, nên hãy tính trước là phải kiểm
thử trên môi trường thật bằng thẻ mệnh giá 10k.

### Cách nạp thẻ hoạt động

`/nap` → **Nạp bằng thẻ cào** → chọn nhà mạng → chọn mệnh giá → nhập serial và mã
thẻ trong modal. Modal chứ không phải chat: mã thẻ gõ vào kênh thì cả server đọc
được và nằm lại trong lịch sử.

Nhà mạng hỗ trợ: Viettel, VinaPhone, MobiFone, Garena, Zing, VCoin.
**Vietnamobile không nạp được.** Chỉ Viettel có mệnh giá 1.000.000.

**card2k không gửi callback** — bot tự hỏi lại mỗi 60 giây, tối đa 30 lần (trần 30
phút). Trạng thái nằm trong database nên restart giữa lúc chờ vẫn dò tiếp.

| Kết quả | Ví | Ghi chú |
|---|---|---|
| Thành công | +đúng mệnh giá | Bạn gánh phí, khách nhận đủ |
| Sai mệnh giá | +**giá trị thật của thẻ** | Thẻ đã bị nuốt, từ chối cũng không lấy lại được |
| Thẻ lỗi/đã dùng | không cộng | Mã thẻ được giữ lại để khách thử nơi khác |
| Hết 30 lần dò | **không cộng** | Vào tab Ví chờ bạn xử lý |
| Trạng thái lạ | **không cộng** | Vào tab Ví chờ bạn xử lý |

Hai dòng cuối cố tình **không** coi là thẻ lỗi: thẻ có thể đã bị trừ thật mà ta không
biết, nên phải để người xem thay vì âm thầm bỏ.

### Phí thẻ bạn đang gánh

Ví được cộng theo **giá trị thật của thẻ**, còn card2k trả về ít hơn. Khoảng chênh đó
là chi phí của bạn và không hiện ở đâu khác, nên tab **Ví coin** có một dòng tổng
theo tháng: đã cộng ví bao nhiêu, card2k trả bao nhiêu, bạn gánh bao nhiêu.

Lưu ý bảng giá công khai ở `card2k.net/api/v1/client/card-types` (97–100%) là chiều
**mua** thẻ, **không phải** chiều đổi thẻ. Tỉ lệ đổi thẻ thực tế thấp hơn đáng kể —
hãy lấy bảng phí đúng chiều từ ticket rồi tính lại giá cọc nếu cần.

Riêng khoản **khai sai mệnh giá**: mức phí phạt của card2k không có tài liệu, và ở
các cổng cùng loại nó có thể rất nặng. Vì bạn đang gánh khoản này, hãy thử **một** thẻ
khai sai có chủ đích khi đã có khoá thật để biết con số, trước khi mở cho nhiều người
dùng.

## 6. Chạy

```bash
npm start
```

Chạy bản đã biên dịch trong `dist/`, nên phải `npm run build` trước mỗi lần sửa mã. Khi phát triển trên máy cá nhân, dùng bản tự nạp lại thay thế:

```bash
npm run dev
```

Thứ tự khởi động: kiểm tra cấu hình → migration → dọn tệp tạm mồ côi → HTTP → đăng nhập bot → hẹn giờ bảo trì.

Token Discord sai **không** làm sập dashboard — bot ngừng, log ghi rõ lý do, dashboard vẫn truy cập được để bạn sửa.

### systemd

```ini
[Unit]
Description=Plugin Vault Bot
After=network.target

[Service]
Type=simple
User=vault
WorkingDirectory=/srv/plugin-vault-bot
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory` là **bắt buộc**: `.env` được đọc theo thư mục làm việc của tiến trình, nên chạy từ chỗ khác là không thấy tệp và tiến trình dừng với danh sách biến thiếu. Riêng các đường dẫn kho (`VAULT_DIR`, `DB_PATH`…) thì giải theo gốc dự án chứ không theo CWD.

Bản đầy đủ hơn — tường lửa, HTTPS, sao lưu tự động, bảng kiểm sau khi dựng — ở [hosting-setup-guide.md](hosting-setup-guide.md).

## 7. Sao lưu

Cần sao lưu **hai** thứ, và `data/vault.db` là thứ không thể tái tạo:

```bash
# Database — dùng lệnh backup của SQLite, không copy tệp đang mở (WAL)
sqlite3 data/vault.db ".backup '/backup/vault-$(date +%F).db'"

# Kho jar
rsync -a vault/ /backup/vault/
```

Mất `vault/` thì tải lại từ Spigot được. Mất `data/vault.db` là mất toàn bộ lịch sử tải, sổ ghi thanh toán và số liệu quỹ — không có cách nào dựng lại.

## 8. Vận hành thường ngày

**Nạp plugin:** tab Tải lên, kéo thả nhiều `.jar` cùng lúc. Hệ thống đọc descriptor bên trong jar để tự phân loại. Jar không đọc được vào tab **Chờ xử lý** để bạn gán tay.

**Đặt giá cọc:** tab Plugin → chọn plugin → sửa giá. Giá 0 nghĩa là tải không cần thanh toán.

**Gắn mã resource Spigot:** cần thiết nếu muốn nhận thông báo bản mới. Không gắn thì plugin đó không được theo dõi.

**Đánh dấu ổn định:** phiên bản đánh dấu ổn định **không bao giờ bị prune**, bất kể nằm ngoài số lượng giữ lại.

**Prune:** chạy mỗi ngày, giữ mọi bản ổn định cộng N bản mới nhất. Xoá là không hoàn tác được — mỗi lần xoá đều ghi log.

**Thanh toán bị treo:** nếu webhook không tới, đơn nằm ở trạng thái đã trả nhưng chưa giao. SePay không có API tra cứu giao dịch, nên đây là đường phục hồi duy nhất: dùng nút giao thủ công.

## 9. Tự động tải từ Spigot (không bắt buộc)

**Mặc định tắt.** Bật đồng nghĩa bạn chấp nhận: điều khoản SpigotMC cấm truy cập tự động, và tài khoản bị khoá là tài khoản đang giữ toàn bộ plugin bạn đã mua. Jar premium cũng bị đóng dấu theo từng lần tải với ID tài khoản của bạn — điều này đúng cả khi tải tay, nhưng tự động thì số lượng jar nhiều hơn.

Chạy **hoàn toàn tự động**: bot tự đăng nhập Spigot, tự tải bản mới, tự nhập kho. Bạn chỉ dán tài khoản vào một tệp, một lần.

### Cài đặt trên VPS

```bash
# Debian 12
sudo apt-get install -y xvfb chromium

# Ubuntu 22.04/24.04 — không có gói `chromium` dạng deb, dùng .deb của Google
sudo apt-get install -y xvfb
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb

npm ci                                  # cài cả puppeteer-real-browser đã pin trong package.json
```

Cần **cả hai**: `puppeteer-real-browser` là dependency production đã pin, nhưng nó không mang theo Chrome. Thiếu trình duyệt thì bot báo `The CHROME_PATH environment variable must be set to a Chrome/Chromium executable` — thông báo đó của thư viện bên dưới và nghe như thiếu biến môi trường, nhưng nguyên nhân thật là **máy chưa có Chrome**.

Đừng cài bằng `npm ci --omit=dev`: `tsx` và `typescript` là devDependency, nên bỏ dev là mất `npm run build` và toàn bộ lệnh vận hành (`deploy-commands`, `spigot-login`, `check-accounts`…).

**Không có quyền sudo?** Tải Chrome về thư mục người dùng, không cần root:

```bash
npx puppeteer browsers install chrome
```

Bot tự tìm cả bản này. Cách apt vẫn tốt hơn nếu có sudo, vì nó tự cập nhật theo hệ thống.

Kiểm tra máy đã có Chrome chưa:

```bash
which google-chrome chromium chromium-browser
```

Không ra gì nghĩa là **chưa cài** — hãy chạy một trong hai lệnh trên.

Bot tự tìm trình duyệt ở các đường dẫn thông thường (`/usr/bin/chromium`, `/usr/bin/google-chrome-stable`, `/opt/google/chrome/chrome`, `/snap/bin/chromium`, `~/.cache/puppeteer/…`). Nếu Chrome của bạn nằm chỗ khác, thêm vào `.env`:

```
CHROME_PATH=/đường/dẫn/tới/chrome
```

`xvfb` nghe như "trình duyệt" nhưng nó **không hiện gì cả** — không cửa sổ, không giao diện, không cần ai ngồi bấm. Chrome chạy trên một màn hình ảo trong bộ nhớ, y như mọi tiến trình nền khác. Tốn khoảng 500 MB đĩa.

Vì sao bắt buộc: endpoint tải của Spigot chỉ trả file khi **cả trang được điều hướng tới** trong trình duyệt thật. Đã đo — `curl` và `fetch` đều nhận trang chặn Cloudflare, kể cả khi mang theo cookie phiên hợp lệ. Chế độ `headless` thuần cũng bị chặn. Đây là giới hạn của Spigot, không phải lựa chọn thiết kế.

### Dán tài khoản

Một tệp, mỗi dòng **ba cột** cách nhau bằng dấu cách: `tên-gợi-nhớ  tên-đăng-nhập  mật-khẩu`

```bash
cat > spigot-credentials.json <<'EOF'
acc-chinh  TEN_DANG_NHAP_1  MAT_KHAU_1
acc-2      TEN_DANG_NHAP_2  MAT_KHAU_2
acc-3      TEN_DANG_NHAP_3  MAT_KHAU_3
EOF
chmod 600 spigot-credentials.json
```

Cột đầu chỉ là tên để bạn nhận ra trong log — đặt gì cũng được. Cột hai là **tên đăng nhập thật trên spigotmc.org** (không phải email hiển thị, không phải tên trong game).

Ba lỗi hay gặp nhất:

- **Không đặt dấu nháy** quanh tên hay mật khẩu. `"tendangnhap"` sẽ được gửi kèm cả dấu nháy và luôn sai.
- **Chỉ có 2 cột** thì cột đầu bị hiểu là tên đăng nhập, cột hai là mật khẩu — mất cột tên gợi nhớ mà không báo lỗi.
- **Đừng copy từ Word/Zalo/Discord**: các ứng dụng đó đổi `'` thành `'` và bot gửi đúng ký tự lạ đó. Hãy gõ tay.

Kiểm tra bot đọc được đúng chưa:

```bash
npm run check-accounts
```

Lệnh này in ra tên đăng nhập bot thật sự dùng, độ dài mật khẩu, và cảnh báo những dấu hiệu sai định dạng ở trên. **Mật khẩu không bao giờ được in ra.** Chạy lệnh này trước khi đi tìm lỗi ở nơi khác — `Incorrect password` thường là tệp sai định dạng chứ không phải mật khẩu sai.

Mật khẩu có dấu cách thì buộc phải dùng dạng JSON:

```json
[{ "label": "acc-chinh", "username": "ten", "password": "mat khau co dau cach" }]
```

Rồi bật công tắc **Tự động tải bản mới từ Spigot** ở tab **Cấu hình**. Xong — không phải làm gì nữa.

**Tệp này chứa mật khẩu dạng chữ.** Bắt buộc phải vậy vì bot cần gõ chúng vào form đăng nhập. Đã gitignore và bot cảnh báo nếu quyền rộng hơn `0600`, nhưng ai đọc được tệp là chiếm được tài khoản Spigot của bạn. Đây là cái giá thật của việc tự động hoàn toàn.

### Nó tự làm gì

Mỗi giờ, sau khi phát hiện có bản mới:

1. Quét trang "đã mua" của từng tài khoản, **ghi lại tài khoản nào sở hữu plugin nào**
2. Mở Chrome trên màn hình ảo, đăng nhập tài khoản **sở hữu plugin đó** — không phải tài khoản đầu tiên
3. Tra id phiên bản: thử `fetch` thuần trước (trang lịch sử của plugin miễn phí không bị Cloudflare chặn), chỉ dùng trình duyệt khi plugin premium đòi đăng nhập
4. Tải từng bản, cách nhau 20 giây để tránh bị khoá
5. Jar vào kho qua đúng luồng nhập liệu như khi bạn kéo thả: đọc descriptor, chống trùng SHA-256, tự phân loại
6. Chỉ báo lên Discord khi **đã tải xong**, cần gán tay, hoặc cookie hết hiệu lực

**Khi còn bản đang nợ, bot quét lại sau 5 phút thay vì chờ đủ 60 phút.** Nhờ vậy kho mới đầy trong một buổi tối chứ không mất vài tuần. Hết nợ thì quay lại nhịp mỗi giờ. Sửa `SPIGOT_BACKLOG_RESWEEP_MS` và `SPIGOT_MAX_DOWNLOADS_PER_SWEEP` nếu muốn đổi, nhưng **đừng bỏ khoảng nghỉ 20 giây** (`SPIGOT_DOWNLOAD_MIN_INTERVAL_MS`) — đó là thứ giữ cho lưu lượng không giống một đợt tấn công, và tài khoản bị khoá là tài khoản giữ toàn bộ plugin bạn đã mua.

### Bảo trì định kỳ — bắt buộc biết

**Cookie đăng nhập của XenForo hết hạn sau 30 ngày** và con số đó không đổi được. Nếu không làm gì, hệ thống chạy tốt suốt một tháng rồi im lặng dừng.

Bot tự đăng nhập lại mỗi lượt nên trường hợp thường không cần can thiệp. Nhưng khi log báo `cookie hết hiệu lực` hoặc `needs_login`, chạy:

```bash
npm run spigot-login -- <tên-tài-khoản>
```

### Lệnh dọn dẹp khi dữ liệu sai

| Lệnh | Dùng khi |
|------|----------|
| `npm run check-accounts` | Nghi tệp tài khoản sai định dạng. In tên đăng nhập và hình dáng mật khẩu, **không in mật khẩu** |
| `npm run rescan-purchased` | Vừa sửa mật khẩu và muốn quét lại danh sách đã mua ngay, không chờ hết ngày |
| `npm run tidy-names` | Menu Discord sắp xếp lộn xộn vì tên plugin mang emoji và khoảng phiên bản |
| `npm run reset-spigot-state` | Dữ liệu "ai sở hữu gì" bị sai. Xoá phần bot tự học, **giữ nguyên** plugin, jar, đơn hàng |

Hai lệnh cuối chạy không tham số là **xem trước**, phải thêm `-- --yes` mới thực hiện. `check-accounts` chỉ đọc và in ra; `rescan-purchased` chỉ xoá dấu "đã quét hôm nay" nên chạy lúc nào cũng an toàn, và nhận thêm tên một tài khoản nếu chỉ muốn quét lại account đó.

Bot **đăng nhập lại mỗi lượt quét**, nên không có chuyện cookie hết hạn rồi bạn phải đi lấy lại. Đây là lý do dùng mật khẩu thay vì cookie.

### Không cần gắn mã resource thủ công

Sau khi đăng nhập, bot tự mở trang **Purchased Resources** của Spigot, đọc danh sách plugin bạn đã mua, rồi tự gắn mã cho plugin trong kho.

Trên Discord/log bạn sẽ thấy:

| Dòng | Nghĩa |
|---|---|
| 🔗 `Vulcan — đã gắn mã resource 83626 từ danh sách đã mua` | Ghép được với plugin có sẵn |
| ➕ `Vulcan — thêm vào kho từ danh sách đã mua` | Đã mua nhưng kho chưa có, tự tạo mục mới |
| ❓ `Đã mua nhưng chưa có trong kho: ...` | Không ghép được, cần bạn xử lý |

Ghép theo **tên**, và chỉ khi chắc chắn. Tên trên Spigot dài (`Vulcan Anti-Cheat | Advanced Cheat Detection | 1.8-26.2 | Folia Supported!`) còn tên trong kho lấy từ descriptor của jar (`Vulcan`), nên bot cắt phần trang trí sau dấu `|` rồi mới so sánh.

Hai trường hợp bot **không** đoán bừa:

- Hai plugin trong kho trùng tên sau khi chuẩn hoá → báo `❓` thay vì gắn nhầm
- Plugin đã có mã sẵn → **không bao giờ ghi đè**, vì bạn có thể đã sửa tay

Vẫn gắn tay được ở tab **Plugin** nếu muốn, bot sẽ tôn trọng giá trị đó.

### Khi nào bot quét

Lần quét đầu chạy **30 giây sau khi khởi động**, rồi mỗi 60 phút. Nên muốn kiểm tra ngay thì chỉ cần restart:

```bash
sudo systemctl restart plugin-vault
sudo journalctl -u plugin-vault -f
```

Chờ 30 giây là thấy `Đã đăng nhập Spigot: ...` hoặc thông báo lỗi. Không phải đợi hết một tiếng mới biết mật khẩu gõ sai.

Trễ 30 giây chứ không chạy ngay, để Discord kịp kết nối — nếu không, kết quả chỉ vào log chứ không tới kênh thông báo.

### Lượt quét đầu tiên chậm hơn, sau đó nhanh

Lần đầu bot phải thử lần lượt các tài khoản để biết tài khoản nào mua plugin nào. Kết quả được ghi lại, nên từ lượt sau nó **đi thẳng tới tài khoản đúng** — 1 request thay vì N.

| Lượt | Với 3 tài khoản, plugin do tài khoản thứ 3 mua |
|---|---|
| Đầu tiên | 3 lần thử (học) |
| Về sau | 1 lần thử |

Điều này quan trọng hơn tốc độ: liên tục nhận 403 trên nhiều tài khoản là dấu hiệu giống dò mật khẩu nhất, và là thứ dễ khiến tài khoản bị khoá.

Bot chỉ ghi "không mua" khi tài khoản **đã đăng nhập được mà vẫn bị từ chối**. Nếu gặp Cloudflare chặn hay phiên hỏng thì không ghi gì — hai thứ đó không nói lên bạn có mua hay không, ghi vào sẽ làm sai bộ nhớ.

Tài khoản "không mua" bị xếp cuối chứ **không bị loại**: sau này bạn mua thêm thì bot vẫn tìm ra. Xoá một tài khoản khỏi tệp thì bộ nhớ về nó cũng bị xoá theo, nên đổi tên tài khoản không gây lỗi.

### Thông báo trên Discord

| Thông báo | Nghĩa |
|---|---|
| ✅ đã tải và lưu vào kho | Xong, không cần làm gì |
| ➖ đã có trong kho | Trùng nội dung, bỏ qua — bình thường khi chưa có bản mới |
| ⚠️ không đọc được thông tin plugin | Vào tab **Chờ xử lý** gán tay |
| 🛒 không tài khoản nào đã mua | Tải thủ công plugin này |
| 🔑 cookie hết hiệu lực | Chỉ gặp khi dùng cách cookie — lấy lại cookie |
| 🛑 Spigot đang chặn | Đã dừng để tránh bị khoá, sẽ thử lại lượt sau |
| 🔄 tải lỗi, sẽ thử lại | Tự thử lại, không mất phiên bản nào |

Bản nào tải lỗi được ghi vào hàng chờ, nên tắt máy hay mất mạng giữa lượt quét cũng không làm mất phiên bản đó.

Hai thông số điều tiết, đổi trong `.env` nếu cần: `SPIGOT_DOWNLOAD_MIN_INTERVAL_MS` (mặc định 20 giây giữa hai lần tải) và `SPIGOT_MAX_DOWNLOADS_PER_SWEEP` (mặc định 25 bản mỗi lượt — chỉ là chặn trên để một lượt không chạy vô hạn; thứ điều tiết thật là khoảng nghỉ). Tải tuần tự, không song song — tải ồ ạt là tín hiệu rõ nhất để bị khoá tài khoản.

### Nếu chỉ muốn dùng cookie, không lưu mật khẩu

Vẫn được: bỏ tệp `spigot-credentials.json`, tạo `spigot-accounts.json` chứa cookie phiên. Bot ưu tiên tệp mật khẩu khi có cả hai.

Đánh đổi: cookie hết hạn thì **bạn** phải đi lấy lại, còn mật khẩu thì bot tự đăng nhập lại mỗi lượt quét. Nếu mục tiêu là không phải động tay thì dùng mật khẩu.

Lấy cookie: đăng nhập spigotmc.org trong trình duyệt, **bắt buộc tick "Stay logged in"** (không tick thì Spigot không tạo `xf_user` mà chỉ có phiên sống 1 giờ). F12 → Application → Cookies → `https://www.spigotmc.org`, copy `xf_user` và `xf_session` **nguyên văn** — `xf_user` có dạng `1%2Cabc...`, sửa dấu `%2C` là mất hiệu lực.

```json
[
  { "label": "acc-chinh", "xfUser": "1%2Cabc...", "xfSession": "def..." },
  { "label": "acc-2",     "xfUser": "2%2Cxyz...", "xfSession": "uvw..." }
]
```

Nhiều tài khoản: không cần logout tài khoản cũ. Mở **cửa sổ ẩn danh mới** cho từng tài khoản (đóng hẳn cửa sổ cũ trước khi mở cái mới, vì các tab ẩn danh dùng chung phiên). Cookie đã copy ra không bị ảnh hưởng khi bạn logout ở trình duyệt.

Cookie `xf_user` mặc định 30 ngày và được gia hạn mỗi lần bot dùng, nên khi bot chạy đều thì thực tế không hết hạn. Nó chỉ chết khi bạn **đổi mật khẩu Spigot**, hoặc bot ngừng chạy quá 30 ngày. Logout ở trình duyệt khác **không** ảnh hưởng — Spigot quản phiên theo từng cookie.

Khi cookie chết, bot nhắn bạn và dừng lượt quét thay vì thử tài khoản khác: thử tiếp trông giống dò mật khẩu và dễ bị khoá.

### Tắt đi

Tắt công tắc ở tab **Cấu hình**, hoặc xoá tệp tài khoản (`spigot-credentials.json` / `spigot-accounts.json`). Cả hai cách đều không ảnh hưởng gì tới các phần khác của hệ thống — thông báo bản mới vẫn chạy như trước.

## 10. Điều cần biết về giới hạn

**Tệp trên 8 MB được gửi bằng liên kết, không phải đính kèm.** Discord giới hạn 10 MiB cho mỗi tệp, và **DM không được hưởng lợi từ boost server** — giới hạn tính theo bên tải lên (bot, không có Nitro) và kênh DM không thuộc server nào. Server Level 3 cũng không nâng được. Liên kết dùng một lần, hết hạn theo `DOWNLOAD_TOKEN_TTL_MINUTES`.

**Dữ liệu phiên bản plugin premium có thể chậm.** Spiget lấy dữ liệu premium với độ chính xác thấp hơn vì SpigotMC không cấp quyền. Thông báo có ghi chú điều này — hãy kiểm tra lại trên trang resource trước khi tải.

**Spigot có thể chặn tải tự động.** Điều khoản SpigotMC cấm truy cập tự động, và jar premium bị đóng dấu theo từng lần tải với ID tài khoản của bạn. Mặc định hệ thống không giải CAPTCHA: phiên bị chặn được giữ trong hàng đợi để thử lại an toàn. Việc mua lời giải Cloudflare là **tuỳ chọn, mặc định tắt** — xem `YESCAPTCHA_CLIENT_KEY` ở mục dưới.

## Xử lý Cloudflare trên VPS

Chrome, Xvfb, profile đăng nhập và tiến trình tải đều chạy trong **cùng một host Linux** (VPS hoặc container) với bot. Không cần worker Windows, SFTP trung gian hay máy thứ hai. Proxy là tùy chọn — xem mục proxy xoay bên dưới.

Các lệnh bảo trì Spigot và launcher browser có guard **Linux host-only**. Nếu ai chạy project trên Windows/macOS, phần dashboard/bot vẫn có thể được phát triển, nhưng browser đăng nhập và tiến trình tải JAR sẽ từ chối khởi động để không đưa credential, cookie hoặc plugin về máy cá nhân.

Mặc định `SPIGOT_INTERACTIVE_CHALLENGE=false`: khi Cloudflare chặn một account, bot đóng browser đó, đặt account vào cooldown theo `SPIGOT_CHALLENGE_COOLDOWN_MS` (mặc định 30 phút), rồi tiếp tục thử account khác. Cooldown được lưu qua restart và được xoá ngay sau lần đăng nhập thành công. Phiên bản chưa tải vẫn nằm trong hàng đợi, tôn trọng `next_attempt_at` và không bị đánh dấu là chưa mua.

Chế độ dashboard chỉ là tùy chọn chẩn đoán. Nếu đặt `SPIGOT_INTERACTIVE_CHALLENGE=true`, bot giữ tab của account tối đa 20 phút và hiện mục **Xác minh trên browser VPS**. Chế độ này cần người thao tác nên không phù hợp với host yêu cầu tự động hoàn toàn.

Không có cổng VNC/CDP công khai: ảnh và input đi qua API dashboard đã xác thực trên cổng ứng dụng hiện tại. Tuy vậy production nên phục vụ dashboard bằng HTTPS vì HTTP không mã hóa cookie quản trị hoặc thao tác browser trên đường truyền.

### Proxy xoay (tuỳ chọn)

IP máy chủ/VPS mở hàng chục phiên đăng nhập liên tiếp là thứ Cloudflare đánh dấu mạnh nhất. Có hai cách khai báo proxy, dùng riêng hoặc dùng chung:

| Biến | Dùng khi |
|---|---|
| `SPIGOT_PROXY_LIST` | Có sẵn danh sách proxy. Phân cách bằng dấu phẩy hoặc xuống dòng; nhận `host:port`, `scheme://host:port`, `user:pass@host:port`, `host:port:user:pass`. |
| `SPIGOT_PROXY_FILE` | Danh sách dài, mỗi dòng một proxy. Gộp với `SPIGOT_PROXY_LIST`. |
| `SPIGOT_PROXY_API_URL` | Dịch vụ xoay theo lượt gọi, trả JSON `{ success, data: { proxyHttp: "host:port" } }`. URL chứa api_key nên chỉ đặt trong `.env`. |

Danh sách tĩnh được dùng trước, API chỉ tới lượt khi mọi proxy trong danh sách đang nghỉ — vì danh sách cho bot biết **còn bao nhiêu IP rảnh**, thông tin cần để quyết định đổi IP hay cho account nghỉ.

Cách bể proxy hoạt động:
- Chọn proxy lâu chưa dùng nhất, nên tải rải đều thay vì dồn vào một IP.
- Proxy làm hỏng một lần mở được cho nghỉ `SPIGOT_PROXY_COOLDOWN_MS` (mặc định 10 phút); hỏng lần nữa thì nghỉ gấp đôi, nên proxy đã hết hạn tự rơi ra khỏi vòng chọn.
- Một lần mở thử tối đa `SPIGOT_PROXY_MAX_ATTEMPTS` proxy (mặc định 3). Hết proxy rảnh thì kết nối thẳng — thà chậm còn hơn bỏ cả account.
- Lỗi của proxy (`ERR_PROXY_CONNECTION_FAILED`, `ERR_TUNNEL_CONNECTION_FAILED`…) được phân biệt với chặn Cloudflare: proxy bị cho nghỉ, còn account **không** bị phạt.
- Bị Cloudflare chặn lúc đăng nhập mà còn IP khác: bot đổi IP và thử lại một lượt trước khi cho account nghỉ. Bị chặn giữa lượt tải thì proxy đó cũng bị cho nghỉ.
- Proxy có mật khẩu được xử lý qua `page.authenticate`, vì Chrome bỏ qua `user:pass` trong `--proxy-server` và trả lời 407 bằng hộp thoại mà tự động hoá không thấy.
- Log chỉ nêu id ngắn (`p-3f2a`), không bao giờ in địa chỉ hay api_key.
- Proxy chỉ áp dụng cho đường qua trình duyệt (đăng nhập, tải jar); tra cứu phiên bản công khai vẫn fetch thẳng.
- Mỗi account có profile Chrome riêng (giữ phiên + `cf_clearance`), nhưng vì IP đổi qua từng lần mở, Cloudflare có thể đòi xác minh lại dù profile còn vé — lúc đó cooldown/dashboard ở trên xử lý tiếp.

### Mua lời giải Cloudflare bằng YesCaptcha (tuỳ chọn)

Dành cho một trường hợp cụ thể: Chrome chạy đúng, xvfb đúng, proxy đúng, **mà trang vẫn đứng ở "Just a moment..." cho tới hết 90 giây và không hiện widget nào để bấm**. Đã gặp thật trong container của một host, trong khi cùng code / cùng bản Chrome / cùng account trên một VPS thì sạch trong ~12 giây; đã loại phông, User-Agent, `navigator.webdriver`, kích thước màn hình, WebGL, cờ Chrome, profile và hơn 12 IP dân dụng mà chưa cô lập được nguyên nhân. Thay vì tìm tiếp, bot mua sẵn cái vé (`cf_clearance`) mà thử thách phát ra rồi nhét vào Chrome.

**Mặc định tắt.** Để trống `YESCAPTCHA_CLIENT_KEY` thì mọi cú chặn xử lý y như trước và không có lời gọi nào ra ngoài.

| Biến | Ý nghĩa |
|---|---|
| `YESCAPTCHA_CLIENT_KEY` | Khoá từ yescaptcha.com. Trống = tắt. Là bí mật trả tiền, chỉ đặt trong `.env`. |
| `YESCAPTCHA_BASE_URL` | `https://api.yescaptcha.com` (mặc định) hoặc `https://cn.yescaptcha.com` cho node trong nước. |
| `YESCAPTCHA_TIMEOUT_MS` | Trần chờ một lời giải, mặc định 120000. Nhà cung cấp trả kết quả sau 10–80 giây. |
| `YESCAPTCHA_CLEARANCE_TTL_MS` | Giữ vé bao lâu trước khi mua vé mới, mặc định 2700000 (45 phút). |
| `YESCAPTCHA_MAX_SOLVES_PER_SWEEP` | Trần số lượt **giải** mỗi lượt quét, mặc định 10. Lượt dùng lại vé không tính. |

**Bắt buộc phải có proxy.** Loại task Cloudflare của YesCaptcha có trường proxy là bắt buộc, và Cloudflare buộc vé vào đúng IP + đúng User-Agent đã giải nó. Chỉ đặt khoá mà không đặt `SPIGOT_PROXY_LIST` hoặc `SPIGOT_PROXY_API_URL` thì bot ghi một dòng cảnh báo rồi bỏ qua. Vài điểm thực tế:

- **Proxy tĩnh (IP không đổi) tốt hơn proxy xoay.** Vé sống khoảng một giờ; nếu nhà cung cấp xoay IP giữa lúc giải và lúc dùng thì vé chết và mất tiền cho một lượt vẫn bị chặn.
- **socks5 kèm mật khẩu không dùng được** — nhà cung cấp không hỗ trợ, bot từ chối sớm kèm lý do. Dùng http/https.
- Nếu proxy chặn theo IP, phải whitelist IP của YesCaptcha: `43.156.113.227`.

Hai cái phanh cho hoá đơn: mỗi lượt giải tốn 25 điểm, nên vé được **cache theo cặp (proxy, User-Agent)** và dùng chung được giữa các account trong cùng lượt quét — `cf_clearance` chứng minh một IP đã qua thử thách, không phải chứng minh danh tính ai — còn `YESCAPTCHA_MAX_SOLVES_PER_SWEEP` chặn số lượt mua. Hết điểm thì bot thôi gọi cho tới khi nạp thêm và khởi động lại, thay vì lặp đúng một câu lỗi suốt đêm trong log.

Kiểm tra cấu hình **ở chính máy đang bị chặn** bằng:

```bash
npm run spigot-probe-captcha
```

Lệnh này in số dư, xin proxy từ đúng bể mà bot dùng, mở trang đăng nhập, mua vé nếu bị chặn, rồi **tải thử một jar miễn phí bằng chính đường tải của production** — nên nó trả lời được câu duy nhất đáng hỏi: máy này tải được hay không.

### Đo được ngày 24/08/2026 — proxy residential phá đường tải

Ba cấu hình, cùng một VPS, cùng resource 6245 (PlaceholderAPI), cùng bản Chrome:

| Cấu hình | Trang resource | Tải jar |
|---|---|---|
| Không proxy (IP datacenter của VPS) | mở được | **ok, 1.11 MB** |
| Proxy residential VN (suiproxy), không YesCaptcha | mở được | **challenged** |
| Proxy residential VN + mua `cf_clearance` từ YesCaptcha | mở được | **challenged** |

Kết luận có ba phần, và phần thứ ba là phần quan trọng:

1. **Đường tải chạy tốt nhất khi KHÔNG proxy** trên VPS này. Đừng bật proxy nếu chưa đo được là nó giúp.
2. `cf_clearance` mua được **không cứu được** một IP đã bị chặn ở đường tải. Vé mở được trang, nhưng endpoint tải vẫn 403.
3. Vì thế thứ tự thử đúng là: **đo không proxy trước**, chỉ thêm proxy khi IP thật bị chặn, và chỉ thêm YesCaptcha khi proxy vẫn không tự vượt được.

Riêng YesCaptcha: **endpoint tải không giải được** — đo hai lần, `unsolvable` sau 69 giây, vì bên giải mở URL bằng trình duyệt rồi đợi trang dựng xong mà endpoint tải trả về một tệp. Trang thật (`/login`, trang resource, trang gốc) giải xong trong 10–13 giây. Code vì thế luôn giải theo trang resource rồi dùng vé đó cho link tải, vì vé có hiệu lực theo tên miền.

## 11. Bảo mật

- Dashboard công khai trên internet. Mật khẩu tối thiểu 12 ký tự, và đăng nhập bị giới hạn tần suất.
- Jar premium mang dấu vết tài khoản của bạn. Mọi lần giao đều ghi vào sổ audit — đó là thứ bảo vệ bạn nếu jar bị rò rỉ.
- Không commit `.env`. `.gitignore` đã chặn, nhưng đừng chủ quan.
- Thư mục `vault/`, `data/`, `tmp/` tạo với quyền `0750`, blob `0640` — trên VPS dùng chung, người dùng khác không đọc được.
