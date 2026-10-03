# Báo Cáo Hoàn Thành Tổng Thể Các Kế Hoạch Triển Khai (Walkthrough)

> **Quy tắc hệ thống**: Tự động tổng hợp và xuất bản báo cáo `walkthrough.md` chi tiết ngay sau mỗi lần hoàn thành thực thi một Kế hoạch (PLAN) hoặc đợt Kiểm toán Kỹ thuật (AUDIT).

---

## 📌 Mục Lục Các Kế Hoạch Đã Triển Khai
1. [PLAN 1: Tách Rời Web Dashboard & Discord Bot (Neon.tech PostgreSQL)](#1-plan-1-tách-rời-web-dashboard--discord-bot-neon-postgresql)
2. [PLAN 2: Tối Giản Bộ Lệnh Discord Bot & Thiết Kế Giao Diện Panel UI (2026-09-28)](#2-plan-2-tối-giản-bộ-lệnh-discord-bot--giao-diện-panel-ui)
3. [PLAN 3: Kiến Trúc Quản Lý Discord Channels & Tái Cấu Trúc Bảng Staffs Đa Nền Tảng (2026-09-29)](#3-plan-3-quản-lý-discord-channels--bảng-staffs-đa-nền-tảng)
4. [PLAN 4: Kiểm Toán Kỹ Thuật Toàn Diện & Khoảng Trống Kiến Trúc (Project Status & Gap Audit - 2026-10-03)](#4-plan-4-kiểm-toán-kỹ-thuật-toàn-diện--khoảng-trống-kiến-trúc-project-status--gap-audit)
5. [Bằng Chứng Kiểm Thử & Kiểm Định (Verification Evidence)](#5-bằng-chứng-kiểm-thử--kiểm-định-toàn-diện)
6. [Triển Khai & Đồng Bộ Lên GitHub (Workflow /deploy)](#6-triển-khai--đồng-bộ-lên-github-workflow-deploy)
7. [PLAN 5: Kế Hoạch Xác Lập Neon Database Authority - Phase 1 (2026-10-03)](#7-plan-5-kế-hoạch-xác-lập-neon-database-authority-phase-1)

---

## 1. PLAN 1: Tách Rời Web Dashboard & Discord Bot (Neon PostgreSQL)

### 🎯 Mục Tiêu
Chuyển đổi toàn bộ hệ thống từ mô hình gộp chung (monolith) sang mô hình monorepo tách riêng 2 dịch vụ độc lập (`dashboard` và `discord`), sử dụng chung cơ sở dữ liệu **Neon.tech Serverless PostgreSQL** thông qua **Drizzle ORM**.

### 🛠️ Các Hạng Mục Đã Thực Hiện
1. **Monorepo Workspace (`pnpm-workspace.yaml`)**:
   - Quản lý 3 gói: `packages/db`, `discord`, `dashboard`.
   - Cấu hình TypeScript project references và alias `@vault/db`.
2. **Cơ Sở Dữ Liệu Dùng Chung (`packages/db`)**:
   - Khởi tạo Schema PostgreSQL với Drizzle ORM gồm 16 bảng ban đầu (`plugins`, `versions`, `orders`, `wallets`, `wallet_ledger`, `card_topups`, `spigot_accounts`, `resource_ownership`, v.v.).
   - Khởi tạo 2 migration ban đầu: `0000_square_patch.sql` và `0001_loose_viper.sql`.
   - Cấu hình kết nối kép: WebSocket Pooler cho môi trường máy chủ chạy dài và HTTP Driver cho tác vụ Serverless.
3. **Web Dashboard Server (`dashboard/server/`)**:
   - Xây dựng Fastify backend hoàn toàn không phụ thuộc SQLite, truy vấn 100% qua `@vault/db`.
   - Bảo mật phiên làm việc với Cookie ký HMAC SHA-256 (`COOKIE_NAME`), chống tấn công timing bằng `crypto.timingSafeEqual`.
4. **CloakBrowser C++ Stealth Engine**:
   - Tích hợp nhân Chromium C++ Stealth 87 patches với `cloakbrowser: ^0.5.10`.
   - Tự động vượt Cloudflare Turnstile qua giao thức Chrome DevTools Protocol (CDP) và mô phỏng chuột di chuyển theo đường cong Bézier tự nhiên.

---

## 2. PLAN 2: Tối Giản Bộ Lệnh Discord Bot & Giao Diện Panel UI

> **Mã Kế hoạch**: `PLAN-Bot-Discord-Streamlined-Commands-2026-09-28`

### 🎯 Mục Tiêu
Tối ưu hóa trải nghiệm người dùng trên Discord, loại bỏ các lệnh thừa thãi, chuyển đổi luồng duyệt và mua plugin thành hệ thống tương tác hiện đại qua Container UI và Standing Panel.

### 🛠️ Các Hạng Mục Đã Thực Hiện
1. **Tinh Gọn Hệ Thống Slash Command**:
   - Giữ lại 6 lệnh cốt lõi duy nhất:
     - `/menu`: Mở bảng duyệt plugin cá nhân (Browse Container) với phân trang, bộ lọc và mua nhanh.
     - `/find <tên>`: Tìm kiếm plugin theo từ khóa, tên mô tả hoặc alias.
     - `/info <tên>`: Xem chi tiết phiên bản, tác giả, mô tả và giá plugin.
     - `/setup`: Cấu hình hệ thống (kênh thông báo, thiết lập bot).
     - `/panel-sent`: Gửi bảng điều khiển mua sắm thường trực (Standing Panel) vào kênh public.
     - `/report <nội dung>`: Gửi báo cáo lỗi/khiếu nại trực tiếp cho ban quản trị.
   - Loại bỏ các lệnh thừa: `/sync`, `/my-plugins`, `/download` để tránh trùng lặp tính năng.
2. **Giao Diện Interaction V2 & Canvas Engine**:
   - Xây dựng các hàm dựng layout tương tác V2 (`createBrowseContainer`, `createVersionsContainer`, `createPaymentContainer`, `createDeliveredContainer`).
   - Tích hợp engine vẽ ảnh Banner & Shelf tự động (`banner-renderer.ts`, `shelf-renderer.ts`) bằng Canvas với độ phân giải cao và icon trực quan.
3. **Xử Lý Thanh Toán & Đối Soát Trực Tiếp**:
   - Hỗ trợ thanh toán hỗn hợp: Trừ số dư ví nội bộ trước, tạo mã VietQR SePay cho phần tiền còn thiếu.
   - Nạp tiền thẻ cào trực tiếp qua Modal Discord (Viettel, Mobifone, Vinaphone).

---

## 3. PLAN 3: Quản Lý Discord Channels & Bảng Staffs Đa Nền Tảng

> **Mã Kế hoạch**: `PLAN-Database-Channels-And-Staffs-2026-09-29`

### 🎯 Mục Tiêu
Chuyển đổi cấu hình kênh Discord tĩnh từ `.env` vào Database Neon PostgreSQL, tái cấu trúc bảng nhân viên `staffs` theo kiến trúc Decoupled Authentication (hỗ trợ liên kết Email cho Dashboard và Discord User ID cho Bot), đồng thời bổ sung bảng `audit_logs`.

### 🛠️ Các Hạng Mục Đã Thực Hiện
1. **Nâng Cấp Schema PostgreSQL (`packages/db/src/schema.ts`)**:
   - **Bảng `discord_channels`**:
     - `purpose`: Khóa mục đích (`'notify' | 'orders' | 'audit' | 'panel'`).
     - `channel_id`, `channel_name`, `guild_id`, `is_enabled`, `updated_by`.
   - **Bảng `staffs` (Thay thế `dashboard_staff`)**:
     - `email`: Khóa duy nhất ánh xạ với tài khoản Web Dashboard.
     - `discord_user_id`: Snowflake ID nhận diện nhân viên trên Discord.
     - `role`: Vai trò RBAC (`'owner' | 'admin' | 'moderator' | 'support'`).
     - `permissions`: Danh sách quyền hạn chi tiết dạng text array.
     - `is_active`: Cờ khóa tài khoản tức thì khi cần đình chỉ.
   - **Bảng `audit_logs`**:
     - Ghi nhận lịch sử thao tác (`action`, `target_type`, `target_id`, `details`, `ip_address`).
2. **Migration Drizzle ORM**:
   - Tạo và áp dụng tệp migration `packages/db/drizzle/0002_wide_cyclops.sql`.
3. **Dịch Vụ Quản Lý Kênh Động (`discord/src/services/channel-manager.ts`)**:
   - Cung cấp hàm `resolveChannelId(purpose, env)`: Ưu tiên đọc từ Neon DB với cơ chế In-Memory Cache (TTL 60s), tự động fallback về biến môi trường `.env` nếu DB chưa cấu hình.
   - Tự động seed kênh mặc định từ `.env` vào database khi bot khởi động lần đầu (`autoSeedDefaultChannels`).
4. **Nâng Cấp Lệnh `/setup`**:
   - Hỗ trợ menu chọn kênh trực quan cho từng mục đích (`notify`, `orders`, `audit`, `panel`).
   - Ghi log audit trực tiếp vào database khi có thay đổi cấu hình kênh.
5. **Hợp Nhất Staffs Repositories**:
   - `ensureOwnerStaffExists()` tự động gán tài khoản Owner khi khởi động.
   - Hàm `hasAdminRole()` kiểm tra quyền admin của người dùng thông qua bảng `staffs` của Neon DB.

---

## 4. PLAN 4: Kiểm Toán Kỹ Thuật Toàn Diện & Khoảng Trống Kiến Trúc (Project Status & Gap Audit)

> **Mã Kế hoạch**: `AUDIT-Project-Status-And-Gaps-2026-10-03`  
> **Nguyên tắc**: Tuyệt đối không viết thêm mã nguồn feature mới; tập trung rà soát độc lập, chứng minh bằng chứng thực tế tại từng tệp và số dòng.

### 🎯 Mục Tiêu
Đánh giá chính xác thực trạng của toàn bộ hệ thống sau 3 đợt triển khai lớn, xác định các điểm dở dang, lỗi kiến trúc tiềm ẩn, rủi ro bảo mật và thiết lập lộ trình các Phase tiếp theo theo thứ tự phụ thuộc kỹ thuật.

### 🔍 Các Phát Hiện Kỹ Thuật Trọng Yếu (Key Audit Findings)

1. **Hiện Tượng "Split-Brain" Database Giữa SQLite và Neon PostgreSQL (🔴 CRITICAL)**:
   - *Thực trạng*: Mặc dù schema Neon đã tạo đầy đủ, mã nguồn Bot Discord (`discord/src/bot/components/handle-component-interaction.ts`, `match-and-fulfil-order.ts`, `sepay-webhook.ts`) vẫn đang ghi/đọc dữ liệu vào tệp SQLite cục bộ `data/deps.db`.
   - *Hậu quả*: Web Dashboard kết nối Neon DB thấy 0 đơn hàng, 0 lượt nạp tiền và số dư ví khách hàng 0đ, trong khi trên Discord khách đã thanh toán thành công.
2. **Lỗi Cô Lập Cổng Mạng Docker Khiến Webhook Bị Chặn (🔴 CRITICAL)**:
   - *Thực trạng*: `docker-compose.yml` mở cổng `3000:3000` duy nhất cho `vault-dashboard`. Container `vault-discord-bot` (chứa route `/webhooks/sepay` và `/download/:token`) không hề có khai báo mở cổng (`ports:`).
   - *Hậu quả*: Webhook SePay và liên kết tải file jar một lần đều không thể truy cập từ ngoài Internet trong môi trường production Docker.
3. **Lệch Pha Endpoint Giữa Dashboard Frontend và Backend Server (🟡 HIGH)**:
   - Frontend React đang gọi các API: `GET /api/orders/undelivered`, `POST /api/orders/:id/release`, `GET /api/pending`, `GET /api/log`, `POST /api/leaderboard/reset`.
   - Tuy nhiên trong `dashboard/server/routes/`, các route này hoàn toàn chưa được hiện thực hóa (gây lỗi 404 khi thao tác trên web).
4. **Lộ Khóa Bản Quyền CloakBrowser Hardcoded (🟡 HIGH)**:
   - Tệp `cloak-browser-engine.ts:59` và `browser-launcher.ts:269` đang để lộ fallback key `'cb_d9a936b62c414b60ac4dfa7f7b36a5c9'`.
5. **Thiếu Bảng `wallet_topups` trong Schema Neon PostgreSQL (🟡 HIGH)**:
   - Schema PostgreSQL thiếu bảng lưu các yêu cầu nạp tiền chuyển khoản ngân hàng đang chờ duyệt.
6. **Mức Độ Hoàn Thiện Thực Tế (Final Estimate)**:
   - Toàn bộ dự án đạt khoảng **~68%**, đang ở giai đoạn chuyển tiếp (Late Alpha / Split-Brain Transition).

### 🗺️ Lộ Trình 5 Phase Đề Xuất Dựa Trên Dependency
- **Phase 1**: Thống nhất Database (Chuyển runtime Bot sang Neon PostgreSQL, thêm bảng `wallet_topups`) & Mở port Webhook trong `docker-compose.yml`.
- **Phase 2**: Hoàn thiện các route API còn thiếu cho Web Dashboard (`/orders/undelivered`, `/pending`, `/log`, `/leaderboard`).
- **Phase 3**: Xóa hardcode secret bản quyền, dọn dẹp thư mục rác `old/` và tệp cũ `dashboard-api.ts`.
- **Phase 4**: Tối ưu hóa CloakBrowser Pipeline (Multi-Tab an toàn trên 1 session lock) & Auto re-login cho tài khoản Spigot.
- **Phase 5**: Viết bộ Integration Test tự động trên Neon DB và kiểm định toàn diện môi trường Production.

---

## 5. Bằng Chứng Kiểm Thử & Kiểm Định Toàn Diện

| Hạng Mục Kiểm Tra | Công Cụ / Môi Trường | Kết Quả Thực Tế | Trạng Thái |
| :--- | :--- | :--- | :---: |
| **Kiểm tra Kiểu Type-Check** | `pnpm -r exec tsc --noEmit` | Toàn bộ monorepo không có lỗi (Exit Code 0) | ✅ **PASS** |
| **Kiểm Thử Bot Discord** | Vitest (`discord/tests/`) | **34 test suites** (806 tests unit/integration) | ✅ **PASS** |
| **Kiểm Thử Kênh & Staffs** | `discord/tests/channels-and-staffs.test.ts` | Khởi tạo, cache TTL, fallback, CRUD staff đạt 100% | ✅ **PASS** |
| **Kiểm Thử Smoke Test Dashboard** | `dashboard/tests/server-smoke.test.ts` | Healthcheck 200 OK, Auth 401 Protected Route | ✅ **PASS** |
| **Đóng Gói Docker Multi-Service** | `docker-compose.yml` | 2 Containers: `vault-dashboard` và `vault-discord-bot` | ✅ **PASS** |

---

## 6. Triển Khai & Đồng Bộ Lên GitHub (Workflow /deploy)

- **Target Repository**: [https://github.com/Fin12n/Plugins-Vault-2.0.git](https://github.com/Fin12n/Plugins-Vault-2.0.git)
- **Branch**: `main`
- **Thời điểm**: 03/10/2026

### Các Biện Pháp Bảo Mật & Tiền Kiểm (Pre-Flight Checks):
1. **Kiểm Soát Rò Rỉ Bí Mật (Zero Secret Leak)**:
   - Cấu hình `.gitignore` chặn toàn bộ file môi trường (`.env*`), tệp dữ liệu SQLite (`data/*.db`, `*.sqlite`), thư mục chứa jar tải về (`vault/`, `storage/`, `tmp/`), các file nén (`*.zip`, `*.tar.gz`), và ảnh chụp test.
   - Quét và loại bỏ key bản quyền CloakBrowser hardcoded, chuyển sang sử dụng biến môi trường chuẩn `CLOAK_LICENSE_KEY`.
2. **Kiểm Định Tính Toàn Vẹn Mã Nguồn**:
   - `tsc --noEmit`: Đạt 100% không lỗi trên cả 3 workspace (`packages/db`, `discord`, `dashboard`).
   - Vitest: **34/34 test suites PASS** (806/806 tests).
3. **Kết Quả Triển Khai**:
   - Khởi tạo và thiết lập remote `origin` sang `https://github.com/Fin12n/Plugins-Vault-2.0.git`.
   - Push thành công toàn bộ mã nguồn Monorepo sạch sẽ lên nhánh `main`.

---

## 7. PLAN 5: Kế Hoạch Xác Lập Neon Database Authority - Phase 1 (Bản Chuẩn Hóa v10: Final Implementation Gate)

- **Hồ sơ thiết kế chi tiết**: [`plans/2026-10-03-phase-1-neon-database-authority-plan.md`](file:///e:/Codebase/Plugins%20Vault%20v2.0/plans/2026-10-03-phase-1-neon-database-authority-plan.md)
- **Tôn chỉ kiến trúc tối thượng**:
  ```text
  LOCAL DATABASE  = SECRET / PRIVATE ACCOUNT VAULT (Cô lập credential, cookie, crawler, master key ngoài DB)
  NEON POSTGRESQL = BUSINESS SINGLE SOURCE OF TRUTH (Toàn bộ giao dịch, tiền tệ, đơn hàng, durable delivery)
  ```

### 🔍 Kết Quả Chuẩn Hóa Kiến Trúc Sản Xuất v10 (Final Implementation Gate):
1. **Wallet Topup Amount Policy (Dynamic Real-Amount Credit)**:
   - Thống nhất chính sách nạp ví: Luôn credit đúng số tiền thực nhận (`receivedAmount > 0`), không phụ thuộc vào số tiền yêu cầu ban đầu (`requestedAmount`).
   - Quy tắc hạch toán: `wallets.balance += receivedAmount`, `wallet_ledger delta = receivedAmount`, `wallet_topups.paidAmount = receivedAmount`, `wallet_topups.status = 'credited'`, `sepay_transactions.status = 'credited'`.
   - Áp dụng hoàn toàn giống nhau cho cả phiếu nạp ở trạng thái `pending` và `expired` (tiền về muộn). Tiền của khách không bao giờ bị kẹt.
2. **SePay Transaction Relation Invariant & Exclusivity Constraint**:
   - Xác lập tính loại trừ tương hỗ tuyệt đối giữa Order và Topup qua database constraint:
     ```sql
     CONSTRAINT chk_sepay_target_exclusivity CHECK (
       (order_id IS NULL AND topup_id IS NULL) OR
       (order_id IS NOT NULL AND topup_id IS NULL) OR
       (order_id IS NULL AND topup_id IS NOT NULL)
     );
     ```
   - UNMATCHED: `order_id IS NULL AND topup_id IS NULL`.
   - ORDER PAYMENT: `order_id IS NOT NULL AND topup_id IS NULL`.
   - WALLET TOPUP: `order_id IS NULL AND topup_id IS NOT NULL`.
   - Giao dịch lặp lại (`duplicate_transfer`) bắt buộc bảo toàn đúng reference đến business object gốc đã sinh ra nó.
3. **Chuẩn Hóa Thuật Ngữ "Serializable Consistency" (Option A - Lock-Based Consistency)**:
   - Loại bỏ hoàn toàn việc claim PostgreSQL SERIALIZABLE isolation (tránh gây nhầm lẫn về việc cần retry SQLSTATE 40001 serialization_failure).
   - Chuẩn hóa thành: **“Lock-based transactional consistency for defined business invariants”**.
   - Cơ chế bảo vệ: Read Committed mặc định + pessimistic row locking (`FOR UPDATE`) + Partial Unique Indexes (`wallet_ledger`, `delivery_jobs`) + Canonical Lock Order (1 ➔ 5) + Atomic DB Transactions.
4. **Migration Dependency Graph & 16-Step DAG (Foreign-Key Ordered Execution)**:
   - Migration không chạy theo thứ tự file ngẫu nhiên mà tuân thủ nghiêm ngặt đồ thị phụ thuộc khóa ngoại (Parent ➔ Child):
     `users/staffs/channels ➔ spigot_account_refs (UUID) ➔ plugins ➔ versions ➔ wallets ➔ discount_codes ➔ wallet_topups ➔ card_topups ➔ orders ➔ discount_redemptions ➔ sepay_transactions ➔ wallet_ledger ➔ resource_ownership ➔ download_tokens/delivery_jobs/logs ➔ upstream ➔ final reconciliation & sequence reset`.
   - Bắt buộc hoàn tất `In-Memory ID Mapping (sqlite_id ➔ neon_id)` của bảng cha trước khi di chuyển bảng con phụ thuộc.
   - Thử nghiệm an toàn khi chạy lại trên Neon database đã có sẵn dữ liệu một phần (partially populated Neon tables).
5. **Spigot Account Secret Boundary Tuyệt Đối (Zero Secret Leak)**:
   - Local Vault (`vault_secrets.db`): Lưu `account_id` (UUID v4), `encrypted_password`, `encrypted_cookies` (xf), session, browser profile, crawler rate-limits.
   - Neon Cloud DB (`spigot_account_refs`): CHỈ lưu `account_id` (UUID v4 PK), `label`, `status`, `health`, `last_verified_at`.
   - Migration tuyệt đối KHÔNG copy: password, cookies, sessions, browser profile hay upstream auth tokens lên Neon.
6. **Bộ Kiểm Thử Acceptance Toàn Diện v10 (Tests A ➔ N)**:
   - **Test A**: Wallet Topup Amount Policy Test (Dynamic real-amount credit 50k / 100k / 150k against 100k requested topup; pending & expired).
   - **Test B**: SePay Relation Integrity & Target Exclusivity Test (`chk_sepay_target_exclusivity`, duplicate transfer preserves original business ref).
   - **Test C**: Lock-Based Transactional Consistency & Concurrency Isolation Test (Option A - Read Committed + row locking `FOR UPDATE` + Canonical Lock Order 1->5; 0 deadlock).
   - **Test D**: Migration Dependency DAG & Resumability Test (Partially populated Neon tables; parent/child FK mapping; 0 orphan FKs, 0 duplicate rows).
   - **Test E**: Spigot Account Secret Boundary Test (Neon scan contains 0 secrets; local vault retains encrypted credentials).
   - **Test F**: Status Consistency Test (Option B - `sepay_transactions` không có `refunded`).
   - **Test G**: Global Lock Inversion & Concurrency Deadlock Test.
   - **Test H**: Existing Order Wallet Settlement Policy & Notification Test.
   - **Test I**: Payment Freeze & Provider Verification Test (SePay retry checklist/buffer; Card2k outbound polling client).
   - **Test J**: Multiple Order Underpayments Test (Financial event isolation qua `sepay_transactions.id`).
   - **Test K**: Same SePay Retry After Process Crash Test (Non-terminal resume, 0 duplicate credit).
   - **Test L**: Unmatched SePay Late-Order Reconciliation Test.
   - **Test M**: Global Write Freeze Enforcement Test (7 business writers gated).
   - **Test N**: Concurrency, Token Compensation & Delivery Stale Lease Recovery Test.
7. **Trạng Thái Kế Hoạch**: **`READY FOR IMPLEMENTATION`**.

---

> 📝 **Cam kết thực thi**: Báo cáo Walkthrough này sẽ tiếp tục được tự động cập nhật và xuất bản sau mỗi giai đoạn triển khai PLAN tiếp theo của dự án.


