# PHASE 1 FINAL IMPLEMENTATION PLAN v7 — DUAL-VAULT & BUSINESS AUTHORITY

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
│   - label              │    (Natural Key:          • card_topups
│   - enc_password       │     plugin_id + version)  • discount_codes
│   - enc_cookies (xf)   │  • manual_uploads         • discount_redemptions
│   - session / profile  │  • orders                 • delivery_logs
│ • account_scan_state   │  • sepay_transactions     • delivery_jobs
│   - rate-limit state   │    (relational trace)       (lease & recovery)
│   - crawl errors       │  • wallets                • upstream_state
│ • vault/ storage blobs │  • download_tokens        • pending_download
│   - JAR files on disk  │    (atomic claim/unclaim) • audit_logs (Staff)
│ • Ciphertext only      │  • resource_ownership    • migration_checkpoints
│                        │  • discord_channels         (atomic batch)
│                        │  • spigot_account_refs (account_id UUID, label)
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
| `versions` | `versions` | Business | ❌ **Chuẩn hóa** | **Natural Key: `(plugin_id, version)`**. Thêm `UNIQUE (plugin_id, version)`. SHA256 chỉ dùng để audit/integrity. |
| `manual_uploads` | `manual_uploads` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_codes` | `discount_codes` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_code_redemptions` | **`discount_code_redemptions`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (chống gian lận mã giảm giá). |
| `download_tokens` | **`download_tokens`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (atomic claim/unclaim & compensation). |
| `audit_log` (Bot) | **`delivery_logs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (có `delivery_idempotency_key`, phân biệt `requested_method` vs `actual_method`). |
| *(Durable Handoff)* | **`delivery_jobs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** với **Unique `(order_id, requested_method)`**, lease timeout & stale recovery. |
| `upstream_state` | `upstream_state` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_download` | `pending_download` | Business | Đã có | Giữ nguyên vẹn. |
| `pending_ingest` | `pending_ingest` | Business | Đã có | Giữ nguyên vẹn. |
| `resource_ownership` | `resource_ownership` | Business | Đã có | Giữ nguyên vẹn (map `resource_id` -> `account_id` UUID). |
| `discord_channels` | `discord_channels` | Business | Đã có | Giữ nguyên cấu hình kênh. |
| `dashboard_staff` | `staffs` | Business | Đã có | Map dữ liệu sang bảng staffs RBAC. |
| `audit_log` (Admin) | `audit_logs` | Business | Đã có | Giữ nguyên cho Staff RBAC actions. |
| `config` | `config` | Business | Đã có | Giữ nguyên cấu hình runtime. |
| *(Resumable Migration)* | **`migration_checkpoints`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý batch checkpoint atomic). |
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

### 4.3. Version Business Identity & Natural Key
Business identity của một plugin version được xác định duy nhất bởi:
$$\text{Version Business Identity} = \text{plugin\_id} + \text{version string}$$

```sql
CREATE UNIQUE INDEX idx_versions_plugin_version
ON versions (plugin_id, version);
```
Trong Drizzle ORM:
```typescript
uniqueIndex("idx_versions_plugin_version").on(table.pluginId, table.version);
```
- **Vai trò của SHA256**: Cột `sha256` trong bảng `versions` **chỉ được sử dụng để verify tính toàn vẹn của tệp JAR (file integrity), phát hiện tệp bị lỗi (corrupted file), đối soát kiểm toán (file content audit) và phát hiện thay đổi artifact**. SHA256 **KHÔNG PHẢI** là business natural key duy nhất của entity version.

---

## 5. Schema Gaps (Đặc tả chi tiết các bảng mới trên Neon)

### 5.1. Bảng `wallet_topups` (Business Data - Expired Lifecycle Reconciliation)
- **Purpose**: Quản lý vòng đời yêu cầu nạp tiền ví qua chuyển khoản VietQR/SePay.
- **Columns**: `id` (serial PK), `code` (varchar 32 unique), `discordUserId` (varchar 32 not null), `amount` (integer not null > 0), `paidAmount` (integer nullable), `status` (varchar 20 default 'pending'), `createdAt` (timestamp with tz), `expiresAt` (timestamp with tz), `creditedAt` (timestamp with tz nullable).
- **Constraints & Indexes**: `uniqueIndex("idx_wallet_topups_code").on(table.code)`, `index("idx_wallet_topups_status").on(table.status)`, `index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt)`.
- **Thống nhất Lifecycle với Payment Matrix**:
  ```text
  pending ───(quá hạn expiresAt)───▶ expired
     │                                  │
     │                                  ▼ (chuyển khoản tới muộn)
     └──────────(thanh toán)──────────▶ credited (đối soát thành công)
  ```

### 5.2. Bảng `sepay_transactions` (Traceability & Explicit States)
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
  `'received'`, `'matched'`, `'credited'`, `'underpaid'`, `'overpaid'`, `'duplicate_transfer'`, `'unmatched'`.

### 5.3. Bảng `discount_code_redemptions` (Business Data)
- **Columns**: `id` (serial PK), `discountId` (integer not null references `discount_codes.id` on delete cascade), `discordUserId` (varchar 32 not null), `orderId` (integer references `orders.id` on delete set null), `discountAmount` (integer > 0), `redeemedAt` (timestamp with tz default now()).
- **Unique Constraints**: `uniqueIndex("idx_discount_redemptions_order").on(table.orderId)`.
- **Indexes**: `index("idx_discount_redemptions_discount_user").on(table.discountId, table.discordUserId)`.

### 5.4. Bảng `download_tokens` (Authorization & Failure Recovery Policy)
- **Columns**:
  - `tokenHash` (varchar 64 primary key - sha256 hex digest)
  - `versionId` (integer not null references `versions.id` on delete cascade)
  - `discordUserId` (varchar 32 not null)
  - `orderId` (integer references `orders.id` on delete set null)
  - `expiresAt` (timestamp with tz not null)
  - `usedAt` (timestamp with tz nullable)
  - `failureReason` (text nullable)
  - `createdAt` (timestamp with tz default now())
- **Thứ tự xử lý bắt buộc tại Endpoint `/download/:token`**:
  ```text
  1. Validate token format (hex sha256)
  2. Validate expiry (expires_at > now())
  3. Validate unused (used_at IS NULL)
  4. Validate referenced order / user / version
  5. Atomically claim token:
     UPDATE download_tokens
     SET used_at = now()
     WHERE token_hash = $hash
       AND used_at IS NULL
       AND expires_at > now()
     RETURNING token_hash, version_id, discord_user_id, order_id;
  6. Verify file exists on local storage (fs.existsSync(jarPath))
  7. Stream file (Content-Disposition, Content-Type, Content-Length)
  ```
- **Xử lý Failure & Compensation Policy**:
  - *Token hợp lệ nhưng File missing / Storage unavailable trước khi stream*:
    - **Không trừ lượt token của khách**.
    - Thực thi bồi hoàn giải phóng token (atomic unclaim):
      ```sql
      UPDATE download_tokens
      SET used_at = NULL, failure_reason = 'file_missing_on_storage'
      WHERE token_hash = $hash;
      ```
    - Trả HTTP 503 Service Unavailable ("Tệp tải đang tạm thời bảo trì, token của bạn đã được bảo lưu. Vui lòng thử lại sau ít phút.").
    - Bắn alert khẩn lên kênh Staff Discord để admin kiểm tra tệp JAR trên đĩa.
  - *Stream fail giữa chừng (Client ngắt mạng / timeout)*:
    - Hỗ trợ HTTP Range requests (`Accept-Ranges: bytes`) cho phép tiếp tục tải phân đoạn.
    - Nếu lỗi không thể khôi phục: Token đã claim. Khách có thể bấm nút "Lấy lại link tải" trên Bot Discord để cấp token mới nếu đơn hàng đã được đánh dấu `paid`.
  - *Concurrent requests dùng cùng token*:
    - Atomic mutation đảm bảo **chính xác 1 request nhận được row từ `RETURNING`** và tải file thành công. Mọi request khác nhận 0 row -> Bị từ chối ngay lập tức (HTTP 410 Gone / 403 Forbidden).

### 5.5. Bảng `delivery_jobs` (Durable Intent, Lease Duration & Stale Recovery)
- **Columns**:
  - `id` (serial PK)
  - `orderId` (integer not null references `orders.id` on delete cascade)
  - `discordUserId` (varchar 32 not null)
  - `versionId` (integer not null references `versions.id`)
  - `requestedMethod` (varchar 32 not null default 'attachment')
  - `status` (varchar 20 default 'queued': 'queued' | 'processing' | 'delivered' | 'failed')
  - `externalAttemptCount` (integer not null default 0)
  - `claimToken` (varchar 64 nullable)
  - `lockedAt` (timestamp with tz nullable)
  - `retryCount` (integer default 0)
  - `lastError` (text nullable)
  - `createdAt` (timestamp with tz default now())
  - `updatedAt` (timestamp with tz default now())
- **Delivery Job Uniqueness Invariant**:
  ```sql
  CREATE UNIQUE INDEX idx_delivery_jobs_order_method_unique
  ON delivery_jobs (order_id, requested_method);
  ```
- **Lease Timeout & Stale Recovery Policy**:
  - `DELIVERY_JOB_LEASE = 300 seconds (5 phút)`.
  - *Claim Rule (Atomic lock acquisition)*:
    ```sql
    UPDATE delivery_jobs
    SET status = 'processing',
        claim_token = $claimUuid,
        locked_at = now(),
        external_attempt_count = external_attempt_count + 1,
        updated_at = now()
    WHERE id = (
      SELECT id FROM delivery_jobs
      WHERE status = 'queued'
         OR (status = 'processing' AND locked_at < now() - INTERVAL '5 minutes')
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, order_id, discord_user_id, version_id, requested_method, claim_token, external_attempt_count, retry_count;
    ```
  - *Retryable Failure*: Nếu gặp lỗi tạm thời (Discord 429 rate limit, network timeout) và `retryCount < 3`:
    ```sql
    UPDATE delivery_jobs
    SET status = 'queued', claim_token = NULL, locked_at = NULL, retry_count = retry_count + 1, last_error = $err, updated_at = now()
    WHERE id = $jobId AND claim_token = $claimUuid;
    ```
  - *Permanent Failure*: Nếu khách khóa DM (Error 50007 Cannot send messages to this user) hoặc `retryCount >= 3`:
    ```sql
    UPDATE delivery_jobs
    SET status = 'failed', claim_token = NULL, last_error = $err, updated_at = now()
    WHERE id = $jobId AND claim_token = $claimUuid;
    ```
    Hệ thống ghi log cảnh báo và tự động chuyển sang cấp download link cho khách qua kênh hỗ trợ.

### 5.6. Bảng `delivery_logs` (Business Audit Trail - Intent vs Outcome)
- **Columns**: `id`, `deliveryIdempotencyKey` (unique), `discordUserId`, `versionId`, `orderId`, `pluginName`, `versionLabel`, `amount`, `requestedMethod` ('attachment' | 'link' | 'manual'), `actualMethod` ('attachment' | 'fallback_link' | 'manual'), `ip`, `deliveredAt`.

### 5.7. Bảng `spigot_account_refs` (Stable UUID Identity Bridge)
- **Columns**: `accountId` (uuid primary key not null), `label` (varchar 64 not null), `status`, `health`, `lastVerifiedAt`, `createdAt`, `updatedAt`.

### 5.8. Bảng `migration_checkpoints` (Atomic Batch Checkpoints)
- **Columns**: `stepName` (varchar 64 primary key), `status` ('in_progress' | 'completed' | 'failed'), `lastProcessedKey`, `processedCount`, `checksum`, `startedAt`, `completedAt`.

---

## 6. Repository Migration Map

| Repository Gốc | Runtime Nguồn | Repository Đích | Runtime Đích | Ghi Chú Ranh Giới |
| :--- | :---: | :--- | :---: | :--- |
| `orders.ts` | SQLite | `neon-orders.ts` | **Neon** | Quản lý đơn hàng trên Neon. |
| `wallets.ts` | SQLite | `neon-wallets.ts` | **Neon** | `applyLedgerEntry` có Row-Locking (`FOR UPDATE`). |
| `wallet-topups.ts` | SQLite | `neon-wallet-topups.ts` | **Neon** | Quản lý phiếu nạp tiền (vòng đời `expired -> credited`). |
| `card-topups.ts` | SQLite | `neon-card-topups.ts` | **Neon** | Quản lý nạp thẻ cào Card2k trên Neon. |
| `discounts.ts` | SQLite | `neon-discounts.ts` | **Neon** | Thêm bảng `discount_code_redemptions`. |
| `plugins.ts` | SQLite | `neon-plugins.ts` | **Neon** | Chuyển catalog plugin sang Neon. |
| `versions.ts` | SQLite | `neon-versions.ts` | **Neon** | Natural Key: `(plugin_id, version)`. |
| `upstream-state.ts` | SQLite | `neon-upstream.ts` | **Neon** | Quản lý version upstream trên Neon. |
| `pending-download.ts` | SQLite | `neon-upstream.ts` | **Neon** | Hàng đợi tải upstream trên Neon. |
| `resource-ownership.ts`| SQLite | `neon-resource-ownership.ts`| **Neon** | Ánh xạ resource_id -> `account_id` UUID. |
| `mint-download-token.ts`| SQLite | `neon-download-tokens.ts` | **Neon** | Quản lý token web tải một lần kèm atomic unclaim compensation. |
| `deliver-version.ts` | SQLite | `neon-delivery-logs.ts` | **Neon** | Ghi nhận nhật ký bàn giao file (`requested` vs `actual`). |
| *(Durable Handoff)* | In-Memory | `neon-delivery-jobs.ts` | **Neon** | Quản lý hàng đợi job có Unique `(order_id, requested_method)` và Lease Recovery. |
| `spigot-accounts.ts` | SQLite | **`spigot-accounts.ts` (Local Vault)** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT** (Có `account_id` UUID). |
| *(Đồng bộ Status)* | SQLite | **`neon-spigot-refs.ts`** | **Neon** | Publish `account_id` UUID, `label`, `status`, `health` sang Neon. |
| `account-scan-state.ts`| SQLite | **`account-scan-state.ts`** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không đẩy crawler state lên Neon. |

---

## 7. Transaction Boundaries, Delivery Semantics & Global Lock Order

### 7.1. Global Database Lock Order (Chống Deadlock Triệt Để)

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
2. **TUYỆT ĐỐI CẤM** luồng xin khóa ngược (ví dụ: `wallets -> discount_codes` là hành vi bất hợp pháp).
3. **Pre-Read để xác định User**: Trước khi xin khóa `wallets`, hệ thống thực hiện **Pre-Read KHÔNG LOCK (`WITHOUT FOR UPDATE`)** để giải quyết `discordUserId`. Sau đó tiến hành khóa `wallets` trước rồi mới khóa `orders` hoặc `wallet_topups`.

---

### 7.2. Đặc tả chi tiết luồng Webhook SePay Topup (Pre-Read & Canonical Lock Order)

```sql
-- BƯỚC 0: Pre-read KHÔNG LOCK để xác định Identity & User sở hữu phiếu nạp
SELECT id AS topup_id, discord_user_id AS user_id, status, amount
FROM wallet_topups
WHERE code = $code;

-- Nếu không tìm thấy: Chuyển sang kiểm tra Order Bank Payment (Mục 7.3) hoặc ghi sepay_transactions 'unmatched'.

-- BẮT ĐẦU TRANSACTION NGHIỆP VỤ:
BEGIN TRANSACTION;
  -- 1. Dedupe webhook SePay
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, status, raw_payload, received_at)
  VALUES ($1, $amount, $type, $code, $content, $desc, 'received', $payload, now())
  ON CONFLICT (sepay_id) DO NOTHING
  RETURNING id;
  -- NẾU không có id trả về -> Webhook trùng -> COMMIT rỗng và RETURN { handled: 'duplicate' }

  -- 2. Khóa ví người dùng (Lock Order #2)
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;

  -- 3. Khóa phiếu nạp ví (Lock Order #4)
  SELECT * FROM wallet_topups WHERE id = $topupId FOR UPDATE;

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

  -- 7. Ghi ledger (PARTIAL UNIQUE INDEX bảo vệ)
  INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
  VALUES ($userId, $amount, new_balance, 'bank_topup', 'topup', $topupId, 'nạp ví SePay', now());

  -- 8. Cập nhật Traceability trên sepay_transactions
  UPDATE sepay_transactions
  SET status = 'credited',
      topup_id = $topupId,
      processed_at = now()
  WHERE id = $sepayTxId;

COMMIT;

[AFTER COMMIT - EXTERNAL SIDE EFFECTS NGOÀI DB TRANSACTION]
  - Trả HTTP 200 OK cho SePay gateway.
  - Gửi Discord DM thông báo số dư mới cho người dùng.
```

---

### 7.3. Đặc tả chi tiết luồng Order Bank Payment Transaction (Exact / Underpay / Overpay)

Áp dụng khi SePay webhook nhận thanh toán trực tiếp cho một đơn hàng (`code` khớp với `orders.code`):

```sql
-- BƯỚC 0: Pre-read KHÔNG LOCK để xác định Identity đơn hàng và User sở hữu
SELECT id AS order_id, discord_user_id AS user_id, status, bank_due, version_id, amount
FROM orders
WHERE code = $code;

-- BẮT ĐẦU TRANSACTION NGHIỆP VỤ:
BEGIN TRANSACTION;
  -- 1. Dedupe webhook SePay
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, status, raw_payload, received_at)
  VALUES ($1, $amount, $type, $code, $content, $desc, 'received', $payload, now())
  ON CONFLICT (sepay_id) DO NOTHING
  RETURNING id;
  -- NẾU không có id trả về -> Webhook trùng -> COMMIT rỗng và RETURN { handled: 'duplicate' }

  -- 2. Khóa dòng liên quan theo Canonical Lock Order:
  -- Lock Order #2 (wallets): Khóa ví người dùng trước
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  -- Lock Order #3 (orders): Khóa đơn hàng
  SELECT * FROM orders WHERE id = $orderId FOR UPDATE;

  -- 3. Validate trạng thái đơn hàng:
  -- Bắt buộc: order.status == 'pending' VÀ order.bank_due > 0.
  -- Nếu đơn hàng đã 'paid' hoặc 'cancelled':
  -- -> Cập nhật sepay_transactions.status = 'duplicate_transfer', order_id = $orderId, COMMIT và dừng.

  -- 4. So sánh số tiền thực nhận ($amount) với bank_due và phân nhánh xử lý:

  -- TRƯỜNG HỢP A: EXACT PAYMENT ($amount == order.bank_due)
  IF $amount = order.bank_due THEN
    -- Cập nhật đơn hàng thành công
    UPDATE orders
    SET status = 'paid', bank_due = 0, updated_at = now()
    WHERE id = $orderId;

    -- Tạo Durable Delivery Job (Lock Order #5)
    INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, requested_method, status)
    VALUES ($orderId, $userId, order.version_id, 'attachment', 'queued')
    ON CONFLICT (order_id, requested_method) DO NOTHING;

    -- Cập nhật Traceability
    UPDATE sepay_transactions
    SET status = 'credited', order_id = $orderId, processed_at = now()
    WHERE id = $sepayTxId;

  -- TRƯỜNG HỢP B: UNDERPAYMENT ($amount < order.bank_due)
  ELSIF $amount < order.bank_due THEN
    -- Không giao hàng. Ghi nhận số tiền thực nhận vào ví của khách để tiền không bị kẹt.
    INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
    VALUES ($userId, $amount, now(), now())
    ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

    -- Ghi sổ cái cho phần tiền nạp bù ví
    INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
    VALUES ($userId, $amount, new_balance, 'order_partial_credit', 'order', $orderId, 'thanh toán thiếu tiền đơn hàng - cộng ví', now());

    -- Đơn hàng giữ nguyên 'pending', bank_due giữ nguyên
    -- Không tạo delivery_job

    -- Cập nhật Traceability
    UPDATE sepay_transactions
    SET status = 'underpaid', order_id = $orderId, processed_at = now()
    WHERE id = $sepayTxId;

  -- TRƯỜNG HỢP C: OVERPAYMENT ($amount > order.bank_due)
  ELSIF $amount > order.bank_due THEN
    excess := $amount - order.bank_due;

    -- Cập nhật đơn hàng thành công
    UPDATE orders
    SET status = 'paid', bank_due = 0, updated_at = now()
    WHERE id = $orderId;

    -- Cộng phần tiền thừa vào ví khách hàng
    INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
    VALUES ($userId, excess, now(), now())
    ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + excess, updated_at = now();

    -- Ghi sổ cái cho phần tiền thừa
    INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
    VALUES ($userId, excess, new_balance, 'order_overpay_credit', 'order', $orderId, 'tiền thừa thanh toán đơn hàng - cộng ví', now());

    -- Tạo Durable Delivery Job (Lock Order #5)
    INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, requested_method, status)
    VALUES ($orderId, $userId, order.version_id, 'attachment', 'queued')
    ON CONFLICT (order_id, requested_method) DO NOTHING;

    -- Cập nhật Traceability
    UPDATE sepay_transactions
    SET status = 'overpaid', order_id = $orderId, processed_at = now()
    WHERE id = $sepayTxId;
  END IF;

COMMIT;

[AFTER COMMIT - EXTERNAL SIDE EFFECTS NGOÀI DB TRANSACTION]
  - Trả HTTP 200 OK cho SePay gateway.
  - Gửi Discord DM thông báo kết quả (Exact / Underpay / Overpay).
  - Worker claim delivery_job bất đồng bộ để thực thi gửi file.
```

---

### 7.4. Đặc tả luồng Purchase + Discount + Durable Delivery Job
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

---

## 8. Payment Amount Policy Matrix

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
   - Nạp từ biến môi trường được bảo vệ: `VAULT_MASTER_KEY` (chuỗi hex 64 ký tự = 32 bytes entropy cao).
2. **Khởi Động An Toàn (Startup Fail-Fast Behavior)**:
   - Thiếu hoặc độ dài khác 32 bytes -> **Lập tức dừng khởi động (`process.exit(1)`)**.
3. **Quy Trình Xoay Khóa (Key Rotation Policy)**:
   - Hỗ trợ dual-key (`VAULT_MASTER_KEY` active, `VAULT_MASTER_KEY_PREVIOUS` fallback).
4. **Chính Sách Sao Lưu & Bảo Vệ Khóa**:
   - Master key chỉ sao lưu ngoại tuyến, không đưa vào backup database, không log giá trị.

---

## 10. Idempotent & Resumable Migration Strategy (Atomic Checkpoints)

### 10.1. Deterministic Natural Business Key Strategy
Mọi bảng Business được di chuyển theo quy trình tất định, cấm chèn mù:
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

**Natural Keys sử dụng**:
- `plugins`: tra cứu qua `plugins.slug`.
- `versions`: tra cứu qua `(plugin_id, version)` (SHA256 chỉ audit file).
- `orders`: tra cứu qua `orders.code`.
- `discount_codes`: tra cứu qua `discount_codes.code`.
- `wallets`: tra cứu qua `wallets.discordUserId`.
- `sepay_transactions`: tra cứu qua `sepay_transactions.sepayId`.
- `card_topups`: tra cứu qua `card_topups.requestId`.
- `spigot_accounts`: tra cứu và liên kết qua `accountId` (UUID).

### 10.2. Migration Checkpoint Atomicity (Tính nguyên tử tuyệt đối theo Batch)
Business data mutation và migration checkpoint/progress của cùng một batch **BẮT BUỘC PHẢI COMMIT ATOMICALLY TRONG CÙNG MỘT TRANSACTION**:

```text
BEGIN TRANSACTION;
  1. Migrate batch dữ liệu nghiệp vụ (ví dụ: orders chunk 500 rows);
  2. Validate tính tương thích và checksum của batch;
  3. Update migration_checkpoints:
     INSERT INTO migration_checkpoints (step_name, status, last_processed_key, processed_count, checksum, completed_at)
     VALUES ($stepName, 'in_progress', $lastKey, $count, $checksum, now())
     ON CONFLICT (step_name) DO UPDATE SET
       last_processed_key = EXCLUDED.last_processed_key,
       processed_count = EXCLUDED.processed_count,
       checksum = EXCLUDED.checksum,
       completed_at = now();
COMMIT;
```

**Quy tắc an toàn khi Crash/Restart**:
- Nếu process crash trước `COMMIT`: Toàn bộ batch dữ liệu nghiệp vụ và trạng thái checkpoint tự động rollback sạch sẽ.
- Khi khởi động lại script: Hệ thống đọc `migration_checkpoints` đã commit ở batch trước và tiếp tục từ `lastProcessedKey`.
- Tuyệt đối không xảy ra tình trạng: Business data đã commit nhưng checkpoint chưa ghi, hoặc checkpoint ghi hoàn thành nhưng business data bị lỗi.

### 10.3. Spigot Account UUID Identity Bridge
Cố định `account_id` dạng UUID v4 bất biến giữa Local SQLite (`vault_secrets.db`) và Neon (`spigot_account_refs`). Đổi `label` không làm thay đổi hay đứt gãy liên kết `account_id`. Mật khẩu và session **tuyệt đối không bao giờ xuất hiện trên Neon**.

### 10.4. Wallet Opening Balance Reconstruction Logic
Kiểm tra tính toàn vẹn của lịch sử sổ cái SQLite: Chỉ bù đúng 1 dòng `opening_balance` khi thật sự thiếu ($S \neq B$). Invariant số dư = tổng delta đạt 100%.

### 10.5. Secret Migration Hygiene
Toàn bộ tệp SQLite cũ được bảo mật `chmod 600`, cấm commit Git, cấm serialize secret sang Neon, redact toàn bộ credential trong migration log.

---

## 11. Reconciliation Strategy

Kiểm định toàn diện 8 chiều sau di chuyển dữ liệu:
1. **Missing rows**: Bắt buộc = 0.
2. **Duplicate rows**: Bắt buộc = 0.
3. **Orphan foreign keys**: Bắt buộc = 0.
4. **Business-key collisions**: Bắt buộc = 0 (`orders.code`, `wallets.discord_user_id`, `sepay_transactions.sepay_id`, `card_topups.request_id`, `plugins.slug`, `versions (plugin_id, version)`, `spigot_account_refs.account_id`).
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

- **T-0 (00:00)**: **Freeze writes**. Bật cờ bảo trì trên Bot Discord (`MAINTENANCE_MODE=true`).
- **T+1 (00:01)**: **Online SQLite Backup**. Dùng `.backup()` API xuất snapshot ra tệp `data/backups/vault_cutover.db`.
- **T+2 (00:03)**: **Migrate Business Data**. Chạy script `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts` (Atomic Checkpoints, Natural Key Mapping).
- **T+3 (00:06)**: **Reconciliation & Validation**. Chạy bộ script đối soát: đếm dòng, kiểm tra business keys, xác thực `reconcileBalances == 0`, reset Postgres Sequences.
- **T+4 (00:08)**: **Switch Runtime**. Khởi động Bot Discord kết nối trực tiếp vào Neon Drizzle Client cho Business Data và Local Secret Vault cho Crawler Accounts.
- **T+5 (00:09)**: **Smoke Test**. Kiểm tra lệnh `/vi`, `/menu`, Dashboard API `/api/orders`.
- **T+6 (00:10)**: **Enable Writes**. Tắt cờ bảo trì. Mở lại tiếp nhận thanh toán bình thường.
- **T+7 (00:11 - 00:40)**: **Monitor**. Giám sát log thời gian thực trong 30 phút.

---

## 13. Rollback Plan

- **Tuyệt đối không rollback bằng cách ghi đè Neon bằng bản backup SQLite cũ**.
- Áp dụng **Application Rollback** (vẫn trỏ cùng Neon DB) hoặc **Neon PITR** (Point-In-Time Recovery).

---

## 14. Final Acceptance Tests (Bản Toàn Diện v7)

### A. SePay Wallet Topup Concurrency Test
Hai webhook SePay gửi đồng thời cho cùng một mã `wallet_topups.code`:
```text
Expected:
- Đúng 1 giao dịch credit tiền ví thành công
- Đúng 1 dòng wallet_ledger được ghi
- Topup chỉ chuyển từ 'pending' -> 'credited' đúng một lần
- Webhook thứ hai cập nhật sepay status = 'duplicate_transfer', không credit đúp ví
```

### B. Order Bank Payment Concurrency Test
Hai webhook / request xử lý đồng thời cho cùng một đơn hàng `orders.code`:
```text
Expected:
- Không double payment (không trừ ví/không cộng đơn 2 lần)
- Không double wallet_ledger
- Đúng 1 delivery_job duy nhất được tạo (nhờ unique index order_id, requested_method)
- Trạng thái đơn hàng nhất quán tuyệt đối (status = 'paid', bank_due = 0)
```

### C. Migration Crash / Resume Test
Mô phỏng ngắt tiến trình (kill -9) tại nhiều checkpoint khác nhau (ví dụ: 25%, 50%, 75%):
```text
Expected:
- Khởi động lại script migration an toàn 100%
- Checkpoint khớp chính xác với business data đã commit
- Không sinh duplicate rows
- Không thất thoát dữ liệu
- Khóa ngoại và sequence đồng bộ nguyên vẹn
```

### D. Download Token Concurrent Access Test
Hai request đồng thời gửi cùng một `token_hash`:
```text
Expected:
- Tối đa đúng 1 request claim thành công và nhận stream tệp (HTTP 200)
- Request còn lại bị từ chối ngay lập tức (HTTP 410 Gone / 403 Forbidden)
- Nếu tệp trên đĩa bị thiếu trước khi stream: Token được bồi hoàn unclaim (used_at = NULL) và trả HTTP 503
```

### E. Delivery Stale Recovery Test
Worker claim job (`status = 'processing'`), sau đó tiến trình crash đột ngột:
```text
Expected:
- Sau khi hết hạn lease (locked_at < now() - 5 phút), job được coi là stale
- Worker khác tự động reclaim an toàn bằng claim_token mới
- Không tạo duplicate delivery intent
- Thực hiện giao hàng thành công và ghi delivery_logs ('requested' = attachment, 'actual' = fallback_link)
```

---

## 15. Files To Modify

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 6 bảng Business: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`, `delivery_jobs`, `migration_checkpoints`.
   - Thêm **Partial Unique Index** trên `wallet_ledger`: `uniqueIndex('idx_wallet_ledger_ref_kind_unique').on(table.refType, table.refId, table.kind).where(sql\`ref_type != '' AND ref_id IS NOT NULL\`)`.
   - Thêm **Unique Index `(pluginId, version)`** trên bảng `versions`.
   - Bổ sung trường `description`, `status`, `orderId`, `topupId`, `processedAt` vào bảng `sepay_transactions`.
   - Bổ sung **Unique Index `(orderId, requestedMethod)`** trên bảng `delivery_jobs`.
   - Bổ sung `requestedMethod` và `actualMethod` vào bảng `delivery_logs`.
   - Thêm trường `failureReason` vào bảng `download_tokens`.
   - Chuẩn hóa bảng `spigotAccounts` thành `spigotAccountRefs` với khóa chính `accountId: uuid().primaryKey()`.
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Xóa bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` nghiệp vụ sang `neonDb`.
   - Tách riêng kết nối `vaultSecretsDb` (SQLite nội bộ) cho Spigot accounts.
   - Kiểm tra `VAULT_MASTER_KEY` fail-fast khi khởi động.
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Viết lại `applyLedgerEntry` sử dụng `db.transaction()` và tuân thủ Canonical Lock Order.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Áp dụng Pre-Read không lock để lấy `discordUserId` trước khi xin khóa theo Canonical Lock Order.
   - Tích hợp đầy đủ transaction Order Bank Payment cho cả 3 trường hợp (Exact, Underpay, Overpay).
   - Tách toàn bộ External Side Effects ra ngoài DB transaction.
6. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Tích hợp Lease Timeout & Worker Stale Recovery Policy với `claimToken`.
   - Phân biệt rõ `requestedMethod` và `actualMethod` khi ghi log.
7. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Triển khai Authorization và Failure Policy: Validate -> Atomic Claim -> Verify File -> Stream, kèm bồi hoàn unclaim token nếu tệp bị thiếu.

---

## 16. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon (hỗ trợ `expired -> credited`).
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file với atomic claim và compensation logic.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file kèm `requestedMethod` và `actualMethod`.
5. `discord/src/repositories/neon-delivery-jobs.ts`: Hàng đợi giao hàng bền vững với Lease Timeout, Claim Token và Stale Recovery Worker.
6. `discord/src/repositories/neon-spigot-refs.ts`: Quản lý tham chiếu trạng thái Spigot qua UUID bất biến.
7. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu nghiệp vụ hỗ trợ Atomic Checkpoint Batches, UUID Account Bridge, Opening Balance logic, và Secret Hygiene.
8. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động toàn diện kiểm tra tính nguyên tử, idempotency, atomic consumption, duplicate jobs, lease recovery, lock order không deadlock và concurrency trên Neon.

---

## 17. Acceptance Criteria

1. [ ] **Dual-Vault Boundary Enforced**: Tuyệt đối không có mật khẩu, cookie, hay session nào của Spigot được lưu trữ hoặc chuyển lên Neon. Toàn bộ credential upstream được cô lập tại Local Secret Vault.
2. [ ] **Pre-Read & Canonical Lock Order Enforced**: SePay webhook thực hiện Pre-Read không lock để tìm user trước khi xin khóa theo thứ tự: `1. discount_codes -> 2. wallets -> 3. orders -> 4. wallet_topups -> 5. delivery_jobs`. Không xảy ra Lock Inversion hay Deadlock.
3. [ ] **Order Bank Payment Fully Specified**: Cả 3 trường hợp Exact, Underpay, Overpay hoạt động nguyên tử trong 1 transaction, side effects chạy sau commit.
4. [ ] **Migration Checkpoint Atomicity Verified**: Dữ liệu nghiệp vụ và checkpoint của cùng một batch commit atomically trong 1 transaction; restart/crash nhiều lần an toàn 100%.
5. [ ] **Version Business Identity Defined**: Natural key của versions là `(plugin_id, version)` có unique index; SHA256 chỉ dùng để audit và kiểm tra toàn vẹn file.
6. [ ] **Download Token Failure Policy Applied**: Endpoint kiểm tra tuần tự; nếu tệp bị thiếu trước khi stream, tự động bồi hoàn unclaim token (`used_at = NULL`) và trả HTTP 503.
7. [ ] **Delivery Job Lease & Recovery Active**: Job có `claimToken`, timeout lease 5 phút; worker crash tự động được worker khác reclaim an toàn, không sinh duplicate intent.
8. [ ] **Spigot Account UUID Bridge Enforced**: Liên kết qua `accountId` UUID bất biến; đổi `label` không làm mất liên kết; mật khẩu và cookie không bao giờ xuất hiện trên Neon.
9. [ ] **Master Encryption Key Isolated**: Master key không nằm trong database, nạp từ `VAULT_MASTER_KEY` môi trường, kiểm tra fail-fast khi khởi động.
10. [ ] **No Production SQLite Business Writes**: Không còn câu lệnh ghi dữ liệu nghiệp vụ (orders, wallets, ledger, payments) nào vào SQLite tại runtime production.
11. [ ] **Single Source of Truth Verified**: Discord Bot và Web Dashboard cùng đọc/ghi một hàng dữ liệu đơn hàng và số dư ví trên Neon theo thời gian thực.
12. [ ] **Partial Unique Index Applied**: Sử dụng Partial Unique Index trên `wallet_ledger`, ngăn nạp đúp tiền ở mức database mà không vi phạm cú pháp PostgreSQL.
13. [ ] **Payment Traceability Established**: Mọi bản ghi `sepay_transactions` lưu vết rõ ràng `order_id`, `topup_id`, `status` tường minh và `processed_at`.
14. [ ] **Expired Topup Handled**: Topup hết hạn chuyển trạng thái hợp lệ sang `credited` khi tiền về muộn, không làm thất thoát tiền của khách.
15. [ ] **Delivery Outcome Formally Distinguished**: `requestedMethod` và `actualMethod` được phân biệt rõ; crash recovery ghi đúng `actualMethod = 'fallback_link'`.
16. [ ] **Wallet Opening Balance Reconciled**: Tự động nhận diện tính toàn vẹn của ledger; chỉ bù 1 dòng `opening_balance` khi thật sự thiếu; invariant số dư = tổng delta đạt 100%.
17. [ ] **Secret Migration Hygiene**: Artifacts cũ (db, wal, dumps) được bảo vệ, cấm commit Git, cấm log mật khẩu.
18. [ ] **Existing UX Unchanged**: Trải nghiệm nút bấm, modal, menu trên Bot Discord và Web Dashboard giữ nguyên 100%.
19. [ ] **Existing Tests Pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.

---

## 18. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Deadlock do Lock Inversion** | **Cao** | Khóa ví trước khi biết user hoặc xin khóa các bảng ngược chiều. | **Pre-Read & Canonical Lock Order**: Pre-read không lock để lấy `discordUserId`, sau đó xin khóa theo đúng thứ tự 1 -> 5. |
| **Mất Token khi Tệp hỏng/mất** | **Cao** | Token bị claim (`used_at = now()`) nhưng server không tìm thấy file jar. | **Compensation Unclaim**: Tự động bồi hoàn `used_at = NULL`, trả HTTP 503 và alert Staff. |
| **Treo Delivery Job khi Worker Crash** | **Cao** | Worker nhận job đang gửi thì bị crash, job vĩnh viễn ở trạng thái `processing`. | **Lease & Stale Recovery**: Quá hạn 5 phút tự động cho phép worker khác reclaim bằng `claim_token` mới. |
| **Lệch trạng thái Checkpoint Migration** | **Cao** | Dữ liệu commit nhưng checkpoint lỗi (hoặc ngược lại). | **Batch Atomicity**: Gom mutation business data và checkpoint của batch vào cùng 1 transaction. |
| **Đứt gãy liên kết Account khi đổi tên** | **Cao** | Dùng `label` làm khóa tự nhiên liên kết giữa Local và Neon. | **UUID Identity Bridge**: Cố định `account_id` dạng UUID v4 vĩnh viễn. |
| **Rò rỉ Spigot Credentials / Master Key** | **Nghiêm trọng** | Lưu trữ master key hoặc đồng bộ secret accounts lên Cloud DB. | **Dual-Vault Boundary**: Master key lưu ngoài DB; credentials lưu tại local SQLite `data/vault_secrets.db` mã hóa AES-256-GCM. |
| **Mất giao dịch khi Rollback sai cách** | **Nghiêm trọng** | Khôi phục database bằng cách ghi đè backup SQLite cũ sau cutover. | **Cấm Rollback ghi đè DB**: Chỉ Rollback Application code; nếu lỗi DB thì dùng Neon PITR. |

---

READY FOR IMPLEMENTATION
