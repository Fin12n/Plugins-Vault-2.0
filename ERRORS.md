# Nhật ký Lỗi & Bài học (Error Log)

## [2026-09-02 22:40] - GET / trả về 404 Route Not Found (Thiếu dashboard/dist)

- **Type**: Integration
- **Severity**: High
- **File**: `src/http/server.ts:168`
- **Agent**: EZStore / Debugger
- **Root Cause**: Thư mục `dashboard` chưa được khai báo trong `pnpm-workspace.yaml` nên dependencies chưa được cài đặt, dẫn đến `dashboard/dist` chưa được build. Fastify server khi không tìm thấy `dashboard/dist/index.html` sẽ bỏ qua việc mount static files cho route `/`, dẫn đến lỗi 404 khi truy cập web.
- **Error Message**: 
  ```
  {"level":40,"msg":"Không tìm thấy dashboard/dist — chỉ phục vụ API"}
  {"level":30,"reqId":"req-1","msg":"Route GET:/ not found"}
  {"level":30,"reqId":"req-1","res":{"statusCode":404}}
  ```
- **Fix Applied**: 
  1. Thêm `packages: ['dashboard']` vào `pnpm-workspace.yaml`.
  2. Chạy `pnpm install` để cài đặt dependencies cho workspace và dashboard.
  3. Chạy `pnpm --filter plugin-vault-dashboard build` để sinh bundle `dashboard/dist`.
- **Prevention**: Thêm lệnh build dashboard tự động vào quy trình khởi động hoặc hướng dẫn deployment.
- **Status**: Fixed

---

## [2026-09-02 23:50] - Nhận diện sai tên Plugin Spigot khi có dải phiên bản không ngoặc

- **Type**: Logic
- **Severity**: High
- **File**: `src/services/upstream/sync-purchased-resources.ts:69`
- **Agent**: EZStore / Debugger
- **Root Cause**: Hàm `displayFrom` trước đây chỉ loại bỏ tiền tố phiên bản nằm trong dấu ngoặc vuông/tròn (`[1.8 - 26.2]`). Khi tác giả Spigot đặt dải phiên bản trần không có ngoặc (`1.17 - 26.2 ⭕ AdvancedJobs ⭐ ...`), hàm cắt chuỗi tại biểu tượng đầu tiên (`⭕`) khiến phần tiền tố `1.17 - 26.2` bị nhận nhầm thành tên plugin thay vì `AdvancedJobs`. Ngoài ra, hàm `stripLead` chưa xử lý biến thể Unicode Variation Selector (`\uFE0F`), để lại ký tự tàng hình ở đầu tên các plugin có emoji khiên/kiếm.
- **Error Message**: 
  ```
  Input: "1.17 - 26.2 ⭕ AdvancedJobs ⭐ 20+ Default Jobs & Create Your Own Jobs Plugin⚡GUI Editor ✅"
  Actual: "1.17 - 26.2"
  Expected: "AdvancedJobs"
  ```
- **Fix Applied**: 
  1. Bổ sung `VERSION_PREFIX` regex nhận diện chính xác các dải phiên bản không ngoặc (`v?\d+\.\d+(?:\.[\dxX]+)?...`).
  2. Bổ sung loại bỏ `\uFE00-\uFE0F\u200D\u200B` và các biểu tượng phân cách (`»`, `«`, `•`, `✦`, `~`).
  3. Cập nhật `normalizeName` và `slugFrom` sử dụng `displayFrom` để đồng bộ tên và slug chuẩn xác.
  4. Cập nhật bản ghi `id: 35` trong cơ sở dữ liệu `vault.db` về đúng tên `AdvancedJobs`.
- **Prevention**: Thêm các test case kiểm thử tự động cho dải phiên bản không ngoặc trong `tests/spigot-auto-download.test.ts`.
- **Status**: Fixed

---

## [2026-09-03 04:42] - Lỗi TypeError: Cannot read properties of undefined (reading 'isActive') khi Toggle mã giảm giá

- **Type**: Integration / Logic
- **Severity**: Medium
- **File**: `dashboard/src/pages/discounts-page.tsx:82` & `src/http/routes/dashboard-api.ts:424`
- **Agent**: EZStore / Debugger
- **Root Cause**: Route `PATCH /api/discounts/:id/toggle` ở Backend trả về trực tiếp đối tượng `DiscountCode` (`return discount;`). Tuy nhiên, hàm `handleToggle` ở Frontend lại đọc thuộc tính `res.discount.isActive` (mong đợi cấu trúc lồng `{ discount: DiscountCode }`). Do `res.discount` là `undefined`, việc truy cập `.isActive` gây ra ngoại lệ `TypeError: Cannot read properties of undefined (reading 'isActive')`, kích hoạt thông báo lỗi Toast màu đỏ trên giao diện khi người dùng bấm nút Toggle.
- **Error Message**: 
  ```
  TypeError: Cannot read properties of undefined (reading 'isActive')
  ```
- **Fix Applied**: 
  1. Backend (`src/http/routes/dashboard-api.ts`): Cập nhật endpoint trả về cả hai cấu trúc `{ ok: true, discount, ...discount }`.
  2. Frontend (`dashboard/src/pages/discounts-page.tsx`): Sử dụng optional chaining và fallback an toàn `res?.discount?.isActive ?? res?.isActive ?? !discount.isActive`.
  3. Rebuild Dashboard (`pnpm --filter plugin-vault-dashboard build`) và khởi động lại Server.
- **Prevention**: Luôn áp dụng Defensive Programming với Optional Chaining (`?.`) và Nullish Coalescing (`??`) khi đọc payload trả về từ API; đồng bộ hóa TypeScript Schema giữa client và server.
- **Status**: Fixed

---

## [2026-09-06 15:40] - DiscordAPIError: Unknown interaction (10062) & Interaction already acknowledged (40060)

- **Type**: Integration / Runtime
- **Severity**: High
- **File**: `src/bot/components/handle-component-interaction.ts:437`, `src/bot/commands/plugin-commands.ts:59`, `src/bot/client.ts:111`
- **Agent**: EZStore / Debugger
- **Root Cause**: 
  1. Discord yêu cầu phản hồi tương tác (initial ack) trong vòng 3 giây (3000ms). Khi server bận (quét cập nhật Spigot / Cloudflare challenge) hoặc độ trễ mạng cao, việc truy vấn DB và gửi trực tiếp `reply`/`update` vượt quá 3 giây dẫn tới lỗi `10062: Unknown interaction`.
  2. `replyOrUpdate` gọi `.reply()` hoặc `.update()` mà không kiểm tra trạng thái `interaction.deferred || interaction.replied`. Nếu tương tác đã được deferred, Discord.js bắt buộc phải dùng `.editReply()`, nếu không sẽ ném `40060: Interaction has already been acknowledged`.
  3. Khi có 2 phiên bản bot chạy song song (hoặc sự kiện gửi đúp), client thứ hai phản hồi sẽ bị Discord API từ chối với mã 40060 hoặc 10062.
- **Error Message**: 
  ```
  DiscordAPIError[40060]: Interaction has already been acknowledged.
  DiscordAPIError[10062]: Unknown interaction
  ```
- **Fix Applied**: 
  1. Đặt cờ `deferReply({ flags: MessageFlags.Ephemeral })` và `deferUpdate()` ngay khi nhận lệnh (`/panel`, `/menu`, `/find`, `/vi`, `/nap`, pagination, select dropdown) để Discord ghi nhận ACK tức thì (< 200ms), mở rộng timeout lên 15 phút.
  2. Cập nhật `replyOrUpdate`, `updateComponentMessage`, và `requireAdminRole` để tự động kiểm tra `deferred || replied` và chuyển sang `editReply()` an toàn.
  3. Bổ sung hàm `isIgnorableDiscordError` trong `src/bot/client.ts` để lọc bỏ các lỗi tương tác hết hạn hoặc đã được phiên khác phản hồi mà không làm spam stack trace lỗi đỏ console.
  4. Thêm unit test kiểm thử cho `isIgnorableDiscordError`.
- **Prevention**: Luôn `deferReply`/`deferUpdate` sớm nhất có thể cho mọi slash command và component interaction có thao tác IO/DB; đảm bảo chỉ có 1 instance Discord bot chạy tại một thời điểm với cùng một `DISCORD_TOKEN`.
- **Status**: Fixed

---

## [2026-09-06 17:50] - TypeError: Cannot read properties of undefined (reading 'trim') trên Dashboard React

- **Type**: Runtime / Integration
- **Severity**: Critical
- **File**: `dashboard/src/app.tsx:334`, `src/http/server.ts:302`, `src/http/auth/session-cookie.ts:79`
- **Agent**: EZStore / Debugger
- **Root Cause**: Component `Shell` trong `dashboard/src/app.tsx` khi render User Capsule đã gọi trực tiếp `user.displayName.trim()`. Khi người dùng đăng nhập bằng cookie session cũ (được tạo từ trước khi tính năng User Capsule hoặc `displayName` được thêm vào), `user.displayName` trả về từ API `/api/session` là `undefined`. Việc gọi `.trim()` trên giá trị `undefined` làm crash React component tree và kích hoạt màn hình `ErrorBoundary` ("Giao diện gặp lỗi. Cannot read properties of undefined (reading 'trim')").
- **Error Message**: 
  ```
  TypeError: Cannot read properties of undefined (reading 'trim')
  ```
- **Fix Applied**: 
  1. Frontend (`dashboard/src/app.tsx`): Tạo fallback an toàn `const displayName = (user?.displayName || user?.username || (user?.role === 'owner' ? 'Chủ sở hữu' : 'Staff')).trim()`. Trích xuất `initialLetter` dự phòng an toàn mà không bao giờ throw lỗi.
  2. Frontend (`dashboard/src/components/header-navbar.tsx`): Bổ sung fallback `user.displayName || user.username || 'User'`.
  3. Backend (`src/http/server.ts`): Tại endpoint `/api/session`, đảm bảo luôn trả về `displayName` được chuẩn hóa và không rỗng.
  4. Backend (`src/http/auth/session-cookie.ts`): Tại `verifySessionCookie`, tự động bù `payload.displayName` nếu cookie cũ bị thiếu.
  5. Đã rebuild bundle dashboard `dashboard/dist` và backend `dist/`.
  6. Bổ sung unit test trong `tests/dashboard-api-routes.test.ts`.
- **Prevention**: Áp dụng triệt để Defensive Programming: Không bao giờ gọi phương thức chuỗi (`.trim()`, `.toLowerCase()`, v.v.) trực tiếp trên thuộc tính đối tượng nhận từ API mà không có Optional Chaining (`?.`) và chuỗi fallback `|| ''`.
- **Status**: Fixed

---

## [2026-09-06 21:30] - Quá trình tải Spigot bị kẹt vô hạn ở "0 tệp, 0.0 MB" (Tài nguyên chưa mua & Thiếu Early Bailout)

- **Type**: Logic / Runtime
- **Severity**: High
- **File**: `src/services/upstream/download-via-browser.ts:961`, `src/services/upstream/download-via-browser.ts:1130`
- **Agent**: EZStore / Debugger
- **Root Cause**: 
  1. Plugin trả phí (Premium) chưa mua: Tài khoản Spigot không sở hữu plugin (ví dụ: CMI #3742, AFK Rewards #111638). Khi điều hướng tới link download `download?version=...`, SpigotMC trả về trang HTML từ chối phân quyền hoặc chuyển hướng lại trang giới thiệu.
  2. Bỏ sót kiểm tra quyền sở hữu: Hàm `downloadViaBrowser` trước đó chỉ kiểm tra `isUnowned` khi `!downloadUrl`. Nhưng khi tìm được link qua API/trang lịch sử, code bỏ qua bước kiểm tra này.
  3. Treo luồng và spam log 0.0 MB: Vòng lặp chờ tải (`while`) cố định chạy trọn vẹn 180 giây (`DOWNLOAD_WAIT_MS = 3 phút`), liên tục ghi log mỗi 10 giây `đang tải... 0 tệp, 0.0 MB` dù không có bất kỳ byte nào được truyền về.
  4. Đường dẫn CDP tương đối: Biến `dir` tạo từ `deps.tmpDir` (`./storage/tmp`) là đường dẫn tương đối, vi phạm yêu cầu của Chrome DevTools Protocol (`downloadPath` phải là đường dẫn tuyệt đối), khiến Chrome không thể lưu tệp vào đúng thư mục tạm.
  5. Thiếu YesCaptcha: Biến `YESCAPTCHA_CLIENT_KEY` không được cấu hình trong `.env.production`. Khi Cloudflare chặn endpoint tải, trình duyệt bị giữ lại trên màn hình "Just a moment..." suốt 3 phút.
- **Error Message**: 
  ```
  [Worker #2] resource 3742: đang tải... 0 tệp, 0.0 MB
  [Worker #1] resource 111638: đang tải... 0 tệp, 0.0 MB
  ```
- **Fix Applied**: 
  1. Chuẩn hóa đường dẫn tuyệt đối: Dùng `resolve(deps.tmpDir, ...)` và gửi cả `Page.setDownloadBehavior` lẫn `Browser.setDownloadBehavior`.
  2. Phát hiện sớm trên trang Resource: Ngay khi mở trang `resources/${resourceId}/`, nếu trang chỉ có nút "Buy Now" mà không có nút "Download", xác định ngay là `not_owned` và bỏ qua ngay từ đầu.
  3. Kiểm tra trang Landed sau khi điều hướng: Nhận diện tức thì nếu trang là Cloudflare challenge (khi không có solver), lỗi phân quyền, hoặc trang đăng nhập để trả về mã kết quả ngay lập tức thay vì rơi vào vòng lặp chờ tải.
  4. Kích hoạt DOM Click: Thêm click tự động vào thẻ `<a>` để kích hoạt download nếu Chrome chặn điều hướng tự động.
  5. Cơ chế Early Bailout (25 giây): Nếu sau 25 giây đầu tiên mà không có tệp nào bắt đầu tải (`0 tệp`), hệ thống kiểm tra trang web và ngắt ngay lập tức, tiết kiệm 155 giây cho mỗi lượt thử lỗi.
- **Prevention**: Không bao giờ đặt vòng lặp chờ file dài hạn (vài phút) mà không có timeout ngắn cho giai đoạn bắt đầu (handshake/start phase); luôn kiểm tra trạng thái trang web (DOM/Title) định kỳ trong lúc chờ tải; luôn chuẩn hóa đường dẫn tuyệt đối cho các tiến trình bên ngoài như Chrome CDP.
- **Status**: Fixed

---

## [2026-09-08 23:15] - Lỗi TypeScript TS2561/TS2551 khi build Docker: 'releaseDate' does not exist in type 'SpigetVersion'

- **Type**: Syntax / Integration
- **Severity**: High
- **File**: `src/services/maintenance/scheduler.ts:820`
- **Agent**: EZStore
- **Root Cause**: Khi gom các bản nợ của plugin đã gán quyền sở hữu trong `scheduler.ts`, đối tượng `upstream` được khởi tạo thủ công với thuộc tính `releaseDate: ver.releaseDate`. Tuy nhiên, interface `SpigetVersion` quy định thuộc tính ngày phát hành tính bằng mili-giây là `releaseDateMs` (chứ không phải `releaseDate`). Hơn nữa, biến `ver` đã vốn là một đối tượng chuẩn kiểu `SpigetVersion` trả về từ `spiget.listVersions(...)`. Lỗi này khiến lệnh biên dịch TypeScript `tsc -p tsconfig.json` ở bước build Docker (`RUN npm run build && (cd dashboard && npm run build)`) thất bại với mã lỗi exit code 2.
- **Error Message**:
  ```
  src/services/maintenance/scheduler.ts(820,19): error TS2561: Object literal may only specify known properties, but 'releaseDate' does not exist in type 'SpigetVersion'. Did you mean to write 'releaseDateMs'?
  src/services/maintenance/scheduler.ts(820,36): error TS2551: Property 'releaseDate' does not exist on type 'SpigetVersion'. Did you mean 'releaseDateMs'?
  ```
- **Fix Applied**:
  1. Trong `scheduler.ts`, cập nhật truyền trực tiếp `upstream: ver`, đồng thời bổ sung `isPremium: plugin.isPremium` và `archivedVersion: existingVersions[0]?.version ?? null` đúng chuẩn kiểu `UpdateFinding`.
  2. Bổ sung `isPremium: boolean` vào `OwnedPluginInfo` trong `src/repositories/resource-ownership.ts` để đồng bộ type checking.
  3. Kiểm tra lại toàn bộ quá trình build với `pnpm tsc --noEmit` và `npm run build`: Thành công 100%.
- **Prevention**: Luôn chạy `pnpm tsc --noEmit` hoặc `npm run build` sau khi chỉnh sửa các luồng dữ liệu liên quan đến upstream/scheduler trước khi commit hoặc build Docker.
- **Status**: Fixed

---
