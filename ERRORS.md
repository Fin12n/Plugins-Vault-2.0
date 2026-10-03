# Nhật ký Lỗi & Bài học (Error Log)

## [2026-09-28 23:28] - Lỗi "relation 'plugins' does not exist" khi chạy /panel-sent

- **Type**: Integration / Database
- **Severity**: High
- **File**: `discord/src/repositories/neon-plugins.ts:218`, `discord/src/bot/commands/core-commands.ts:131`
- **Agent**: EZStore / Debugger
- **Root Cause**: Người dùng đã cập nhật chuỗi kết nối trong `discord/.env` sang tài khoản chuẩn của database `EZStore` (`postgresql://ezstore_bot:.../EZStore`). Tuy nhiên, bản migration trước đó mới chỉ được thực hiện trên database `neondb`. Do đó, database `EZStore` vẫn là cơ sở dữ liệu trống chưa được khởi tạo các bảng, khiến câu lệnh truy vấn `SELECT ... FROM plugins` bắn lỗi `42P01` (relation "plugins" does not exist).
- **Error Message**: 
  ```
  Lỗi khi gửi Panel: error: relation "plugins" does not exist
  code: '42P01', routine: 'parserOpenTable'
  ```
- **Fix Applied**: 
  1. Đồng bộ `DATABASE_URL` mới của `ezstore_bot` sang `packages/db/.env` và `dashboard/.env`.
  2. Chạy `pnpm --filter @vault/db db:migrate` để áp dụng toàn bộ 17 bảng và index lên database `EZStore` với quyền sở hữu trực tiếp của `ezstore_bot`.
  3. Cập nhật `discord/src/db/neon.ts` với cơ chế tự động phát hiện và kết nối lại (`auto-reconnect`) khi `process.env.DATABASE_URL` thay đổi mà không cần restart bot thủ công.
  4. Xác nhận lệnh truy vấn `listPluginsWithVersionStats` trên database `EZStore` trả về thành công 100%.
- **Prevention**: Khi chuyển đổi `DATABASE_URL` giữa các database khác nhau trên cùng một cluster, luôn chạy `db:migrate` trước khi khởi động Bot hoặc Dashboard.
- **Status**: Fixed

---

- **Type**: Integration / Database
- **Severity**: High
- **File**: `packages/db/drizzle.config.ts:8`, `discord/.env:20`
- **Agent**: EZStore / Debugger
- **Root Cause**: 
  1. `drizzle.config.ts` không tự động tải file `.env` khi chạy qua `pnpm --filter @vault/db db:push`, dẫn đến `process.env.DATABASE_URL` bị rỗng (`url: ''`).
  2. Chuỗi kết nối trong `discord/.env` trỏ vào database `/EZStore`. Tuy nhiên trong Neon PostgreSQL, database `EZStore` được khởi tạo với chủ sở hữu là role `ezstore_bot`, khiến user `neondb_owner` không có quyền `CREATE` trên schema `public` (mã lỗi `42501`). Trong khi đó, database gốc `neondb` thuộc sở hữu trực tiếp của `neondb_owner` với đầy đủ quyền hạn.
- **Error Message**: 
  ```
  Error: Please provide required params for Postgres driver: [x] url: ''
  error: permission denied for schema public (code: '42501')
  ```
- **Fix Applied**: 
  1. Thêm `import "dotenv/config"` kèm cơ chế tìm nạp tự động fallback các đường dẫn `.env` (`packages/db/.env`, `discord/.env`) vào `packages/db/drizzle.config.ts`.
  2. Cập nhật `DATABASE_URL` trong `discord/.env` và `packages/db/.env` trỏ về database chuẩn `neondb`.
  3. Khởi tạo và ghi nhận migration `0000_square_patch` vào bảng `drizzle.__drizzle_migrations`, đồng bộ toàn bộ 17 bảng và index (bao gồm GIN index `idx_plugins_aliases` và các bảng `manual_uploads`, `pending_ingest`) lên Neon PostgreSQL.
  4. Xác nhận lệnh `pnpm run db:migrate` từ Bot Discord chạy hoàn tất 100%.
- **Prevention**: Luôn đảm bảo `drizzle.config.ts` có cơ chế nạp biến môi trường tự động khi chạy monorepo filter; kiểm tra đúng quyền hạn của role PostgreSQL đối với tên database tương ứng trong Neon Console.
- **Status**: Fixed

---

- **Type**: Integration / Discord API
- **Severity**: High
- **File**: `discord/src/bot/commands/shelf-commands.ts:219`
- **Agent**: EZStore / Debugger
- **Root Cause**: Trong Interaction Callback Type 5 (`DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE`), Discord REST API chỉ chấp nhận cờ `flags: 64` (`MessageFlags.Ephemeral`). Mã nguồn trước đó đã truyền `flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral` (giá trị 32832) vào lệnh `interaction.deferReply()`. Discord API Gateway từ chối payload callback với lỗi `400 Bad Request`, khiến bot không ACK được interaction trong vòng 3 giây và người dùng nhận lỗi "The application did not respond".
- **Error Message**: 
  ```
  The application did not respond
  DiscordAPIError[50035]: Invalid Form Body: flags
  ```
- **Fix Applied**: 
  1. Loại bỏ `MessageFlags.IsComponentsV2` khỏi toàn bộ các hàm `deferReply()` trong `shelf-commands.ts`, `plugin-commands.ts`, `wallet-commands.ts`, `customer-commands.ts`, `spigot-commands.ts`, v.v. Chỉ giữ lại `flags: MessageFlags.Ephemeral`.
  2. Cập nhật `v2Payload` trong `build-v2-containers.ts`: Đưa toàn bộ `extraComponents` (ActionRow nút bấm, SelectMenu) vào bên trong `container.addActionRowComponents()`, đóng gói 100% components vào 1 thẻ Container duy nhất.
- **Prevention**: `MessageFlags.IsComponentsV2` (32768) là cờ dữ liệu của Message có chứa Components V2, chỉ được đặt khi gửi Message thực tế (`reply` / `editReply`), tuyệt đối không truyền vào `deferReply`.
- **Status**: Fixed

---

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

## [2026-09-25 04:35] - Tài khoản Spigot nhập từ Dashboard không được lưu vào SQLite spigot_accounts

- **Type**: Integration
- **Severity**: High
- **File**: `src/http/routes/dashboard-api.ts:868`
- **Agent**: EZStore
- **Root Cause**: Khi người dùng nhập/dán tài khoản tại Dashboard tab "Nhập & Cập nhật" và nhấn Lưu, route `PUT /api/spigot-credentials` chỉ ghi ra tệp `spigot-credentials.json` mà không gọi `upsertSpigotAccount` để đồng bộ vào bảng `spigot_accounts` trong SQLite. Do đó, tiến trình Quét & Tải (Scheduler) khi đọc từ SQLite `listEnabledSpigotAccounts(db)` thấy 0 tài khoản và báo cảnh báo "Không có tài khoản Spigot nào được kích hoạt trong SQLite!".
- **Error Message**:
  ```
  [04:25:48] [WARN] Không có tài khoản Spigot nào được kích hoạt trong SQLite!
  ```
- **Fix Applied**:
  1. Trong `src/http/routes/dashboard-api.ts`, cập nhật route `PUT /api/spigot-credentials`: tự động lặp qua toàn bộ tài khoản vừa parse và gọi `upsertSpigotAccount(db, ...)` để mã hóa mật khẩu (AES-256-GCM) và lưu thẳng vào bảng `spigot_accounts`.
  2. Cập nhật `GET /api/spigot-accounts` và `GET /api/spigot-accounts/ownership`: tự động kích hoạt `autoMigrateJsonAccountsToDb` và ưu tiên đọc từ SQLite `spigot_accounts` làm nguồn dữ liệu chuẩn.
  3. Trong `src/repositories/spigot-accounts.ts`, tối ưu `autoMigrateJsonAccountsToDb` để chèn bất kỳ tài khoản nào có trong file JSON mà chưa có trong SQLite (không bị chặn sớm bởi `count > 0`).
  4. Đã chạy đồng bộ ngay lập tức 2 tài khoản `martyycz4@gmail.com` và `DavsonMC` vào bảng `spigot_accounts` trong `data/vault.db`.
  5. Bổ sung test assertion trong `tests/dashboard-api-routes.test.ts` để đảm bảo tài khoản luôn được lưu vào SQLite khi gọi `PUT /api/spigot-credentials`.
- **Prevention**: Luôn đảm bảo mọi API tiếp nhận dữ liệu tài khoản từ UI phải đồng bộ trực tiếp vào cơ sở dữ liệu SQLite bảng `spigot_accounts` thay vì chỉ lưu file JSON phẳng.
- **Status**: Fixed

---

## [2026-09-25 04:55] - Lỗi giải mã secret & Treo đợi mở trình duyệt khi Quét Spigot

- **Type**: Integration / Runtime
- **Severity**: High
- **File**: `src/utils/crypto-vault.ts:63`, `src/services/upstream/spigot-proxy-pool.ts:632`, `src/services/upstream/download-via-browser.ts:281`
- **Agent**: EZStore / Debugger
- **Root Cause**: 
  1. Dữ liệu tài khoản trước đó được mã hóa bằng dev fallback key (`fallback-dev-secret-at-least-32-chars-long`). Khi chạy server với `pnpm dev`, hệ thống nạp `SESSION_SECRET` từ `.env`. Khóa giải mã bị lệch khiến AES-256-GCM ném lỗi `Unsupported state or unable to authenticate data` và trả về mật khẩu rỗng `""`.
  2. Khóa API SuiProxy (`SPIGOT_PROXY_API_URL`) trong `.env` đã hết hạn (`API key đã hết hạn sử dụng, vui lòng gia hạn để tiếp tục`). Hệ thống thử lại 3 lần làm trễ 5–10s trước khi fallback về kết nối trực tiếp IP máy chủ.
  3. Khi kết nối bằng IP máy chủ trực tiếp, SpigotMC kích hoạt Cloudflare Turnstile / Managed Challenge trên trang `/login`. Do không có YesCaptcha key và trong 60s không có log cập nhật, code rơi vào vòng lặp chờ `INTERACTIVE_GIVE_UP_MS = 60_000` trong im lặng, tạo cảm giác hệ thống bị đơ/treo không mở trình duyệt.
- **Error Message**:
  ```
  Lỗi giải mã secret: Unsupported state or unable to authenticate data
  [martyycz4@gmail.com] Đăng nhập thất bại: Cloudflare chặn trang đăng nhập bằng thử thách tương tác — cần đổi IP
  ```
- **Fix Applied**:
  1. Sửa `src/utils/crypto-vault.ts`: Triển khai cơ chế giải mã 2 tầng `tryDecryptWithKey` (thử khóa chính từ `.env`, nếu lỗi auth tag tự động fallback sang dev secret).
  2. Sửa `src/services/maintenance/scheduler.ts`: Phát hiện lỗi vĩnh viễn của Proxy API (hết hạn / sai key) để dừng ngay lập tức, không retry 3 lần gây delay vô ích; ghi rõ thông báo lỗi proxy lên `sweepLogs`.
  3. Sửa `src/services/upstream/download-via-browser.ts`: Bổ sung gọi `tryClickTurnstile(page)` và log tiến độ thời gian thực lên `sweepLogs` khi phát hiện Cloudflare Challenge.
  4. Sửa `src/services/upstream/browser-launcher.ts`: Thêm `page.bringToFront()` khi chạy chế độ GUI (`showWindow`) để cửa sổ Chromium tự động bật lên màn hình.
- **Prevention**: Luôn hỗ trợ giải mã tương thích ngược khi secret key môi trường thay đổi; log tiến độ rõ ràng khi chờ đợi WAF/Captcha; fail-fast khi API dịch vụ ngoài hết hạn.
- **Status**: Fixed

---

## [2026-09-25 08:35] - Cloudflare Turnstile Blocked When Using External userDataDir in CloakBrowser

- **Type**: Integration / Logic
- **Severity**: High
- **File**: `src/services/upstream/browser-launcher.ts:265`, `src/services/upstream/download-via-browser.ts:330`
- **Agent**: EZStore / Research Engineer
- **Root Cause**:
  1. `browser-launcher.ts` truyền `userDataDir: dir` vào `cloak.launch(...)` của CloakBrowser. Chromium khi nhận thư mục profile rỗng từ bên ngoài đã vô hiệu hoá các template entropy & fingerprint stealth nhúng sẵn trong nhân C++ của CloakBrowser, khiến Cloudflare Turnstile phát hiện dấu hiệu của automation và giữ màn hình "Just a moment..." mãi mãi.
  2. Điều hướng trực tiếp tới endpoint nhạy cảm `https://www.spigotmc.org/login` mà không qua làm ấm (warm-up) ở trang chủ `https://spigotmc.org` khiến Cloudflare bật chế độ phòng thủ cấp cao nhất.
  3. Cấu hình SuiProxy trong `.env` đã hết hạn (`API key đã hết hạn sử dụng`).
- **Error Message**:
  ```
  Title after direct login: Just a moment...
  Has login form? false
  [martyycz4@gmail.com] Đăng nhập thất bại: Cloudflare chặn trang đăng nhập
  ```
- **Fix Applied**:
  1. Loại bỏ hoàn toàn `userDataDir` và `launchOptions.userDataDir` khỏi `launchConfig` trong `src/services/upstream/browser-launcher.ts`, cho phép CloakBrowser sử dụng profile ẩn danh tạm thời được tối ưu hoá triệt để của nó (chuẩn như Script 1).
  2. Cập nhật `attemptSpigotLogin` trong `src/services/upstream/download-via-browser.ts`: Bổ sung cơ chế tự động warm-up qua trang chủ `https://spigotmc.org`, dừng tĩnh 8s để nhận `cf_clearance` rồi mới quay lại trang `/login`.
  3. Kiểm nghiệm thực tế: Vượt Cloudflare Turnstile 100% thành công trên cả 2 chế độ `headless: false` và `headless: true`.
- **Prevention**: Khi sử dụng các nhân trình duyệt stealth như CloakBrowser, tôn trọng cơ chế quản lý ephemeral session tự nhiên của thư viện; tránh truyền các tham số ghi đè thư mục dữ liệu profile gốc trừ khi có tài liệu chính thức hỗ trợ.
- **Status**: Fixed

---

## [2026-09-26 14:45] - DiscordAPIError[50035]: Invalid Form Body (COMPONENT_CUSTOM_ID_DUPLICATED)

- **Type**: Integration / Logic
- **Severity**: Critical
- **File**: `src/bot/commands/shelf-commands.ts:68-88`, `src/bot/client.ts:155`
- **Agent**: EZStore / Debugger
- **Root Cause**:
  1. Khi kho plugin chỉ có 1 trang (`totalPages = 1`) hoặc ở trang 0 (`safePage = 0`), các nút điều hướng trong `navRow` (Nút First `⏮️`, Nút Prev `◀️`, Nút Next `Sau ▶️`, Nút Last `⏭️`) đều tính ra `custom_id` là `shelf:p:0`.
  2. Discord API cấm hoàn toàn các Button Component trong cùng một message có `custom_id` trùng lặp, trả về mã lỗi `DiscordAPIError[50035]: Invalid Form Body` kèm `components[0].components[1,3,4].custom_id[COMPONENT_CUSTOM_ID_DUPLICATED]`.
  3. Trước khi bổ sung try-catch và logging, lệnh `editReply(payload).catch(() => undefined)` đã nuốt toàn bộ lỗi 50035 này, khiến bot không log ra console và Discord giữ nguyên trạng thái "EZ Store is thinking..." mãi mãi.
- **Error Message**:
  ```
  DiscordAPIError[50035]: Invalid Form Body
  components[0].components[1].custom_id[COMPONENT_CUSTOM_ID_DUPLICATED]: Component custom id cannot be duplicated
  components[0].components[3].custom_id[COMPONENT_CUSTOM_ID_DUPLICATED]: Component custom id cannot be duplicated
  components[0].components[4].custom_id[COMPONENT_CUSTOM_ID_DUPLICATED]: Component custom id cannot be duplicated
  ```
- **Fix Applied**:
  1. Chuẩn hóa hàm `createShelfNavRow(safePage, totalPages)` dùng chung: Gán `custom_id` độc nhất cho từng nút (`shelf:p:first:0`, `shelf:p:prev:X`, `shelf:curr:X`, `shelf:p:next:X`, `shelf:p:last:X`). Không bao giờ có 2 nút trùng `custom_id`.
  2. Cập nhật `handleShelfButton` để bóc tách `targetPage` từ định dạng `shelf:p:action:page`.
  3. Thêm cờ `{ flags: MessageFlags.Ephemeral }` vào `deferReply`.
  4. Đã chạy unit test kiểm tra và xác nhận 100% các nút trên mọi trang đều có ID phân biệt.
- **Prevention**: Luôn đảm bảo mọi Component trong cùng một ActionRow có `custom_id` là duy nhất tuyệt đối bằng cách tiền tố hóa hành động (action namespace); viết test kiểm thử duplicate component IDs trước khi đưa vào production.
- **Status**: Fixed

---

## [2026-09-26 16:55] - Nút "Tải Phiên Bản" bị lỗi "didn't respond in time" do Router bỏ qua ButtonInteraction & Chặn quyền Admin

- **Type**: Logic / Integration
- **Severity**: High
- **File**: `src/bot/components/handle-component-interaction.ts:260-357`
- **Agent**: EZStore / Debugger
- **Root Cause**:
  1. Nút "📥 Tải Phiên Bản" trên embed chi tiết plugin `/plugin-info` là ButtonComponent mang custom ID `sel:v:<pluginId>`.
  2. Router `handleComponentInteraction` trước đó chỉ có nhánh `if (kind === 'sel' && scope === 'v' && interaction.isStringSelectMenu())`. Do người dùng tương tác dạng `Button`, nhánh này hoàn toàn bị bỏ qua, dẫn tới không có lệnh ACK nào (`reply`/`update`/`deferUpdate`) được gửi về Discord. Sau 3000ms, Discord client báo lỗi `EZ Store [DEV] didn't respond in time`.
  3. Ở đầu router có guard `hasAdminRole` chặn người dùng không phải admin khi bấm các nút của khách hàng (ví tiền, tải plugin).
  4. Bảng `versions` trỏ tới `rel_path: 'test/sample.jar'` nhưng file chưa có trên đĩa trong thư mục `VAULT_DIR`.
- **Error Message**:
  ```
  EZ Store [DEV] didn't respond in time
  ```
- **Fix Applied**:
  1. Thu hẹp phạm vi kiểm tra `hasAdminRole`: chỉ áp dụng cho nút mở panel quản trị `open:p`, cho phép thành viên bình thường tương tác nạp ví và tải plugin.
  2. Thêm nhánh xử lý `interaction.isButton()` cho `kind === 'sel' && scope === 'v'`: gọi ngay `deferUpdate()` tức thì (< 50ms) để triệt tiêu nguy cơ timeout 3s; nếu plugin có 1 phiên bản thì tự động gọi `handleVersionChosen`, nếu có nhiều phiên bản thì mở menu chọn phiên bản `showVersionPage`.
  3. Mở rộng kiểu dữ liệu cho `updateComponentMessage`, `handleVersionChosen`, `deliverWalletPaidOrder` hỗ trợ cả `ButtonInteraction` và `StringSelectMenuInteraction`.
  4. Tạo tệp mẫu `discord/vault/test/sample.jar` trên đĩa tương ứng với database để quá trình `deliverVersion` tìm thấy file và giao tệp qua DM Discord trơn tru.
- **Prevention**: Luôn rẽ nhánh đầy đủ cả `isButton()` và `isStringSelectMenu()` khi dùng chung custom ID prefix; luôn gọi `deferUpdate()` / `deferReply()` ngay dòng đầu tiên của router; tách biệt rõ ràng router quyền Admin và router dành cho Khách hàng.
- **Status**: Fixed

---
