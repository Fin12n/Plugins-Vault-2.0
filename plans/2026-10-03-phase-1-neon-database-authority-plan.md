# PHASE 1 FINAL IMPLEMENTATION PLAN v3 — DUAL-VAULT & BUSINESS AUTHORITY

> **Tôn chỉ kiến trúc tối thượng (Core Architectural Principle)**:
> ```text
> ┌────────────────────────────────────────────────────────┐
> │ LOCAL DATABASE  = SECRET / PRIVATE ACCOUNT VAULT       │
> │ NEON POSTGRESQL = BUSINESS SINGLE SOURCE OF TRUTH      │
> └────────────────────────────────────────────────────────┘
> ```
> - **Tuyệt đối không lưu trữ thông tin nhạy cảm** (Mật khẩu, Cookie, Session, Token định danh cá nhân upstream, Browser Profile) trên Neon Cloud PostgreSQL.
> - **Toàn bộ dữ liệu nghiệp vụ** (Đơn hàng, Tiền tệ, Ví, Sổ cái, Thẻ cào, Webhook, Link tải, Bàn giao, Danh mục) chuyển 100% về **Neon PostgreSQL**.
> - Không rewrite bot, không đổi UI/UX, không thêm feature mới và không can thiệp CloakBrowser.

---

## 1. Current Architecture

### 1.1. Hiện trạng phân mảnh dữ liệu (Split-Brain)
1. **Discord Bot Runtime**:
   - Sử dụng thư viện `better-sqlite3` kết nối đồng bộ tới tệp SQLite cục bộ (`data/deps.db` hoặc `data/vault.db`) ([connection.ts:L23-L49](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/connection.ts#L23-L49)).
   - Toàn bộ giao dịch tiền bạc cốt lõi bao gồm: tạo đơn hàng ([orders.ts:L29-L61](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/orders.ts#L29-L61)), trừ số dư ví ([wallets.ts:L55-L96](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L55-L96)), ghi sổ cái ([wallets.ts:L78-L90](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L78-L90)), xử lý webhook ngân hàng SePay ([match-and-fulfil-order.ts:L156-L237](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts#L156-L237)), nạp thẻ cào Card2k ([submit-card-topup.ts:L70-L130](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts#L70-L130)), cấp link tải một lần ([mint-download-token.ts:L17-L30](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts#L17-L30)), và nhật ký giao file ([deliver-version.ts:L135-L163](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts#L135-L163)) đều được ghi độc quyền vào SQLite.
2. **Dashboard Backend Runtime**:
   - Khởi tạo kết nối trực tiếp tới Neon PostgreSQL thông qua gói `@vault/db` ([neon.ts:L8](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/db/neon.ts#L8)).
   - Các API truy vấn danh sách đơn hàng ([orders-routes.ts:L36-L50](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/orders-routes.ts#L36-L50)), số dư ví ([wallets-routes.ts:L21-L40](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/wallets-routes.ts#L21-L40)) hoàn toàn đọc từ Neon PostgreSQL.
3. **Lỗ hổng kiến trúc cũ**:
   - Bảng `spigotAccounts` trong Neon schema hiện tại đang chứa `passwordEncrypted`, `xfUserEncrypted`, `xfSessionEncrypted` ([schema.ts:L203-L222](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts#L203-L222)). Đây là rủi ro rò rỉ credential tài khoản upstream lên cloud database công cộng.
   - Bảng `account_scan_state` chứa tiến trình crawler cục bộ không nên đẩy lên cloud database nghiệp vụ.

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
│   - rate-limit state   │  • download_tokens        • upstream_state
│   - crawl errors       │  • resource_ownership    • pending_download
│ • vault/ storage blobs │  • discord_channels       • audit_logs (Staff)
│   - JAR files on disk  │  • spigot_account_refs (id, label, health, status)
└────────────────────────┘  ══════════════════════════════════════════════
```

---

## 3. Data Classification Matrix

| Phân Loại Dữ Liệu | Danh Sách Bảng / Dữ Liệu | Nơi Lưu Trữ Duy Nhất | Chính Sách Quản Trị & Truy Xuất |
| :--- | :--- | :---: | :--- |
| **SECRET / PRIVATE ACCOUNT VAULT** | `spigot_accounts` (credentials), `account_scan_state`, Browser Profiles, Encryption Keys | **Local SQLite** (`data/vault_secrets.db`) | **GIỮ CỤC BỘ**. Không export, không dump, không migrate lên Neon. Quyền truy cập tệp `0o700`. |
| **BUSINESS DATA (Authority)** | `orders`, `wallets`, `wallet_ledger`, `wallet_topups`, `sepay_transactions`, `card_topups`, `plugins`, `versions`, `manual_uploads`, `delivery_logs`, `download_tokens`, `discount_codes`, `discount_code_redemptions`, `resource_ownership`, `upstream_state`, `pending_download`, `pending_ingest`, `discord_channels`, `staffs`, `audit_logs`, `config` | **Neon PostgreSQL** | **CHUYỂN SANG NEON**. Neon là Single Source of Truth. Discord Bot và Dashboard cùng đọc/ghi. |
| **PUBLIC ACCOUNT REFERENCE** | `spigot_account_refs` (`id`, `label`, `status`, `health`, `last_check_at`) | **Neon PostgreSQL** | **CHUYỂN THAM CHIẾU SANG NEON**. Không chứa bất kỳ trường mật khẩu hay cookie nào. |
| **CACHE & ASSETS** | File `.jar` nhị phân (`vault/`), File tạm (`tmp/`), Discord In-Memory Session | **Local Filesystem / Memory** | **GIỮ CỤC BỘ**. Nội dung content-addressed theo SHA-256; database chỉ lưu metadata và đường dẫn tương đối. |

---

## 4. Schema Parity & Uniqueness Invariants

Bảng đối chiếu toàn bộ các bảng dữ liệu sau khi áp dụng ranh giới phân tách:

| Tên Bảng Nguồn (SQLite) | Bảng Đích Tại Neon | Phân Loại | Trạng Thái Schema | Hành Động Kỹ Thuật |
| :--- | :--- | :---: | :---: | :--- |
| `orders` | `orders` | Business | Đã có | Chuyển timestamps sang UTC timestamp with timezone. |
| `wallets` | `wallets` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `wallet_ledger` | `wallet_ledger` | Business | Đã có | **Bổ sung DB Uniqueness constraint: `UNIQUE (ref_type, ref_id, kind) WHERE ref_type != '' AND ref_id IS NOT NULL`** để chống nạp đúp tiền ở mức cơ sở dữ liệu. |
| `wallet_topups` | **`wallet_topups`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý nạp tiền chuyển khoản). |
| `sepay_transactions` | `sepay_transactions` | Business | Đã có | Bổ sung cột `description: text`. |
| `card_topups` | `card_topups` | Business | Đã có | Giữ nguyên vẹn 100%. |
| `plugins` | `plugins` | Business | Đã có | Gộp `plugin_aliases` thành mảng string `aliases`. |
| `plugin_aliases` | *(Trong `plugins.aliases`)* | Business | Đã gom | Migrate dữ liệu vào mảng text trên Neon. |
| `versions` | `versions` | Business | Đã có | Giữ nguyên, thêm `changeLogs`, `source`. |
| `manual_uploads` | `manual_uploads` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_codes` | `discount_codes` | Business | Đã có | Giữ nguyên vẹn. |
| `discount_code_redemptions` | **`discount_code_redemptions`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (chống gian lận mã giảm giá). |
| `download_tokens` | **`download_tokens`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (quản lý link tải web an toàn). |
| `audit_log` (Bot) | **`delivery_logs`** | Business | ❌ **Cần thêm** | **Tạo mới trên Neon** (tách biệt hoàn toàn với `audit_logs`). |
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

### 5.3. Bảng `download_tokens` (Business Data)
- **Purpose**: Lưu mã băm SHA-256 xác thực link tải một lần qua Web endpoint `/download/:token`.
- **Columns**: `tokenHash` (varchar 64 primary key - sha256 hex digest), `versionId` (integer not null references `versions.id` on delete cascade), `discordUserId` (varchar 32 not null), `orderId` (integer references `orders.id` on delete set null), `expiresAt` (timestamp with tz not null), `usedAt` (timestamp with tz nullable), `createdAt` (timestamp with tz default now()).
- **Indexes**: `index("idx_download_tokens_expires").on(table.expiresAt)`, `index("idx_download_tokens_order").on(table.orderId)`.

### 5.4. Bảng `delivery_logs` (Business Data - Tách riêng khỏi `audit_logs`)
- **Purpose**: Nhật ký giao nhận file plugin jar của Bot Discord cho khách hàng (Customer Delivery History).
  * `audit_logs`: Chỉ dành riêng cho Staff/Admin RBAC actions trên Dashboard.
  * `delivery_logs`: Chỉ ghi nhận sự kiện phát hành file jar cho khách hàng. Không ghi trùng lặp.
- **Columns**: `id` (serial PK), `discordUserId` (varchar 32 not null), `versionId` (integer references `versions.id` on delete set null), `orderId` (integer references `orders.id` on delete set null), `pluginName` (varchar 255 not null), `versionLabel` (varchar 64 default ''), `amount` (integer default 0), `deliveryMethod` (varchar 32: 'attachment' | 'link' | 'manual'), `ip` (varchar 45 nullable), `deliveredAt` (timestamp with tz default now()).
- **Indexes**: `index("idx_delivery_logs_user").on(table.discordUserId)`, `index("idx_delivery_logs_delivered_at").on(table.deliveredAt)`.

### 5.5. Bảng `spigot_account_refs` (Public Reference trên Neon - Không chứa Secret)
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
| `deliver-version.ts` | SQLite | `neon-delivery-logs.ts` | **Neon** | Ghi nhận nhật ký bàn giao file trên Neon. |
| `spigot-accounts.ts` | SQLite | **`spigot-accounts.ts` (Local Vault)** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không chuyển secret sang Neon. |
| *(Đồng bộ Status)* | SQLite | **`neon-spigot-refs.ts`** | **Neon** | Chỉ publish `id`, `label`, `status`, `health` sang Neon. |
| `account-scan-state.ts`| SQLite | **`account-scan-state.ts`** | **Local SQLite** | **GIỮ TẠI LOCAL VAULT**. Không đẩy crawler state lên Neon. |

---

## 7. Transaction Boundaries & Concurrency

### 7.1. Nguyên tắc cô lập Side Effects
**TUYỆT ĐỐI KHÔNG GIỮ TRANSACTION MỞ** trong khi:
- Gọi Discord API (gửi DM, gửi embed, thêm role).
- Gửi HTTP request (Card2k, Spigot, SePay webhook response).
- Thao tác CloakBrowser / Puppeteer / YesCaptcha.
- Đọc/Ghi file Jar trên ổ cứng `vault/`.

Mọi side effect chỉ được thực thi **SAU KHI TRANSACTION COMMIT THÀNH CÔNG**.

---

### 7.2. Đặc tả chi tiết các luồng giao dịch chuẩn hóa

#### 1. Webhook SePay Topup Idempotency & DB Uniqueness
```sql
BEGIN TRANSACTION;
  -- 1. Dedupe webhook SePay
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, raw_payload, received_at)
  VALUES ($1, ...) ON CONFLICT (sepay_id) DO NOTHING RETURNING id;

  -- NẾU không có id trả về -> Webhook trùng -> COMMIT/ROLLBACK rỗng và RETURN { handled: 'duplicate' }

  -- 2. Tìm topup và khóa hàng
  SELECT * FROM wallet_topups WHERE code = $code FOR UPDATE;

  -- 3. Atomic status flip: Chỉ thành công khi status đang là 'pending'
  UPDATE wallet_topups
  SET status = 'credited',
      paid_amount = $amount,
      credited_at = now()
  WHERE id = $topupId
    AND status = 'pending'
  RETURNING id;

  -- 4. BẮT BUỘC: Chỉ khi RETURNING trả về ĐÚNG 1 ROW mới thực thi cộng tiền ví:
  --    Nếu trả về 0 row (đã bị credit bởi webhook khác hoặc đã expired):
  --    -> TUYỆT ĐỐI KHÔNG CỘNG TIỀN VÀ KHÔNG GHI SỔ CÁI!
  --    -> COMMIT và RETURN { handled: 'ignored', why: 'not-pending' }

  -- 5. Lock ví và cộng tiền
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
  VALUES ($userId, $amount, now(), now())
  ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

  -- 6. Ghi ledger (Được bảo vệ thêm bởi UNIQUE constraint: ref_type, ref_id, kind)
  INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
  VALUES ($userId, $amount, new_balance, 'bank_topup', 'topup', $topupId, 'nạp ví SePay', now());

COMMIT;

[EXTERNAL SIDE EFFECTS SAU COMMIT]
  - Trả HTTP 200 OK cho SePay; gửi tin nhắn Discord DM thông báo số dư mới.
```

#### 2. Discount Concurrency & Row-Locking Serialization
```sql
-- Chuẩn hóa: Bỏ SELECT COUNT(*) FOR UPDATE (không hợp lệ trong Postgres SQL).
-- Thay bằng cơ chế Row-Locking trên parent row `discount_codes` để serialize mọi lượt redeem của cùng mã.
BEGIN TRANSACTION;
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

  -- 3. Kiểm tra điều kiện hợp lệ:
  --    - isActive == true
  --    - expiresAt > now()
  --    - count < per_user_limit (nếu có cấu hình)
  --    - orderAmount >= minOrder
  --    NẾU không thỏa mãn -> ABORT("Mã không hợp lệ hoặc vượt hạn mức cá nhân");

  -- 4. Tăng used_count có kiểm tra trần max_uses
  UPDATE discount_codes
  SET used_count = used_count + 1
  WHERE id = $discountId
    AND (max_uses IS NULL OR used_count < max_uses)
  RETURNING id;
  -- NẾU không có row nào trả về -> ABORT("Mã giảm giá vừa hết lượt sử dụng");

  -- 5. Ghi nhận redemption
  INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
  VALUES ($discountId, $userId, $orderId, $discountAmount, now());
COMMIT;
```

#### 3. Purchase + Discount = ONE TRANSACTION BOUNDARY
Discount application bắt buộc phải nằm trong cùng một transaction với purchase:
```text
BEGIN TRANSACTION
  1. Lock discount:
     SELECT * FROM discount_codes WHERE id = $discountId FOR UPDATE;
  2. Validate discount (per_user_limit, max_uses, min_order, expires_at);
  3. Tính finalPrice = max(0, orderAmount - discountAmount);

  4. Lock wallet:
     SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
  5. Validate balance & calculate:
     walletPaid = min(balance, finalPrice);
     bankDue = finalPrice - walletPaid;
     status = (bankDue == 0) ? 'wallet_paid' : 'pending';

  6. Tạo đơn hàng:
     INSERT INTO orders (code, discord_user_id, version_id, plugin_name, amount, wallet_paid, bank_due, status, ...)
     VALUES (...) RETURNING id, code;

  7. Trừ tiền ví (nếu walletPaid > 0):
     UPDATE wallets SET balance = balance - walletPaid, updated_at = now() WHERE discord_user_id = $userId;
     INSERT INTO wallet_ledger (discord_user_id, delta: -walletPaid, kind: 'order_hold', ref_type: 'order', ref_id: order.id, ...);

  8. Ghi nhận mã giảm giá & Tăng lượt sử dụng:
     UPDATE discount_codes SET used_count = used_count + 1 WHERE id = $discountId AND (max_uses IS NULL OR used_count < max_uses) RETURNING id;
     INSERT INTO discount_code_redemptions (discount_id, discord_user_id, order_id, discount_amount, redeemed_at)
     VALUES ($discountId, $userId, order.id, discountAmount, now());
COMMIT

-- NẾU BẤT KỲ BƯỚC NÀO TRÊN THẤT BẠI:
-- Toàn bộ transaction rollback sạch sẽ 100%:
-- -> discount redemption rollback
-- -> discount usage rollback
-- -> wallet mutation rollback
-- -> order rollback

[EXTERNAL SIDE EFFECTS SAU COMMIT]
  - NẾU status == 'wallet_paid': Kích hoạt bất đồng bộ deliverVersion() gửi file jar qua DM.
  - NẾU status == 'pending': Trả VietQR URL thu phần tiền bankDue còn lại.
```

---

## 8. Migration Strategy

### 8.1. Quy trình sao lưu SQLite an toàn (Zero Corruption Backup)
1. Bật cờ bảo trì hệ thống `MAINTENANCE_MODE=true` trên Bot Discord để dừng toàn bộ tác vụ ghi.
2. Thực thi **SQLite Online Backup API** (`better-sqlite3: .backup()`):
   ```typescript
   const sourceDb = openDb(env.DB_PATH);
   await sourceDb.backup(`data/backups/vault_pre_cutover_${Date.now()}.db`);
   sourceDb.close();
   ```
3. **Backup Verification**:
   - `PRAGMA integrity_check;` -> Bắt buộc trả về `ok`.
   - `PRAGMA foreign_key_check;` -> Bắt buộc trả về `[]`.
4. **Restore Test**: Thử nghiệm mở tệp backup trên một in-memory SQLite độc lập trước khi tiến hành chuyển đổi.

### 8.2. Chiến lược phân tách dữ liệu & Xử lý xung đột (Conflict Policy)
Chỉ chuyển đổi dữ liệu Business; giữ lại Secret Vault:
- **`spigot_accounts`**: **KHÔNG MIGRATE CREDENTIALS**.
  * Dữ liệu nhạy cảm (username, passwords, cookies) chuyển sang tệp SQLite bảo mật `data/vault_secrets.db` (chỉ chạy local).
  * Chỉ trích xuất thông tin phi nhạy cảm (`id`, `label`, `status`, `health`, `last_verified_at`) nạp vào bảng `spigot_account_refs` trên Neon.
- **`account_scan_state`**: **KHÔNG MIGRATE**. Giữ nguyên vẹn tại `data/vault_secrets.db`.
- **`orders`**: **Conflict on `code` -> Fail Migration**. Trùng code khác user lập tức dừng để Admin can thiệp.
- **`wallets`**: **Conflict on `discord_user_id` -> Reconcile to Ledger Sum**. Số dư ví luôn bằng `SUM(wallet_ledger.delta)`.
- **`plugins` / `versions`**: Hợp nhất metadata mới nhất; giữ `deposit_price` của SQLite nếu có đơn hàng liên quan.
- **`staffs`**: Merge tài khoản; ưu tiên phân quyền RBAC đã thiết lập trên Neon Dashboard.

---

## 9. Reconciliation Strategy

Kiểm định toàn diện 8 chiều sau di chuyển dữ liệu:
1. **Missing rows**: Bắt buộc = 0.
2. **Duplicate rows**: Bắt buộc = 0.
3. **Orphan foreign keys**: Bắt buộc = 0.
4. **Business-key collisions**: Bắt buộc = 0 (`orders.code`, `wallets.discord_user_id`, `sepay_transactions.sepay_id`, `card_topups.request_id`, `plugins.slug`, `versions.sha256`).
5. **Unexpected truncation**: Bắt buộc = 0.
6. **Timestamp conversion**: Chuyển đổi chính xác Unix seconds sang UTC Timestamp.
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

## 10. Cutover Plan (Timeline T-0 đến T+7)

- **T-0 (00:00)**: **Freeze writes**. Bật cờ bảo trì trên Bot Discord (`MAINTENANCE_MODE=true`). Từ chối nhận đơn mới, hoãn xử lý webhook SePay.
- **T+1 (00:01)**: **Online SQLite Backup**. Dùng `.backup()` API xuất snapshot ra tệp `data/backups/vault_cutover.db`. Chạy kiểm tra `PRAGMA integrity_check`.
- **T+2 (00:03)**: **Migrate Business Data**. Chạy script `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts` (chỉ chuyển Business Data và Public Account Refs, tuyệt đối không chuyển mật khẩu hay cookie).
- **T+3 (00:06)**: **Reconciliation & Validation**. Chạy bộ script đối soát: đếm dòng, kiểm tra business keys, xác thực `reconcileBalances == 0`, reset Postgres Sequences (`setval`).
- **T+4 (00:08)**: **Switch Runtime**. Khởi động Bot Discord kết nối trực tiếp vào Neon Drizzle Client cho Business Data và Local Secret Vault cho Crawler Accounts. Ngắt kết nối SQLite nghiệp vụ hoàn toàn.
- **T+5 (00:09)**: **Smoke Test**. Kiểm tra lệnh `/vi`, `/menu`, Dashboard API `/api/orders` xác nhận nhìn thấy đơn hàng tức thì.
- **T+6 (00:10)**: **Enable Writes**. Tắt cờ bảo trì. Mở lại tiếp nhận thanh toán và đơn hàng bình thường.
- **T+7 (00:11 - 00:40)**: **Monitor**. Giám sát log thời gian thực trong 30 phút.

---

## 11. Rollback Plan

### Nguyên tắc Rollback an toàn (Tránh mất mát giao dịch mới):
- **Tuyệt đối không rollback bằng cách ghi đè Neon bằng bản backup SQLite cũ**: Việc này sẽ xóa sạch toàn bộ các đơn hàng và tiền nạp mới phát sinh trên Neon sau thời điểm cutover!
- **Cơ chế Rollback đúng**:
  1. **Application Rollback (Nếu lỗi Code/Logic Bot)**: Deploy lại bản build bot trước đó nhưng **VẪN TRỎ VÀO CÙNG NEON DATABASE**. Dữ liệu nghiệp vụ trên Neon được bảo toàn 100%.
  2. **Database Recovery (Nếu lỗi Schema/Migration Postgres)**: Khôi phục bằng tính năng **Neon Point-In-Time Recovery (PITR)** hoặc phục hồi từ bản snapshot của chính Neon.
  3. **Bản backup SQLite**: Chỉ sử dụng làm tài liệu đối soát lịch sử (Forensics / Cold Archive) hoặc trường hợp khẩn cấp tái thiết lập lại toàn bộ hệ thống từ con số 0.

---

## 12. Test Plan (Bao gồm Acceptance Tests Mở Rộng)

1. **Duplicate Topup Test (Acceptance)**:
   - Giả lập 2 webhook SePay có `sepay_id` khác nhau nhưng mang cùng `wallet_topups.code` gửi tới máy chủ cùng lúc.
   - **Kỳ vọng**: Đúng 1 giao dịch credit tiền ví thành công; đúng 1 dòng ledger được tạo; `wallet_topups.status = 'credited'`. Giao dịch thứ hai bị chặn bởi atomic status update và DB uniqueness constraint, trả về `ignored/not-pending`.
2. **Concurrent First Redemption Test (Acceptance)**:
   - 2 purchase đồng thời của cùng một user với cùng một discount code có cấu hình `per_user_limit = 1`.
   - **Kỳ vọng**: Nhờ row-lock `SELECT ... FOR UPDATE` trên `discount_codes`, hai giao dịch được serialize tuần tự; đúng 1 purchase được áp dụng mã giảm giá; purchase thứ hai nhận thông báo mã đã đạt giới hạn cá nhân và tính nguyên giá.
3. **Purchase Failure After Discount Validation Test (Acceptance)**:
   - Mô phỏng lỗi database (ví dụ network glitch hoặc syntax error) xảy ra ngay sau bước validate discount thành công trong transaction purchase.
   - **Kỳ vọng**: Toàn bộ transaction rollback sạch sẽ: không có discount redemption nào được ghi, `used_count` của discount không tăng, ví không bị trừ tiền, và đơn hàng không tồn tại.
4. **Concurrent Purchase**: 10 request đồng thời mở đơn hàng từ cùng một user có số dư chỉ đủ mua 1 sản phẩm -> Đúng 1 đơn hàng trừ ví thành công; 9 đơn còn lại chuyển sang chờ chuyển khoản 100%. Không bao giờ âm ví.
5. **Concurrent Topup**: 2 webhook ngân hàng gửi tiền vào cùng 1 ví tại cùng 1 thời điểm -> Cả 2 giao dịch đều ghi nhận đủ, số dư ví bằng tổng của cả 2 lần nạp, không bị Lost Update.
6. **Duplicate Webhook**: Bắn 5 request trùng `sepay_id` đồng thời tới máy chủ -> Đúng 1 request được xử lý; 4 request còn lại nhận diện duplicate an toàn mà không ghi đúp tiền.

---

## 13. Files To Modify

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 4 bảng Business: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`.
   - Thêm uniqueness constraint trên `wallet_ledger`: `UNIQUE (ref_type, ref_id, kind) WHERE ref_type != '' AND ref_id IS NOT NULL`.
   - Bổ sung trường `description: text` vào bảng `sepay_transactions`.
   - Chuẩn hóa bảng `spigotAccounts` thành `spigotAccountRefs` (loại bỏ toàn bộ các cột `passwordEncrypted`, `xfUserEncrypted`, `xfSessionEncrypted`).
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Xóa bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` nghiệp vụ sang `neonDb`.
   - Tách riêng kết nối `vaultSecretsDb` (SQLite nội bộ) chỉ dùng cho Spigot crawler và browser launcher.
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Viết lại `applyLedgerEntry` sử dụng `db.transaction()` và `SELECT ... FOR UPDATE`.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Gom dedupe và cập nhật trạng thái đơn/topup vào cùng 1 transaction boundary duy nhất. Cô lập hoàn toàn side effects ra ngoài transaction.
   - Tích hợp luồng Purchase + Discount vào cùng 1 transaction boundary duy nhất.
6. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Chuyển `recordDelivery` ghi nhận vào bảng `delivery_logs` trên Neon.
7. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Chuyển sang sử dụng bảng `download_tokens` trên Neon.

---

## 14. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon.
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file bảo mật trên Neon.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file của Bot trên Neon.
5. `discord/src/repositories/neon-spigot-refs.ts`: Quản lý tham chiếu trạng thái Spigot không chứa mật khẩu trên Neon.
6. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu nghiệp vụ có kiểm soát ranh giới bảo mật và đối soát checksum.
7. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động kiểm tra tính nguyên tử, idempotency và concurrency trên Neon.

---

## 15. Acceptance Criteria

1. [ ] **Dual-Vault Boundary Enforced**: Tuyệt đối không có mật khẩu, cookie, hay session nào của Spigot được lưu trữ hoặc chuyển lên Neon. Toàn bộ credential upstream được cô lập tại Local Secret Vault.
2. [ ] **No Production SQLite Business Writes**: Không còn câu lệnh ghi dữ liệu nghiệp vụ (orders, wallets, ledger, payments) nào vào SQLite tại runtime production.
3. [ ] **Single Source of Truth Verified**: Discord Bot và Web Dashboard cùng đọc/ghi một hàng dữ liệu đơn hàng và số dư ví trên Neon theo thời gian thực.
4. [ ] **Payment Transitions are Atomic**: Webhook SePay xử lý dedupe, đơn hàng, nạp ví trong đúng 1 transaction boundary duy nhất.
5. [ ] **Side Effects Isolated**: Không có Discord API call, HTTP call hay File I/O nào được giữ bên trong transaction database.
6. [ ] **Wallet Ledger Invariant Passed**: `wallets.balance == sum(wallet_ledger.delta)` đạt 100% trên toàn bộ người dùng sau di chuyển.
7. [ ] **Duplicate Webhook Safe**: Webhook gửi lặp không bao giờ ghi đúp tiền hay làm sai trạng thái đơn.
8. [ ] **Duplicate Topup Handled Safely**: Hai webhook khác `sepay_id` cùng `topup.code` chỉ credit ví đúng 1 lần duy nhất nhờ status guard và DB uniqueness.
9. [ ] **Discount Concurrency Controlled**: Concurrent redemptions được serialize an toàn nhờ lock parent row `discount_codes`, tôn trọng `per_user_limit` và `max_uses`.
10. [ ] **Purchase + Discount Unified in 1 Transaction**: Nếu purchase lỗi giữa chừng, toàn bộ discount redemption, usage count, order và wallet mutation đều rollback sạch sẽ.
11. [ ] **Migration Reconciliation Passed**: Đạt missing = 0, duplicate = 0, orphan FK = 0 trên toàn bộ các khóa nghiệp vụ.
12. [ ] **Zero Data Loss**: Toàn bộ lịch sử nạp tiền, đơn hàng và số dư của khách hàng được bảo tồn nguyên vẹn.
13. [ ] **Existing UX Unchanged**: Trải nghiệm nút bấm, modal, menu trên Bot Discord và Web Dashboard giữ nguyên 100%.
14. [ ] **Existing Tests Pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.
15. [ ] **New Integration Tests Pass**: Test suite kiểm tra tính nguyên tử và cạnh tranh trên Neon đạt 100%.

---

## 16. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Rò rỉ Spigot Credentials lên Cloud** | **Nghiêm trọng** | Đồng bộ toàn bộ bảng SQLite lên Neon không kiểm soát ranh giới. | **Dual-Vault Boundary**: Giữ credentials tại Local SQLite; Neon chỉ lưu `spigot_account_refs` phi nhạy cảm. |
| **Topup nạp đúp tiền ví** | **Nghiêm trọng** | Hai webhook khác `sepay_id` đến cùng lúc cho cùng 1 mã nạp. | Atomic status update `WHERE status = 'pending' RETURNING id` kết hợp `UNIQUE (ref_type, ref_id, kind)` trên `wallet_ledger`. |
| **Lệch hạn mức mã giảm giá** | **Cao** | Hai purchase đồng thời cùng tranh chấp lượt mã cuối cùng. | Khóa hàng cha `SELECT * FROM discount_codes WHERE id = $id FOR UPDATE` để serialize và gom vào 1 transaction duy nhất với purchase. |
| **Mất giao dịch khi Rollback sai cách** | **Nghiêm trọng** | Khôi phục database bằng cách ghi đè backup SQLite cũ sau cutover. | **Cấm Rollback ghi đè DB**: Chỉ Rollback Application code; nếu lỗi DB thì dùng Neon PITR. |

---

```text
READY FOR IMPLEMENTATION
```
