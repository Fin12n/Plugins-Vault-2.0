# PHASE 1 FINAL IMPLEMENTATION PLAN v6 — DUAL-VAULT & BUSINESS AUTHORITY

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
│   - account_id (UUID)  │  • plugins / versions     • wallet_topups
│   - label              │  • manual_uploads         • card_topups
│   - enc_password       │  • orders                 • discount_codes
│   - enc_cookies (xf)   │  • sepay_transactions     • discount_redemptions
│   - session / profile  │    (relational trace)     • delivery_logs
│ • account_scan_state   │  • wallets                • delivery_jobs
│   - rate-limit state   │  • download_tokens        • upstream_state
│   - crawl errors       │  • resource_ownership    • pending_download
│ • vault/ storage blobs │  • discord_channels       • audit_logs (Staff)
│   - JAR files on disk  │  • spigot_account_refs (account_id UUID, label, health)
│ • Ciphertext only      │  • migration_checkpoints (Resumable progress)
└────────────────────────┘  ══════════════════════════════════════════════
  ▲
  │ (Key injected from outside DB: VAULT_MASTER_KEY)
```

---

## 3. Data Classification Matrix

| Phân Loại Dữ Liệu | Danh Sách Bảng / Dữ Liệu | Nơi Lưu Trữ Duy Nhất | Chính Sách Quản Trị & Truy Xuất |
| :--- | :--- | :---: | :--- |
| **SECRET / PRIVATE ACCOUNT VAULT** | `spigot_accounts` (`account_id` UUID, credentials, cookies), `account_scan_state`, Browser Profiles, Local temporary state | **Local SQLite** (`data/vault_secrets.db`) | **GIỮ CỤC BỘ**. Không export, không dump, không migrate lên Neon. Quyền truy cập tệp `0o600`/`0o700`. |
| **MASTER ENCRYPTION KEY** | Khóa giải mã cục bộ 256-bit (`VAULT_MASTER_KEY`) | **Environment Secret / OS Secret Store** | **NGOÀI DATABASE**. Không lưu trong `vault_secrets.db`, không lưu trong Neon, không ghi log. |
| **BUSINESS DATA (Authority)** | `orders`, `wallets`, `wallet_ledger`, `wallet_topups`, `sepay_transactions`, `card_topups`, `plugins`, `versions`, `manual_uploads`, `delivery_logs`, `delivery_jobs`, `download_tokens`, `discount_codes`, `discount_code_redemptions`, `resource_ownership`, `upstream_state`, `pending_download`, `pending_ingest`, `discord_channels`, `staffs`, `audit_logs`, `config`, `migration_checkpoints` | **Neon PostgreSQL** | **CHUYỂN SANG NEON**. Neon là Single Source of Truth. Discord Bot và Dashboard cùng đọc/ghi. |
| **PUBLIC ACCOUNT REFERENCE** | `spigot_account_refs` (`account_id` UUID PK, `label`, `status`, `health`, `last_verified_at`) | **Neon PostgreSQL** | **CHUYỂN THAM CHIẾU SANG NEON**. Liên kết qua stable `account_id` UUID, không dùng `label` làm identity, không chứa secret. |
| **CACHE & ASSETS** | File `.jar` nhị phân (`vault/`), File tạm (`tmp/`), Discord In-Memory Session | **Local Filesystem / Memory** | **GIỮ CỤC BỘ**. Nội dung content-addressed theo SHA-256; database chỉ lưu metadata và đường dẫn tương đối. |

---

## 4. Schema Parity & Uniqueness Invariants

### 4.1. Bảng đối chiếu thực thể
| Tên Bảng Nguồn (SQLite) | Bảng Đích Tại Neon | Phân Loại | Trạng Thái Schema | Hành Động Kỹ Thuật |
| :--- | :--- | :---: | :---: | :--- |
| `orders` | `orders` | Business | Đã có | Chuyển timestamps sang UTC timestamp with timezone. |
| `wallets` | `wallets` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `wallet_ledger` | `wallet_ledger` | Business | Đã có | **Tạo Partial Unique Index** để ngăn duplicate credit theo business key. |
| `wallet_topups` | **`wallet_topups`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý nạp tiền chuyển khoản, vòng đời hỗ trợ thanh toán muộn `expired -> credited`). |
| `sepay_transactions` | `sepay_transactions` | Business | ❌ **Chuẩn hóa** | Bổ sung cột `description`, `status` tường minh và khóa ngoại truy vết `order_id`, `topup_id`, `processed_at`. |
| `card_topups` | `card_topups` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `plugins` | `plugins` | Business | Đã có | Gộp `plugin_aliases` thành mảng string `aliases`. |
| `plugin_aliases` | *(Trong `plugins.aliases`)* | Business | Đã gom | Migrate dữ liệu vào mảng text trên Neon. |
| `versions` | `versions` | Business | Đã có | Giữ nguyên, thêm `changeLogs`, `source`. |
| `manual_uploads` | `manual_uploads` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_codes` | `discount_codes` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_code_redemptions` | **`discount_code_redemptions`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (chống gian lận mã giảm giá). |
| `download_tokens` | **`download_tokens`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý link tải web với atomic consumption). |
| `audit_log` (Bot) | **`delivery_logs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (có `delivery_idempotency_key`, phân biệt `requested_method` vs `actual_method`). |
| *(Durable Handoff)* | **`delivery_jobs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** với **Unique constraint `(order_id, requested_method)`**. |
| `upstream_state` | `upstream_state` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_download` | `pending_download` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_ingest` | `pending_ingest` | Business | Đã có | Giữ nguyên vẹn. |
| `resource_ownership` | `resource_ownership` | Business | Đã có | Giữ nguyên vẹn (map `resource_id` -> `account_id` UUID). |
| `discord_channels` | `discord_channels` | Business | Đã có | Giữ nguyên cấu hình kênh. |
| `dashboard_staff` | `staffs` | Business | Đã có | Map dữ liệu sang bảng staffs RBAC. |
| `audit_log` (Admin) | `audit_logs` | Business | Đã có | Giữ nguyên cho Staff RBAC actions. |
| `config` | `config` | Business | Đã có | Giữ nguyên cấu hình runtime. |
| *(Resumable Migration)* | **`migration_checkpoints`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (lưu vết checkpoint tiến trình di chuyển dữ liệu). |
| `spigot_accounts` (Secret) | *(Không đưa lên Neon)* | **Secret** | **Local Only** | **GIỮ TẠI LOCAL SQLITE** (Bổ sung `account_id` UUID). |
| *(Identity Bridge)* | **`spigot_account_refs`** | Reference | ❌ **Chuẩn hóa** | Thay thế `spigotAccounts` cũ trên Neon: Khóa chính `account_id` UUID, loại bỏ mật khẩu. |
| `account_scan_state` | *(Không đưa lên Neon)* | **Secret** | **Local Only** | **GIỮ TẠI LOCAL SQLITE**. |

### 4.2. Wallet Ledger Unique — Postgres Correctness
PostgreSQL **KHÔNG HỖ TRỢ** cú pháp table constraint `UNIQUE (...) WHERE ...`. Bắt buộc phải triển khai bằng **PARTIAL UNIQUE INDEX**:

```sql
CREATE UNIQUE INDEX idx_wallet_ledger_ref_kind_unique
ON wallet_ledger (ref_type, ref_id, kind)
WHERE ref_type != '' AND ref_id IS NOT NULL;
```

Trong Drizzle ORM ([packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts)):
```typescript
uniqueIndex("idx_wallet_ledger_ref_kind_unique")
  .on(table.refType, table.refId, table.kind)
  .where(sql`ref_type != '' AND ref_id IS NOT NULL`);
```
*Tác dụng*: Ngăn chặn hoàn toàn việc credit đúp cùng một nghiệp vụ (`topup`, `order_refund`, `card_topup`) vào cùng một loại ledger ở tầng database, trong khi vẫn cho phép các dòng ledger không có ref (như manual adjustment) được ghi nhận an toàn.

---

## 5. Schema Gaps (Đặc tả chi tiết các bảng mới trên Neon)

### 5.1. Bảng `wallet_topups` (Business Data - Expired Lifecycle Reconciliation)
- **Purpose**: Quản lý vòng đời yêu cầu nạp tiền ví qua chuyển khoản VietQR/SePay.
- **Columns**: `id` (serial PK), `code` (varchar 32 unique), `discordUserId` (varchar 32 not null), `amount` (integer not null > 0), `paidAmount` (integer nullable), `status` (varchar 20 default 'pending'), `createdAt` (timestamp with tz), `expiresAt` (timestamp with tz), `creditedAt` (timestamp with tz nullable).
- **Constraints & Indexes**: `uniqueIndex("idx_wallet_topups_code").on(table.code)`, `index("idx_wallet_topups_status").on(table.status)`, `index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt)`.
- **Thống nhất Lifecycle với Payment Matrix**:
  Trạng thái `expired` **KHÔNG PHẢI LÀ TERMINAL STATE**. Nếu tiền khách chuyển đến muộn sau khi hết hạn, hệ thống tự động đối soát và chuyển trạng thái hợp lệ sang `credited`:
  ```text
  pending ───(quá hạn expiresAt)───▶ expired
     │                                  │
     │                                  ▼ (chuyển khoản tới muộn)
     └──────────(thanh toán)──────────▶ credited (đối soát thành công)
  ```

### 5.2. Bảng `sepay_transactions` (Traceability & Explicit States)
- **Purpose**: Lưu vết toàn bộ giao dịch ngân hàng và liên kết quan hệ trực tiếp tới đơn hàng hoặc phiếu nạp ví (Full Payment Traceability).
- **Columns**:
  - `id` (serial PK)
  - `sepayId` (varchar 64 unique not null)
  - `amount` (integer not null)
  - `transferType` (varchar 10 not null)
  - `code` (varchar 32 not null)
  - `content` (text not null)
  - `description` (text nullable)
  - `status` (varchar 32 not null default 'received')
  - `orderId` (integer nullable references `orders.id` on delete set null)
  - `topupId` (integer nullable references `wallet_topups.id` on delete set null)
  - `processedAt` (timestamp with tz nullable)
  - `rawPayload` (jsonb not null)
  - `receivedAt` (timestamp with tz default now())
- **Explicit Status Enum/States**:
  - `'received'`: Webhook đã tiếp nhận vào database, chờ xử lý nghiệp vụ.
  - `'matched'`: Đã khớp mã giao dịch với đơn hàng hoặc phiếu nạp hợp lệ.
  - `'credited'`: Đã hoàn tất cộng tiền ví hoặc kích hoạt đơn hàng thành công.
  - `'underpaid'`: Chuyển thiếu tiền; đã xử lý cộng tiền thực nhận vào ví người dùng.
  - `'overpaid'`: Chuyển thừa tiền; đã xử lý giao đơn và hoàn tiền thừa vào ví.
  - `'duplicate_transfer'`: Chuyển khoản lặp lại cho mã nạp đã được credit trước đó (không cộng đúp).
  - `'unmatched'`: Mã nội dung chuyển khoản không tìm thấy trong hệ thống, chuyển cảnh báo Staff đối soát.

### 5.3. Bảng `discount_code_redemptions` (Business Data)
- **Purpose**: Lưu vết và thực thi giới hạn sử dụng mã giảm giá.
- **Columns**: `id` (serial PK), `discountId` (integer not null references `discount_codes.id` on delete cascade), `discordUserId` (varchar 32 not null), `orderId` (integer references `orders.id` on delete set null), `discountAmount` (integer > 0), `redeemedAt` (timestamp with tz default now()).
- **Unique Constraints**: `uniqueIndex("idx_discount_redemptions_order").on(table.orderId)`.
- **Indexes**: `index("idx_discount_redemptions_discount_user").on(table.discountId, table.discordUserId)`.

### 5.4. Bảng `download_tokens` (Business Data - Atomic Consumption)
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
  Chỉ request nhận được row trả về mới được phép tải file.

### 5.5. Bảng `delivery_jobs` (Durable Delivery Intent with Uniqueness)
- **Purpose**: Quản lý ý định giao hàng bền vững (Durable Delivery Intent).
- **Columns**:
  - `id` (serial PK)
  - `orderId` (integer not null references `orders.id` on delete cascade)
  - `discordUserId` (varchar 32 not null)
  - `versionId` (integer not null references `versions.id`)
  - `requestedMethod` (varchar 32 not null default 'attachment')
  - `status` (varchar 20 default 'queued': 'queued' | 'processing' | 'delivered' | 'failed')
  - `externalAttemptCount` (integer not null default 0)
  - `claimToken` (varchar 64 nullable)
  - `lastError` (text nullable)
  - `lockedAt` (timestamp with tz nullable)
  - `createdAt` (timestamp with tz default now())
  - `updatedAt` (timestamp with tz default now())
- **Delivery Job Uniqueness Invariant**:
  ```sql
  CREATE UNIQUE INDEX idx_delivery_jobs_order_method_unique
  ON delivery_jobs (order_id, requested_method);
  ```
  *Nguyên tắc*: **1 Order + 1 Delivery Method = Đúng 1 Active Delivery Intent**. Retries tái sử dụng cùng 1 row.

### 5.6. Bảng `delivery_logs` (Business Audit Trail - Intent vs Outcome)
- **Purpose**: Lưu vết lịch sử phát hành file plugin jar cho khách hàng (Customer Delivery History).
- **Columns**:
  - `id` (serial PK)
  - `deliveryIdempotencyKey` (varchar 128 not null)
  - `discordUserId` (varchar 32 not null)
  - `versionId` (integer references `versions.id` on delete set null)
  - `orderId` (integer references `orders.id` on delete set null)
  - `pluginName` (varchar 255 not null)
  - `versionLabel` (varchar 64 default '')
  - `amount` (integer default 0)
  - `requestedMethod` (varchar 32 not null: 'attachment' | 'link' | 'manual')
  - `actualMethod` (varchar 32 not null: 'attachment' | 'fallback_link' | 'manual')
  - `ip` (varchar 45 nullable)
  - `deliveredAt` (timestamp with tz default now())
- **Idempotency Constraint**:
  ```sql
  CREATE UNIQUE INDEX idx_delivery_logs_idempotency_key
  ON delivery_logs (delivery_idempotency_key);
  ```
  *Quy chuẩn Outcome*: Nếu gửi attachment thất bại hoặc crash recovery kích hoạt cấp link, ghi rõ `requestedMethod = 'attachment'`, `actualMethod = 'fallback_link'`. Không bao giờ ghi fallback link dưới danh nghĩa attachment.

### 5.7. Bảng `spigot_account_refs` (Stable UUID Identity Bridge)
- **Purpose**: Tham chiếu tài khoản Spigot giữa Local Vault và Neon Dashboard qua UUID bất biến, **không dùng `label` làm định danh khóa chính**.
- **Columns**:
  - `accountId` (uuid primary key not null)
  - `label` (varchar 64 not null)
  - `status` (varchar 20 default 'ok')
  - `health` (varchar 32 default 'healthy')
  - `lastVerifiedAt` (timestamp with tz nullable)
  - `createdAt` (timestamp with tz default now())
  - `updatedAt` (timestamp with tz default now())
- **Identity Invariant**: Thay đổi `label` trên Dashboard hoặc Local không làm thay đổi hay đứt gãy liên kết `accountId`.
- **Bảo mật tuyệt đối**: Không chứa mật khẩu, cookie hay session.

### 5.8. Bảng `migration_checkpoints` (Resumable Migration Progress)
- **Purpose**: Ghi nhận tiến trình di chuyển dữ liệu theo từng checkpoint để hỗ trợ resume an toàn khi gặp sự cố crash hoặc timeout.
- **Columns**:
  - `stepName` (varchar 64 primary key)
  - `status` (varchar 20 not null default 'in_progress': 'in_progress' | 'completed' | 'failed')
  - `lastProcessedKey` (varchar 128 nullable)
  - `processedCount` (integer default 0)
  - `checksum` (varchar 64 nullable)
  - `startedAt` (timestamp with tz default now())
  - `completedAt` (timestamp with tz nullable)

---

## 6. Repository Migration Map

| Repository Gốc | Runtime Nguồn | Repository Đích | Runtime Đích | Ghi Chú Ranh Giới |
| :--- | :---: | :--- | :---: | :--- |
| `orders.ts` | SQLite | `neon-orders.ts` | **Neon** | Quản lý đơn hàng trên Neon. |
| `wallets.ts` | SQLite | `neon-wallets.ts` | **Neon** | `applyLedgerEntry` có Row-Locking (`FOR UPDATE`). |
| `wallet-topups.ts` | SQLite | `neon-wallet-topups.ts` | **Neon** | Quản lý phiếu nạp tiền ngân hàng trên Neon (vòng đời `expired -> credited`). |
| `card-topups.ts` | SQLite | `neon-card-topups.ts` | **Neon** | Quản lý nạp thẻ cào Card2k trên Neon. |
| `discounts.ts` | SQLite | `neon-discounts.ts` | **Neon** | Thêm bảng `discount_code_redemptions`. |
| `plugins.ts` | SQLite | `neon-plugins.ts` | **Neon** | Chuyển catalog plugin sang Neon. |
| `versions.ts` | SQLite | `neon-versions.ts` | **Neon** | Chuyển catalog phiên bản sang Neon. |
| `upstream-state.ts` | SQLite | `neon-upstream.ts` | **Neon** | Quản lý version upstream trên Neon. |
| `pending-download.ts` | SQLite | `neon-upstream.ts` | **Neon** | Hàng đợi tải upstream trên Neon. |
| `resource-ownership.ts`| SQLite | `neon-resource-ownership.ts`| **Neon** | Ánh xạ resource_id -> `account_id` UUID. |
| `mint-download-token.ts`| SQLite | `neon-download-tokens.ts` | **Neon** | Quản lý token web tải một lần trên Neon (Atomic mutation). |
| `deliver-version.ts` | SQLite | `neon-delivery-logs.ts` | **Neon** | Ghi nhận nhật ký bàn giao file (`requested` vs `actual`). |
| *(Durable Handoff)* | In-Memory | `neon-delivery-jobs.ts` | **Neon** | Quản lý hàng đợi job có Unique `(order_id, requested_method)`. |
| `spigot-accounts.ts` | SQLite | **`spigot-accounts.ts` (Local Vault)** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT** (Có `account_id` UUID). |
| *(Đồng bộ Status)* | SQLite | **`neon-spigot-refs.ts`** | **Neon** | Publish `account_id` UUID, `label`, `status`, `health` sang Neon. |
| `account-scan-state.ts`| SQLite | **`account-scan-state.ts`** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không đẩy crawler state lên Neon. |

---

## 7. Transaction Boundaries, Delivery Semantics & Global Lock Order

### 7.1. Global Database Lock Order (Chống Deadlock Triệt Để)

Để ngăn chặn hoàn toàn nguy cơ deadlock và đảo ngược thứ tự khóa (Lock Inversion), toàn bộ ứng dụng tuân thủ nghiêm ngặt **Thứ Tự Khóa Chuẩn Hóa Toàn Cục (Canonical Lock Acquisition Order)**:

```text
┌────────────────────────────────────────────────────────┐
│             CANONICAL DATABASE LOCK ORDER              │
├────────────────────────────────────────────────────────┤
│  1. discount_codes     (Parent discount row lock)      │
│  2. wallets            (User wallet balance lock)      │
│  3. orders             (Order status & amounts lock)   │
│  4. wallet_topups      (Bank topup state lock)         │
│  5. delivery_jobs      (Delivery intent queue lock)    │
└────────────────────────────────────────────────────────┘
```

**Quy tắc bất biến (Lock Invariant Rules)**:
1. Mọi transaction liên quan đến nhiều thực thể **BẮT BUỘC** phải xin khóa theo đúng chiều tăng dần từ 1 đến 5.
2. **TUYỆT ĐỐI CẤM** luồng xin khóa ngược (ví dụ: `wallets -> discount_codes` là hành vi bất hợp pháp, bị từ chối ở tầng kiến trúc).
3. Luồng nạp tiền SePay: Nếu chỉ tác động `wallet_topups` và `wallets`, thứ tự xin khóa chuẩn là: Khóa `wallets` trước -> sau đó khóa hoặc cập nhật `wallet_topups`.
4. Luồng mua hàng có mã giảm giá: Khóa `discount_codes` trước -> sau đó khóa `wallets` -> tạo/khóa `orders`.

---

### 7.2. Phân định ngữ nghĩa Delivery & Crash Recovery Policy

```text
┌──────────────────────────────────────┐       ┌──────────────────────────────────────┐
│        DATABASE DELIVERY STATE       │  vs   │       EXTERNAL DISCORD DELIVERY      │
│            = IDEMPOTENT              │       │           = AT-LEAST-ONCE            │
│  (delivery_jobs + delivery_logs)     │       │  (Discord API DM không có dedupe ID) │
└──────────────────────────────────────┘       └──────────────────────────────────────┘
```

#### Kịch bản Crash Recovery & Phân biệt Requested vs Actual Method:
1. **Trước khi gửi Discord API**:
   - Worker claim job bằng atomic update:
     ```sql
     UPDATE delivery_jobs
     SET status = 'processing',
         claim_token = $claimUuid,
         locked_at = now(),
         external_attempt_count = external_attempt_count + 1
     WHERE id = $jobId AND status = 'queued'
     RETURNING id;
     ```
2. **Kịch bản Crash sau khi send thành công nhưng chưa kịp ghi `delivery_logs`**:
   - Recovery Worker phát hiện job quá hạn có `external_attempt_count >= 1`:
     - **Không spam lại tệp attachment** qua DM (tránh gửi 2 file nặng).
     - Tạo một token tải dự phòng (`download_tokens`).
     - Gửi thông báo DM ngắn kèm link dự phòng.
     - Ghi nhận vào `delivery_logs`:
       * `requestedMethod = 'attachment'`
       * `actualMethod = 'fallback_link'`
       * `deliveryIdempotencyKey = ${orderId}:attachment`
     - Cập nhật `delivery_jobs.status = 'delivered'`.

---

### 7.3. Đặc tả chi tiết các luồng giao dịch chuẩn hóa

#### 1. Webhook SePay: Idempotency, Traceability & Tuân thủ Lock Order
```sql
BEGIN TRANSACTION;
  -- 1. Dedupe webhook SePay
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, status, raw_payload, received_at)
  VALUES ($1, $amount, $type, $code, $content, $desc, 'received', $payload, now())
  ON CONFLICT (sepay_id) DO NOTHING
  RETURNING id;

  -- NẾU không có id trả về -> Webhook trùng -> COMMIT rỗng và RETURN { handled: 'duplicate' }

  -- 2. Khóa ví người dùng trước (Tuân thủ Lock Order: wallets trước topups)
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;

  -- 3. Khóa phiếu nạp ví
  SELECT * FROM wallet_topups WHERE code = $code FOR UPDATE;

  -- 4. Atomic status flip: Cho phép từ 'pending' HOẶC 'expired' sang 'credited'
  UPDATE wallet_topups
  SET status = 'credited',
      paid_amount = $amount,
      credited_at = now()
  WHERE id = $topupId
    AND status IN ('pending', 'expired')
  RETURNING id;

  -- 5. BẮT BUỘC: Chỉ khi RETURNING trả đúng 1 row mới được:
  --    UPDATE wallet + INSERT wallet_ledger + CẬP NHẬT sepay_transactions traceability
  --    Nếu không có row: topup đã xử lý -> không credit lại -> cập nhật sepay status = 'duplicate_transfer'

  -- 6. Cộng tiền ví
  INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
  VALUES ($userId, $amount, now(), now())
  ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

  -- 7. Ghi ledger (Được bảo vệ bởi PARTIAL UNIQUE INDEX: ref_type, ref_id, kind)
  INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
  VALUES ($userId, $amount, new_balance, 'bank_topup', 'topup', $topupId, 'nạp ví SePay', now());

  -- 8. Cập nhật Full Relational Traceability trên sepay_transactions
  UPDATE sepay_transactions
  SET status = 'credited',
      topup_id = $topupId,
      processed_at = now()
  WHERE id = $sepayTxId;

COMMIT;

[AFTER COMMIT - EXTERNAL SIDE EFFECTS]
  - Trả HTTP 200 OK cho SePay gateway.
  - Gửi thông báo Discord DM thông báo số dư mới cho người dùng.
```

#### 2. Purchase + Discount + Durable Delivery Job (Tuân thủ Lock Order)
```text
BEGIN TRANSACTION
  1. Lock discount_codes (Lock Order #1):
     SELECT * FROM discount_codes WHERE id = $discountId FOR UPDATE;
  2. Validate discount (per_user_limit, max_uses, min_order, expires_at);
  3. Calculate final price: finalPrice = max(0, orderAmount - discountAmount);

  4. Lock wallets (Lock Order #2):
     SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  5. Validate balance & calculate:
     walletPaid = min(balance, finalPrice);
     bankDue = finalPrice - walletPaid;
     status = (bankDue == 0) ? 'wallet_paid' : 'pending';

  6. Create orders (Lock Order #3):
     INSERT INTO orders (code, discord_user_id, version_id, plugin_name, amount, wallet_paid, bank_due, status, ...)
     VALUES (...) RETURNING id;

  7. Debit wallet & insert ledger (nếu walletPaid > 0):
     UPDATE wallets SET balance = balance - walletPaid WHERE discord_user_id = $userId;
     INSERT INTO wallet_ledger (discord_user_id, delta: -walletPaid, kind: 'order_hold', ref_type: 'order', ref_id: order.id, ...);

  8. Create discount redemption & Increment discount usage:
     INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
     VALUES ($discountId, $userId, order.id, discountAmount, now());
     UPDATE discount_codes SET used_count = used_count + 1 WHERE id = $discountId AND (max_uses IS NULL OR used_count < max_uses) RETURNING id;

  9. Create durable delivery job (Lock Order #5, nếu status == 'wallet_paid'):
     INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, requested_method, status)
     VALUES (order.id, $userId, version.id, 'attachment', 'queued')
     ON CONFLICT (order_id, requested_method) DO NOTHING;
COMMIT
```

**Nguyên tắc Rollback tuyệt đối**:
Nếu purchase rollback -> Toàn bộ discount redemption, usage count, wallet mutation, delivery job và order rollback sạch sẽ 100%.

---

## 8. Payment Amount Policy Matrix

Hệ thống xử lý thanh toán SePay tuân thủ bảng chính sách tường minh, liên kết chặt chẽ với trạng thái `sepay_transactions.status`:

| Tình Huống | Expected Amount | Received Amount | Result Code | SePay Status | Wallet Mutation | Topup / Order Status | Traceability & Notification |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :--- |
| **Exact Payment (Topup)** | 100,000 | 100,000 | `exact` | `credited` | `+100,000` VNĐ; ghi ledger `bank_topup`. | Topup: `status = 'credited'`, `paid_amount = 100,000` | Gán `topup_id`, `processed_at`. Gửi DM xác nhận số dư mới. |
| **Underpayment (Topup)** | 100,000 | 50,000 | `underpaid` | `underpaid` | `+50,000` VNĐ (cộng đúng số tiền thực nhận); ghi ledger `bank_topup`. | Topup: `status = 'credited'`, `paid_amount = 50,000` (để tiền không bị kẹt) | Gán `topup_id`, `processed_at`. Gửi DM: "Bạn chuyển thiếu (Yêu cầu: 100k, Thực nhận: 50k). Ví đã được cộng đúng 50,000 VNĐ." |
| **Overpayment (Topup)** | 100,000 | 150,000 | `overpaid` | `overpaid` | `+150,000` VNĐ (khách nhận đủ toàn bộ số tiền đã chuyển); ghi ledger `bank_topup`. | Topup: `status = 'credited'`, `paid_amount = 150,000` | Gán `topup_id`, `processed_at`. Gửi DM: "Bạn chuyển thừa (Yêu cầu: 100k, Thực nhận: 150k). Toàn bộ 150,000 VNĐ đã được cộng vào ví." |
| **Exact Payment (Order bankDue)** | 100,000 | 100,000 | `exact` | `credited` | Không đổi ví. | Order: `status = 'paid'`, tạo `delivery_job` `queued`. | Gán `order_id`, `processed_at`. Gửi DM thông báo đơn thành công và chuẩn bị nhận file. |
| **Underpayment (Order bankDue)** | 100,000 | 50,000 | `underpaid` | `underpaid` | `+50,000` VNĐ vào ví; ghi ledger `kind = 'order_partial_credit'`. | Order: Giữ `status = 'pending'`, không giao file. | Gán `order_id`, `processed_at`. Gửi DM: "Bạn chuyển thiếu so với đơn. 50,000 VNĐ đã lưu vào ví. Vui lòng bù phần còn lại." |
| **Overpayment (Order bankDue)** | 100,000 | 150,000 | `overpaid` | `overpaid` | `+50,000` VNĐ (phần thừa) vào ví; ghi ledger `kind = 'order_overpay_credit'`. | Order: `status = 'paid'`, tạo `delivery_job` `queued`. | Gán `order_id`, `processed_at`. Gửi DM: "Đơn hàng thành công! Tiền thừa 50,000 VNĐ đã được lưu vào ví của bạn." |
| **Unknown Topup Code** | Bất kỳ | Bất kỳ | `unmatched` | `unmatched` | Không có mutation ví. | Không gắn đối tượng. | Bắn alert lên kênh Staff Discord để admin kiểm tra đối soát thủ công. |
| **Expired Topup Code** | 100,000 | 100,000 | `expired_topup` | `credited` | `+100,000` VNĐ vào ví; ghi ledger `bank_topup`. | Topup: Chuyển từ `expired` -> `credited`, `paid_amount = 100,000`. | Gán `topup_id`, `processed_at`. Gửi DM: "Phiếu nạp đã hết hạn nhưng tiền đã chuyển thành công. Hệ thống đã kích hoạt và cộng tiền vào ví." |
| **Duplicate Topup Code (Khác sepay_id)** | 100,000 | 100,000 | `duplicate_transfer` | `duplicate_transfer` | Không tự động cộng tiền ví lần 2 (nhờ atomic guard `WHERE status IN ('pending', 'expired')`). | Topup giữ nguyên `credited`. | Gán `topup_id`, `processed_at`. Bắn alert lên kênh Staff Discord để admin xử lý hoàn tiền hoặc credit ví thủ công. |

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

## 10. Idempotent & Resumable Migration Strategy

### 10.1. Deterministic Natural Business Key Strategy
Mọi bảng Business được di chuyển theo quy trình tất định (Deterministic Lifecycle), cấm chèn mù (no blind insert):
```text
Natural Business Key
        ↓
Find Existing Row in Neon
        ↓
Validate Compatibility & Checksum
        ↓
Reuse Existing OR Insert/Update
        ↓
Record In-Memory ID Mapping (SQLite ID -> Neon ID)
```

**Chi tiết Natural Keys sử dụng**:
- `plugins`: tra cứu qua `plugins.slug`.
- `versions`: tra cứu qua `versions.sha256` hoặc `${pluginSlug}:${versionString}`.
- `orders`: tra cứu qua `orders.code`.
- `discount_codes`: tra cứu qua `discount_codes.code`.
- `wallets`: tra cứu qua `wallets.discordUserId`.
- `sepay_transactions`: tra cứu qua `sepay_transactions.sepayId`.
- `card_topups`: tra cứu qua `card_topups.requestId`.
- `spigot_accounts`: tra cứu và liên kết qua `accountId` (UUID).

### 10.2. Resumable Checkpoints Architecture (`migration_checkpoints`)
Để đảm bảo an toàn tuyệt đối khi process crash, đứt mạng hoặc timeout:
1. Script chia quá trình di chuyển thành các checkpoint độc lập:
   - `01_check_prerequisites`
   - `02_migrate_plugins_and_versions`
   - `03_migrate_wallets_and_ledger`
   - `04_migrate_orders_and_items`
   - `05_migrate_topups_and_payments`
   - `06_migrate_account_refs`
   - `07_sync_sequences`
   - `08_final_reconciliation`
2. Mỗi checkpoint hoàn thành được lưu vào bảng `migration_checkpoints` trên Neon kèm timestamp và checksum.
3. Khi chạy lại (Rerun / Resume):
   - Script đọc `migration_checkpoints`.
   - Bỏ qua các bước đã hoàn tất hoặc tiếp tục từ `lastProcessedKey`.
   - Đảm bảo: **Same SQLite Source + Same Neon Target = Chạy lại an toàn 100%, không sinh duplicate row, không hỏng khóa ngoại.**

### 10.3. Spigot Account UUID Identity Bridge
Xóa bỏ hoàn toàn việc dùng `label` làm identity giữa Local và Neon.
1. **Thiết kế UUID Bất Biến**:
   - Mỗi tài khoản Spigot sở hữu một `account_id` dạng UUID v4 vĩnh viễn.
   - Khi tách từ SQLite cũ: Nếu bản ghi cũ chỉ có ID integer, script sinh ra deterministic UUID (dựa trên UUIDv5 namespace hoặc gán UUIDv4 cố định và ghi ngược lại vào SQLite `vault_secrets.db`).
2. **Cấu trúc lưu trữ**:
   - **Local SQLite (`vault_secrets.db`)**: `account_id (UUID)`, `label`, `credentials` (mã hóa), `cookies`, `browser_profile`.
   - **Neon PostgreSQL (`spigot_account_refs`)**: `account_id (UUID PK)`, `label`, `status`, `health`, `last_verified_at`.
3. **Quy tắc bất biến**: Đổi tên `label` không làm thay đổi `account_id`, không làm đứt gãy mapping giữa Local Vault và Dashboard. Mật khẩu và session **tuyệt đối không bao giờ xuất hiện trên Neon**.

### 10.4. Wallet Opening Balance Reconstruction Logic
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

### 10.5. Secret Migration Hygiene (Vệ sinh bảo mật tuyệt đối)
Khi bóc tách `spigot_accounts` sang `vault_secrets.db`:
1. **Xử lý tệp SQLite cũ**:
   - Toàn bộ các tệp: `data/deps.db`, `data/deps.db-wal`, `data/deps.db-shm`, tệp snapshot backup cũ chứa credentials được phân loại là **Sensitive Tier 1 Artifacts**.
   - Cấu hình phân quyền truy cập tệp cục bộ: `chmod 600` (chỉ user chạy bot có quyền đọc/ghi).
   - Tuyệt đối cấm commit vào Git (`.gitignore` đã cấu hình chặn `data/*.db*`, `*.sqlite*`).
2. **Loại bỏ Secret khỏi Migration Pipeline**:
   - Script di chuyển chỉ trích xuất trường phi nhạy cảm (`account_id`, `label`, `status`, `health`, `last_verified_at`) nạp vào `spigot_account_refs` trên Neon.
   - Tuyệt đối không serialize mật khẩu, cookie `xf_user`, session `xf_session` vào bất kỳ biến tạm, tệp JSON dump hay câu lệnh INSERT sang Neon.
   - Tuyệt đối không log giá trị secret trong console hay migration log (mọi trường nhạy cảm phải hiển thị `[REDACTED]`).

---

## 11. Reconciliation Strategy

Kiểm định toàn diện 8 chiều sau di chuyển dữ liệu:
1. **Missing rows**: Bắt buộc = 0.
2. **Duplicate rows**: Bắt buộc = 0.
3. **Orphan foreign keys**: Bắt buộc = 0.
4. **Business-key collisions**: Bắt buộc = 0 (`orders.code`, `wallets.discord_user_id`, `sepay_transactions.sepay_id`, `card_topups.request_id`, `plugins.slug`, `versions.sha256`, `spigot_account_refs.account_id`).
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
- **T+2 (00:03)**: **Migrate Business Data**. Chạy script `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts` (sử dụng Resumable Checkpoints và Deterministic Natural Business Key Mapping, chỉ chuyển Business Data và Public Account Refs có `account_id` UUID, tuyệt đối không chuyển mật khẩu hay cookie).
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

## 14. Final Acceptance Tests (Bản Toàn Diện v6)

### 1. Migration Crash / Resume Test
Mô phỏng ngắt tiến trình (kill -9) giữa chừng khi script migration đang chạy 50%:
```text
Run 1: Chạy đến bước orders -> crash giả lập
Run 2: Tiếp tục chạy lại migration
Expected:
Script nhận diện checkpoint đã hoàn thành
Không sinh duplicate row
Không thất thoát bản ghi
Khóa ngoại nguyên vẹn 100%
```

### 2. Account Identity Bridge Test
Kiểm tra tính độc lập giữa định danh tài khoản và nhãn hiển thị:
```text
Tài khoản cục bộ có account_id UUID
Thay đổi label của tài khoản trên local hoặc Dashboard
Expected:
account_id trên Neon giữ nguyên vẹn
Mapping không bị đứt gãy
Mật khẩu/cookie vẫn nằm tại local SQLite, không bao giờ đẩy lên Neon
```

### 3. Delivery Outcome Accuracy Test
Mô phỏng crash sau khi Discord DM send thành công nhưng chưa commit log -> Recovery Worker xử lý:
```text
Expected:
delivery_logs ghi nhận chính xác:
- requestedMethod = 'attachment'
- actualMethod = 'fallback_link'
Không ghi fallback link dưới danh nghĩa attachment
Không gửi lặp file nặng qua Discord DM
```

### 4. Global Lock Order Deadlock Freedom Test
Mô phỏng 2 giao dịch đồng thời cạnh tranh tài nguyên theo đúng Canonical Lock Order:
- Transaction A: `discount_codes` -> `wallets`
- Transaction B: `discount_codes` -> `wallets`
```text
Expected:
Cả 2 transaction hoàn tất tuần tự
Không xảy ra Deadlock (DeadlockCount = 0)
Không có hiện tượng Lock Inversion
```

### 5. Duplicate Topup Test
Hai webhook khác `sepay_id` nhưng cùng `wallet_topups.code`:
```text
Expected:
1 wallet credit
1 ledger entry
topup status = credited
Webhook thứ 2 cập nhật sepay status = 'duplicate_transfer', không credit ví lần 2
```

### 6. Concurrent First Redemption Test
Hai purchase đồng thời với cùng discount + cùng user (`per_user_limit = 1`):
```text
Expected:
respect per_user_limit
no duplicate redemption
Đúng 1 đơn được giảm giá; đơn thứ hai tính nguyên giá
```

### 7. Purchase Failure After Discount Validation Test
Simulate DB failure sau discount validation trong cùng transaction:
```text
Expected:
no redemption
no used_count increment
no wallet mutation
no delivery job
no order
```

### 8. Download Token Atomic Consumption Test
2 requests đồng thời gửi cùng một `token_hash`:
```text
Expected:
exactly 1 success (nhận stream file 200 OK)
exactly 1 rejected (nhận 410 Gone / 403 Forbidden)
Không tải đúp file
```

### 9. Duplicate Delivery Job Test
Hai request đồng thời tạo delivery job cho cùng một `order_id` và cùng một `requested_method`:
```text
Expected:
Đúng 1 delivery job duy nhất được tạo trong database nhờ unique constraint (order_id, requested_method)
Request thứ 2 tái sử dụng job hiện có
```

### 10. Expired Topup Paid Later Test
Phiếu nạp tiền đã chuyển sang `expired` do hết hạn, sau đó khách chuyển tiền tới SePay:
```text
Expected:
Topup chuyển trạng thái từ 'expired' -> 'credited'
Cộng đủ tiền vào ví người dùng và ghi sổ cái
Cập nhật sepay_transactions status = 'credited', topup_id = $topupId
Gửi thông báo DM ghi nhận thanh toán muộn thành công theo đúng Payment Amount Policy Matrix
```

---

## 15. Files To Modify

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 6 bảng Business: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`, `delivery_jobs`, `migration_checkpoints`.
   - Thêm **Partial Unique Index** trên `wallet_ledger`: `uniqueIndex('idx_wallet_ledger_ref_kind_unique').on(table.refType, table.refId, table.kind).where(sql\`ref_type != '' AND ref_id IS NOT NULL\`)`.
   - Bổ sung trường `description`, `status`, `orderId`, `topupId`, `processedAt` vào bảng `sepay_transactions`.
   - Bổ sung **Unique Index `(orderId, requestedMethod)`** trên bảng `delivery_jobs`.
   - Thêm trường `requestedMethod` và `actualMethod` vào bảng `delivery_logs`.
   - Chuẩn hóa bảng `spigotAccounts` thành `spigotAccountRefs` với khóa chính `accountId: uuid().primaryKey()`.
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Xóa bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` nghiệp vụ sang `neonDb`.
   - Tách riêng kết nối `vaultSecretsDb` (SQLite nội bộ) chỉ dùng cho Spigot crawler và browser launcher.
   - Kiểm tra `VAULT_MASTER_KEY` khi khởi động bot (Fail-fast).
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Viết lại `applyLedgerEntry` sử dụng `db.transaction()` và tuân thủ Canonical Lock Order.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Áp dụng Canonical Lock Order: Khóa `wallets` trước -> khóa `wallet_topups`.
   - Tích hợp Payment Amount Policy Matrix và traceability `sepay_transactions`.
   - Tích hợp luồng Purchase + Discount + Durable Delivery Job tuân thủ Lock Order.
6. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Phân biệt rõ `requestedMethod` và `actualMethod` khi ghi log.
   - Áp dụng Worker Recovery Policy khi xảy ra crash sau send.
7. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Chuyển sang sử dụng bảng `download_tokens` trên Neon với Atomic Consumption logic.

---

## 16. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon (hỗ trợ `expired -> credited`).
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file bảo mật với atomic mutation.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file kèm `requestedMethod` và `actualMethod`.
5. `discord/src/repositories/neon-delivery-jobs.ts`: Hàng đợi giao hàng bền vững với ràng buộc Unique `(order_id, requested_method)`.
6. `discord/src/repositories/neon-spigot-refs.ts`: Quản lý tham chiếu trạng thái Spigot qua UUID bất biến.
7. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu nghiệp vụ có Resumable Checkpoints, UUID Account Bridge, Opening Balance logic, và Secret Hygiene.
8. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động kiểm tra tính nguyên tử, idempotency, atomic consumption, duplicate jobs, crash recovery, lock order không deadlock và concurrency trên Neon.

---

## 17. Acceptance Criteria

1. [ ] **Dual-Vault Boundary Enforced**: Tuyệt đối không có mật khẩu, cookie, hay session nào của Spigot được lưu trữ hoặc chuyển lên Neon. Toàn bộ credential upstream được cô lập tại Local Secret Vault.
2. [ ] **Spigot Account UUID Bridge Enforced**: Liên kết qua `accountId` UUID bất biến; đổi `label` không làm mất liên kết; mật khẩu và cookie không bao giờ xuất hiện trên Neon.
3. [ ] **Resumable Migration Verified**: Script migration có checkpoints; gặp crash hoặc timeout chạy lại vẫn an toàn tuyệt đối, không sinh duplicate row hay đứt gãy khóa ngoại.
4. [ ] **Global Lock Order Applied**: Toàn bộ các transaction tuân thủ thứ tự: `discount_codes` -> `wallets` -> `orders` -> `wallet_topups` -> `delivery_jobs`. Không xảy ra Lock Inversion hay Deadlock.
5. [ ] **Delivery Outcome Formally Distinguished**: `requestedMethod` và `actualMethod` được phân biệt rõ; crash recovery ghi đúng `actualMethod = 'fallback_link'`.
6. [ ] **Master Encryption Key Isolated**: Master key không nằm trong database, nạp từ `VAULT_MASTER_KEY` môi trường, kiểm tra fail-fast khi khởi động.
7. [ ] **No Production SQLite Business Writes**: Không còn câu lệnh ghi dữ liệu nghiệp vụ (orders, wallets, ledger, payments) nào vào SQLite tại runtime production.
8. [ ] **Single Source of Truth Verified**: Discord Bot và Web Dashboard cùng đọc/ghi một hàng dữ liệu đơn hàng và số dư ví trên Neon theo thời gian thực.
9. [ ] **Partial Unique Index Applied**: Sử dụng Partial Unique Index trên `wallet_ledger`, ngăn nạp đúp tiền ở mức database mà không vi phạm cú pháp PostgreSQL.
10. [ ] **Payment Traceability Established**: Mọi bản ghi `sepay_transactions` lưu vết rõ ràng `order_id`, `topup_id`, `status` tường minh và `processed_at`.
11. [ ] **Payment Policy Strictly Applied**: Toàn bộ ma trận số tiền (Exact, Underpay, Overpay, Unknown, Expired, Duplicate) hoạt động đúng chính sách tường minh.
12. [ ] **Expired Topup Handled**: Topup hết hạn chuyển trạng thái hợp lệ sang `credited` khi tiền về muộn, không làm thất thoát tiền của khách.
13. [ ] **Durable Delivery Job Unique**: Ràng buộc Unique `(order_id, requested_method)` trên `delivery_jobs` đảm bảo đúng 1 active delivery intent per method.
14. [ ] **Download Token Atomically Consumed**: 2 request đồng thời tới cùng một token hash chỉ có đúng 1 request tải thành công.
15. [ ] **Wallet Opening Balance Reconciled**: Tự động nhận diện tính toàn vẹn của ledger; chỉ bù 1 dòng `opening_balance` khi thật sự thiếu; invariant số dư = tổng delta đạt 100%.
16. [ ] **Secret Migration Hygiene**: Artifacts cũ (db, wal, dumps) được bảo vệ, cấm commit Git, cấm log mật khẩu.
17. [ ] **Discount Concurrency Controlled**: Concurrent redemptions được serialize an toàn nhờ lock parent row `discount_codes`, tôn trọng `per_user_limit` và `max_uses`.
18. [ ] **Purchase + Discount Unified in 1 Transaction**: Nếu purchase lỗi giữa chừng, toàn bộ discount redemption, usage count, order và wallet mutation đều rollback sạch sẽ.
19. [ ] **Existing UX Unchanged**: Trải nghiệm nút bấm, modal, menu trên Bot Discord và Web Dashboard giữ nguyên 100%.
20. [ ] **Existing Tests Pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.

---

## 18. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Đứt gãy liên kết Account khi đổi tên** | **Cao** | Dùng `label` làm khóa tự nhiên liên kết giữa Local và Neon. | **UUID Identity Bridge**: Cố định `account_id` dạng UUID v4 vĩnh viễn; `label` chỉ là thuộc tính hiển thị. |
| **Deadlock do Lock Inversion** | **Cao** | Các transaction khác nhau xin khóa các bảng theo thứ tự đảo ngược. | **Canonical Lock Order**: Bắt buộc xin khóa theo thứ tự duy nhất: `discount_codes` -> `wallets` -> `orders` -> `wallet_topups`. |
| **Crash khi Migration gây dữ liệu dở dang** | **Cao** | Script migration chèn mù (blind insert), chạy lại bị trùng lặp hoặc fail. | **Resumable Checkpoints**: Lưu vết tiến trình vào `migration_checkpoints`, kiểm tra natural key trước khi xử lý từng dòng. |
| **Báo cáo sai lệch phương thức giao file** | **Trung bình** | Ghi nhận fallback link dưới danh nghĩa file đính kèm. | **Intent vs Outcome**: Phân định rõ `requestedMethod = 'attachment'` và `actualMethod = 'fallback_link'`. |
| **Rò rỉ Spigot Credentials / Master Key** | **Nghiêm trọng** | Lưu trữ master key hoặc đồng bộ secret accounts lên Cloud DB. | **Dual-Vault Boundary**: Master key lưu ngoài DB; credentials lưu tại local SQLite `data/vault_secrets.db` mã hóa AES-256-GCM. |
| **Nạp đúp tiền ví hoặc sai lệch số dư** | **Nghiêm trọng** | Webhook lặp, underpay/overpay không xác định, hoặc duplicate opening balance. | Atomic status update `WHERE status IN ('pending', 'expired')`, chính sách số tiền tường minh, và Partial Unique Index trên ledger. |
| **Mất giao dịch khi Rollback sai cách** | **Nghiêm trọng** | Khôi phục database bằng cách ghi đè backup SQLite cũ sau cutover. | **Cấm Rollback ghi đè DB**: Chỉ Rollback Application code; nếu lỗi DB thì dùng Neon PITR. |

---

READY FOR IMPLEMENTATION
