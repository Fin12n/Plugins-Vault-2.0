# PHASE 1 FINAL IMPLEMENTATION PLAN v4 — DUAL-VAULT & BUSINESS AUTHORITY

> **Tôn chỉ kiến trúc tối thượng (Core Architectural Principle)**:
> ```text
> ┌────────────────────────────────────────────────────────┐
> │ LOCAL DATABASE  = SECRET / PRIVATE ACCOUNT VAULT       │
> │ NEON POSTGRESQL = BUSINESS SINGLE SOURCE OF TRUTH      │
> └────────────────────────────────────────────────────────┘
> ```
> - **Tuyệt đối không lưu trữ thông tin nhạy cảm** (Mật khẩu, Cookie, Session, Token định danh cá nhân upstream, Browser Profile, Master Encryption Key) trên Neon Cloud PostgreSQL.
> - **Toàn bộ dữ liệu nghiệp vụ** (Đơn hàng, Tiền tệ, Ví, Sổ cái, Thẻ cào, Webhook, Link tải, Bàn giao, Danh mục) chuyển 100% về **Neon PostgreSQL**.
> - Không rewrite bot, không đổi UI/UX, không thêm feature ngoài phạm vi Phase 1, và không can thiệp CloakBrowser.

---

## 1. Current Architecture

### 1.1. Hiện trạng phân mảnh dữ liệu (Split-Brain)
1. **Discord Bot Runtime**:
   - Sử dụng thư viện `better-sqlite3` kết nối đồng bộ tới tệp SQLite cục bộ (`data/deps.db` hoặc `data/vault.db`) ([connection.ts:L23-L49](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/connection.ts#L23-L49)).
   - Toàn bộ giao dịch tiền bạc cốt lõi bao gồm: tạo đơn hàng ([orders.ts:L29-L61](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/orders.ts#L29-L61)), trừ số dư ví ([wallets.ts:L55-L96](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L55-L96)), ghi sổ cái ([wallets.ts:L78-L90](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L78-L90)), xử lý webhook ngân hàng SePay ([match-and-fulfil-order.ts:L156-L237](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts#L156-L237)), nạp thẻ cào Card2k ([submit-card-topup.ts:L70-L130](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts#L70-L130)), cấp link tải một lần ([mint-download-token.ts:L17-L30](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts#L17-L30)), và nhật ký giao file ([deliver-version.ts:L135-L163](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts#L135-L163)) đều được ghi độc quyền vào SQLite.
2. **Dashboard Backend Runtime**:
   - Khởi tạo kết nối trực tiếp tới Neon PostgreSQL thông qua gói `@vault/db` ([neon.ts:L8](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/db/neon.ts#L8)).
   - Các API truy vấn danh sách đơn hàng ([orders-routes.ts:L36-L50](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/orders-routes.ts#L36-L50)), số dư ví ([wallets-routes.ts:L21-L40](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/wallets-routes.ts#L21-L40)) hoàn toàn đọc từ Neon PostgreSQL.
3. **Lỗ hổng kiến trúc cần khắc phục**:
   - Bảng `spigotAccounts` trong Neon schema cũ chứa `passwordEncrypted`, `xfUserEncrypted`, `xfSessionEncrypted` ([schema.ts:L203-L222](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts#L203-L222)). Phải loại bỏ hoàn toàn các cột này khỏi Neon và chuyển về Local Vault.
   - Bảng `account_scan_state` chứa tiến trình crawler cục bộ không đưa lên cloud database nghiệp vụ.

---

## 2. Target Architecture

```text
       ┌────────────────────────────────────────────────────────┐
       │                 APPLICATION WORKSPACES                 │
       │   Discord Bot V2                  Web Dashboard        │
       └───────────┬──────────────────────────────┬─────────────┘
                   │                              │
        ┌──────────┴──────────┐                   │
        │ Local Private Access│                   │ Public Business Access
        ▼                     ▼                   ▼
┌────────────────────────┐  ══════════════════════════════════════════════
│  LOCAL SECRET VAULT    │              NEON POSTGRESQL
│  (Isolated SQLite DB)  │       (BUSINESS SINGLE SOURCE OF TRUTH)
├────────────────────────┤  ══════════════════════════════════════════════
│ • spigot_accounts      │  • users / staffs         • wallet_ledger
│   - id, username       │  • plugins / versions     • wallet_topups
│   - enc_password       │  • manual_uploads         • card_topups
│   - enc_cookies (xf)   │  • orders                 • discount_codes
│   - session / profile  │  • sepay_transactions     • discount_redemptions
│ • account_scan_state   │  • wallets                • delivery_logs
│   - rate-limit state   │  • download_tokens        • delivery_jobs
│   - crawl errors       │  • resource_ownership    • upstream_state
│ • vault/ storage blobs │  • discord_channels       • pending_download
│   - JAR files on disk  │  • spigot_account_refs    • audit_logs (Staff)
│ • Ciphertext only      │    (id, label, health, status)
└────────────────────────┘  ══════════════════════════════════════════════
  ▲
  │ (Key injected from outside DB: VAULT_MASTER_KEY)
```

---

## 3. Data Classification Matrix

| Phân Loại Dữ Liệu | Danh Sách Bảng / Dữ Liệu | Nơi Lưu Trữ Duy Nhất | Chính Sách Quản Trị & Truy Xuất |
| :--- | :--- | :---: | :--- |
| **SECRET / PRIVATE ACCOUNT VAULT** | `spigot_accounts` (credentials, cookies), `account_scan_state`, Browser Profiles, Local temporary state | **Local SQLite** (`data/vault_secrets.db`) | **GIỮ CỤC BỘ**. Không export, không dump, không migrate lên Neon. Quyền truy cập tệp `0o600`/`0o700`. |
| **MASTER ENCRYPTION KEY** | Khóa giải mã cục bộ 256-bit (`VAULT_MASTER_KEY`) | **Environment Secret / OS Secret Store** | **NGOÀI DATABASE**. Không lưu trong `vault_secrets.db`, không lưu trong Neon, không ghi log. |
| **BUSINESS DATA (Authority)** | `orders`, `wallets`, `wallet_ledger`, `wallet_topups`, `sepay_transactions`, `card_topups`, `plugins`, `versions`, `manual_uploads`, `delivery_logs`, `delivery_jobs`, `download_tokens`, `discount_codes`, `discount_code_redemptions`, `resource_ownership`, `upstream_state`, `pending_download`, `pending_ingest`, `discord_channels`, `staffs`, `audit_logs`, `config` | **Neon PostgreSQL** | **CHUYỂN SANG NEON**. Neon là Single Source of Truth. Discord Bot và Dashboard cùng đọc/ghi. |
| **PUBLIC ACCOUNT REFERENCE** | `spigot_account_refs` (`id`, `label`, `status`, `health`, `last_check_at`) | **Neon PostgreSQL** | **CHUYỂN THAM CHIẾU SANG NEON**. Không chứa bất kỳ trường mật khẩu hay cookie nào. |
| **CACHE & ASSETS** | File `.jar` nhị phân (`vault/`), File tạm (`tmp/`), Discord In-Memory Session | **Local Filesystem / Memory** | **GIỮ CỤC BỘ**. Nội dung content-addressed theo SHA-256; database chỉ lưu metadata và đường dẫn tương đối. |

---

## 4. Schema Parity & Uniqueness Invariants

### 4.1. Bảng đối chiếu thực thể
| Tên Bảng Nguồn (SQLite) | Bảng Đích Tại Neon | Phân Loại | Trạng Thái Schema | Hành Động Kỹ Thuật |
| :--- | :--- | :---: | :---: | :--- |
| `orders` | `orders` | Business | Đã có | Chuyển timestamps sang UTC timestamp with timezone. |
| `wallets` | `wallets` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `wallet_ledger` | `wallet_ledger` | Business | Đã có | **Tạo Partial Unique Index** để ngăn duplicate credit theo business key. |
| `wallet_topups` | **`wallet_topups`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý nạp tiền chuyển khoản). |
| `sepay_transactions` | `sepay_transactions` | Business | Đã có | Bổ sung cột `description: text`. |
| `card_topups` | `card_topups` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `plugins` | `plugins` | Business | Đã có | Gộp `plugin_aliases` thành mảng string `aliases`. |
| `plugin_aliases` | *(Trong `plugins.aliases`)* | Business | Đã gom | Migrate dữ liệu vào mảng text trên Neon. |
| `versions` | `versions` | Business | Đã có | Giữ nguyên, thêm `changeLogs`, `source`. |
| `manual_uploads` | `manual_uploads` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_codes` | `discount_codes` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_code_redemptions` | **`discount_code_redemptions`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (chống gian lận mã giảm giá). |
| `download_tokens` | **`download_tokens`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý link tải web với atomic consumption). |
| `audit_log` (Bot) | **`delivery_logs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (có `delivery_idempotency_key`). |
| *(Durable Handoff)* | **`delivery_jobs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (hoặc dùng `pending_download` mở rộng). |
| `upstream_state` | `upstream_state` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_download` | `pending_download` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_ingest` | `pending_ingest` | Business | Đã có | Giữ nguyên vẹn. |
| `resource_ownership` | `resource_ownership` | Business | Đã có | Giữ nguyên vẹn (chỉ map resource_id -> account_label). |
| `discord_channels` | `discord_channels` | Business | Đã có | Giữ nguyên cấu hình kênh. |
| `dashboard_staff` | `staffs` | Business | Đã có | Map dữ liệu sang bảng staffs RBAC. |
| `audit_log` (Admin) | `audit_logs` | Business | Đã có | Giữ nguyên cho Staff RBAC actions. |
| `config` | `config` | Business | Đã có | Giữ nguyên cấu hình runtime. |
| `spigot_accounts` (Secret) | *(Không đưa lên Neon)* | **Secret** | **Local Only** | **GIỮ TẠI LOCAL SQLITE**. |
| *(Tạo tham chiếu mới)* | **`spigot_account_refs`** | Reference | ❌ **Chuẩn hóa** | Thay thế `spigotAccounts` cũ trên Neon, loại bỏ cột secret. |
| `account_scan_state` | *(Không đưa lên Neon)* | **Secret** | **Local Only** | **GIỮ TẠI LOCAL SQLITE**. |

### 4.2. Wallet Ledger Unique — Postgres Correctness (Quy tắc bắt buộc)
PostgreSQL **KHÔNG HỖ TRỢ** table constraint `UNIQUE (...) WHERE ...`. Bắt buộc phải dùng **PARTIAL UNIQUE INDEX**:

```sql
CREATE UNIQUE INDEX idx_wallet_ledger_ref_kind_unique
ON wallet_ledger (ref_type, ref_id, kind)
WHERE ref_type != '' AND ref_id IS NOT NULL;
```

Trong Drizzle ORM ([schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts)):
```typescript
uniqueIndex("idx_wallet_ledger_ref_kind_unique")
  .on(table.refType, table.refId, table.kind)
  .where(sql`ref_type != '' AND ref_id IS NOT NULL`);
```
*Tác dụng*: Ngăn chặn hoàn toàn việc credit đúp cùng một nghiệp vụ (`topup`, `order_refund`, `card_topup`) vào cùng một loại ledger, trong khi vẫn cho phép các dòng ledger không có ref (như manual adjustment) được ghi nhận an toàn.

---

## 5. Schema Gaps (Đặc tả chi tiết các bảng mới trên Neon)

### 5.1. Bảng `wallet_topups` (Business Data)
- **Purpose**: Quản lý vòng đời yêu cầu nạp tiền ví qua chuyển khoản VietQR/SePay.
- **Columns**: `id` (serial PK), `code` (varchar 32 unique), `discordUserId` (varchar 32 not null), `amount` (integer not null > 0), `paidAmount` (integer nullable), `status` (varchar 20 default 'pending'), `createdAt` (timestamp with tz), `expiresAt` (timestamp with tz), `creditedAt` (timestamp with tz nullable).
- **Constraints & Indexes**: `uniqueIndex("idx_wallet_topups_code").on(table.code)`, `index("idx_wallet_topups_status").on(table.status)`, `index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt)`.
- **Lifecycle**: `pending` -> `credited` HOẶC `pending` -> `expired`.

### 5.2. Bảng `discount_code_redemptions` (Business Data)
- **Purpose**: Lưu vết và thực thi giới hạn sử dụng mã giảm giá.
- **Columns**: `id` (serial PK), `discountId` (integer not null references `discount_codes.id` on delete cascade), `discordUserId` (varchar 32 not null), `orderId` (integer references `orders.id` on delete set null), `discountAmount` (integer > 0), `redeemedAt` (timestamp with tz default now()).
- **Unique Constraints**: `uniqueIndex("idx_discount_redemptions_order").on(table.orderId)`.
- **Indexes**: `index("idx_discount_redemptions_discount_user").on(table.discountId, table.discordUserId)`.

### 5.3. Bảng `download_tokens` (Business Data - Atomic Consumption)
- **Purpose**: Lưu mã băm SHA-256 xác thực link tải một lần qua Web endpoint `/download/:token`.
- **Columns**: `tokenHash` (varchar 64 primary key - sha256 hex digest), `versionId` (integer not null references `versions.id` on delete cascade), `discordUserId` (varchar 32 not null), `orderId` (integer references `orders.id` on delete set null), `expiresAt` (timestamp with tz not null), `usedAt` (timestamp with tz nullable), `createdAt` (timestamp with tz default now()).
- **Indexes**: `index("idx_download_tokens_expires").on(table.expiresAt)`, `index("idx_download_tokens_order").on(table.orderId)`.
- **Atomic Consumption Invariant**: Cấm đọc rồi ghi (no read-then-write). Tiêu thụ token bằng atomic mutation:
  ```sql
  UPDATE download_tokens
  SET used_at = now()
  WHERE token_hash = $hash
    AND used_at IS NULL
    AND expires_at > now()
  RETURNING version_id, discord_user_id, order_id;
  ```
  Chỉ request nhận được row trả về mới được phép tải file. Request đến sau nhận 0 row -> Bị từ chối ngay lập tức (HTTP 410 Gone).

### 5.4. Bảng `delivery_logs` (Business Data - Idempotent Audit)
- **Purpose**: Nhật ký giao nhận file plugin jar của Bot Discord cho khách hàng.
- **Columns**: `id` (serial PK), `deliveryIdempotencyKey` (varchar 128 not null), `discordUserId` (varchar 32 not null), `versionId` (integer references `versions.id` on delete set null), `orderId` (integer references `orders.id` on delete set null), `pluginName` (varchar 255 not null), `versionLabel` (varchar 64 default ''), `amount` (integer default 0), `deliveryMethod` (varchar 32: 'attachment' | 'link' | 'manual'), `ip` (varchar 45 nullable), `deliveredAt` (timestamp with tz default now()).
- **Idempotency Constraint**:
  ```sql
  CREATE UNIQUE INDEX idx_delivery_logs_idempotency_key
  ON delivery_logs (delivery_idempotency_key);
  ```
  `deliveryIdempotencyKey` được chuẩn hóa theo định dạng: `${orderId}:${deliveryMethod}` (hoặc `${orderId}:${versionId}:${deliveryMethod}`).
  Retry không bao giờ tạo duplicate successful delivery records.

### 5.5. Bảng `delivery_jobs` (Durable Handoff Queue)
- **Purpose**: Đảm bảo bàn giao bền vững, ngăn ngừa mất intent khi bot crash ngay sau `COMMIT`.
- **Columns**: `id` (serial PK), `orderId` (integer not null references `orders.id` on delete cascade), `discordUserId` (varchar 32 not null), `versionId` (integer not null references `versions.id`), `deliveryMethod` (varchar 32 default 'attachment'), `status` (varchar 20 default 'queued': 'queued' | 'processing' | 'delivered' | 'failed'), `retryCount` (integer default 0), `lastError` (text nullable), `lockedAt` (timestamp with tz nullable), `createdAt` (timestamp with tz default now()), `updatedAt` (timestamp with tz default now()).
- **Indexes**: `index("idx_delivery_jobs_status").on(table.status, table.createdAt)`.

### 5.6. Bảng `spigot_account_refs` (Public Reference trên Neon - Không chứa Secret)
- **Purpose**: Cung cấp danh sách tham chiếu tài khoản Spigot cho Web Dashboard giám sát trạng thái sức khỏe mà **tuyệt đối không để lộ mật khẩu hay cookie**.
- **Columns**: `id` (serial PK), `label` (varchar 64 unique not null), `status` (varchar 20 default 'ok'), `health` (varchar 32 default 'healthy'), `lastVerifiedAt` (timestamp with tz nullable), `createdAt` (timestamp with tz default now()), `updatedAt` (timestamp with tz default now()).
- **Loại bỏ hoàn toàn**: `password_encrypted`, `xf_user_encrypted`, `xf_session_encrypted`, `browser_profile`.

---

## 6. Repository Migration Map

| Repository Gốc | Runtime Nguồn | Repository Đích | Runtime Đích | Ghi Chú Ranh Giới |
| :--- | :---: | :--- | :---: | :--- |
| `orders.ts` | SQLite | `neon-orders.ts` | **Neon** | Quản lý đơn hàng trên Neon. |
| `wallets.ts` | SQLite | `neon-wallets.ts` | **Neon** | `applyLedgerEntry` có Row-Locking (`FOR UPDATE`). |
| `wallet-topups.ts` | SQLite | `neon-wallet-topups.ts` | **Neon** | Quản lý phiếu nạp tiền ngân hàng trên Neon. |
| `card-topups.ts` | SQLite | `neon-card-topups.ts` | **Neon** | Quản lý nạp thẻ cào Card2k trên Neon. |
| `discounts.ts` | SQLite | `neon-discounts.ts` | **Neon** | Thêm bảng `discount_code_redemptions`. |
| `plugins.ts` | SQLite | `neon-plugins.ts` | **Neon** | Chuyển catalog plugin sang Neon. |
| `versions.ts` | SQLite | `neon-versions.ts` | **Neon** | Chuyển catalog phiên bản sang Neon. |
| `upstream-state.ts` | SQLite | `neon-upstream.ts` | **Neon** | Quản lý version upstream trên Neon. |
| `pending-download.ts` | SQLite | `neon-upstream.ts` | **Neon** | Hàng đợi tải upstream trên Neon. |
| `resource-ownership.ts`| SQLite | `neon-resource-ownership.ts`| **Neon** | Ánh xạ resource_id -> account_label. |
| `mint-download-token.ts`| SQLite | `neon-download-tokens.ts` | **Neon** | Quản lý token web tải một lần trên Neon. |
| `deliver-version.ts` | SQLite | `neon-delivery-logs.ts` | **Neon** | Ghi nhận nhật ký bàn giao file có idempotency key. |
| *(Durable Handoff)* | In-Memory | `neon-delivery-jobs.ts` | **Neon** | Durable delivery claim worker. |
| `spigot-accounts.ts` | SQLite | **`spigot-accounts.ts` (Local Vault)** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không chuyển secret sang Neon. |
| *(Đồng bộ Status)* | SQLite | **`neon-spigot-refs.ts`** | **Neon** | Chỉ publish `id`, `label`, `status`, `health` sang Neon. |
| `account-scan-state.ts`| SQLite | **`account-scan-state.ts`** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không đẩy crawler state lên Neon. |

---

## 7. Transaction Boundaries, Durable Delivery & Concurrency

### 7.1. Phân biệt ranh giới: Database State vs External Side Effect
Mô hình `COMMIT ↓ async deliverVersion()` **KHÔNG ĐƯỢC CHẤP NHẬN** làm cơ chế đảm bảo delivery vì nếu máy chủ crash ngay sau COMMIT, ý định giao hàng (delivery intent) sẽ bị mất vĩnh viễn.

**Nguyên tắc kiến trúc**:
1. **DATABASE STATE (Bên trong Transaction)**:
   - Thay đổi số dư ví, đơn hàng, ghi ledger, ghi nhận mã giảm giá.
   - Tạo hoặc cập nhật **Durable Delivery Job** (`delivery_jobs`) ở trạng thái `queued`.
2. **COMMIT**: Transaction hoàn tất, trạng thái lưu bền vững trên Neon.
3. **EXTERNAL SIDE EFFECT (Bên ngoài Transaction - Worker Claim Pattern)**:
   - Worker tiến hành claim job (`status = 'processing'`, cập nhật `locked_at = now()`).
   - Thực thi gửi file qua Discord DM hoặc tạo download token.
   - Nếu thành công: Ghi `delivery_logs` (với `delivery_idempotency_key`) và đánh dấu job `status = 'delivered'`.
   - Nếu bot crash trước/trong khi gửi: Khi bot khởi động lại, recovery worker tự động quét các job `status = 'queued'` hoặc `status = 'processing'` bị quá hạn (stale lock > 5 phút) để tiếp tục giao hàng. Delivery intent không bao giờ bị mất!

---

### 7.2. Đặc tả chi tiết các luồng giao dịch chuẩn hóa

#### 1. Webhook SePay Topup Idempotency & Partial Unique Index
```sql
BEGIN TRANSACTION;
  -- 1. Dedupe webhook SePay
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, raw_payload, received_at)
  VALUES ($1, ...) ON CONFLICT (sepay_id) DO NOTHING RETURNING id;

  -- NẾU không có id trả về -> Webhook trùng -> COMMIT/ROLLBACK rỗng và RETURN { handled: 'duplicate' }

  -- 2. Khóa phiếu nạp tiền
  SELECT * FROM wallet_topups WHERE code = $code FOR UPDATE;

  -- 3. Atomic status flip: Chỉ thành công khi status đang là 'pending'
  UPDATE wallet_topups
  SET status = 'credited',
      paid_amount = $amount,
      credited_at = now()
  WHERE id = $topupId
    AND status = 'pending'
  RETURNING id;

  -- 4. BẮT BUỘC: Chỉ khi RETURNING trả đúng 1 row mới được:
  --    UPDATE wallet + INSERT wallet_ledger
  --    Nếu không có row: topup đã xử lý -> không credit lại -> không insert ledger lần nữa.
  --    COMMIT và RETURN { handled: 'ignored', why: 'not-pending' }

  -- 5. Lock ví và cộng tiền
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
  VALUES ($userId, $amount, now(), now())
  ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

  -- 6. Ghi ledger (Được bảo vệ bởi PARTIAL UNIQUE INDEX: ref_type, ref_id, kind)
  INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
  VALUES ($userId, $amount, new_balance, 'bank_topup', 'topup', $topupId, 'nạp ví SePay', now());

COMMIT;

[AFTER COMMIT - EXTERNAL SIDE EFFECTS]
  - Trả HTTP 200 OK cho SePay gateway.
  - Gửi thông báo Discord DM thông báo số dư mới cho người dùng.
```

#### 2. Discount Concurrency & Row-Locking Serialization
```sql
-- Khóa parent discount_codes row để serialize concurrent redemption của cùng discount:
BEGIN;

  -- 1. Khóa bản ghi cha của mã giảm giá
  SELECT *
  FROM discount_codes
  WHERE id = $discountId
  FOR UPDATE;

  -- 2. Đếm số lần user đã sử dụng mã này
  SELECT count(*)
  FROM discount_code_redemptions
  WHERE discount_id = $discountId
    AND discord_user_id = $userId;

  -- 3. Validate per_user_limit & business conditions
  validate per_user_limit;

  -- 4. Tăng used_count atomically với guard max_uses
  UPDATE discount_codes
  SET used_count = used_count + 1
  WHERE id = $discountId
    AND (max_uses IS NULL OR used_count < max_uses)
  RETURNING id;
  -- NẾU RETURNING không có row -> ABORT("Mã giảm giá đã hết lượt sử dụng");

  -- 5. Ghi nhận redemption
  INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
  VALUES ($discountId, $userId, $orderId, $discountAmount, now());

COMMIT;
```

#### 3. Purchase + Discount + Durable Delivery Job = ONE TRANSACTION BOUNDARY
Discount application và Durable Delivery Job **phải nằm trong cùng transaction với purchase**:
```text
BEGIN
  1. Lock discount:
     SELECT * FROM discount_codes WHERE id = $discountId FOR UPDATE;
  2. Validate discount (per_user_limit, max_uses, min_order, expires_at);
  3. Calculate final price: finalPrice = max(0, orderAmount - discountAmount);

  4. Lock wallet:
     SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  5. Validate balance & calculate:
     walletPaid = min(balance, finalPrice);
     bankDue = finalPrice - walletPaid;
     status = (bankDue == 0) ? 'wallet_paid' : 'pending';

  6. Create order:
     INSERT INTO orders (code, discord_user_id, version_id, plugin_name, amount, wallet_paid, bank_due, status, ...)
     VALUES (...) RETURNING id;

  7. Debit wallet & insert ledger (nếu walletPaid > 0):
     UPDATE wallets SET balance = balance - walletPaid WHERE discord_user_id = $userId;
     INSERT INTO wallet_ledger (discord_user_id, delta: -walletPaid, kind: 'order_hold', ref_type: 'order', ref_id: order.id, ...);

  8. Create discount redemption & Increment discount usage:
     INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
     VALUES ($discountId, $userId, order.id, discountAmount, now());
     UPDATE discount_codes SET used_count = used_count + 1 WHERE id = $discountId AND (max_uses IS NULL OR used_count < max_uses) RETURNING id;

  9. Create durable delivery job (nếu status == 'wallet_paid'):
     INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, delivery_method, status)
     VALUES (order.id, $userId, version.id, 'attachment', 'queued');
COMMIT
```

**Nguyên tắc Rollback tuyệt đối**:
Nếu purchase rollback:
```text
discount redemption rollback
discount usage rollback
wallet mutation rollback
delivery job rollback
order rollback
```

**[AFTER COMMIT - EXTERNAL SIDE EFFECTS]**:
- Worker claims job -> thực thi gửi DM / đính kèm file jar -> ghi `delivery_logs` (idempotency key: `${order.id}:attachment`) -> đánh dấu job `delivered`.
- Nếu status == 'pending': Trả VietQR URL cho khách hàng chuyển khoản phần `bankDue`.

---

## 8. Payment Amount Policy Matrix

Hệ thống xử lý thanh toán SePay tuân thủ bảng chính sách tường minh, không áp dụng hành vi suy đoán ngầm:

| Tình Huống | Expected Amount | Received Amount | Result Code | Wallet Mutation | Topup / Order Status | Notification Policy |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- |
| **Exact Payment (Topup)** | 100,000 | 100,000 | `exact` | `+100,000` VNĐ vào ví; ghi ledger `bank_topup`. | `status = 'credited'`, `paid_amount = 100,000` | Gửi DM xác nhận nạp tiền thành công và số dư hiện tại. |
| **Underpayment (Topup)** | 100,000 | 50,000 | `underpaid` | `+50,000` VNĐ vào ví (ghi nhận đúng số tiền thực nhận); ghi ledger `bank_topup`. | `status = 'credited'`, `paid_amount = 50,000` (hoàn tất theo số tiền thực nhận để tiền không bị kẹt) | Gửi DM thông báo: "Bạn đã chuyển thiếu (Yêu cầu: 100k, Thực nhận: 50k). Ví đã được cộng đúng 50,000 VNĐ." |
| **Overpayment (Topup)** | 100,000 | 150,000 | `overpaid` | `+150,000` VNĐ vào ví (khách nhận đủ toàn bộ số tiền đã chuyển); ghi ledger `bank_topup`. | `status = 'credited'`, `paid_amount = 150,000` | Gửi DM thông báo: "Bạn đã chuyển thừa (Yêu cầu: 100k, Thực nhận: 150k). Toàn bộ 150,000 VNĐ đã được cộng vào ví." |
| **Exact Payment (Order bankDue)** | 100,000 | 100,000 | `exact` | Không đổi ví. | Order: `status = 'paid'`, tạo `delivery_job` `queued`. | Gửi DM thông báo đơn thanh toán thành công và chuẩn bị nhận file. |
| **Underpayment (Order bankDue)** | 100,000 | 50,000 | `underpaid` | `+50,000` VNĐ vào ví; ghi ledger `kind = 'order_partial_credit'`. | Order: Giữ `status = 'pending'`, không giao hàng. | Gửi DM thông báo: "Bạn chuyển thiếu so với giá đơn. 50,000 VNĐ đã được lưu vào ví của bạn. Vui lòng thanh toán phần còn lại hoặc dùng số dư ví." |
| **Overpayment (Order bankDue)** | 100,000 | 150,000 | `overpaid` | `+50,000` VNĐ (phần thừa) vào ví; ghi ledger `kind = 'order_overpay_credit'`. | Order: `status = 'paid'`, tạo `delivery_job` `queued`. | Gửi DM thông báo: "Đơn hàng thành công! Phần tiền thừa 50,000 VNĐ đã được cộng vào ví của bạn." |
| **Unknown Topup Code** | Bất kỳ | Bất kỳ | `unmatched` | Không có mutation ví. | Lưu vào `sepay_transactions` với `status = 'unmatched'`. | Gửi cảnh báo lên kênh Staff Discord để admin kiểm tra đối soát thủ công. |
| **Expired Topup Code** | 100,000 | 100,000 | `expired_topup` | `+100,000` VNĐ vào ví; ghi ledger `bank_topup`. Không giữ tiền của khách. | `status = 'credited'`, `paid_amount = 100,000`. | Gửi DM thông báo: "Phiếu nạp đã hết hạn nhưng tiền đã chuyển thành công. Hệ thống đã kích hoạt và cộng tiền vào ví." |
| **Duplicate Topup Code (Khác sepay_id)** | 100,000 | 100,000 | `duplicate_transfer` | Không tự động cộng tiền ví lần 2 (nhờ atomic guard `WHERE status = 'pending'`). | Topup giữ nguyên `credited`. Ghi nhận giao dịch SePay thứ 2 với `status = 'duplicate_transfer'`. | Bắn alert lên kênh Staff Discord: "Phát hiện chuyển khoản lặp cho cùng một mã nạp" để xử lý hoàn tiền hoặc credit ví thủ công. |

---

## 9. Master Encryption Key Policy

Local Secret Vault (`data/vault_secrets.db`) chỉ lưu trữ dữ liệu đã mã hóa (**Ciphertext + IV + Auth Tag** bằng thuật toán AES-256-GCM) và metadata.

1. **Vị Trí Lưu Trữ Master Key (Key Source)**:
   - **TUYỆT ĐỐI KHÔNG LƯU TRONG DATABASE** (`vault_secrets.db` hay Neon).
   - Master key được nạp từ biến môi trường được bảo vệ: `VAULT_MASTER_KEY` (chuỗi hex 64 ký tự = 32 bytes entropy cao).
   - Trong môi trường container/production: Inject thông qua Docker Secrets hoặc OS Secret Store.
2. **Khởi Động An Toàn (Startup Fail-Fast Behavior)**:
   - Khi tiến trình bot khởi động: Kiểm tra sự tồn tại và độ dài của `VAULT_MASTER_KEY`.
   - Nếu thiếu hoặc độ dài không hợp lệ (khác 32 bytes): **Lập tức dừng khởi động (`process.exit(1)`)** với thông báo lỗi tường minh:
     `FATAL: VAULT_MASTER_KEY is missing or invalid. Refusing to start to protect credential vault integrity.`
3. **Quy Trình Xoay Khóa (Key Rotation Policy)**:
   - Hệ thống hỗ trợ cấu hình 2 khóa cùng lúc: `VAULT_MASTER_KEY` (khóa hiện tại dùng mã hóa/giải mã) và `VAULT_MASTER_KEY_PREVIOUS` (khóa cũ chỉ dùng giải mã).
   - Script xoay khóa (`pnpm tsx discord/scripts/rotate-vault-keys.ts`):
     - Giải mã toàn bộ credentials bằng khóa cũ -> Mã hóa lại bằng khóa mới với IV ngẫu nhiên -> Cập nhật bản ghi trong `vault_secrets.db`.
     - Sau khi xoay xong, gỡ bỏ `VAULT_MASTER_KEY_PREVIOUS`.
4. **Chính Sách Sao Lưu & Bảo Vệ Khóa (Backup & Hygiene)**:
   - Master key chỉ được sao lưu ngoại tuyến (Offline Cold Storage / Hardware Security Module / Password Manager của quản trị viên).
   - Tuyệt đối không đưa master key vào bản backup cơ sở dữ liệu.
   - Tuyệt đối không log giá trị master key ra console hay file log.

---

## 10. Migration Strategy, ID Mapping & Hygiene

### 10.1. Foreign-Key ID Mapping Architecture
Không giả định các khóa chính Integer (`id`) trong SQLite có thể giữ nguyên khi nạp sang Neon (đặc biệt khi Neon đã có sequence tự tăng hoặc dữ liệu khởi tạo trước).

**Quy trình Mapping 3 bước**:
```text
SQLite ID  ──▶  Natural Business Key  ──▶  Neon ID
```

Tất cả các bảng có quan hệ phụ thuộc (Dependent Foreign Keys) bắt buộc phải tra cứu qua bảng ánh xạ trong bộ nhớ:
1. `pluginMap: Map<sqlitePluginId, neonPluginId>` tra cứu qua `plugins.slug`.
2. `versionMap: Map<sqliteVersionId, neonVersionId>` tra cứu qua `versions.sha256` hoặc `${pluginSlug}:${versionString}`.
3. `orderMap: Map<sqliteOrderId, neonOrderId>` tra cứu qua `orders.code`.
4. `discountMap: Map<sqliteDiscountId, neonDiscountId>` tra cứu qua `discount_codes.code`.

**Chế Độ Kiểm Tra Môi Trường Di Chuyển (Neon Migration Mode)**:
- Pre-flight check kiểm tra số lượng bản ghi nghiệp vụ hiện tại trên Neon:
  - Nếu `SELECT count(*) FROM orders` == 0 VÀ `SELECT count(*) FROM wallet_ledger` == 0:
    Kích hoạt **`Neon Empty Migration Mode`**: Cho phép giữ nguyên ID gốc nếu sequence chưa chạy, đồng thời đồng bộ hóa Postgres sequences bằng `SELECT setval(pg_get_serial_sequence('...', 'id'), max(id))`.
  - Nếu đã có bản ghi tồn tại: Tự động chuyển sang **`Business Key Mapping Mode`** đầy đủ, ánh xạ mọi foreign key mà không làm đè dữ liệu cũ.

### 10.2. Wallet Opening Balance Reconstruction Logic
Để đảm bảo tuyệt đối Invariant:
$$\text{wallet.balance} = \sum \text{wallet\_ledger.delta}$$
Script di chuyển kiểm tra tính toàn vẹn của lịch sử sổ cái SQLite:
1. Tính tổng lịch sử: $S = \sum \text{sqlite\_wallet\_ledger.delta}$ cho từng user.
2. So sánh với số dư hiện tại của ví $B = \text{sqlite\_wallets.balance}$.
3. **Quyết Định Tạo Opening Balance**:
   - NẾU $S == B$: Lịch sử hoàn toàn đầy đủ. **TUYỆT ĐỐI KHÔNG TẠO OPENING BALANCE** (tránh duplicate tiền).
   - NẾU $S \neq B$ (do hệ thống cũ có giao dịch điều chỉnh không ghi ledger hoặc ledger bị dọn dẹp):
     Tạo **đúng 1 dòng ledger mở sổ duy nhất (migration-only)**:
     ```text
     kind = 'opening_balance'
     delta = (B - S)
     ref_type = 'migration'
     ref_id = user.id
     note = 'Số dư ban đầu chuyển tiếp từ SQLite cũ'
     ```
     Sau bước này, tổng delta của ledger luôn khớp 100% với số dư ví $B$.

### 10.3. Secret Migration Hygiene (Vệ sinh bảo mật tuyệt đối)
Khi bóc tách `spigot_accounts` sang `vault_secrets.db`:
1. **Xử lý tệp SQLite cũ**:
   - Toàn bộ các tệp: `data/deps.db`, `data/deps.db-wal`, `data/deps.db-shm`, tệp snapshot backup cũ chứa credentials được phân loại là **Sensitive Tier 1 Artifacts**.
   - Cấu hình phân quyền truy cập tệp cục bộ: `chmod 600` (chỉ user chạy bot có quyền đọc/ghi).
   - Tuyệt đối cấm commit vào Git (`.gitignore` đã cấu hình chặn `data/*.db*`, `*.sqlite*`).
2. **Loại bỏ Secret khỏi Migration Pipeline**:
   - Script di chuyển chỉ trích xuất trường phi nhạy cảm (`id`, `label`, `status`, `health`, `last_verified_at`) nạp vào `spigot_account_refs` trên Neon.
   - Tuyệt đối không serialize mật khẩu, cookie `xf_user`, session `xf_session` vào bất kỳ biến tạm, tệp JSON dump hay câu lệnh INSERT sang Neon.
   - Tuyệt đối không log giá trị secret trong console hay migration log (mọi trường nhạy cảm phải hiển thị `[REDACTED]`).

---

## 11. Reconciliation Strategy

Kiểm định toàn diện 8 chiều sau di chuyển dữ liệu:
1. **Missing rows**: Bắt buộc = 0.
2. **Duplicate rows**: Bắt buộc = 0.
3. **Orphan foreign keys**: Bắt buộc = 0.
4. **Business-key collisions**: Bắt buộc = 0 (`orders.code`, `wallets.discord_user_id`, `sepay_transactions.sepay_id`, `card_topups.request_id`, `plugins.slug`, `versions.sha256`).
5. **Unexpected truncation**: Bắt buộc = 0.
6. **Timestamp conversion**: Chuyển đổi chính xác Unix seconds sang UTC Timestamp with timezone.
7. **Boolean conversion**: Chuyển đổi 0/1 sang `true`/`false`.
8. **JSON conversion**: Chuyển đổi chuỗi JSON sang `jsonb` hợp lệ.
9. **Wallet Invariant Check**:
   ```sql
   SELECT w.discord_user_id, w.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
   FROM wallets w
   LEFT JOIN wallet_ledger l ON l.discord_user_id = w.discord_user_id
   GROUP BY w.discord_user_id, w.balance
   HAVING w.balance != COALESCE(SUM(l.delta), 0);
   ```
   **Kết quả bắt buộc**: Trả về đúng **0 dòng**.

---

## 12. Cutover Plan (Timeline T-0 đến T+7)

- **T-0 (00:00)**: **Freeze writes**. Bật cờ bảo trì trên Bot Discord (`MAINTENANCE_MODE=true`). Từ chối nhận đơn mới, hoãn xử lý webhook SePay.
- **T+1 (00:01)**: **Online SQLite Backup**. Dùng `.backup()` API xuất snapshot ra tệp `data/backups/vault_cutover.db`. Chạy kiểm tra `PRAGMA integrity_check`.
- **T+2 (00:03)**: **Migrate Business Data**. Chạy script `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts` (sử dụng ID Mapping, chỉ chuyển Business Data và Public Account Refs, tuyệt đối không chuyển mật khẩu hay cookie).
- **T+3 (00:06)**: **Reconciliation & Validation**. Chạy bộ script đối soát: đếm dòng, kiểm tra business keys, xác thực `reconcileBalances == 0`, reset Postgres Sequences (`setval`).
- **T+4 (00:08)**: **Switch Runtime**. Khởi động Bot Discord kết nối trực tiếp vào Neon Drizzle Client cho Business Data và Local Secret Vault cho Crawler Accounts. Ngắt kết nối SQLite nghiệp vụ hoàn toàn.
- **T+5 (00:09)**: **Smoke Test**. Kiểm tra lệnh `/vi`, `/menu`, Dashboard API `/api/orders` xác nhận nhìn thấy đơn hàng tức thì.
- **T+6 (00:10)**: **Enable Writes**. Tắt cờ bảo trì. Mở lại tiếp nhận thanh toán và đơn hàng bình thường.
- **T+7 (00:11 - 00:40)**: **Monitor**. Giám sát log thời gian thực trong 30 phút.

---

## 13. Rollback Plan

### Nguyên tắc Rollback an toàn (Tránh mất mát giao dịch mới):
- **Tuyệt đối không rollback bằng cách ghi đè Neon bằng bản backup SQLite cũ**: Việc này sẽ xóa sạch toàn bộ các đơn hàng và tiền nạp mới phát sinh trên Neon sau thời điểm cutover!
- **Cơ chế Rollback đúng**:
  1. **Application Rollback (Nếu lỗi Code/Logic Bot)**: Deploy lại bản build bot trước đó nhưng **VẪN TRỎ VÀO CÙNG NEON DATABASE**. Dữ liệu nghiệp vụ trên Neon được bảo toàn 100%.
  2. **Database Recovery (Nếu lỗi Schema/Migration Postgres)**: Khôi phục bằng tính năng **Neon Point-In-Time Recovery (PITR)** hoặc phục hồi từ bản snapshot của chính Neon.
  3. **Bản backup SQLite**: Chỉ sử dụng làm tài liệu đối soát lịch sử (Forensics / Cold Archive) hoặc trường hợp khẩn cấp tái thiết lập lại toàn bộ hệ thống từ con số 0.

---

## 14. Test Plan (Bao gồm Acceptance Tests Mở Rộng)

### 1. Duplicate Topup (Acceptance Test)
Hai webhook khác `sepay_id` nhưng cùng `wallet_topups.code`:
```text
Expected:
1 wallet credit
1 ledger entry
topup status = credited
Webhook thứ 2 trả về ignored/duplicate_transfer mà không credit đúp
```

### 2. Concurrent First Redemption (Acceptance Test)
Hai purchase đồng thời với cùng discount + cùng user (`per_user_limit = 1`):
```text
Expected:
respect per_user_limit
no duplicate redemption
Đúng 1 đơn được giảm giá; đơn thứ hai tính nguyên giá
```

### 3. Purchase Failure After Discount Validation (Acceptance Test)
Simulate DB failure sau discount validation trong cùng transaction:
```text
Expected:
no redemption
no used_count increment
no wallet mutation
no delivery job
no order
```

### 4. Download Token Atomic Consumption (Acceptance Test)
2 requests đồng thời gửi cùng một `token_hash`:
```text
Expected:
exactly 1 success (nhận stream file 200 OK)
exactly 1 rejected (nhận 410 Gone / 403 Forbidden)
Không tải đúp file
```

### 5. Delivery Idempotency Test (Acceptance Test)
Thực thi retry delivery cùng 1 phương thức cho 1 order:
```text
Expected:
Không tạo duplicate dòng trong delivery_logs nhờ unique constraint trên delivery_idempotency_key
Tái sử dụng kết quả giao hàng an toàn
```

### 6. Concurrent Purchase Test
10 request đồng thời mở đơn hàng từ cùng một user có số dư chỉ đủ mua 1 sản phẩm -> Đúng 1 đơn hàng trừ ví thành công; 9 đơn còn lại chuyển sang chờ chuyển khoản 100%. Không bao giờ âm ví.

### 7. Concurrent Topup Test
2 webhook ngân hàng gửi tiền vào cùng 1 ví tại cùng 1 thời điểm -> Cả 2 giao dịch đều ghi nhận đủ, số dư ví bằng tổng của cả 2 lần nạp, không bị Lost Update.

---

## 15. Files To Modify

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 5 bảng Business: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`, `delivery_jobs`.
   - Thêm **Partial Unique Index** trên `wallet_ledger`: `uniqueIndex('idx_wallet_ledger_ref_kind_unique').on(table.refType, table.refId, table.kind).where(sql\`ref_type != '' AND ref_id IS NOT NULL\`)`.
   - Bổ sung trường `description: text` vào bảng `sepay_transactions`.
   - Chuẩn hóa bảng `spigotAccounts` thành `spigotAccountRefs` (loại bỏ toàn bộ các cột `passwordEncrypted`, `xfUserEncrypted`, `xfSessionEncrypted`).
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Xóa bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` nghiệp vụ sang `neonDb`.
   - Tách riêng kết nối `vaultSecretsDb` (SQLite nội bộ) chỉ dùng cho Spigot crawler và browser launcher.
   - Kiểm tra `VAULT_MASTER_KEY` khi khởi động bot (Fail-fast).
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Viết lại `applyLedgerEntry` sử dụng `db.transaction()` và `SELECT ... FOR UPDATE`.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Gom dedupe và cập nhật trạng thái đơn/topup vào cùng 1 transaction boundary duy nhất.
   - Tích hợp Payment Amount Policy Matrix tường minh.
   - Tích hợp luồng Purchase + Discount + Durable Delivery Job vào cùng 1 transaction boundary duy nhất.
6. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Chuyển `recordDelivery` ghi nhận vào bảng `delivery_logs` trên Neon kèm `deliveryIdempotencyKey`.
7. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Chuyển sang sử dụng bảng `download_tokens` trên Neon với Atomic Consumption logic.

---

## 16. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon.
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file bảo mật với atomic mutation.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file kèm idempotency key.
5. `discord/src/repositories/neon-delivery-jobs.ts`: Hàng đợi giao hàng bền vững (Durable Delivery Handoff Worker).
6. `discord/src/repositories/neon-spigot-refs.ts`: Quản lý tham chiếu trạng thái Spigot không chứa mật khẩu trên Neon.
7. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu nghiệp vụ có hỗ trợ ID Mapping, Opening Balance logic, và Secret Hygiene.
8. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động kiểm tra tính nguyên tử, idempotency, atomic consumption và concurrency trên Neon.

---

## 17. Acceptance Criteria

1. [ ] **Dual-Vault Boundary Enforced**: Tuyệt đối không có mật khẩu, cookie, hay session nào của Spigot được lưu trữ hoặc chuyển lên Neon. Toàn bộ credential upstream được cô lập tại Local Secret Vault.
2. [ ] **Master Encryption Key Isolated**: Master key không nằm trong database, nạp từ `VAULT_MASTER_KEY` môi trường, kiểm tra fail-fast khi khởi động.
3. [ ] **No Production SQLite Business Writes**: Không còn câu lệnh ghi dữ liệu nghiệp vụ (orders, wallets, ledger, payments) nào vào SQLite tại runtime production.
4. [ ] **Single Source of Truth Verified**: Discord Bot và Web Dashboard cùng đọc/ghi một hàng dữ liệu đơn hàng và số dư ví trên Neon theo thời gian thực.
5. [ ] **Partial Unique Index Applied**: Sử dụng Partial Unique Index trên `wallet_ledger`, ngăn nạp đúp tiền ở mức database mà không vi phạm cú pháp PostgreSQL.
6. [ ] **Payment Policy Strictly Applied**: Toàn bộ ma trận số tiền (Exact, Underpay, Overpay, Unknown, Expired, Duplicate) hoạt động đúng chính sách tường minh.
7. [ ] **Durable Delivery Handoff**: Delivery job được lưu trong cùng transaction với purchase; worker claim sau commit; crash không làm mất delivery intent.
8. [ ] **Download Token Atomically Consumed**: 2 request đồng thời tới cùng một token hash chỉ có đúng 1 request tải thành công.
9. [ ] **Delivery Log Idempotent**: Có `delivery_idempotency_key`, retry không tạo duplicate successful delivery logs.
10. [ ] **Wallet Opening Balance Reconciled**: Tự động nhận diện tính toàn vẹn của ledger; chỉ bù 1 dòng `opening_balance` khi thật sự thiếu; invariant số dư = tổng delta đạt 100%.
11. [ ] **Foreign Key Mapping Validated**: Di chuyển SQLite sang Neon ánh xạ an toàn qua Natural Business Keys, không phụ thuộc trùng khớp ID integer.
12. [ ] **Secret Migration Hygiene**: Artifacts cũ (db, wal, dumps) được bảo vệ, cấm commit Git, cấm log mật khẩu.
13. [ ] **Discount Concurrency Controlled**: Concurrent redemptions được serialize an toàn nhờ lock parent row `discount_codes`, tôn trọng `per_user_limit` và `max_uses`.
14. [ ] **Purchase + Discount Unified in 1 Transaction**: Nếu purchase lỗi giữa chừng, toàn bộ discount redemption, usage count, order và wallet mutation đều rollback sạch sẽ.
15. [ ] **Existing UX Unchanged**: Trải nghiệm nút bấm, modal, menu trên Bot Discord và Web Dashboard giữ nguyên 100%.
16. [ ] **Existing Tests Pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.

---

## 18. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Rò rỉ Spigot Credentials / Master Key** | **Nghiêm trọng** | Lưu trữ master key hoặc đồng bộ secret accounts lên Cloud DB. | **Dual-Vault Boundary**: Master key lưu ngoài DB; credentials lưu tại local SQLite `data/vault_secrets.db` mã hóa AES-256-GCM. |
| **Lỗi cú pháp Unique Index Postgres** | **Cao** | Dùng table constraint `UNIQUE (...) WHERE ...` bị Postgres từ chối. | Thay bằng **PARTIAL UNIQUE INDEX** chuẩn trong Postgres & Drizzle ORM. |
| **Mất Delivery Intent khi Crash** | **Nghiêm trọng** | Gọi `deliverVersion()` async sau COMMIT mà không lưu state bền vững. | **Durable Delivery Handoff**: Ghi `delivery_jobs` trong cùng transaction với purchase; worker claim bất đồng bộ. |
| **Nạp đúp tiền ví hoặc sai lệch số dư** | **Nghiêm trọng** | Webhook lặp, underpay/overpay không xác định, hoặc duplicate opening balance. | Atomic status update `WHERE status = 'pending'`, chính sách số tiền tường minh, và thuật toán kiểm tra ledger trước khi tạo opening balance. |
| **Sai lệch Foreign Key khi Migrate** | **Cao** | Giữ nguyên SQLite Integer IDs khi Neon đã có sequence tự tăng. | **Natural Business Key Mapping**: Ánh xạ ID thông qua `slug`, `sha256`, `code` trước khi insert bảng phụ thuộc. |
| **Mất giao dịch khi Rollback sai cách** | **Nghiêm trọng** | Khôi phục database bằng cách ghi đè backup SQLite cũ sau cutover. | **Cấm Rollback ghi đè DB**: Chỉ Rollback Application code; nếu lỗi DB thì dùng Neon PITR. |

---

READY FOR IMPLEMENTATION
