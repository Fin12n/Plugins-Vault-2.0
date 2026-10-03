# PHASE 1 FINAL IMPLEMENTATION PLAN — NEON DATABASE AUTHORITY

> **Mục tiêu tối thượng**: Thiết lập **Neon PostgreSQL** làm **Single Source of Truth** duy nhất cho toàn bộ dữ liệu nghiệp vụ (Business Data), xóa bỏ hoàn toàn trạng thái chia tách dữ liệu (Split-Brain) giữa Discord Bot và Web Dashboard mà **không rewrite bot, không đổi UI/UX, không thêm feature mới và không can thiệp CloakBrowser**.

---

## 1. Current Architecture

### 1.1. Hiện trạng phân mảnh dữ liệu (Split-Brain)
Hệ thống hiện tại đang bị chia tách thành hai thế giới dữ liệu độc lập:
1. **Discord Bot Runtime**:
   - Sử dụng thư viện `better-sqlite3` kết nối đồng bộ tới tệp SQLite cục bộ (`data/deps.db` hoặc `data/vault.db`) ([connection.ts:L23-L49](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/connection.ts#L23-L49)).
   - Toàn bộ giao dịch tiền bạc cốt lõi bao gồm: tạo đơn hàng ([orders.ts:L29-L61](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/orders.ts#L29-L61)), trừ số dư ví ([wallets.ts:L55-L96](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L55-L96)), ghi sổ cái ([wallets.ts:L78-L90](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L78-L90)), xử lý webhook ngân hàng SePay ([match-and-fulfil-order.ts:L156-L237](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts#L156-L237)), nạp thẻ cào Card2k ([submit-card-topup.ts:L70-L130](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts#L70-L130)), cấp link tải một lần ([mint-download-token.ts:L17-L30](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts#L17-L30)), và nhật ký giao file ([deliver-version.ts:L135-L163](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts#L135-L163)) đều được ghi độc quyền vào SQLite.
2. **Dashboard Backend Runtime**:
   - Khởi tạo kết nối trực tiếp tới Neon PostgreSQL thông qua gói `@vault/db` ([neon.ts:L8](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/db/neon.ts#L8)).
   - Các API truy vấn danh sách đơn hàng ([orders-routes.ts:L36-L50](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/orders-routes.ts#L36-L50)), số dư ví ([wallets-routes.ts:L21-L40](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/wallets-routes.ts#L21-L40)) hoàn toàn đọc từ Neon PostgreSQL.
3. **Lỗ hổng nghiêm trọng của cơ chế đồng bộ cũ**:
   - Hàm `autoSyncSqliteToNeonIfEmpty()` ([neon-sync.ts:L6-L136](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/neon-sync.ts#L6-L136)) chỉ kích hoạt khi bảng `plugins` trên Neon hoàn toàn trống (`count === 0`). Nếu Neon đã có dù chỉ 1 plugin, hàm lập tức bỏ qua.
   - Hàm này hoàn toàn bỏ qua `orders`, `wallets`, `wallet_ledger`, `sepay_transactions`, `card_topups`, `wallet_topups`, `download_tokens`, `audit_log`.

---

## 2. Target Architecture

```text
       ┌────────────────────────┐         ┌────────────────────────┐
       │   Discord Bot V2       │         │  Web Dashboard Server  │
       │ (Slash / Interactions) │         │    (Fastify API)       │
       └───────────┬────────────┘         └───────────┬────────────┘
                   │                                  │
                   │ (Drizzle ORM / Neon Client)      │ (Drizzle ORM)
                   ▼                                  ▼
      ═══════════════════════════════════════════════════════════════════
                      NEON POSTGRESQL (SINGLE SOURCE OF TRUTH)
        - users / wallets / wallet_ledger / wallet_topups
        - orders / sepay_transactions / card_topups
        - plugins / versions / manual_uploads / upstream_state
        - download_tokens / delivery_logs / audit_logs
        - spigot_accounts / resource_ownership / discord_channels / staffs
      ═══════════════════════════════════════════════════════════════════
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │  Local Filesystem     │             │ Local Cache (Opt.)    │
        │  (Vault JARs / Blobs) │             │ (Memory TTL Cache)    │
        └───────────────────────┘             └───────────────────────┘
```

- **Neon PostgreSQL** là cơ sở dữ liệu duy nhất lưu trữ toàn bộ trạng thái nghiệp vụ.
- Tuyệt đối không còn bất kỳ câu lệnh ghi nghiệp vụ nào (INSERT/UPDATE/DELETE) vào SQLite trong môi trường Production.
- SQLite chỉ tồn tại dưới dạng bản lưu trữ (Cold Archive), nguồn chuyển đổi (Migration Source), hoặc In-Memory Fixture trong các Unit Test nhanh.

---

## 3. Schema Parity

Bảng ma trận đối chiếu toàn bộ 21 bảng SQLite với PostgreSQL schema hiện tại ([packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts)):

| SQLite Table | Neon Table | Tồn tại | Tương thích Schema | Lệch kiểu dữ liệu / Trường thiếu | Chính sách chuyển đổi |
| :--- | :--- | :---: | :---: | :--- | :--- |
| `plugins` | `plugins` | ✅ Có | Tương thích cao | SQLite có bảng con `plugin_aliases`; Neon gộp thành mảng `aliases: text[]`. SQLite có `external_link`, Neon là `spigot_link`. | Giữ schema Neon; chuyển `plugin_aliases` thành mảng string. |
| `plugin_aliases` | *(Trong `plugins.aliases`)* | ✅ Tích hợp | Đã gom | Không cần bảng riêng. | Migrate data từ bảng phụ vào mảng string. |
| `versions` | `versions` | ✅ Có | Tương thích | Neon có thêm `changeLogs`, `source`. | Đặt default `source='spigot_auto'`, `changeLogs=''`. |
| `orders` | `orders` | ✅ Có | Tương thích | Timestamps trên SQLite là Unix seconds; Neon là `timestamp with timezone` hoặc `timestamp`. | Chuyển đổi `to_timestamp(created_at)`. |
| `sepay_transactions` | `sepay_transactions` | ✅ Có | Tương thích | Thiếu cột `description: text` (SQLite có `description`). | Bổ sung `description: text` vào Neon schema. |
| `wallets` | `wallets` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1, kiểm tra số dư. |
| `wallet_ledger` | `wallet_ledger` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1, kiểm tra tính liên tục số dư. |
| **`wallet_topups`** | *(Chưa có)* | ❌ **THIẾU** | **Không có** | Thiếu bảng lưu yêu cầu nạp tiền chuyển khoản ngân hàng. | **Bổ sung bảng `wallet_topups` vào Neon schema.** |
| `card_topups` | `card_topups` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| `discount_codes` | `discount_codes` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| **`discount_code_redemptions`** | *(Chưa có)* | ❌ **THIẾU** | **Không có** | Thiếu bảng lưu lịch sử sử dụng mã giảm giá. | **Bổ sung bảng `discount_code_redemptions` vào Neon.** |
| **`download_tokens`** | *(Chưa có)* | ❌ **THIẾU** | **Không có** | Thiếu bảng lưu mã băm sha256 cho link tải web một lần. | **Bổ sung bảng `download_tokens` vào Neon schema.** |
| **`audit_log` (Bot delivery)** | `audit_logs` (Dashboard) | ⚠️ **LỆCH** | Khác mục đích | `audit_logs` trên Neon dành riêng cho Staff RBAC trên Dashboard. Thiếu bảng lưu vết phát file jar cho user. | **Bổ sung bảng `delivery_logs` riêng biệt trên Neon.** |
| `upstream_state` | `upstream_state` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| `pending_download` | `pending_download` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| `pending_ingest` | `pending_ingest` | ✅ Có | Tương thích cao | Neon có thêm các trường AI metadata (`detectedPluginName`, `detectedVersion`, `status`). | Migrate 1-1. |
| `resource_ownership` | `resource_ownership` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| **`account_scan_state`** | *(Chưa có)* | ❌ **THIẾU** | **Không có** | Thiếu bảng cache trạng thái quét trang đã mua của tài khoản Spigot. | **Bổ sung bảng `account_scan_state` vào Neon schema.** |
| `spigot_accounts` | `spigot_accounts` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1 (mật khẩu AES-256-GCM giữ nguyên). |
| `config` | `config` | ✅ Có | 100% | Hoàn toàn tương thích. | Migrate 1-1. |
| `dashboard_staff` | `staffs` | ✅ Có | Neon cao cấp hơn | SQLite chỉ có 6 trường đơn giản; Neon có đầy đủ RBAC. | Map `discord_user_id`, `username`, `display_name` sang `staffs`. |

---

## 4. Schema Gaps (Đặc tả chi tiết 5 bảng bổ sung)

### 4.1. Bảng `wallet_topups`
1. **Purpose**: Quản lý vòng đời của các yêu cầu nạp tiền vào ví qua chuyển khoản ngân hàng (VietQR/SePay). Tách riêng khỏi bảng `orders` vì top-up không gắn với plugin hay version, không có shortfall (`underpaid`).
2. **Columns**:
   - `id`: `serial` primary key.
   - `code`: `varchar(32)` not null unique (mã nạp tiền in hoa trên QR, ví dụ `TOPUP123456`).
   - `discordUserId`: `varchar(32)` not null.
   - `amount`: `integer` not null (số tiền người dùng đăng ký nạp, VND > 0).
   - `paidAmount`: `integer` nullable (số tiền thực tế chuyển vào ngân hàng).
   - `status`: `varchar(20)` not null default `'pending'` (`'pending'` | `'credited'` | `'expired'`).
   - `createdAt`: `timestamp with time zone` default now() not null.
   - `expiresAt`: `timestamp with time zone` not null.
   - `creditedAt`: `timestamp with time zone` nullable.
3. **Primary key**: `id`.
4. **Foreign keys**: Không (ràng buộc mềm qua `discordUserId`).
5. **Unique constraints**: `uniqueIndex("idx_wallet_topups_code").on(table.code)`.
6. **Indexes**:
   - `index("idx_wallet_topups_status").on(table.status)`
   - `index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt)`
7. **Lifecycle/status**: `pending` -> `credited` (khi tiền vào) HOẶC `pending` -> `expired` (quá TTL 15 phút chưa chuyển).
8. **Data retention**: Giữ vĩnh viễn (phục vụ đối soát kế toán quỹ).
9. **Source SQLite table**: `wallet_topups` ([migrate.ts:L277-L294](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/migrate.ts#L277-L294)).
10. **Consumers**: `open-wallet-topup.ts`, `match-and-fulfil-order.ts`, `wallet-commands.ts`, Dashboard top-up reconcile API.
11. **Justification**: Nếu không có bảng này, webhook SePay khi nhận được tiền nạp ví sẽ không thể khớp lệnh, tiền của khách hàng bị treo hoặc thất thoát.

### 4.2. Bảng `discount_code_redemptions`
1. **Purpose**: Ghi nhận lịch sử sử dụng mã giảm giá, kiểm soát số lần dùng trên từng đơn hàng và từng người dùng.
2. **Columns**:
   - `id`: `serial` primary key.
   - `discountId`: `integer` not null references `discount_codes(id)` on delete cascade.
   - `discordUserId`: `varchar(32)` not null.
   - `orderId`: `integer` references `orders(id)` on delete set null.
   - `discountAmount`: `integer` not null (số tiền đã giảm thực tế > 0).
   - `redeemedAt`: `timestamp with time zone` default now() not null.
3. **Primary key**: `id`.
4. **Foreign keys**: `discountId` -> `discount_codes(id)`, `orderId` -> `orders(id)`.
5. **Unique constraints & Invariants**:
   - `uniqueIndex("idx_discount_redemption_order").on(table.orderId)` (Một đơn hàng chỉ được hưởng tối đa 1 lần giảm giá).
   - Invariant: Nếu mã cấu hình `per_user_limit = 1`, hệ thống chặn bổ sung bằng điều kiện kiểm tra tồn tại `(discount_id, discord_user_id)`.
6. **Indexes**:
   - `index("idx_discount_redemptions_discount").on(table.discountId)`
   - `index("idx_discount_redemptions_user").on(table.discordUserId)`
7. **Lifecycle/status**: Append-only (tạo khi đơn được thanh toán thành công).
8. **Data retention**: Giữ vĩnh viễn theo đơn hàng.
9. **Source SQLite table**: `discount_code_redemptions` ([migrate.ts:L364-L375](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/migrate.ts#L364-L375)).
10. **Consumers**: `discounts.ts`, `orders.ts`, Dashboard Discounts Analytics.
11. **Justification**: Ngăn chặn gian lận dùng mã giảm giá vô hạn lần hoặc áp dụng nhiều mã giảm giá trên một đơn hàng.

### 4.3. Bảng `download_tokens`
1. **Purpose**: Lưu trữ mã băm SHA-256 của token tải file một lần qua Web endpoint `/download/:token`. Token thô không bao giờ lưu trong database.
2. **Columns**:
   - `tokenHash`: `varchar(64)` primary key (chuỗi Hex sha256 digest của token).
   - `versionId`: `integer` not null references `versions(id)` on delete cascade.
   - `discordUserId`: `varchar(32)` not null.
   - `orderId`: `integer` references `orders(id)` on delete set null.
   - `expiresAt`: `timestamp with time zone` not null.
   - `usedAt`: `timestamp with time zone` nullable.
   - `createdAt`: `timestamp with time zone` default now() not null.
3. **Primary key**: `tokenHash`.
4. **Foreign keys**: `versionId` -> `versions(id)`, `orderId` -> `orders(id)`.
5. **Unique constraints**: Khóa chính `tokenHash`.
6. **Indexes**:
   - `index("idx_download_tokens_expires").on(table.expiresAt)`
   - `index("idx_download_tokens_order").on(table.orderId)`
7. **Lifecycle/status**: Chưa dùng (`usedAt IS NULL` và `expiresAt > now()`) -> Đã dùng (`usedAt = now()`) HOẶC Hết hạn (bị sweep sau TTL).
8. **Data retention**: Dòng đã dùng giữ 7 ngày để hiển thị trạng thái "Khách đã tải"; dòng hết hạn chưa dùng được quét dọn định kỳ bởi maintenance scheduler.
9. **Source SQLite table**: `download_tokens` ([schema.sql:L127-L141](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/schema.sql#L127-L141)).
10. **Consumers**: `mint-download-token.ts`, `server.ts` (HTTP download route `/download/:token`).
11. **Justification**: Bảo vệ tài sản số (file jar); ngăn chặn chia sẻ link tải công khai ra ngoài.

### 4.4. Bảng `delivery_logs` (Tách bạch khỏi `audit_logs`)
1. **Purpose**: Nhật ký giao nhận file plugin jar của bot cho khách hàng.
   - **Quy tắc phân định bắt buộc**:
     * `audit_logs`: Chỉ ghi nhận hành vi quản trị của Staff/Admin trên Dashboard (RBAC actions: đổi giá, duyệt staff, đổi kênh, ban/unban).
     * `delivery_logs`: Chỉ ghi nhận sự kiện phát hành file jar cho người dùng (Customer Delivery Events).
     * Tuyệt đối không ghi đúp một sự kiện vào cả 2 bảng.
2. **Columns**:
   - `id`: `serial` primary key.
   - `discordUserId`: `varchar(32)` not null.
   - `versionId`: `integer` references `versions(id)` on delete set null.
   - `orderId`: `integer` references `orders(id)` on delete set null.
   - `pluginName`: `varchar(255)` not null.
   - `versionLabel`: `varchar(64)` default `''` not null.
   - `amount`: `integer` default 0 not null.
   - `deliveryMethod`: `varchar(32)` not null (`'attachment'` | `'link'` | `'manual'`).
   - `ip`: `varchar(45)` nullable.
   - `deliveredAt`: `timestamp with time zone` default now() not null.
3. **Primary key**: `id`.
4. **Foreign keys**: `versionId` -> `versions(id)`, `orderId` -> `orders(id)`.
5. **Indexes**:
   - `index("idx_delivery_logs_user").on(table.discordUserId)`
   - `index("idx_delivery_logs_delivered_at").on(table.deliveredAt)`
   - `index("idx_delivery_logs_order").on(table.orderId)`
6. **Lifecycle/status**: Append-only.
7. **Data retention**: Giữ vĩnh viễn (báo cáo doanh thu và minh chứng đã bàn giao phần mềm).
8. **Source SQLite table**: `audit_log` ([schema.sql:L142-L161](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/schema.sql#L142-L161)).
9. **Consumers**: `deliver-version.ts`, `monthly-fund-stats.ts`, Dashboard Delivery Reports.
10. **Justification**: Giúp báo cáo tài chính và quỹ không bị trộn lẫn với nhật ký thao tác kỹ thuật của nhân viên.

### 4.5. Bảng `account_scan_state`
1. **Purpose**: Lưu trữ trạng thái lần quét trang "đã mua" của tài khoản Spigot, phục vụ thuật toán giãn cách quét 24h nhằm chống khóa tài khoản Spigot do Cloudflare rate-limit.
2. **Columns**:
   - `accountLabel`: `varchar(64)` primary key.
   - `lastScanAt`: `timestamp with time zone` not null.
   - `resourceCount`: `integer` default 0 not null.
   - `lastError`: `text` default `''` not null.
3. **Primary key**: `accountLabel`.
4. **Foreign keys**: Không.
5. **Indexes**: Khóa chính `accountLabel`.
6. **Lifecycle/status**: Upsert liên tục sau mỗi lần quét.
7. **Data retention**: Giữ theo danh sách tài khoản Spigot.
8. **Source SQLite table**: `account_scan_state` ([migrate.ts:L149-L157](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/migrate.ts#L149-L157)).
9. **Consumers**: `scheduler.ts`, `sync-purchased-resources.ts`.
10. **Justification**: Ngăn chặn crawler quét liên tục làm cháy proxy và chết tài khoản Spigot.

---

## 5. Repository Migration Map

| Current Repository (SQLite) | Current DB | Equivalent Neon Repository | Required Schema | Transaction Semantics |
| :--- | :---: | :--- | :--- | :--- |
| `discord/src/repositories/orders.ts` | SQLite | `discord/src/repositories/neon-orders.ts` | Dùng bảng `orders`. | **Bắt buộc Transaction**: Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`. |
| `discord/src/repositories/wallets.ts` | SQLite | `discord/src/repositories/neon-wallets.ts` | Dùng bảng `wallets`, `wallet_ledger`. | **Bắt buộc Transaction + Row-Locking (`FOR UPDATE`)**: Thay đổi `adjustWalletBalance` thành `applyLedgerEntry` đảm bảo bất biến số dư. |
| `discord/src/repositories/wallet-topups.ts` | SQLite | **Tạo mới** `discord/src/repositories/neon-wallet-topups.ts` | Thêm bảng `wallet_topups`. | **Bắt buộc Transaction**: Atomic status flip kết hợp ghi ledger. |
| `discord/src/repositories/card-topups.ts` | SQLite | **Tạo mới** `discord/src/repositories/neon-card-topups.ts` | Dùng bảng `card_topups`. | **Bắt buộc Transaction**: Atomic claim credit kết hợp ghi ledger. |
| `discord/src/repositories/discounts.ts` | SQLite | `discord/src/repositories/neon-discounts.ts` | Thêm bảng `discount_code_redemptions`. | **Bắt buộc Transaction**: Atomic update `used_count` + Insert redemption. |
| `discord/src/repositories/plugins.ts` | SQLite | `discord/src/repositories/neon-plugins.ts` | Dùng bảng `plugins`. | `db.transaction()` cho `bulkSetPluginPrice`. |
| `discord/src/repositories/versions.ts` | SQLite | `discord/src/repositories/neon-versions.ts` | Dùng bảng `versions`. | `db.transaction()` khi lưu version kèm cập nhật upstream. |
| `discord/src/repositories/upstream-state.ts` | SQLite | `discord/src/repositories/neon-upstream.ts` | Dùng bảng `upstream_state`. | Atomic Upsert (`onConflictDoUpdate`). |
| `discord/src/repositories/pending-download.ts` | SQLite | `discord/src/repositories/neon-upstream.ts` | Dùng bảng `pending_download`. | Atomic Upsert (`onConflictDoUpdate`). |
| `discord/src/repositories/resource-ownership.ts` | SQLite | `discord/src/repositories/neon-resource-ownership.ts` | Dùng bảng `resource_ownership`. | Atomic Upsert (`onConflictDoUpdate`). |
| `discord/src/repositories/account-scan-state.ts` | SQLite | **Tạo mới** `discord/src/repositories/neon-account-scan.ts` | Thêm bảng `account_scan_state`. | Atomic Upsert. |
| `discord/src/repositories/spigot-accounts.ts` | SQLite | `discord/src/repositories/neon-spigot-accounts.ts` | Dùng bảng `spigot_accounts`. | CRUD + AES-256-GCM. |
| `discord/src/services/delivery/mint-download-token.ts` | SQLite | **Tạo mới** `discord/src/repositories/neon-download-tokens.ts` | Thêm bảng `download_tokens`. | Atomic UPDATE guarded on `used_at IS NULL`. |
| `discord/src/services/delivery/deliver-version.ts` | SQLite | **Tạo mới** `discord/src/repositories/neon-delivery-logs.ts` | Thêm bảng `delivery_logs`. | Insert append-only. |

---

## 6. Transaction Boundaries & Side Effects Isolation

### 6.1. Quy tắc cô lập Side Effects (Bắt buộc)
**TUYỆT ĐỐI KHÔNG ĐƯỢC GIỮ TRANSACTION MỞ** trong bất kỳ thao tác nào sau đây:
- **Discord API Calls**: Gửi tin nhắn DM, gửi embed vào kênh thông báo, edit reply.
- **HTTP Requests**: Gọi API Card2k, gửi request Spigot, trả HTTP Response cho SePay webhook.
- **Browser Automation**: Khởi động CloakBrowser, tương tác Puppeteer, giải Cloudflare Turnstile.
- **File Disk I/O**: Đọc file jar từ `vault/`, ghi file tạm vào `tmp/`, tính SHA-256 tệp nhị phân.
- **Network Services**: Gọi YesCaptcha, Spiget API, CDN download streaming.

Mọi side effect đều phải được kích hoạt **SAU KHI TRANSACTION ĐÃ COMMIT THÀNH CÔNG**.

---

### 6.2. Đặc tả chi tiết các luồng giao dịch nghiệp vụ

#### Flow 1: Bank Order Payment (SePay Webhook trả cho Đơn hàng)
- **Vấn đề đã khắc phục**: Loại bỏ mô hình `INSERT sepay_transactions` độc lập rồi mới update `orders`. Toàn bộ dedupe và state transition phải nằm trong cùng một transaction boundary.
```text
BEGIN TRANSACTION
  1. INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, raw_payload, received_at)
     VALUES ($1, ...)
     ON CONFLICT (sepay_id) DO NOTHING
     RETURNING id;
  2. NẾU không có dòng nào được trả về:
     -- Đã nhận webhook này trước đó! (Idempotency Replay)
     ROLLBACK (hoặc commit empty) và RETURN { handled: 'duplicate' }
  3. SELECT * FROM orders WHERE code = $code FOR UPDATE;
  4. NẾU không tìm thấy order:
     -- Chuyển tiếp sang kiểm tra Topup (Flow 2) trong cùng transaction.
  5. UPDATE sepay_transactions SET order_id = order.id WHERE sepay_id = $sepay_id;
  6. NẾU order.status != 'pending':
     NẾU order.status IN ('wallet_paid', 'delivered'):
       UPDATE wallets SET balance = balance + $transferAmount WHERE discord_user_id = order.discord_user_id;
       INSERT INTO wallet_ledger (delta, kind: 'overpay', ref_type: 'order', ref_id: order.id, ...);
     COMMIT
     RETURN { handled: 'ignored', why: 'not-pending' }
  7. NẾU transferAmount < order.bankDue:
     UPDATE orders SET status = 'underpaid', paid_amount = $transferAmount, paid_at = now() WHERE id = order.id;
     COMMIT
     RETURN { handled: 'ignored', why: 'underpaid' }
  8. UPDATE orders SET status = 'paid', paid_amount = $transferAmount, paid_at = now() WHERE id = order.id;
  9. NẾU transferAmount > order.bankDue (Khách chuyển thừa tiền):
     surplus = transferAmount - order.bankDue;
     UPDATE wallets SET balance = balance + surplus WHERE discord_user_id = order.discord_user_id;
     INSERT INTO wallet_ledger (delta: surplus, kind: 'overpay', ref_type: 'order', ref_id: order.id, ...);
COMMIT

[EXTERNAL SIDE EFFECTS - NGOÀI TRANSACTION]
  - Trả HTTP 200 OK cho SePay ngay lập tức.
  - Kích hoạt bất đồng bộ `fulfilOrder()` để gửi file jar qua Discord DM cho khách hàng.
```

#### Flow 2: Bank Wallet Topup (SePay Webhook nạp tiền vào ví)
```text
BEGIN TRANSACTION (nối tiếp từ bước 4 của Flow 1 nếu không phải order)
  1. SELECT * FROM wallet_topups WHERE code = $code FOR UPDATE;
  2. NẾU không tìm thấy topup:
     COMMIT và RETURN { handled: 'ignored', why: 'no-order' }
  3. UPDATE wallet_topups SET status = 'credited', paid_amount = $transferAmount, credited_at = now()
     WHERE id = topup.id AND status = 'pending'
     RETURNING id;
  4. NẾU không update được dòng nào (đã xử lý hoặc hết hạn):
     COMMIT và RETURN { handled: 'ignored', why: 'not-pending' }
  5. SELECT balance FROM wallets WHERE discord_user_id = topup.discord_user_id FOR UPDATE;
  6. INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
     VALUES (topup.discord_user_id, $transferAmount, now(), now())
     ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $transferAmount, updated_at = now()
     RETURNING balance;
  7. INSERT INTO wallet_ledger (discord_user_id, delta: $transferAmount, balance_after, kind: 'bank_topup', ref_type: 'topup', ref_id: topup.id, ...);
COMMIT

[EXTERNAL SIDE EFFECTS - NGOÀI TRANSACTION]
  - Trả HTTP 200 OK cho SePay.
  - Gửi thông báo nạp ví thành công qua Discord DM cho khách.
```

#### Flow 3: Wallet Purchase (Mua plugin bằng số dư ví)
```text
[EXTERNAL SIDE EFFECTS TRƯỚC TRANSACTION]
  - Kiểm tra tính sẵn sàng của file jar trên đĩa vault.
  - Tính toán giá depositPrice và kiểm tra mã giảm giá (nếu có).

BEGIN TRANSACTION
  1. SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  2. walletPaid = min(balance, price);
     bankDue = price - walletPaid;
  3. NẾU bankDue == 0 (Ví đủ 100% tiền): status = 'wallet_paid';
     NGƯỢC LẠI: status = 'pending';
  4. INSERT INTO orders (code, discord_user_id, version_id, plugin_name, version_label, amount, wallet_paid, bank_due, status, created_at, expires_at)
     VALUES (...) RETURNING *;
  5. NẾU walletPaid > 0:
     UPDATE wallets SET balance = balance - walletPaid, updated_at = now() WHERE discord_user_id = $userId;
     INSERT INTO wallet_ledger (discord_user_id, delta: -walletPaid, balance_after, kind: 'order_hold', ref_type: 'order', ref_id: order.id, ...);
COMMIT

[EXTERNAL SIDE EFFECTS SAU TRANSACTION]
  - NẾU status == 'wallet_paid': Kích hoạt bất đồng bộ `fulfilOrder()` giao hàng ngay lập tức.
  - NẾU status == 'pending': Tạo VietQR URL từ bankDue và trả về embed hướng dẫn chuyển khoản.
```

#### Flow 4: Card Topup (Khớp nạp thẻ cào Card2k)
```text
[EXTERNAL SIDE EFFECTS TRƯỚC TRANSACTION]
  - Gửi HTTP request tới Card2k API để check trạng thái thẻ.

BEGIN TRANSACTION
  1. UPDATE card_topups
     SET status = $status, actual_value = $actualValue, net_amount = $netAmount, credited_at = now()
     WHERE id = $id AND credited_at IS NULL AND status = 'pending'
     RETURNING id, discord_user_id;
  2. NẾU không có dòng nào được trả về:
     ROLLBACK và RETURN { settled: false, credited: false }; -- Đã được claim bởi poll khác
  3. NẾU kết quả thẻ hợp lệ có giá trị:
     SELECT balance FROM wallets WHERE discord_user_id = $discordUserId FOR UPDATE;
     UPDATE wallets SET balance = balance + $actualValue, updated_at = now() WHERE discord_user_id = $discordUserId;
     INSERT INTO wallet_ledger (discord_user_id, delta: $actualValue, balance_after, kind: 'card_topup', ref_type: 'card', ref_id: $id, ...);
COMMIT

[EXTERNAL SIDE EFFECTS SAU TRANSACTION]
  - Gửi thông báo nạp thẻ thành công vào Discord DM của khách hàng.
```

#### Flow 5: Order Expiration & Exactly-Once Refund (Hết hạn & Hoàn ví)
```text
BEGIN TRANSACTION
  1. SELECT id, discord_user_id, wallet_paid FROM orders
     WHERE status = 'pending' AND expires_at <= now()
     FOR UPDATE SKIP LOCKED;
  2. VỚI MỖI order:
     UPDATE orders SET status = 'expired' WHERE id = order.id AND status = 'pending';
     NẾU order.wallet_paid > 0:
       -- Exactly-Once Claim
       UPDATE orders SET wallet_paid = 0 WHERE id = order.id AND wallet_paid = order.wallet_paid;
       SELECT balance FROM wallets WHERE discord_user_id = order.discord_user_id FOR UPDATE;
       UPDATE wallets SET balance = balance + order.wallet_paid, updated_at = now() WHERE discord_user_id = order.discord_user_id;
       INSERT INTO wallet_ledger (discord_user_id, delta: order.wallet_paid, balance_after, kind: 'order_refund', ref_type: 'order', ref_id: order.id, note: 'đơn hết hạn');
COMMIT
```

---

## 7. Migration Strategy & Backup

### 7.1. Sao lưu SQLite an toàn (Zero Corruption Backup)
- **Tuyệt đối không dùng**: Lệnh copy file thô khi database đang mở kết nối WAL vì dễ tạo ra snapshot rách (torn pages).
- **Quy trình chuẩn**:
  1. Gọi lệnh khóa cờ bảo trì hệ thống (`maintenance = true`) trên Discord Bot để tạm dừng tiếp nhận đơn mới.
  2. Sử dụng **SQLite Online Backup API** thông qua phương thức `.backup()` của `better-sqlite3`:
     ```typescript
     const sourceDb = openDb(env.DB_PATH);
     await sourceDb.backup(`data/backups/vault_pre_cutover_${Date.now()}.db`);
     sourceDb.close();
     ```
  3. **Kiểm định bản sao lưu (Backup Verification)**:
     - Mở tệp backup vừa tạo và thực thi:
       * `PRAGMA integrity_check;` -> Kết quả phải là `ok`.
       * `PRAGMA foreign_key_check;` -> Kết quả phải rỗng (`[]`).
  4. **Thử nghiệm khôi phục (Restore Test)**:
     - Chạy script kiểm tra nạp thử dữ liệu từ bản backup lên một database SQLite in-memory để đảm bảo 100% các bảng đều đọc được bình thường trước khi tiến hành chuyển đổi sang Neon.

---

### 7.2. Chính sách xử lý dữ liệu hiện có trên Neon (Existing Data Conflict Policy)
Không giả định Neon rỗng. Xử lý theo 3 trạng thái:
1. **SQLite-only data**: Chuyển thẳng sang Neon.
2. **Neon-only data**: Giữ nguyên vẹn trên Neon.
3. **Data present in both (Trùng lặp dữ liệu giữa 2 bên)**:
   - **`staffs`**: **Merge**. Ưu tiên bản ghi trên Neon nếu đã có phân quyền RBAC và email; bổ sung thêm tài khoản từ SQLite `dashboard_staff` nếu chưa tồn tại trên Neon.
   - **`audit_logs`**: **Tách biệt hoàn toàn**. Giữ nguyên `audit_logs` của Neon cho Staff RBAC; dữ liệu `audit_log` của SQLite được chuyển vào bảng mới `delivery_logs`.
   - **`discord_channels`**: **Prefer Neon**. Giữ nguyên cấu hình kênh Discord đã được cài đặt trên Neon.
   - **`plugins`**: **Merge**. Khóa trùng theo `slug` hoặc `resource_id`. Hợp nhất mảng `aliases` (loại bỏ trùng lặp). Giữ mô tả và link mới nhất từ Neon nếu Dashboard đã sửa, giữ `deposit_price` của SQLite nếu SQLite có đơn hàng liên quan.
   - **`versions`**: **Prefer SQLite on `sha256` conflict**. Phiên bản trong SQLite gắn liền với file jar vật lý trên đĩa vault; bổ sung thêm trường `changeLogs` nếu Neon có.
   - **`orders`**: **Conflict on `code` -> Fail Migration & Require Manual Reconcile**. Mã đơn hàng là duy nhất. Nếu cùng một code mà khác `discord_user_id` hoặc trạng thái, script migration phải lập tức dừng lại để Admin can thiệp, không được tự ý ghi đè.
   - **`wallets`**: **Conflict on `discord_user_id` -> Reconcile to Ledger Sum**. Số dư ví luôn được chuẩn hóa bằng tổng biến động của sổ cái: `balance = SUM(wallet_ledger.delta)`.
   - **`wallet_ledger`**: **Append-only & Dedupe**. Chống trùng lặp theo khóa nghiệp vụ `(discord_user_id, kind, ref_type, ref_id, created_at)`.
   - **`card_topups`**: **Conflict on `request_id` -> Prefer Terminal State**. Ưu tiên trạng thái đã hoàn tất (`success`, `failed`, `credited`) hơn trạng thái `pending`.

---

## 8. Reconciliation Strategy

### 8.1. Business-Key Reconciliation
Script di chuyển dữ liệu bắt buộc phải kiểm tra và xác nhận các chỉ số nghiệp vụ sau:
1. **Orders**: Khớp từng mã `code` giữa SQLite và Neon.
2. **Wallets**: Khớp từng `discord_user_id`.
3. **SePay Transactions**: Khớp từng `sepay_id`.
4. **Card Topups**: Khớp từng `request_id`.
5. **Plugins**: Khớp từng `slug` và `resource_id`.
6. **Versions**: Khớp từng chuỗi mã băm `sha256`.

### 8.2. Tiêu chí kiểm định 8 chiều (Reconciliation Verification)
- **Missing rows**: Bắt buộc = 0.
- **Duplicate rows**: Bắt buộc = 0.
- **Orphan foreign keys**: Bắt buộc = 0 (kiểm tra `foreign_key_check` toàn diện).
- **Business-key collisions**: Bắt buộc = 0.
- **Unexpected truncation**: Bắt buộc = 0 (kiểm tra độ dài xâu ký tự phiên bản, tên plugin).
- **Timestamp conversion**: Toàn bộ Unix epoch seconds được chuyển đổi chính xác sang UTC Timestamp (không bị lệch múi giờ).
- **Boolean conversion**: Toàn bộ cờ 0/1 được chuyển thành `true`/`false`.
- **JSON conversion**: Toàn bộ chuỗi payload thô của SePay chuyển đổi thành `jsonb` hợp lệ.
- **NULL vs Empty string**: Giữ nguyên vẹn ngữ nghĩa (ví dụ: `code` null khác với code `''`).

### 8.3. Bất biến số dư ví (Wallet Invariant Check)
Thực thi truy vấn đối soát trên toàn bộ người dùng:
```sql
SELECT w.discord_user_id, w.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
FROM wallets w
LEFT JOIN wallet_ledger l ON l.discord_user_id = w.discord_user_id
GROUP BY w.discord_user_id, w.balance
HAVING w.balance != COALESCE(SUM(l.delta), 0);
```
**Yêu cầu bắt buộc**: Kết quả phải trả về **0 dòng**.

---

## 9. Cutover Plan (Timeline T-0 đến T+7)

| Mốc Thời Gian | Hành Động Kỹ Thuật Chi Tiết | Trạng Thái Hệ Thống |
| :---: | :--- | :---: |
| **T-0 (00:00)** | **Freeze Writes**: Bật cờ bảo trì trên Bot Discord (`MAINTENANCE_MODE=true`). Bot từ chối nhận lệnh mua mới; webhook SePay tạm hoãn xử lý (hoặc trả 503 để SePay retry sau). | Tạm dừng ghi |
| **T+1 (00:01)** | **Online SQLite Backup**: Dùng `.backup()` API xuất snapshot ra tệp `data/backups/vault_cutover.db`. Chạy kiểm tra `PRAGMA integrity_check`. | Đọc an toàn |
| **T+2 (00:03)** | **Migrate Data**: Thực thi `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts` áp dụng đầy đủ Conflict Policy. | Đang chuyển dữ liệu |
| **T+3 (00:06)** | **Reconciliation & Validation**: Tự động chạy bộ script đối soát: đếm dòng, kiểm tra business keys, xác thực `reconcileBalances == 0`, reset toàn bộ Postgres Sequences. | Kiểm định |
| **T+4 (00:08)** | **Switch Runtime**: Cập nhật cấu hình môi trường, khởi động Bot Discord trỏ trực tiếp vào Neon Drizzle Client, ngắt kết nối SQLite runtime hoàn toàn. | Chuyển mạch |
| **T+5 (00:09)** | **Smoke Test**: Kiểm tra lệnh `/vi`, `/menu`, tạo thử 1 đơn hàng test, gọi API Web Dashboard `/api/orders` xác nhận nhìn thấy đơn ngay lập tức. | Thử nghiệm nội bộ |
| **T+6 (00:10)** | **Enable Writes**: Tắt cờ bảo trì. Hệ thống mở lại nhận thanh toán và tương tác người dùng bình thường. | Hoạt động trở lại |
| **T+7 (00:11 - 00:40)** | **Monitor**: Giám sát log thời gian thực trong 30 phút. Kiểm tra latency, connection pooler, và tỷ lệ thành công của webhook. | Giám sát |

---

## 10. Rollback Plan

### 10.1. Điều kiện kích hoạt Rollback ngay lập tức
- Tỷ lệ lỗi kết nối hoặc timeout tới Neon PostgreSQL vượt quá **3%** trong 15 phút đầu.
- Phát hiện bất kỳ trường hợp nào số dư ví bị lệch so với sổ cái (`reconcileBalances` > 0).
- Xảy ra deadlock không thể tự giải phóng trong các transaction thanh toán.

### 10.2. Các bước khôi phục (Rollback Procedure)
1. Bật ngay cờ bảo trì hệ thống.
2. Đổi biến môi trường của Bot quay trở lại sử dụng tệp SQLite `data/backups/vault_cutover.db`.
3. Khởi động lại Bot Discord ở chế độ SQLite ban đầu.
4. Trả webhook SePay về xử lý trên SQLite.
5. Xuất dump lỗi từ Neon để đội ngũ kỹ thuật phân tích và khắc phục trước đợt cutover kế tiếp.

---

## 11. Test Plan

Thiết kế bộ kiểm thử chuyên sâu cho các kịch bản cạnh tranh và sự cố:
1. **Concurrent Purchase**: 10 request đồng thời mở đơn hàng từ cùng một người dùng có số dư chỉ đủ mua 1 sản phẩm.
   - *Kỳ vọng*: Đúng 1 đơn hàng trừ ví thành công; 9 đơn hàng còn lại chuyển sang chờ chuyển khoản ngân hàng 100%. Không bao giờ âm ví.
2. **Concurrent Topup**: 2 webhook ngân hàng gửi tiền vào cùng 1 tài khoản ví tại cùng 1 thời điểm.
   - *Kỳ vọng*: Cả 2 giao dịch đều được ghi nhận đầy đủ, số dư ví bằng tổng của cả 2 lần nạp, không bị hiện tượng Lost Update.
3. **Purchase + Topup Concurrently**: Vừa có tiền chuyển khoản nạp vào vừa có lệnh mua hàng trừ ví cùng lúc.
   - *Kỳ vọng*: Row-locking xử lý tuần tự, số dư cuối cùng khớp tuyệt đối với tổng ledger.
4. **Refund + Purchase Concurrently**: Quá trình hoàn tiền đơn hàng hết hạn diễn ra đồng thời với lệnh mua mới.
   - *Kỳ vọng*: Tiền được hoàn trước khi mua hoặc sau khi mua, không thất thoát coin.
5. **Duplicate Webhook**: Bắn 5 request trùng `sepay_id` đồng thời tới máy chủ.
   - *Kỳ vọng*: Đúng 1 request được xử lý; 4 request còn lại nhận diện duplicate an toàn mà không ghi đúp tiền.
6. **Process Crash Simulation**: Dừng đột ngột tiến trình Node.js giữa lúc đang thực thi webhook.
   - *Kỳ vọng*: Database rollback toàn bộ; khi webhook gửi retry, hệ thống tiếp tục xử lý thành công không để lại dữ liệu rác.

---

## 12. Files To Modify (Không sửa code trong task này)

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 5 bảng: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`, `account_scan_state`.
   - Bổ sung trường `description: text` vào bảng `sepay_transactions`.
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Gỡ bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` từ SQLite sang `neonDb`.
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Viết lại hàm `applyLedgerEntry` sử dụng `db.transaction()` và `SELECT ... FOR UPDATE`.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Tái cấu trúc transaction boundary cho webhook SePay: đưa dedupe và state update vào cùng 1 transaction. Cô lập hoàn toàn side effects (Discord DM, HTTP) ra ngoài transaction.
6. [discord/src/services/payment/open-wallet-topup.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/open-wallet-topup.ts):
   - Chuyển sang dùng `neon-wallet-topups.ts`.
7. [discord/src/services/card/submit-card-topup.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts):
   - Chuyển sang dùng `neon-card-topups.ts` và Neon transaction.
8. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Chuyển `recordDelivery` ghi nhận vào bảng `delivery_logs`.
9. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Chuyển sang dùng bảng `download_tokens` trên Neon.
10. [discord/src/services/maintenance/scheduler.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/maintenance/scheduler.ts):
    - Đổi các tác vụ định kỳ quét đơn hết hạn, poll thẻ cào, sweep tokens sang Neon.

---

## 13. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon.
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file bảo mật trên Neon.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file của Bot trên Neon.
5. `discord/src/repositories/neon-account-scan.ts`: Quản lý cache trạng thái quét tài khoản Spigot trên Neon.
6. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu toàn diện 20 bảng từ SQLite sang Neon có áp dụng Conflict Policy và đối soát.
7. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động kiểm tra tính nguyên tử, idempotency và concurrency trên Neon.

---

## 14. Acceptance Criteria (15 Tiêu Chí Bắt Buộc)

Phase 1 chỉ được đánh giá là **PASS** khi thỏa mãn toàn bộ 15 tiêu chí sau:
1. [ ] **No production SQLite business writes**: Tuyệt đối không còn câu lệnh ghi dữ liệu nghiệp vụ nào vào SQLite tại runtime production.
2. [ ] **Discord and Dashboard read the same Neon rows**: Đơn hàng tạo từ Discord Bot xuất hiện tức thì trên Dashboard và ngược lại.
3. [ ] **Payment transitions are atomic**: Mọi giao dịch thanh toán đều nằm gọn trong một transaction boundary duy nhất.
4. [ ] **Wallet ledger is consistent**: `wallets.balance == sum(wallet_ledger.delta)` đạt 100% trên toàn bộ người dùng.
5. [ ] **Duplicate webhook is safe**: Webhook SePay gửi trùng không bao giờ ghi đúp tiền hoặc làm sai lệch trạng thái đơn.
6. [ ] **Concurrent wallet mutation is safe**: Kiểm thử mua hàng và nạp tiền đồng thời không gây race condition hay âm số dư.
7. [ ] **Migration reconciliation passes**: Đối soát business keys đạt 100% khớp (missing = 0, unexpected truncation = 0).
8. [ ] **No orphan rows**: Không có bản ghi mồ côi khóa ngoại sau di chuyển.
9. [ ] **No duplicate business keys**: Không trùng lặp mã đơn, mã giao dịch, mã thẻ hay sha256.
10. [ ] **Rollback procedure tested**: Kịch bản khôi phục về bản backup SQLite đã được diễn tập thành công.
11. [ ] **Existing Discord UX unchanged**: Giao diện, menu nút bấm, modal nạp tiền trên Discord Bot giữ nguyên vẹn 100%.
12. [ ] **Existing Dashboard UX unchanged**: Giao diện quản trị Web Dashboard giữ nguyên vẹn 100%.
13. [ ] **Existing tests pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.
14. [ ] **New integration tests pass**: Bộ test mới về tính nguyên tử trên Neon đạt 100%.
15. [ ] **Docker production build passes**: Bản build container multi-service trong `docker-compose.yml` hoạt động trơn tru.

---

## 15. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Race condition khi trừ số dư ví** | **Nghiêm trọng** | Môi trường web đa luồng/kết nối đồng thời dễ đọc cùng số dư cũ. | Bắt buộc sử dụng `SELECT ... FOR UPDATE` trong transaction của Neon. |
| **Webhook retry gây duplicate tiền** | **Nghiêm trọng** | Tách rời insert log và update trạng thái đơn hàng. | Gom toàn bộ vào 1 transaction duy nhất với `ON CONFLICT DO NOTHING RETURNING id`. |
| **Deadlock trong database Neon** | **Trung bình** | Thứ tự khóa hàng giữa các bảng không nhất quán. | Chuẩn hóa thứ tự khóa: Luôn khóa `wallets` trước, sau đó mới cập nhật `orders`/`wallet_topups`. |
| **Lệch Sequence ID sau Migration** | **Cao** | Khi insert dữ liệu cũ có sẵn ID, Postgres sequence không tự tăng. | Chạy lệnh `SELECT setval('..._id_seq', MAX(id))` cho toàn bộ các bảng serial ngay sau migration. |
| **Độ trễ mạng làm chậm lệnh Bot** | **Trung bình** | Kết nối mạng từ Bot tới Neon qua Internet có độ trễ lớn hơn SQLite local. | Sử dụng Neon WebSocket Pooler, gom các câu lệnh vào cùng transaction để giảm số lượt round-trip mạng. |
