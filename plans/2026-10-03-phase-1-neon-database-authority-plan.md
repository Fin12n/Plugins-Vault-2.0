# PHASE 1 FINAL IMPLEMENTATION PLAN v10 — FINAL IMPLEMENTATION GATE

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
│   - account_id (UUID)  │  • plugins / versions       (Partial Unique Index)
│   - label              │    (Natural Key:          • wallet_topups
│   - enc_password       │     plugin_id + version)  • card_topups
│   - enc_cookies (xf)   │  • manual_uploads         • discount_codes
│   - session / profile  │  • orders                 • discount_redemptions
│ • account_scan_state   │  • sepay_transactions     • delivery_logs
│   - rate-limit state   │    (relational trace)     • delivery_jobs
│   - crawl errors       │  • wallets                  (lease & recovery)
│ • vault/ storage blobs │  • download_tokens        • upstream_state
│   - JAR files on disk  │    (atomic claim/unclaim) • pending_download
│ • Ciphertext only      │  • resource_ownership    • audit_logs (Staff)
│                        │  • discord_channels       • migration_checkpoints
│                        │  • spigot_account_refs       (atomic batch completed)
│                        │    (account_id UUID, label)
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

### 4.2. Wallet Ledger Unique & Business Reference Isolation — Postgres Correctness
PostgreSQL **KHÔNG HỖ TRỢ** cú pháp table constraint `UNIQUE (...) WHERE ...`. Bắt buộc phải triển khai bằng **PARTIAL UNIQUE INDEX**:

1. **Partial Unique Index chống duplicate credit theo Business Event**:
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

2. **Quy tắc cô lập Business Reference cho Financial Events (Ngăn ngừa xung đột Multiple Underpayments)**:
   - Nếu dùng `ref_type = 'order'` và `ref_id = orderId` cho giao dịch thanh toán thiếu (`kind = 'order_partial_credit'`), việc người dùng chuyển khoản thiếu nhiều lần cho cùng một đơn hàng sẽ kích hoạt **Unique Constraint Conflict** ở lần chuyển khoản thứ hai.
   - **Bắt buộc**: Mỗi sự kiện tài chính SePay chuyển khoản phải có business reference độc lập:
     - **Thanh toán thiếu đơn hàng (Underpayment credit)**:
       `ref_type = 'sepay_transaction'`
       `ref_id = sepay_transactions.id`
       `kind = 'order_partial_credit'`
     - **Thanh toán thừa đơn hàng (Overpayment credit)**:
       `ref_type = 'sepay_transaction'`
       `ref_id = sepay_transactions.id`
       `kind = 'order_overpay_credit'`
     - **Nạp ví SePay**:
       `ref_type = 'topup'`
       `ref_id = wallet_topups.id`
       `kind = 'topup_credit'`
     - **Nạp thẻ cào**:
       `ref_type = 'card_topup'`
       `ref_id = card_topups.id`
       `kind = 'card_credit'`
     - **Trừ ví mua hàng**:
       `ref_type = 'order'`
       `ref_id = orders.id`
       `kind = 'order_debit'`
     - **Hoàn tiền đơn hàng**:
       `ref_type = 'order'`
       `ref_id = orders.id`
       `kind = 'order_refund'`
     - **Điều chỉnh số dư bởi Quản trị viên**:
       `ref_type = 'audit_log'`
       `ref_id = audit_logs.id`
       `kind = 'admin_adjustment'`
   - **Chuỗi truy vết (Traceability Invariant)**:
     $$\text{sepay\_transaction.id} \longrightarrow \text{orders.id} \longrightarrow \text{wallet\_ledger.ref\_id}$$
     Mọi chuyển khoản đều truy vết ngược về đơn hàng gốc qua `sepay_transactions.order_id` và truy vết số dư ví qua `wallet_ledger.ref_id = sepay_transactions.id`. Tuyệt đối không mất mát thông tin giao dịch.

3. **Bảo đảm Opening Balance xuất hiện tối đa 1 lần duy nhất**:
   ```sql
   CREATE UNIQUE INDEX idx_wallet_ledger_opening_balance
   ON wallet_ledger (discord_user_id)
   WHERE kind = 'opening_balance';
   ```
   Trong Drizzle ORM:
   ```typescript
   uniqueIndex("idx_wallet_ledger_opening_balance")
     .on(table.discordUserId)
     .where(sql`kind = 'opening_balance'`);
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

### 5.1. Bảng `wallet_topups` (Dynamic Real-Amount Credit Policy & Lifecycle Reconciliation)
- **Purpose**: Quản lý vòng đời yêu cầu nạp tiền ví qua chuyển khoản VietQR/SePay.
- **Columns**: `id` (serial PK), `code` (varchar 32 unique), `discordUserId` (varchar 32 not null), `amount` (integer not null > 0 - số tiền yêu cầu lúc tạo phiếu), `paidAmount` (integer nullable - số tiền thực nhận qua ngân hàng), `status` (varchar 20 default 'pending'), `createdAt` (timestamp with tz), `expiresAt` (timestamp with tz), `creditedAt` (timestamp with tz nullable).
- **Constraints & Indexes**: `uniqueIndex("idx_wallet_topups_code").on(table.code)`, `index("idx_wallet_topups_status").on(table.status)`, `index("idx_wallet_topups_user").on(table.discordUserId, table.createdAt)`.
- **Thống nhất Lifecycle với Payment Matrix**:
  ```text
  pending ───(quá hạn expiresAt)───▶ expired
     │                                  │
     │                                  ▼ (chuyển khoản tới muộn)
     └──────────(thanh toán)──────────▶ credited (đối soát thành công)
  ```
- **Chính sách số tiền nạp ví (Dynamic Real-Amount Credit Policy)**:
  - Khi khách hàng nạp ví bằng VietQR/SePay với mã `wallet_topups.code`: Hệ thống **LUÔN CREDIT ĐÚNG SỐ TIỀN THỰC NHẬN (`receivedAmount`), KHÔNG PHỤ THUỘC SỐ TIỀN YÊU CẦU (`requestedAmount`)**.
  - Quy tắc hạch toán cốt lõi:
    ```text
    receivedAmount > 0
    ➔ wallets.balance += receivedAmount
    ➔ wallet_ledger.delta = receivedAmount (kind = 'topup_credit', ref_type = 'topup', ref_id = topup.id)
    ➔ wallet_topups.paidAmount = receivedAmount
    ➔ wallet_topups.status = 'credited'
    ➔ sepay_transactions.status = 'credited' (topup_id = topup.id, order_id = NULL)
    ```
  - Áp dụng hoàn toàn như nhau cho cả phiếu nạp ở trạng thái `pending` và `expired` (thanh toán tới muộn).
  - Ví dụ cụ thể (Phiếu nạp yêu cầu `amount = 100.000đ`):
    - Khách chuyển 50.000đ: Ví cộng đúng 50.000đ, `paidAmount = 50.000`, `status = credited`, `sepay_status = credited`.
    - Khách chuyển 100.000đ: Ví cộng đúng 100.000đ, `paidAmount = 100.000`, `status = credited`, `sepay_status = credited`.
    - Khách chuyển 150.000đ: Ví cộng đúng 150.000đ, `paidAmount = 150.000`, `status = credited`, `sepay_status = credited`.
    ➔ Khách nhận đúng từng đồng mình chuyển vào ví, tiền không bao giờ bị kẹt, không phát sinh underpaid/overpaid phức tạp trên nạp ví.

### 5.2. Bảng `sepay_transactions` (Canonical State Machine & Target Exclusivity Invariant)
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
- **Canonical State Machine (Không có trạng thái `refunded`)**:
  ```text
                  ┌─────────────────▶ credited (exact match / settled)
                  ├─────────────────▶ underpaid (short transfer -> wallet credited)
  received ───────┼─────────────────▶ overpaid (excess transfer -> wallet credited)
                  ├─────────────────▶ duplicate_transfer (transfer to already paid item)
                  └─────────────────▶ unmatched (code not found in orders/topups)
                                         │
                                         ▼ (order/topup appears later via reconcile)
                                      credited / underpaid / overpaid
  ```
  - **Trạng thái Non-Terminal (Cho phép Resume/Reconcile)**: `'received'`, `'unmatched'`.
  - **Trạng thái Terminal (Idempotent No-Op)**: `'credited'`, `'underpaid'`, `'overpaid'`, `'duplicate_transfer'`.
  - **Thống nhất kiến trúc về Refund (Option B)**:
    - Bảng `sepay_transactions` **TUYỆT ĐỐI KHÔNG CÓ TRẠNG THÁI `'refunded'`**.
    - Bản ghi `sepay_transactions` là chứng từ kiểm toán bất biến ghi nhận dòng tiền thực tế đã chuyển vào tài khoản ngân hàng (`transfer_type = 'in'`).
    - Việc hoàn tiền (Refund) là nghiệp vụ thuần túy thuộc vòng đời đơn hàng (`orders.status = 'refunded'`) và sổ cái ví (`wallet_ledger.kind = 'order_refund'`), tiền trong ngân hàng vẫn nằm tại tài khoản chủ kho hoặc xử lý ngoại tuyến.
- **SePay Relation Invariant & Target Exclusivity Constraint**:
  - Bản ghi `sepay_transactions` **BẮT BUỘC** phải tuân thủ tính loại trừ tương hỗ (Mutual Exclusivity) giữa `order_id` và `topup_id`:
    1. **UNMATCHED**: `order_id IS NULL AND topup_id IS NULL` (Mã giao dịch chưa tìm thấy trong cả orders và topups).
    2. **ORDER PAYMENT**: `order_id IS NOT NULL AND topup_id IS NULL` (Giao dịch thanh toán đơn hàng, bao gồm `credited`, `underpaid`, `overpaid`, và `duplicate_transfer` phát sinh từ đơn hàng).
    3. **WALLET TOPUP**: `order_id IS NULL AND topup_id IS NOT NULL` (Giao dịch nạp tiền ví, bao gồm `credited` và `duplicate_transfer` phát sinh từ phiếu nạp).
  - **Database Constraint (PostgreSQL CHECK)**:
    ```sql
    CONSTRAINT chk_sepay_target_exclusivity CHECK (
      (order_id IS NULL AND topup_id IS NULL) OR
      (order_id IS NOT NULL AND topup_id IS NULL) OR
      (order_id IS NULL AND topup_id IS NOT NULL)
    );
    ```
  - **Ràng buộc Duplicate Transfer**: Giao dịch bị duplicate (`status = 'duplicate_transfer'`) bắt buộc vẫn phải lưu vết đúng thực thể nghiệp vụ ban đầu đã sinh ra nó (`order_id` nếu là thanh toán đơn lặp lại, hoặc `topup_id` nếu là nạp ví lặp lại). Tuyệt đối không để bản ghi rỗng quan hệ hoặc trỏ đồng thời cả hai.

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

### 7.1. Global Database Lock Order (Chống Deadlock Triệt Để & Audit Toàn Diện)

```text
┌────────────────────────────────────────────────────────────────────────┐
│                     CANONICAL DATABASE LOCK ORDER                      │
├────────────────────────────────────────────────────────────────────────┤
│  1. discount_codes     (Parent discount row lock)                      │
│  2. wallets            (User wallet balance lock - CHỈ KHÓA KHI CẦN)   │
│  3. orders             (Order status & amounts lock)                   │
│  4. wallet_topups      (Bank topup state lock)                         │
│  5. delivery_jobs      (Delivery intent queue lock)                    │
└────────────────────────────────────────────────────────────────────────┘
```

#### Bảng Audit Toàn Bộ Transaction Paths Có Thể Lock Đồng Thời:

| Nghiệp Vụ (Code Path) | Các Bảng Được Khóa | Thứ Tự Khóa Thực Tế | Tuân Thủ Canonical | Ghi Chú Tối Ưu Hóa & Loại Bỏ Inversion |
| :--- | :--- | :--- | :---: | :--- |
| **Purchase (`openOrder`)** | `discounts`, `wallets`, `orders`, `delivery_jobs` | **1 ➔ 2 ➔ 3 ➔ 5** | **PASS** | Mua hàng có áp mã giảm giá và trừ ví. Khóa ví trước khi chèn order. |
| **Order Payment (Exact)** | `orders`, `delivery_jobs` | **3 ➔ 5** | **PASS** | **KHÔNG KHÓA VÍ**. Khách chuyển đủ tiền, số dư ví không đổi ➔ Tuyệt đối không khóa `wallets` một cách không cần thiết, loại bỏ tranh chấp với nạp ví/mua hàng. |
| **Order Payment (Underpay)**| `wallets`, `orders` | **2 ➔ 3** | **PASS** | Chuyển thiếu tiền: ví được cộng `+amount` ➔ Bắt buộc khóa `wallets (#2)` trước rồi mới khóa `orders (#3)`. |
| **Order Payment (Overpay)** | `wallets`, `orders`, `delivery_jobs` | **2 ➔ 3 ➔ 5** | **PASS** | Chuyển thừa tiền: ví được cộng `+excess` ➔ Khóa `wallets (#2)` trước, khóa `orders (#3)` tiếp theo, chèn `delivery_jobs (#5)`. |
| **Order Refund (`refundOrderWallet`)**| `wallets`, `orders` | **2 ➔ 3** | **PASS** | **LOẠI BỎ LOCK INVERSION**: Pre-read `orders` không lock để lấy `discordUserId`, sau đó khóa `wallets (#2) FOR UPDATE` trước, rồi khóa `orders (#3) FOR UPDATE`. Tuyệt đối không khóa `orders ➔ wallets`. |
| **Wallet Topup (SePay)** | `wallets`, `wallet_topups` | **2 ➔ 4** | **PASS** | Pre-read topup không lock lấy `discordUserId`. Khóa `wallets (#2) FOR UPDATE` trước, rồi khóa `wallet_topups (#4) FOR UPDATE`. |
| **Card Topup (Card2k Sweep)**| `wallets`, `card_topups` | **2 ➔ card_topups** | **PASS** | Polling worker duyệt thẻ khớp: khóa `wallets (#2) FOR UPDATE`, sau đó cập nhật `card_topups`. |
| **Delivery Worker (`claimJob`)**| `delivery_jobs` | **5** | **PASS** | Worker chỉ khóa `delivery_jobs (#5) FOR UPDATE SKIP LOCKED`, không khóa bảng tiền tệ. |

**Quy tắc bất biến cốt lõi (Lock Invariant Rules)**:
1. **Chỉ khóa ví khi transaction thực sự cần wallet mutation**: Các flow chỉ xử lý Order (như Exact Payment) tuyệt đối không được khóa ví người dùng.
2. **Loại bỏ 100% Lock Inversion**: Toàn bộ codebase tuân thủ một chiều duy nhất: `wallets (#2) ➔ orders (#3)`. Mọi luồng liên quan (Purchase, Payment, Refund) đều khóa `wallets` trước `orders`. Cấm tuyệt đối code path khóa `orders ➔ wallets`.
3. **Pre-Read để xác định Identity & Owner**: Trước khi xin khóa `wallets`, hệ thống thực hiện **Pre-Read KHÔNG LOCK (`WITHOUT FOR UPDATE`)** để giải quyết `discordUserId`.

---

### 7.2. Đặc tả chi tiết luồng Webhook SePay Topup (Pre-Read, Retry/Resume & Canonical Lock Order)

```sql
-- BƯỚC 0: Pre-read KHÔNG LOCK để xác định Identity & User sở hữu phiếu nạp
SELECT id AS topup_id, discord_user_id AS user_id, status, amount
FROM wallet_topups
WHERE code = $code;

-- Nếu không tìm thấy: Chuyển sang kiểm tra Order Bank Payment (Mục 7.3) hoặc ghi sepay_transactions 'unmatched'.

-- BẮT ĐẦU TRANSACTION NGHIỆP VỤ:
BEGIN TRANSACTION;
  -- 1. Insert SePay transaction nếu chưa có
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, status, raw_payload, received_at)
  VALUES ($sepayId, $amount, $type, $code, $content, $desc, 'received', $payload, now())
  ON CONFLICT (sepay_id) DO NOTHING;

  -- 2. Khóa dòng và kiểm tra trạng thái của SePay transaction:
  SELECT id, status, topup_id, order_id, amount
  FROM sepay_transactions
  WHERE sepay_id = $sepayId
  FOR UPDATE;

  -- PHÂN BIỆT RÕ 3 TRƯỜNG HỢP XỬ LÝ (A, B, C):
  -- CASE A: Duplicate transaction đã hoàn tất xử lý nghiệp vụ terminal ('credited', 'duplicate_transfer')
  -- (Option B: Bảng sepay_transactions tuyệt đối không có trạng thái 'refunded')
  IF existing_sepay.status IN ('credited', 'duplicate_transfer') THEN
    COMMIT;
    RETURN { handled: 'duplicate_already_processed', status: existing_sepay.status };
  END IF;

  -- CASE B: Transaction tồn tại nhưng chưa hoàn tất ('received' do process crash giữa chừng) -> RESUME
  -- CASE C: Transaction ở trạng thái 'unmatched' và nay khớp topup hợp lệ -> RECONCILE
  -- Cả Case B và C tiếp tục thực thi quy trình nghiệp vụ dưới khóa hàng an toàn (không tạo duplicate credit):

  -- 3. Khóa ví người dùng (Lock Order #2)
  SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;

  -- 4. Khóa phiếu nạp ví (Lock Order #4)
  SELECT * FROM wallet_topups WHERE id = $topupId FOR UPDATE;

  -- 5. Atomic status flip: Cho phép chuyển từ 'pending' HOẶC 'expired' sang 'credited'
  UPDATE wallet_topups
  SET status = 'credited',
      paid_amount = $amount,
      credited_at = now()
  WHERE id = $topupId
    AND status IN ('pending', 'expired')
  RETURNING id;

  -- 6. BẮT BUỘC: Kiểm tra kết quả atomic flip:
  IF FOUND THEN
    -- Chỉ khi RETURNING trả đúng 1 row mới thực thi:
    -- Cộng tiền ví (Lock Order #2)
    INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
    VALUES ($userId, $amount, now(), now())
    ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

    -- Ghi sổ cái với ref_type = 'topup', ref_id = $topupId (PARTIAL UNIQUE INDEX bảo vệ)
    INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
    VALUES ($userId, $amount, new_balance, 'topup_credit', 'topup', $topupId, 'nạp ví SePay', now());

    -- Cập nhật Traceability sang trạng thái terminal 'credited' (Target Exclusivity: topup_id set, order_id NULL)
    UPDATE sepay_transactions
    SET status = 'credited',
        topup_id = $topupId,
        order_id = NULL,
        processed_at = now()
    WHERE id = existing_sepay.id;

  ELSE
    -- Topup này đã ở trạng thái credited trước đó (được xử lý bởi luồng khác)
    -- Ghi nhận sepay transaction thành 'duplicate_transfer', lưu vết topup_id gốc, order_id = NULL
    UPDATE sepay_transactions
    SET status = 'duplicate_transfer',
        topup_id = $topupId,
        order_id = NULL,
        processed_at = now()
    WHERE id = existing_sepay.id;
  END IF;

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
  -- 1. Insert SePay transaction nếu chưa có
  INSERT INTO sepay_transactions (sepay_id, amount, transfer_type, code, content, description, status, raw_payload, received_at)
  VALUES ($sepayId, $amount, $type, $code, $content, $desc, 'received', $payload, now())
  ON CONFLICT (sepay_id) DO NOTHING;

  -- 2. Khóa dòng và kiểm tra trạng thái của SePay transaction:
  SELECT id, status, order_id, amount
  FROM sepay_transactions
  WHERE sepay_id = $sepayId
  FOR UPDATE;

  -- PHÂN BIỆT RÕ RETRY / DUPLICATE SEMANTICS:
  -- CASE A: Duplicate transaction đã hoàn tất xử lý terminal ('credited', 'underpaid', 'overpaid', 'duplicate_transfer')
  -- (Option B: Bảng sepay_transactions tuyệt đối không có trạng thái 'refunded')
  IF existing_sepay.status IN ('credited', 'underpaid', 'overpaid', 'duplicate_transfer') THEN
    COMMIT;
    RETURN { handled: 'duplicate_already_processed', status: existing_sepay.status };
  END IF;

  -- CASE B & C: Non-terminal state ('received' do crash giữa chừng hoặc late-matching từ 'unmatched')
  -- Tiếp tục xử lý / resume an toàn dưới khóa hàng mà không sinh duplicate credit:

  -- 3. Khóa dòng liên quan theo Canonical Lock Order (Chỉ khóa ví khi cần mutate ví):
  IF $amount = order.bank_due THEN
    -- Trường hợp Exact Payment: Không thay đổi số dư ví -> KHÔNG KHÓA VÍ
    -- Chỉ khóa Order (Lock Order #3)
    SELECT * FROM orders WHERE id = $orderId FOR UPDATE;
  ELSE
    -- Trường hợp Underpayment ($amount < bank_due) hoặc Overpayment ($amount > bank_due):
    -- Cần cộng tiền thực nhận hoặc tiền thừa vào ví -> BẮT BUỘC KHÓA VÍ TRƯỚC THEO THỨ TỰ CANONICAL:
    -- Lock Order #2 (wallets): Khóa ví người dùng
    SELECT balance FROM wallets WHERE discord_user_id = $userId FOR UPDATE;
    -- Lock Order #3 (orders): Khóa đơn hàng
    SELECT * FROM orders WHERE id = $orderId FOR UPDATE;
  END IF;

  -- 4. Validate trạng thái đơn hàng:
  -- Nếu đơn hàng đã 'paid' hoặc 'cancelled' hoặc bank_due == 0:
  IF order.status != 'pending' OR order.bank_due <= 0 THEN
    UPDATE sepay_transactions
    SET status = 'duplicate_transfer', order_id = $orderId, topup_id = NULL, processed_at = now()
    WHERE id = existing_sepay.id;
    COMMIT;
    RETURN { handled: 'order_not_pending' };
  END IF;

  -- 5. So sánh số tiền thực nhận ($amount) với bank_due và phân nhánh xử lý:

  -- =========================================================================
  -- TRƯỜNG HỢP A: EXACT PAYMENT ($amount == order.bank_due)
  -- =========================================================================
  IF $amount = order.bank_due THEN
    -- Cập nhật đơn hàng thành công (Không mutate ví)
    UPDATE orders
    SET status = 'paid', bank_due = 0, updated_at = now()
    WHERE id = $orderId;

    -- Tạo Durable Delivery Job (Lock Order #5)
    INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, requested_method, status)
    VALUES ($orderId, $userId, order.version_id, 'attachment', 'queued')
    ON CONFLICT (order_id, requested_method) DO NOTHING;

    -- Cập nhật Traceability sang 'credited' (Target Exclusivity: order_id set, topup_id NULL)
    UPDATE sepay_transactions
    SET status = 'credited', order_id = $orderId, topup_id = NULL, processed_at = now()
    WHERE id = existing_sepay.id;

  -- =========================================================================
  -- TRƯỜNG HỢP B: UNDERPAYMENT ($amount < order.bank_due)
  -- BUSINESS POLICY: DIRECT WALLET CREDIT (NO ORDER ACCUMULATOR MODEL)
  -- 1. order.bank_due GIỮ NGUYÊN KHÔNG ĐỔI (ví dụ: vẫn là 100.000 VNĐ).
  -- 2. order.status GIỮ NGUYÊN 'pending' (Không giao file).
  -- 3. Toàn bộ số tiền thực nhận $amount được CỘNG 100% VÀO VÍ của khách hàng.
  -- 4. Ghi sổ cái: ref_type = 'sepay_transaction', ref_id = sepay_transactions.id.
  --    -> Mỗi lần chuyển khoản thiếu tạo 1 entry ledger riêng biệt, loại bỏ 100%
  --       nguy cơ Unique Constraint Conflict khi khách chuyển nhiều lần thiếu.
  -- 5. EXISTING-ORDER WALLET SETTLEMENT POLICY:
  --    Hệ thống KHÔNG có use-case/API settleExistingOrderWithWallet(orderId).
  --    Khách không thể dùng ví để thanh toán bù cho đơn đang pending này.
  -- =========================================================================
  ELSIF $amount < order.bank_due THEN
    -- Cộng số tiền thực nhận vào ví khách hàng
    INSERT INTO wallets (discord_user_id, balance, created_at, updated_at)
    VALUES ($userId, $amount, now(), now())
    ON CONFLICT (discord_user_id) DO UPDATE SET balance = wallets.balance + $amount, updated_at = now();

    -- Ghi sổ cái với reference độc lập của SePay Transaction
    INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
    VALUES ($userId, $amount, new_balance, 'order_partial_credit', 'sepay_transaction', existing_sepay.id, 'thanh toán thiếu tiền đơn hàng - cộng ví an toàn', now());

    -- Cập nhật Traceability SePay transaction sang trạng thái terminal 'underpaid' (Target Exclusivity: order_id set, topup_id NULL)
    UPDATE sepay_transactions
    SET status = 'underpaid', order_id = $orderId, topup_id = NULL, processed_at = now()
    WHERE id = existing_sepay.id;

    -- Thông điệp gửi khách hàng (Discord DM):
    -- "Đơn hàng #{code} chưa đủ số tiền (Đã nhận: {amount}đ / Cần thanh toán: {bank_due}đ).
    --  Số tiền {amount}đ đã được cộng an toàn vào Ví Plugins Vault của bạn (Số dư ví hiện tại: {new_balance}đ).
    --  Để nhận tài nguyên, quý khách có thể:
    --  (1) Chuyển khoản đủ chính xác {bank_due}đ với cú pháp mã đơn để hoàn tất đơn hàng này, HOẶC
    --  (2) Chờ đơn hàng hết hạn (hoặc hủy) và tạo đơn mới: hệ thống sẽ tự động trừ số dư ví {new_balance}đ của bạn vào đơn hàng mới.
    --  TUYỆT ĐỐI KHÔNG thông báo 'bù phần còn lại' qua cùng mã chuyển khoản vì bank_due không giảm!
    --  TUYỆT ĐỐI KHÔNG thông báo khách có thể 'dùng ví thanh toán đơn pending này' vì hệ thống không có tính năng đó."

  -- =========================================================================
  -- TRƯỜNG HỢP C: OVERPAYMENT ($amount > order.bank_due)
  -- =========================================================================
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

    -- Ghi sổ cái cho phần tiền thừa với ref_type = 'sepay_transaction'
    INSERT INTO wallet_ledger (discord_user_id, delta, balance_after, kind, ref_type, ref_id, note, created_at)
    VALUES ($userId, excess, new_balance, 'order_overpay_credit', 'sepay_transaction', existing_sepay.id, 'tiền thừa thanh toán đơn hàng - cộng ví', now());

    -- Tạo Durable Delivery Job (Lock Order #5)
    INSERT INTO delivery_jobs (order_id, discord_user_id, version_id, requested_method, status)
    VALUES ($orderId, $userId, order.version_id, 'attachment', 'queued')
    ON CONFLICT (order_id, requested_method) DO NOTHING;

    -- Cập nhật Traceability (Target Exclusivity: order_id set, topup_id NULL)
    UPDATE sepay_transactions
    SET status = 'overpaid', order_id = $orderId, topup_id = NULL, processed_at = now()
    WHERE id = existing_sepay.id;
  END IF;

COMMIT;

[AFTER COMMIT - EXTERNAL SIDE EFFECTS NGOÀI DB TRANSACTION]
  - Trả HTTP 200 OK cho SePay gateway.
  - Gửi Discord DM thông báo kết quả (Exact / Underpay / Overpay) với nội dung minh bạch theo chính sách trên.
  - Worker claim delivery_job bất đồng bộ để thực thi gửi file nếu đơn hàng thành công.
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
| **Exact Payment (Topup)** | 100,000 | 100,000 | `exact` | `credited` | `+100,000` VNĐ; ghi ledger `topup_credit`, `ref_type = 'topup'`, `ref_id = topup.id`. | Topup: `status = 'credited'`, `paid_amount = 100,000` | Gán `topup_id`, `order_id = NULL`, `processed_at`. Gửi DM xác nhận số dư mới. |
| **Partial Payment (Topup)** | 100,000 | 50,000 | `partial_topup` | `credited` | `+50,000` VNĐ (Dynamic real-amount credit); ghi ledger `topup_credit`, `ref_type = 'topup'`, `ref_id = topup.id`. | Topup: `status = 'credited'`, `paid_amount = 50,000` (tiền không bị kẹt) | Gán `topup_id`, `order_id = NULL`, `processed_at`. Gửi DM: "Nạp ví thành công số tiền thực nhận 50,000 VNĐ. Số dư ví hiện tại: {new_balance}đ." |
| **Excess Payment (Topup)** | 100,000 | 150,000 | `excess_topup` | `credited` | `+150,000` VNĐ (Dynamic real-amount credit); ghi ledger `topup_credit`, `ref_type = 'topup'`, `ref_id = topup.id`. | Topup: `status = 'credited'`, `paid_amount = 150,000` | Gán `topup_id`, `order_id = NULL`, `processed_at`. Gửi DM: "Nạp ví thành công số tiền thực nhận 150,000 VNĐ. Số dư ví hiện tại: {new_balance}đ." |
| **Exact Payment (Order bankDue)** | 100,000 | 100,000 | `exact` | `credited` | Không đổi ví (bỏ qua khóa ví). | Order: `status = 'paid'`, `bank_due = 0`, tạo `delivery_job` `queued`. | Gán `order_id`, `topup_id = NULL`, `processed_at`. Gửi DM thông báo đơn thành công và chuẩn bị nhận file. |
| **Underpayment (Order bankDue)** | 100,000 | 50,000 | `underpaid` | `underpaid` | `+50,000` VNĐ vào ví; ghi ledger: `ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id`, `kind = 'order_partial_credit'`. | Order: Giữ `status = 'pending'`, `bank_due = 100,000` (không giảm), không giao file. | Gán `order_id`, `topup_id = NULL`, `processed_at`. Gửi DM: "Đơn hàng chưa đủ tiền (Đã nhận 50k/Cần 100k). 50.000đ đã được cộng an toàn vào ví. Bạn có thể chuyển khoản đủ 100.000đ cho đơn hàng này, hoặc chờ đơn hết hạn để tạo đơn mới (hệ thống sẽ tự động trừ 50.000đ số dư ví vào đơn mới). Tuyệt đối không yêu cầu bù phần còn lại vì bank_due không giảm." |
| **Overpayment (Order bankDue)** | 100,000 | 150,000 | `overpaid` | `overpaid` | `+50,000` VNĐ (phần thừa) vào ví; ghi ledger: `ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id`, `kind = 'order_overpay_credit'`. | Order: `status = 'paid'`, `bank_due = 0`, tạo `delivery_job` `queued`. | Gán `order_id`, `topup_id = NULL`, `processed_at`. Gửi DM: "Đơn hàng thành công! Phần tiền thừa 50,000 VNĐ đã được lưu an toàn vào ví của bạn." |
| **Unknown Code (Order/Topup)** | Bất kỳ | Bất kỳ | `unmatched` | `unmatched` | Không có mutation ví. | Không gắn đối tượng. | `order_id = NULL`, `topup_id = NULL`. Lưu giao dịch `unmatched`, có cơ chế retry / reconcile khi order/topup xuất hiện sau đó. Bắn alert Staff Discord. |
| **Expired Topup Code** | 100,000 | Bất kỳ > 0 | `expired_topup` | `credited` | `+receivedAmount` VNĐ vào ví; ghi ledger `topup_credit`. | Topup: Chuyển từ `expired` -> `credited`, `paid_amount = receivedAmount`. | Gán `topup_id`, `order_id = NULL`, `processed_at`. Gửi DM: "Phiếu nạp đã hết hạn nhưng tiền đã chuyển thành công. Hệ thống đã kích hoạt và cộng đúng {receivedAmount}đ vào ví." |
| **Duplicate Topup Code (Khác sepay_id)** | 100,000 | 100,000 | `duplicate_transfer` | `duplicate_transfer` | Không tự động cộng tiền ví lần 2 (nhờ atomic guard `WHERE status IN ('pending', 'expired')`). | Topup giữ nguyên `credited`. | Gán `topup_id` (lưu vết phiếu nạp gốc), `order_id = NULL`, `processed_at`. Bắn alert Staff Discord xử lý thủ công. |
| **Duplicate Order Payment (Khác sepay_id)** | 100,000 | 100,000 | `duplicate_transfer` | `duplicate_transfer` | Không tự động cộng tiền ví/đơn lần 2. | Order giữ nguyên `paid`. | Gán `order_id` (lưu vết đơn hàng gốc), `topup_id = NULL`, `processed_at`. Bắn alert Staff Discord xử lý hoàn tiền thủ công. |

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

## 10. Idempotent & Resumable Migration Strategy (Dependency DAG & Atomic Checkpoints)

### 10.1. Migration Dependency Graph & DAG (Foreign-Key Ordered Execution)

Quá trình di chuyển dữ liệu từ SQLite sang Neon **TUYỆT ĐỐI KHÔNG CHẠY NGẪU NHIÊN THEO THỨ TỰ TỆP**. Hệ thống bắt buộc phải thực thi theo một Đồ thị có hướng không chu trình (**Directed Acyclic Graph - DAG**) bắt nguồn trực tiếp từ quan hệ khóa ngoại (Foreign-Key Dependencies) của cơ sở dữ liệu authoritative trên Neon.

```text
  users / staffs (Root PK)
     │
     ├──────────────────────┬──────────────────────┬──────────────────────┐
     ▼                      ▼                      ▼                      ▼
  plugins (Root)         wallets                discount_codes         spigot_accounts
     │                      │                      │                   (Local SQLite)
     ▼                      │                      │                      │
  versions                  │                      │                      ▼
     │                      │                      │               spigot_account_refs
     ├──────────┬───────────┤                      │               (Publish UUID Neon)
     │          │           │                      │                      │
     ▼          │           ▼                      │                      ▼
  orders ───────┼────▶ wallet_topups               │             resource_ownership
     │          │           │                      │                      │
     ├──────────┼───────────┴───────────┬──────────┘                      │
     │          │                       │                                 │
     ▼          ▼                       ▼                                 │
  sepay_transactions           discount_redemptions                       │
     │                                                                    │
     ▼                                                                    │
  wallet_ledger (References: order_id, topup_id, sepay_id)                │
     │                                                                    │
     ├──────────────────────────┬─────────────────────────────────────────┤
     ▼                          ▼                                         ▼
  delivery_jobs           download_tokens                           delivery_logs
  (FK: order, version)    (FK: order, version)                      (FK: order, version)
     │
     ▼
  upstream_state & pending_download
     │
     ▼
  FINAL RECONCILIATION & SEQUENCE RESET (Setval PostgreSQL sequences)
```

#### Chi Tiết 16 Bước Migration Theo Thứ Tự Ràng Buộc Phụ Thuộc (Parent ➔ Child):

| Bước (Step) | Bảng Nghiệp Vụ | Phụ Thuộc Bảng Cha (Dependencies) | Khóa Tự Nhiên / Identity | Ghi Chú ID Mapping & Xử Lý Dữ Liệu |
| :---: | :--- | :--- | :--- | :--- |
| **Step 1** | `users`, `staffs`, `discord_channels` | *(Root - Không phụ thuộc)* | `discord_user_id` / `channel_id` | Khởi tạo bảng danh tính người dùng và cấu hình kênh. |
| **Step 2** | `spigot_account_refs` | *(Local Vault `spigot_accounts`)* | `account_id` (UUID v4) | **Chỉ publish tham chiếu**: `accountId`, `label`, `status`, `health`. **KHÔNG copy secret**. |
| **Step 3** | `plugins` | *(Root - Không phụ thuộc)* | `plugins.slug` | Catalog gốc. Ghi nhận ID map `sqlite_plugin_id ➔ neon_plugin_id`. |
| **Step 4** | `versions` | `plugins` (Step 3) | `(plugin_id, version)` | Gán `plugin_id` mới từ ID map. Ghi nhận `sqlite_version_id ➔ neon_version_id`. |
| **Step 5** | `wallets` | `users` (Step 1) | `discord_user_id` | Tái lập ví tiền cho từng người dùng. |
| **Step 6** | `discount_codes` | *(Root - Không phụ thuộc)* | `discount_codes.code` | Ghi nhận ID map `sqlite_discount_id ➔ neon_discount_id`. |
| **Step 7** | `wallet_topups` | `wallets` (Step 5) | `wallet_topups.code` | Ghi nhận ID map `sqlite_topup_id ➔ neon_topup_id`. Hỗ trợ lifecycle `expired`. |
| **Step 8** | `card_topups` | `wallets` (Step 5) | `card_topups.request_id` | Ghi nhận phiếu nạp thẻ cào Card2k. |
| **Step 9** | `orders` | `versions` (Step 4), `wallets` (Step 5) | `orders.code` | Remap `version_id`. Ghi nhận ID map `sqlite_order_id ➔ neon_order_id`. |
| **Step 10**| `discount_code_redemptions` | `discount_codes` (Step 6), `orders` (Step 9) | `(discount_id, order_id)` | Remap `discount_id` và `order_id` từ ID mapping. |
| **Step 11**| `sepay_transactions` | `orders` (Step 9), `wallet_topups` (Step 7) | `sepay_transactions.sepay_id` | Remap `order_id` / `topup_id`. Đảm bảo `chk_sepay_target_exclusivity`. |
| **Step 12**| `wallet_ledger` | `wallets` (Step 5), `orders`, `topups`, `sepay` | `(ref_type, ref_id, kind)` | Remap `ref_id` tương ứng loại tham chiếu. Bù `opening_balance` nếu thiếu ($S \neq B$). |
| **Step 13**| `resource_ownership` | `spigot_account_refs` (Step 2) | `(account_id, resource_id)` | Ánh xạ quyền sở hữu tài nguyên qua `account_id` UUID. |
| **Step 14**| `download_tokens`, `delivery_jobs`, `delivery_logs` | `orders` (Step 9), `versions` (Step 4) | `token_hash` / `(order_id, method)` | Remap `order_id` và `version_id`. Thiết lập trạng thái ban đầu an toàn. |
| **Step 15**| `upstream_state`, `pending_download` | `plugins` (Step 3), `versions` (Step 4) | `(plugin_id, version_id)` | Remap `plugin_id` và `version_id`. |
| **Step 16**| **Final Reconciliation & Sequence Reset** | *(Toàn bộ các bước 1-15)* | Full Integrity Check | Chạy kiểm định 9 chiều đối soát; reset toàn bộ PostgreSQL serial sequences (`setval`). |

**Nguyên Tắc Bất Biến ID Mapping & Resumability**:
1. Bảng cha bắt buộc phải hoàn tất migration và xây dựng đầy đủ `In-Memory ID Mapping (sqlite_id ➔ neon_id)` trước khi bảng con phụ thuộc bắt đầu xử lý.
2. Mỗi batch của từng step commit atomically cùng với bản ghi `migration_checkpoints (step_name, status = 'completed')`.
3. Khi migration bị ngắt quãng giữa chừng (crash/timeout) và chạy lại: Hệ thống đọc các checkpoint đã `completed`, nạp lại in-memory ID map từ các bảng cha đã có trên Neon qua Natural Keys, và tiếp tục xử lý các step còn lại mà không tạo ra bất kỳ orphan FK hay duplicate row nào.

---

### 10.2. Deterministic Natural Business Key Strategy
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
- `spigot_account_refs`: tra cứu và liên kết qua `account_id` (UUID v4) được publish từ Local Secret Vault (tuyệt đối không copy credentials/cookies/sessions/profiles lên Neon).

---

### 10.3. Migration Checkpoint Atomicity (Status 'completed' Commit Invariant)
Business data mutation và migration checkpoint/progress của cùng một batch **BẮT BUỘC PHẢI COMMIT ATOMICALLY TRONG CÙNG MỘT TRANSACTION**:

```sql
BEGIN TRANSACTION;
  -- 1. Migrate batch dữ liệu nghiệp vụ (ví dụ: orders chunk 500 rows);
  -- 2. Validate tính tương thích và checksum của batch;
  -- 3. Cập nhật migration_checkpoints sang trạng thái 'completed' ngay trong cùng transaction:
  INSERT INTO migration_checkpoints (step_name, status, last_processed_key, processed_count, checksum, started_at, completed_at)
  VALUES ($stepName, 'completed', $lastKey, $count, $checksum, $startedAt, now())
  ON CONFLICT (step_name) DO UPDATE SET
    status = 'completed',
    last_processed_key = EXCLUDED.last_processed_key,
    processed_count = EXCLUDED.processed_count,
    checksum = EXCLUDED.checksum,
    completed_at = now();
COMMIT;
```

**Quy tắc an toàn khi Crash/Restart (Atomicity Guaranteed)**:
- Nếu process crash trước `COMMIT`: Toàn bộ batch dữ liệu nghiệp vụ và trạng thái checkpoint tự động rollback 100%.
- Nếu `COMMIT` thành công: Cả batch dữ liệu nghiệp vụ và bản ghi checkpoint với `status = 'completed'` đồng thời tồn tại bền vững.
- **Bất biến**: Tuyệt đối không bao giờ xảy ra tình trạng: *Business data đã committed nhưng checkpoint chưa completed*.
- Khi khởi động lại script sau crash: Hệ thống đọc `migration_checkpoints` đã `completed` ở batch trước và tiếp tục từ `last_processed_key`.

---

### 10.4. Spigot Account Secret Boundary & UUID Identity Bridge

Hệ thống thiết lập ranh giới bảo mật bất khả xâm phạm giữa Local Secret Vault và Neon Cloud PostgreSQL:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   SPIGOT ACCOUNT SECRET BOUNDARY                       │
├────────────────────────────────────────────────────────────────────────┤
│  LOCAL SECRET VAULT (vault_secrets.db - Isolated SQLite):              │
│  • account_id (UUID v4)                                                │
│  • label (varchar 64)                                                  │
│  • encrypted_password (AES-256-GCM)                                    │
│  • encrypted_cookies (xf_user, xf_session - AES-256-GCM)               │
│  • encrypted_session / authentication state                            │
│  • browser_profile / browser path                                      │
│  • private account state / crawler rate limits                         │
├────────────────────────────────────────────────────────────────────────┤
│  NEON CLOUD POSTGRESQL (spigot_account_refs - Business Single Source):  │
│  • account_id (UUID v4 - Primary Key)                                  │
│  • label (varchar 64)                                                  │
│  • status ('active' | 'cooldown' | 'suspended')                        │
│  • health ('healthy' | 'degraded' | 'dead')                            │
│  • last_verified_at (timestamp with time zone)                         │
└────────────────────────────────────────────────────────────────────────┘
```

**Ràng Buộc Tuyệt Đối Về Di Chuyển Dữ Liệu (Secret Boundary Rules)**:
1. **Migration KHÔNG BAO GIỜ COPY các trường sau lên Neon**:
   - `password` / `passwordEncrypted`
   - `cookie` / `xfUserEncrypted` / `xfSessionEncrypted`
   - `session` / browser authentication state
   - `browser profile` / crawler path
   - upstream auth tokens
2. **Migration CHỈ THỰC HIỆN**:
   - Đọc danh sách tài khoản từ Local SQLite (`vault_secrets.db`).
   - Duy trì `account_id` dạng UUID v4 bất biến cho từng tài khoản.
   - Xuất bản bản ghi tham chiếu phi nhạy cảm (`spigot_account_refs`: `accountId`, `label`, `status`, `health`, `last_verified_at`) lên Neon phục vụ Dashboard theo dõi trạng thái. Đổi `label` trên Dashboard không làm đứt gãy liên kết `account_id`.
3. Bảng `account_scan_state` lưu trữ lỗi và rate-limit crawler cục bộ **hoàn toàn giữ tại Local Vault, không đưa lên Neon**.

---

### 10.5. Wallet Opening Balance Reconstruction & Single-Occurrence Rule
1. Kiểm tra tính toàn vẹn của lịch sử sổ cái SQLite: Chỉ bù đúng 1 dòng `opening_balance` khi thật sự thiếu ($S \neq B$). Invariant số dư = tổng delta đạt 100%.
2. **Quy tắc Single-Occurrence**: `opening_balance` chỉ được phép xuất hiện **tối đa 1 lần duy nhất** cho mỗi ví người dùng (`idx_wallet_ledger_opening_balance`). Tuyệt đối không tạo lại khi migration chạy lại.

---

### 10.6. Secret Migration Hygiene
Toàn bộ tệp SQLite cũ được bảo mật `chmod 600`, cấm commit Git, cấm serialize secret sang Neon, redact toàn bộ credential trong migration log.

---

## 11. Reconciliation Strategy & Wallet Invariants

Kiểm định toàn diện 9 chiều sau di chuyển dữ liệu:
1. **Missing rows**: Bắt buộc = 0.
2. **Duplicate rows**: Bắt buộc = 0.
3. **Orphan foreign keys**: Bắt buộc = 0.
4. **Business-key collisions**: Bắt buộc = 0 (`orders.code`, `wallets.discord_user_id`, `sepay_transactions.sepay_id`, `card_topups.request_id`, `plugins.slug`, `versions (plugin_id, version)`, `spigot_account_refs.account_id`).
5. **Unexpected truncation**: Bắt buộc = 0.
6. **Timestamp conversion**: Chuyển đổi chính xác Unix seconds sang UTC Timestamp with timezone.
7. **Boolean conversion**: Chuyển đổi 0/1 sang `true`/`false`.
8. **JSON conversion**: Chuyển đổi chuỗi JSON sang `jsonb` hợp lệ.
9. **Wallet Financial Invariants**:
   - **Bất biến 1 (Mathematical Invariant)**:
     $$\text{wallet.balance} \equiv \sum \text{wallet\_ledger.delta}$$
     ```sql
     SELECT w.discord_user_id, w.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
     FROM wallets w
     LEFT JOIN wallet_ledger l ON l.discord_user_id = w.discord_user_id
     GROUP BY w.discord_user_id, w.balance
     HAVING w.balance != COALESCE(SUM(l.delta), 0);
     ```
     **Kết quả bắt buộc**: Trả về đúng **0 dòng**.
   - **Bất biến 2 (Opening Balance Count)**: `opening_balance` chỉ xuất hiện tối đa một lần cho mỗi ví (`COUNT(WHERE kind = 'opening_balance') <= 1`).
   - **Bất biến 3 (Audit Trail Completeness)**: Mọi biến động số dư ví (business balance mutation) bắt buộc phải có một ledger entry tương ứng. Tuyệt đối cấm direct update balance mà không ghi sổ cái.
   - **Bất biến 4 (Event Reference Isolation)**: Mọi khoản credit do thanh toán thiếu/thừa đơn hàng bắt buộc phải dùng `sepay_transactions.id` làm reference (`ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id`).
   - **Bất biến 5 (Explicit Kind Taxonomy)**: Mọi ledger entry phải thuộc danh mục kind tường minh:
     - `opening_balance`: Số dư ban đầu từ SQLite migration
     - `topup_credit`: Nạp tiền ví qua SePay ngân hàng
     - `card_credit`: Nạp tiền ví qua thẻ cào Card2k
     - `order_debit`: Trừ tiền ví khi mua hàng
     - `order_partial_credit`: Tiền nạp vào ví do chuyển khoản thiếu tiền đơn hàng
     - `order_overpay_credit`: Tiền thừa nạp vào ví khi chuyển thừa tiền đơn hàng
     - `order_refund`: Hoàn tiền đơn hàng vào ví
     - `admin_adjustment`: Điều chỉnh số dư thủ công bởi quản trị viên (có tham chiếu audit log)

---

## 12. Cutover Plan & Global Business Write Freeze (Timeline T-0 đến T+7)

Trong suốt thời gian thực thi Cutover và Migration, **TUYỆT ĐỐI KHÔNG CHỈ FREEZE BOT DISCORD**. Hệ thống bắt buộc phải kích hoạt cơ chế bảo trì toàn cục (**Global Maintenance / Write-Freeze Mode**) nhằm cô lập và ngăn chặn 100% mọi luồng ghi dữ liệu nghiệp vụ (**Business Writers**) ngoài script migration.

### 12.1. Danh mục 7 Business Writers bị đóng băng trong Write Freeze:
1. **Discord Bot**:
   - Chặn toàn bộ lệnh Slash Commands tạo đơn, thanh toán, nạp tiền (`/buy`, `/pay`, `/napthe`, `/topup`).
   - Chặn toàn bộ Button Click & Modal Submit (trả về ephemeral message: *"Hệ thống đang bảo trì nâng cấp cơ sở dữ liệu. Vui lòng thử lại sau ít phút."*).
2. **Dashboard Mutations**:
   - Chặn toàn bộ API routes ghi nhận thay đổi (POST, PUT, PATCH, DELETE) trên `/api/orders`, `/api/wallets`, `/api/plugins`, `/api/staffs`.
   - Trả về HTTP 503 Service Unavailable kèm header `Retry-After: 60`.
3. **Worker (Delivery & Ingest)**:
   - Dừng việc claim job mới từ `delivery_jobs` và hàng đợi tải file `pending_download`.
4. **Scheduler & Cron Jobs**:
   - Tạm dừng các cron job định kỳ (quét đơn hết hạn `expireStaleOrders`, quét tài khoản crawler, backup nền).
5. **Payment Ingress & Provider Assumptions (SePay & Card2k)**:
   - **Cổng SePay (Inbound Webhook Delivery)**:
     - **Pre-cutover Verification Checklist (T-10m)**: Operator bắt buộc truy cập SePay Merchant Dashboard (`my.sepay.vn` ➔ Cấu hình Webhook) để xác minh tính năng **"Tự động gửi lại webhook khi lỗi (Auto-retry)"** đang ở trạng thái **BẬT (Enabled)**. Tuyệt đối không coi retry là guaranteed nếu configuration thực tế chưa bật.
     - **Chính sách tiếp nhận Webhook trong thời gian Freeze (T-0 đến T+6)**: Webhook endpoint trả về **HTTP 503 Service Unavailable** kèm header `Retry-After: 60`. Khi nhận mã phản hồi 503, SePay sẽ tự động giữ và thử lại webhook sau 60 giây.
     - **Durable Ingress Buffer Fallback**: Nhằm bảo đảm an toàn dữ liệu kể cả khi kết nối mạng hoặc cấu hình retry từ SePay gặp sự cố, hệ thống trang bị bộ đệm bền vững cục bộ (`data/sepay_ingress_buffer.jsonl` hoặc memory buffer). Mọi webhook lọt vào trong cửa sổ freeze được ghi nhận an toàn vào buffer và tự động replay lên Neon Authoritative DB tại T+6, bảo đảm 100% không drop thanh toán.
   - **Cổng Card2k (Outbound Polling Client - KHÔNG PHẢI WEBHOOK!)**:
     - **Thực tế tích hợp (Codebase Inspection)**: Kiểm tra mã nguồn ([scheduler.ts:L553-L560](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/maintenance/scheduler.ts#L553-L560)) xác nhận Card2k **hoàn toàn không có webhook callback** (`card2k sends no callback, so this is the only way a submitted card ever resolves`). Giao dịch nạp thẻ được xử lý qua lệnh nạp chủ động (`submitCard`) và quét định kỳ (`pollPendingCards` mỗi 60s).
     - **Quy trình Freeze an toàn không mất thẻ**:
       1. Tại T-0: Tạm khóa modal submit lệnh `/napthe` trên Discord Bot khi `GLOBAL_MAINTENANCE_MODE=true` (thông báo khách gửi lại sau ít phút).
       2. Tạm dừng scheduler sweep `pollPendingCards` trong suốt cửa sổ cutover (T-0 đến T+6).
       3. Toàn bộ các thẻ cào đang ở trạng thái `pending` trong `card_topups` được migrate nguyên vẹn sang Neon.
       4. Tại T+6: Kích hoạt lại `pollPendingCards` trên Neon Authoritative DB. Tiến trình polling quét lại toàn bộ thẻ pending và tự động cộng ví chính xác các thẻ đã được Card2k xử lý trong thời gian bảo trì. Không có bất kỳ thẻ nào bị drop hay thất thoát!
6. **Delivery Worker / Handoff Processor**:
   - Tạm ngừng các luồng gửi file ngoại vi sang Discord DM.
7. **Background Jobs & Sidecars**:
   - Tạm ngưng các tác vụ nền không thiết yếu.

### 12.2. Tiến trình Cutover chi tiết (T-10m đến T+7)
- **T-10m**: **Pre-Cutover Checklist & Provider Verification**.
  - Kiểm tra SePay Merchant Dashboard: Xác minh "Auto-Retry on 5xx" đang BẬT.
  - Kiểm tra bộ đệm Ingress Buffer sẵn sàng hoạt động dự phòng.
  - Kiểm tra trạng thái hàng đợi `card_topups`: Đảm bảo không có deadlock hay treo xử lý.
- **T-0 (00:00)**: **Enter Global Write Freeze**.
  - Kích hoạt `GLOBAL_MAINTENANCE_MODE=true` trên tất cả các dịch vụ (Bot Discord, Web Dashboard, Workers, Schedulers, Webhook Endpoints).
  - Khóa modal `/napthe` và tạm dừng interval `pollPendingCards`.
  - Webhook SePay bắt đầu trả về HTTP 503 `Retry-After: 60` (kèm Durable Ingress Buffer dự phòng).
- **T+1 (00:01)**: **Backup Local SQLite Secret / Business Source**.
  - Chạy `better-sqlite3` `.backup()` API xuất bản snapshot nhất quán ra tệp `data/backups/vault_cutover.db`.
  - Verify SHA-256 hash và file size của bản backup.
- **T+2 (00:03)**: **Run Idempotent Batch Migration**.
  - Chạy script `pnpm tsx discord/scripts/migrate-sqlite-to-neon-full.ts`.
  - Xử lý từng batch kèm atomic checkpoint commit (`status = 'completed'`).
  - Ánh xạ natural keys, publish UUID references (`spigot_account_refs`) cho Spigot accounts từ Local Vault (tuyệt đối KHÔNG copy password/cookies/sessions/profiles), tái lập opening balance nếu thiếu.
- **T+3 (00:06)**: **Reconciliation & Financial Validation**.
  - Thực thi kiểm tra đối soát 9 chiều (Missing rows = 0, Duplicate rows = 0, Collisions = 0).
  - Chạy truy vấn kiểm định bất biến ví: `reconcileBalances == 0`.
  - Reset PostgreSQL Sequences (`setval(pg_get_serial_sequence(...))`) cho toàn bộ các bảng auto-increment.
- **T+4 (00:08)**: **Runtime Switch**.
  - Đổi cấu hình kết nối của Discord Bot, Dashboard Backend và Workers sang Neon PostgreSQL (`DATABASE_URL=postgres://...`).
  - Thiết lập kết nối Local SQLite chỉ dùng riêng cho `data/vault_secrets.db` (Local Secret Vault).
- **T+5 (00:09)**: **Smoke Tests trên Neon Runtime**.
  - Kiểm tra đọc/ghi thử nghiệm: xem danh sách đơn hàng Dashboard, kiểm tra lệnh `/vi` trên Bot, kiểm tra quyền Staff RBAC.
- **T+6 (00:10)**: **Release Global Write Freeze**.
  - Tắt `GLOBAL_MAINTENANCE_MODE=false`.
  - Mở lại toàn bộ 7 business writers; mở lại modal `/napthe` và kích hoạt scheduler sweep `pollPendingCards` trên Neon.
  - Replay các webhook từ Ingress Buffer (nếu có) và tiếp nhận SePay retries ➔ Xử lý chính xác trên Neon Authoritative DB.
- **T+7 (00:11 - 00:40)**: **Post-Cutover Live Monitoring**.
  - Giám sát real-time metrics, error rate, latency và database connection pool trong 30 phút.

---

## 13. Rollback Plan

- **Tuyệt đối không rollback bằng cách ghi đè Neon bằng bản backup SQLite cũ**.
- Áp dụng **Application Rollback** (vẫn trỏ cùng Neon DB) hoặc **Neon PITR** (Point-In-Time Recovery).

---

## 14. Final Acceptance Tests (Bản Toàn Diện v10 — Implementation Gate)

### Test A: Wallet Topup Amount Policy Test (Dynamic Real-Amount Credit)
Kiểm thử chính sách nạp ví theo số tiền thực nhận (Dynamic Real-Amount Credit Policy):
```text
Kịch bản: Khách hàng tạo phiếu nạp ví wallet_topups với requested amount = 100.000 VNĐ (code: TOPUP-100).
Thử nghiệm 3 trường hợp số tiền thực nhận qua SePay:
1. Trường hợp 1: Nhận 50.000 VNĐ (Under-amount so với yêu cầu).
2. Trường hợp 2: Nhận 100.000 VNĐ (Exact amount so với yêu cầu).
3. Trường hợp 3: Nhận 150.000 VNĐ (Over-amount so với yêu cầu).
Đồng thời kiểm thử cho cả phiếu nạp ở trạng thái 'pending' và 'expired' (tiền về muộn).

Expected Behavior (Thống nhất 100% theo Dynamic Real-Amount Credit Policy):
1. Trường hợp 1 (Nhận 50.000đ):
   - wallets.balance += 50.000 VNĐ
   - wallet_ledger delta = +50.000, kind = 'topup_credit', ref_type = 'topup', ref_id = topup.id
   - wallet_topups.paidAmount = 50.000, wallet_topups.status = 'credited'
   - sepay_transactions.status = 'credited', topup_id = topup.id, order_id = NULL
2. Trường hợp 2 (Nhận 100.000đ):
   - wallets.balance += 100.000 VNĐ
   - wallet_ledger delta = +100.000, kind = 'topup_credit', ref_type = 'topup', ref_id = topup.id
   - wallet_topups.paidAmount = 100.000, wallet_topups.status = 'credited'
   - sepay_transactions.status = 'credited', topup_id = topup.id, order_id = NULL
3. Trường hợp 3 (Nhận 150.000đ):
   - wallets.balance += 150.000 VNĐ
   - wallet_ledger delta = +150.000, kind = 'topup_credit', ref_type = 'topup', ref_id = topup.id
   - wallet_topups.paidAmount = 150.000, wallet_topups.status = 'credited'
   - sepay_transactions.status = 'credited', topup_id = topup.id, order_id = NULL
4. Phiếu nạp 'expired': Chuyển trạng thái sang 'credited', cộng đúng số tiền thực nhận vào ví và ghi ledger y hệt 'pending'. Tiền của khách không bao giờ bị kẹt.
```

### Test B: SePay Relation Integrity & Target Exclusivity Test
Xác thực tính toàn vẹn quan hệ và loại trừ tương hỗ (Mutual Exclusivity) của bảng `sepay_transactions`:
```text
Kịch bản: Kiểm tra ràng buộc cơ sở dữ liệu và application logic cho 3 loại giao dịch SePay:
1. Giao dịch chưa khớp (UNMATCHED):
   - order_id IS NULL AND topup_id IS NULL
2. Giao dịch thanh toán đơn hàng (ORDER PAYMENT):
   - order_id IS NOT NULL AND topup_id IS NULL
3. Giao dịch nạp tiền ví (WALLET TOPUP):
   - order_id IS NULL AND topup_id IS NOT NULL
4. Thử nghiệm vi phạm (Negative Test):
   - Cố tình chèn/cập nhật bản ghi có đồng thời order_id NOT NULL VÀ topup_id NOT NULL.
5. Giao dịch lặp lại (duplicate_transfer):
   - Kiểm tra giao dịch trùng lặp cho đơn hàng và nạp ví.

Expected Behavior:
1. Ràng buộc CHECK `chk_sepay_target_exclusivity` trên PostgreSQL:
   - Chấp nhận đúng 3 trạng thái quan hệ hợp lệ (Unmatched, Order, Topup).
   - Từ chối ngay lập tức (throw Check Constraint Violation Error) nếu bản ghi cố tình reference cả order_id và topup_id cùng lúc.
2. Giao dịch lặp lại (`duplicate_transfer`):
   - Bắt buộc giữ nguyên đúng reference đến business object gốc đã sinh ra nó (nếu là duplicate order payment thì order_id set, topup_id NULL; nếu là duplicate topup thì order_id NULL, topup_id set).
   - Tuyệt đối không xóa rỗng reference của duplicate transfer và không vi phạm tính loại trừ.
```

### Test C: Lock-Based Transactional Consistency & Concurrency Isolation Test (Option A)
Kiểm thử tính nhất quán dựa trên khóa (Lock-based transactional consistency for defined business invariants) trên PostgreSQL:
```text
Kịch bản: Khởi chạy 20 worker threads đồng thời mô phỏng giao dịch cạnh tranh cao (High Concurrency Stress):
1. Concurrent Purchase (`openOrder`): áp mã giảm giá + trừ tiền ví.
2. Concurrent Order Payment: Webhook SePay exact payment (không khóa ví) và underpay/overpay (khóa ví -> order).
3. Concurrent Refund: `refundOrderWallet` (pre-read không lock -> khóa wallets #2 -> khóa orders #3).
4. Concurrent Wallet Topup: Nạp ví SePay (khóa wallets #2 -> khóa wallet_topups #4).
5. Isolation Level: PostgreSQL mặc định (Read Committed) kết hợp row-level locking (SELECT ... FOR UPDATE) và Canonical Lock Order.

Expected Behavior:
1. PostgreSQL Deadlock Error Count = 0 (Không phát sinh mã lỗi 40P01 deadlock_detected).
2. Không sử dụng và không claim PostgreSQL SERIALIZABLE isolation; toàn bộ tính toàn vẹn được đảm bảo bởi:
   - Pessimistic Row Locking (`FOR UPDATE`)
   - Canonical Lock Order (1. discount -> 2. wallet -> 3. order -> 4. topup -> 5. delivery_job)
   - Partial Unique Indexes (`wallet_ledger`, `delivery_jobs`)
   - Atomic DB Transactions
3. Đạt tính nhất quán tuyệt đối cho các bất biến nghiệp vụ (Business Invariants):
   - Không có negative wallet balance ngoài ý muốn
   - Không có double-spent discount codes
   - Không có duplicate delivery jobs
   - Tổng delta ledger luôn bằng số dư ví 100%
```

### Test D: Migration Dependency DAG & Resumability Test
Kiểm thử di chuyển dữ liệu theo đồ thị phụ thuộc (Foreign-Key Dependency DAG) và khả năng phục hồi:
```text
Kịch bản:
1. Chạy migration trên cơ sở dữ liệu Neon đã có sẵn dữ liệu một phần (partially populated Neon tables, ví dụ đã có một số users, plugins, orders từ đợt chạy trước).
2. Cố tình ngắt tiến trình (kill -9) giữa chừng tại Step 9 (orders).
3. Khởi động lại script migration.

Expected Behavior:
1. Script tuân thủ nghiêm ngặt thứ tự DAG 16 bước: Parent migrate trước, Child migrate sau.
2. In-Memory ID Mapping (`sqlite_id ➔ neon_id`) được tái lập đầy đủ từ các bảng cha đã có trên Neon thông qua Natural Keys trước khi xử lý bảng con.
3. Checkpoint Atomicity: Bảng `migration_checkpoints` ghi nhận đúng trạng thái 'completed' của từng batch đã commit.
4. Kết quả sau khi hoàn tất:
   - Orphan Foreign Keys = 0 (Không có bất kỳ bản ghi con nào trỏ vào ID cha không tồn tại).
   - Duplicate Rows = 0 (Không bị nhân đôi bản ghi nhờ Natural Key lookups).
   - Foreign-key constraints của PostgreSQL hoàn toàn thỏa mãn mà không cần tạm thời drop hay disable constraints.
```

### Test E: Spigot Account Secret Boundary Test
Kiểm định ranh giới bảo mật tài khoản Spigot giữa Local Vault và Neon Cloud:
```text
Kịch bản:
1. Thực hiện toàn bộ quy trình migration từ SQLite sang Neon.
2. Quét toàn bộ schema, bảng, cột, indexes, và bản ghi trên Neon Cloud PostgreSQL.
3. Kiểm tra tệp cơ sở dữ liệu Local Secret Vault (`data/vault_secrets.db`).

Expected Behavior:
1. Trên Neon Cloud PostgreSQL:
   - Bảng `spigot_account_refs` CHỈ chứa: `account_id` (UUID v4), `label`, `status`, `health`, `last_verified_at`, `created_at`, `updated_at`.
   - TUYỆT ĐỐI KHÔNG TỒN TẠI các cột hoặc dữ liệu về: `password`, `password_encrypted`, `cookies`, `xf_user`, `xf_session`, `session`, `browser_profile`, `upstream_auth_tokens`.
   - Bảng `account_scan_state` KHÔNG xuất hiện trên Neon.
2. Tại Local Secret Vault (`data/vault_secrets.db`):
   - Lưu trữ đầy đủ bản ghi với `account_id` UUID tương ứng, mật khẩu mã hóa AES-256-GCM, cookies mã hóa, browser profiles và crawler state.
   - Master Encryption Key (`VAULT_MASTER_KEY`) không nằm trong tệp DB.
```

### Test F: Status Consistency Test (Option B & Schema Alignment)
Xác thực tính nhất quán tuyệt đối giữa Business Logic và Schema:
```text
Expected Behavior:
1. Không có bất kỳ dòng code, query, handler hay test nào tham chiếu đến trạng thái không tồn tại trong schema.
2. Bảng sepay_transactions.status chỉ chấp nhận đúng 6 giá trị:
   - Non-terminal (cho phép resume / reconcile): 'received', 'unmatched'.
   - Terminal (idempotent no-op): 'credited', 'underpaid', 'overpaid', 'duplicate_transfer'.
3. TUYỆT ĐỐI KHÔNG CÓ TRẠNG THÁI 'refunded' trên sepay_transactions (Option B).
4. Nghiệp vụ hoàn tiền (Refund) thuộc độc quyền vòng đời đơn hàng và sổ cái:
   - orders.status = 'refunded'
   - wallet_ledger.kind = 'order_refund'
5. Giao dịch ngân hàng SePay là chứng từ kiểm toán bất biến (transfer_type = 'in'); tiền trong ngân hàng không đổi trạng thái khi đơn hàng bị hoàn tiền vào ví.
```

### Test G: Global Lock Inversion & Concurrency Deadlock Test
Kiểm thử áp lực đồng thời (High-Concurrency Stress Harness) trên PostgreSQL đảm bảo 0 Deadlock:
```text
Kịch bản: Khởi chạy đồng thời 20 worker threads ngẫu nhiên kích hoạt 4 luồng giao dịch đồng thời trên cùng user / order:
1. Purchase + Order Payment:
   - User mở đơn mua hàng trừ ví (openOrder: wallets #2 -> orders #3).
   - Webhook SePay thanh toán thiếu/thừa tiền (underpay/overpay: wallets #2 -> orders #3).
   - Webhook SePay thanh toán đủ tiền (exact: chỉ orders #3, bỏ qua wallets).
2. Order Payment + Refund:
   - Luồng hoàn tiền đơn hàng refundOrderWallet: Pre-read orders không lock để lấy discordUserId, sau đó khóa wallets (#2) FOR UPDATE trước, rồi mới khóa orders (#3) FOR UPDATE.
   - Luồng thanh toán đơn hàng cũng khóa wallets (#2) trước rồi mới khóa orders (#3).
   - Cả hai luồng hoàn toàn tuân thủ Canonical Lock Order: wallets (#2) -> orders (#3).
   ➔ Loại bỏ 100% nguy cơ Lock Inversion và Deadlock giữa Payment và Refund!
3. Wallet Topup + Purchase:
   - Nạp tiền ví SePay khóa wallets (#2) -> wallet_topups (#4).
   - Mua hàng khóa wallets (#2) -> orders (#3).
   ➔ Cùng xuất phát từ ví (#2), không có khóa chéo.
4. Concurrent Order Payment:
   - Hai webhook SePay gửi đồng thời cho cùng một mã đơn hàng orders.code.

Expected Behavior:
- PostgreSQL Deadlock Error Count = 0 (Không phát sinh bất kỳ lỗi 40P01 deadlock_detected nào).
- Toàn bộ transaction tuân thủ Canonical Lock Order 1 -> 5.
- Đạt tính nhất quán giao dịch dựa trên khóa (Lock-based transactional consistency for defined business invariants) trên Read Committed + row locks, số dư ví và trạng thái đơn hàng chính xác 100%.
```

### Test H: Existing Order Wallet Settlement Policy & Notification Test
Kiểm thử chính sách xử lý thanh toán thiếu và thông điệp khách hàng:
```text
Kịch bản:
- Đơn hàng #ORD-200 có bank_due = 100.000 VNĐ.
- Khách hàng chuyển khoản thiếu: 50.000 VNĐ qua SePay.

Expected Behavior:
1. Xác minh codebase: Hệ thống KHÔNG tồn tại API hay handler settleExistingOrderWithWallet(orderId).
2. Toàn bộ số tiền 50.000 VNĐ được cộng 100% vào ví khách hàng (wallets.balance += 50k).
3. Ghi sổ cái: ref_type = 'sepay_transaction', ref_id = sepay_transactions.id, kind = 'order_partial_credit'.
4. Trạng thái đơn hàng: status giữ nguyên 'pending', bank_due giữ nguyên 100.000 VNĐ (không giảm).
5. sepay_transactions.status chuyển sang 'underpaid'.
6. Discord Notification Text gửi khách hàng:
   - Thông báo số tiền 50.000 VNĐ đã vào ví an toàn.
   - Hướng dẫn khách hàng 2 lựa chọn được hỗ trợ thực tế:
     (1) Chuyển khoản đủ chính xác 100.000 VNĐ cho đơn hàng này, HOẶC
     (2) Chờ đơn hết hạn/hủy để tạo đơn mới: đơn mới sẽ tự động áp dụng 50.000 VNĐ số dư ví hiện có.
   - TUYỆT ĐỐI KHÔNG hứa hoặc gợi ý khách có thể "dùng số dư ví để hoàn tất đơn hàng đang pending này".
```

### Test I: Payment Freeze & Provider Verification Test
Kiểm thử cơ chế đóng băng thanh toán và xác minh nhà cung cấp trong cửa sổ Cutover:
```text
Kịch bản: Kích hoạt GLOBAL_MAINTENANCE_MODE = true (T-0 đến T+6).

Expected Behavior:
1. Đối với Cổng SePay:
   - Operator hoàn thành checklist xác minh "Auto-Retry on 5xx" đang BẬT trên SePay Merchant Dashboard tại T-10m.
   - Trong thời gian Freeze: Webhook endpoint trả về HTTP 503 Service Unavailable kèm Retry-After: 60.
   - SePay gateway nhận 503 và tự động đưa webhook vào hàng đợi retry.
   - Bộ đệm Durable Ingress Buffer ghi nhận an toàn payload vào disk buffer (data/sepay_ingress_buffer.jsonl).
   - Tại T+6: Toàn bộ webhook được replay và xử lý chính xác trên Neon Authoritative DB, không drop thanh toán.
2. Đối với Cổng Card2k:
   - Xác minh mã nguồn scheduler.ts:555: Card2k không có webhook callback, sử dụng outbound polling client.
   - Tại T-0: Modal submit lệnh /napthe trên Bot Discord bị khóa (trả ephemeral bảo trì).
   - Scheduler sweep pollPendingCards tạm dừng trong suốt 6 phút cutover.
   - Toàn bộ thẻ pending trong card_topups được bảo toàn và migrate an toàn sang Neon.
   - Tại T+6: Polling sweep được kích hoạt lại trên Neon DB, quét và settle đầy đủ mọi thẻ cào.
   - Kết quả: Không có giao dịch thẻ hay bank nào bị silently dropped hoặc thất thoát.
```

### Test J: Multiple Order Underpayments Test (Financial Event Isolation)
Mô phỏng trường hợp một đơn hàng nhận nhiều khoản chuyển khoản thiếu liên tiếp:
```text
Kịch bản:
- Đơn hàng #ORD-100 có bank_due = 100.000 VNĐ.
- Khách chuyển khoản lần 1: 40.000 VNĐ -> Webhook SePay #TX-1 đến hệ thống.
- Khách chuyển khoản lần 2: 60.000 VNĐ -> Webhook SePay #TX-2 đến hệ thống.

Expected Behavior:
1. Webhook #TX-1 (40k):
   - Ví khách hàng: +40.000 VNĐ (balance = 40.000đ).
   - wallet_ledger entry #1: delta = +40.000, kind = 'order_partial_credit', ref_type = 'sepay_transaction', ref_id = tx1.id.
   - sepay_transactions status = 'underpaid', order_id = ORD-100, topup_id = NULL.
   - Đơn hàng giữ nguyên: status = 'pending', bank_due = 100.000đ (không giảm).
2. Webhook #TX-2 (60k):
   - Ví khách hàng: +60.000 VNĐ (balance = 100.000đ).
   - wallet_ledger entry #2: delta = +60.000, kind = 'order_partial_credit', ref_type = 'sepay_transaction', ref_id = tx2.id.
   - sepay_transactions status = 'underpaid', order_id = ORD-100, topup_id = NULL.
   - Đơn hàng giữ nguyên: status = 'pending', bank_due = 100.000đ.
3. Database Invariants:
   - TUYỆT ĐỐI KHÔNG BỊ UNIQUE CONSTRAINT CONFLICT trên Partial Unique Index của wallet_ledger (do ref_id khác biệt: tx1.id vs tx2.id).
   - Ràng buộc chk_sepay_target_exclusivity thỏa mãn (order_id set, topup_id NULL).
   - Traceability toàn vẹn 100%: sepay_transactions trỏ tới order; ledger trỏ tới sepay_transaction.
   - Khách có thể chuyển đủ 100k cho đơn này, hoặc chờ đơn hết hạn để tạo đơn mới (hệ thống sẽ tự động trừ 100k ví).
```

### Test K: Same SePay Retry After Process Crash Test (Non-Terminal Resume)
Mô phỏng sự cố tiến trình sập sau khi đã insert bản ghi SePay nhưng chưa kịp xử lý nghiệp vụ:
```text
Kịch bản:
- Webhook SePay #TX-3 gửi đến hệ thống.
- Hệ thống chèn sepay_transactions với status = 'received'.
- Tiến trình bị crash đột ngột (SIGKILL) trước khi khóa ví và cộng tiền.
- Gateway SePay retry gửi lại cùng payload với sepay_id = TX-3.

Expected Behavior:
1. Hệ thống tra cứu bản ghi sepay_id = TX-3 và nhận diện status = 'received' (non-terminal).
2. Không bị drop silently bởi naive ON CONFLICT DO NOTHING.
3. Hệ thống xin khóa dòng sepay_transactions FOR UPDATE, xác định user và khóa ví, thực hiện cộng tiền ví an toàn.
4. Ghi wallet_ledger đúng 1 lần, chuyển sepay_transactions status sang 'credited'.
5. Kết quả: Ví khách hàng chỉ được cộng đúng 1 lần tiền (No duplicate wallet credit).
```

### Test L: Unmatched SePay Late-Order Reconciliation Test
Mô phỏng trường hợp tiền về trước khi khách tạo đơn hàng hoặc tạo phiếu nạp:
```text
Kịch bản:
- Webhook SePay #TX-4 gửi đến kèm nội dung chuyển khoản mã ABC.
- Mã ABC tại thời điểm đó chưa tồn tại trong hệ thống (chưa có order hoặc topup).
- Hệ thống ghi nhận sepay_transactions với status = 'unmatched', order_id = NULL, topup_id = NULL.
- 5 phút sau, khách hàng tạo đơn hàng hoặc phiếu nạp ví với mã ABC.
- Tiến trình retry webhook hoặc job reconciliation đối soát quét lại giao dịch #TX-4.

Expected Behavior:
1. Giao dịch #TX-4 không bị loại bỏ vĩnh viễn.
2. Bộ đối soát nhận diện mã ABC nay đã hợp lệ, khóa đơn/phiếu nạp và hoàn tất quy trình nghiệp vụ.
3. sepay_transactions chuyển trạng thái từ 'unmatched' sang 'credited' (hoặc 'underpaid'/'overpaid' tùy số tiền), cập nhật đúng quan hệ độc quyền order_id hoặc topup_id.
4. Dữ liệu ví và đơn hàng cập nhật chính xác, không thất thoát giao dịch.
```

### Test M: Global Write Freeze Enforcement Test (7 Writers)
Mô phỏng nỗ lực ghi dữ liệu của toàn bộ 7 business writers trong cửa sổ cutover:
```text
Kịch bản:
- Hệ thống đang trong trạng thái GLOBAL_MAINTENANCE_MODE = true (T-0 đến T+6).
- Đồng thời phát sinh:
  1. Lệnh Bot Discord (/buy, nút Thanh toán, modal /napthe)
  2. Request Dashboard Mutation (POST /api/orders)
  3. Worker Delivery claim job
  4. Scheduler Cron Job quét đơn và Card2k sweep
  5. Webhook SePay gửi thông báo chuyển khoản

Expected Behavior:
1. Bot Discord: Trả ephemeral thông báo bảo trì, 0 write DB.
2. Dashboard API: Trả HTTP 503 kèm header Retry-After: 60, 0 write DB.
3. Worker & Scheduler: Bị khóa tạm thời, không thực hiện claim hay update.
4. Webhook SePay: Trả HTTP 503 kèm Retry-After: 60 (ghi nhận vào Ingress Buffer).
5. Database Neon: Duy nhất script migration thực thi các batch transaction; hoàn toàn không có mutation ngoại vi nào xen lẫn.
```

### Test N: Concurrency, Token Compensation & Delivery Stale Lease Recovery Test
Kiểm thử các tình huống tranh chấp tài nguyên và phục hồi tiến trình:
```text
Expected Behavior:
1. Concurrency trên Wallet Topup (Hai webhook cùng mã topup):
   - Đúng 1 giao dịch credit tiền ví thành công theo Dynamic Real-Amount Credit Policy.
   - Đúng 1 dòng wallet_ledger được ghi (ref_type = 'topup', ref_id = topup.id).
   - Topup chuyển sang 'credited' đúng một lần.
   - Webhook thứ hai cập nhật sepay status = 'duplicate_transfer', giữ nguyên topup_id gốc, order_id = NULL, không credit đúp ví.
2. Concurrency trên Order Payment (Hai webhook cùng mã đơn hàng):
   - Không double payment, không double ledger.
   - Đúng 1 delivery_job duy nhất được tạo (nhờ unique index order_id, requested_method).
   - Trạng thái đơn hàng nhất quán tuyệt đối (status = 'paid', bank_due = 0).
3. Download Token Compensation (Hai request cùng token hash):
   - Tối đa đúng 1 request claim thành công và nhận stream tệp (HTTP 200).
   - Request còn lại bị từ chối ngay lập tức (HTTP 410 Gone / 403 Forbidden).
   - Nếu tệp trên đĩa bị thiếu trước khi stream: Token được bồi hoàn unclaim (used_at = NULL) và trả HTTP 503.
4. Delivery Job Stale Recovery:
   - Worker claim job (status = 'processing'), sau đó crash đột ngột.
   - Sau khi hết hạn lease (locked_at < now() - 5 phút), job được coi là stale.
   - Worker khác tự động reclaim an toàn bằng claim_token mới, không tạo duplicate delivery intent.
   - Thực hiện giao hàng thành công và ghi delivery_logs (requested = attachment, actual = fallback_link).
```

---

## 15. Files To Modify

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
   - Thêm định nghĩa 6 bảng Business: `wallet_topups`, `discount_code_redemptions`, `download_tokens`, `delivery_logs`, `delivery_jobs`, `migration_checkpoints`.
   - Bổ sung bảng `wallet_topups` hỗ trợ **Dynamic Real-Amount Credit Policy** (`amount`, `paidAmount`, `status`: pending, expired, credited).
   - Thêm **CHECK Constraint loại trừ tương hỗ** trên `sepay_transactions`: `CONSTRAINT chk_sepay_target_exclusivity CHECK ((order_id IS NULL AND topup_id IS NULL) OR (order_id IS NOT NULL AND topup_id IS NULL) OR (order_id IS NULL AND topup_id IS NOT NULL))`.
   - Bổ sung trường `description`, `status`, `orderId`, `topupId`, `processedAt` vào bảng `sepay_transactions` (chuẩn hóa enum status: `received`, `unmatched`, `credited`, `underpaid`, `overpaid`, `duplicate_transfer` - tuyệt đối không có `refunded`).
   - Thêm **Partial Unique Index** trên `wallet_ledger`: `uniqueIndex('idx_wallet_ledger_ref_kind_unique').on(table.refType, table.refId, table.kind).where(sql\`ref_type != '' AND ref_id IS NOT NULL\`)`.
   - Thêm **Partial Unique Index** cho opening balance: `uniqueIndex('idx_wallet_ledger_opening_balance').on(table.discordUserId).where(sql\`kind = 'opening_balance'\`)`.
   - Thêm **Unique Index `(pluginId, version)`** trên bảng `versions`.
   - Bổ sung **Unique Index `(orderId, requestedMethod)`** trên bảng `delivery_jobs`.
   - Bổ sung `requestedMethod` và `actualMethod` vào bảng `delivery_logs`.
   - Thêm trường `failureReason` vào bảng `download_tokens`.
   - Chuẩn hóa bảng `spigotAccounts` cũ thành **`spigotAccountRefs`** trên Neon: Khóa chính `accountId: uuid().primaryKey()`, `label`, `status`, `health`, `lastVerifiedAt` (loại bỏ 100% các cột mật khẩu, cookie, session, profile).
2. [discord/src/index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts):
   - Xóa bỏ `autoSyncSqliteToNeonIfEmpty`.
   - Chuyển toàn bộ Dependency Injection `db` nghiệp vụ sang `neonDb`.
   - Tách riêng kết nối `vaultSecretsDb` (SQLite nội bộ) cho Spigot accounts.
   - Kiểm tra `VAULT_MASTER_KEY` fail-fast khi khởi động.
   - Hỗ trợ biến `GLOBAL_MAINTENANCE_MODE` đóng băng toàn cục 7 writers.
3. [discord/src/repositories/neon-wallets.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-wallets.ts):
   - Triển khai **Lock-based transactional consistency for defined business invariants (Option A)** trên Read Committed + `FOR UPDATE` và Canonical Lock Order.
   - Viết lại `applyLedgerEntry` sử dụng `db.transaction()` có row-locking.
   - Bổ sung `listLedger`, `listWallets`, `countWallets`, `sumWalletBalances`, `reconcileBalances`.
   - Kiểm soát chặt chẽ danh mục ledger kind và ràng buộc mọi mutation balance phải có ledger entry.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts):
   - Bổ sung `expireStaleOrders`, `refundOrderWallet`, `listUndeliveredPaidOrders`.
   - Triển khai `refundOrderWallet` tuân thủ Canonical Lock Order: Pre-read `orders` không lock để lấy `discordUserId`, sau đó khóa `wallets (#2) FOR UPDATE` trước, rồi khóa `orders (#3) FOR UPDATE`. Loại bỏ 100% nguy cơ Lock Inversion với `openOrder` và `matchOrderPayment`.
5. [discord/src/services/payment/match-and-fulfil-order.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts):
   - Áp dụng Pre-Read không lock để lấy `discordUserId` trước khi xin khóa theo Canonical Lock Order.
   - Tối ưu hóa khóa hàng: Exact payment không khóa ví; Underpay/Overpay khóa `wallets` trước rồi mới khóa `orders`.
   - Xử lý SePay Retry / Dedupe semantics (phân biệt Case A terminal no-op, Case B resume crash, Case C reconcile unmatched). Tuyệt đối không tham chiếu trạng thái `refunded`.
   - Đảm bảo `chk_sepay_target_exclusivity`: Order payment gán `order_id` và `topup_id = NULL`; topup payment gán `topup_id` và `order_id = NULL`. Duplicate transfer bảo toàn đối tượng gốc.
   - Tích hợp Order Underpayment với `ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id` và thông điệp minh bạch không giảm bank_due, không hứa hẹn tính năng dùng ví trả nốt đơn pending.
   - Tách toàn bộ External Side Effects ra ngoài DB transaction.
6. [discord/src/services/maintenance/scheduler.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/maintenance/scheduler.ts):
   - Hỗ trợ tạm dừng scheduler sweep `pollPendingCards` khi `GLOBAL_MAINTENANCE_MODE=true` và tái kích hoạt trên Neon tại T+6.
7. [discord/src/services/card/submit-card-topup.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts):
   - Chặn submit thẻ cào khi hệ thống ở chế độ bảo trì toàn cục.
8. [discord/src/services/delivery/deliver-version.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts):
   - Tích hợp Lease Timeout & Worker Stale Recovery Policy với `claimToken`.
   - Phân biệt rõ `requestedMethod` và `actualMethod` khi ghi log.
9. [discord/src/services/delivery/mint-download-token.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts):
   - Triển khai Authorization và Failure Policy: Validate -> Atomic Claim -> Verify File -> Stream, kèm bồi hoàn unclaim token nếu tệp bị thiếu.

---

## 16. Files To Add

1. `discord/src/repositories/neon-wallet-topups.ts`: Quản lý nạp tiền ngân hàng trên Neon với **Dynamic Real-Amount Credit Policy** (luôn cộng số tiền thực nhận `paidAmount = receivedAmount`, áp dụng giống nhau cho `pending` và `expired`).
2. `discord/src/repositories/neon-card-topups.ts`: Quản lý nạp thẻ cào Card2k trên Neon.
3. `discord/src/repositories/neon-download-tokens.ts`: Quản lý token tải file với atomic claim và compensation logic.
4. `discord/src/repositories/neon-delivery-logs.ts`: Quản lý nhật ký phát file kèm `requestedMethod` và `actualMethod`.
5. `discord/src/repositories/neon-delivery-jobs.ts`: Hàng đợi giao hàng bền vững với Lease Timeout, Claim Token và Stale Recovery Worker.
6. `discord/src/repositories/neon-spigot-refs.ts`: Quản lý tham chiếu trạng thái Spigot qua UUID bất biến (`account_id`, `label`, `status`, `health`, `last_verified_at` - zero secret credentials).
7. `discord/scripts/migrate-sqlite-to-neon-full.ts`: Script di chuyển dữ liệu nghiệp vụ theo **16-step Foreign-Key Dependency DAG** (Parent ➔ Child), In-Memory ID Mapping, Atomic Checkpoint Batches (`status = 'completed'` inside commit), UUID Account Bridge (zero secret copying), Opening Balance logic, và Secret Hygiene.
8. `discord/tests/neon-payment-atomicity.test.ts`: Bộ kiểm thử tự động toàn diện kiểm tra tính nguyên tử, idempotency, atomic consumption, duplicate jobs, lease recovery, lock order không deadlock và concurrency trên Neon.

---

## 17. Acceptance Criteria

1. [ ] **Wallet Topup Amount Policy Enforced**: Luôn credit đúng số tiền thực nhận (`receivedAmount > 0`), không phụ thuộc số tiền yêu cầu. `wallets.balance += receivedAmount`, `wallet_ledger delta = receivedAmount`, `paidAmount = receivedAmount`, `status = 'credited'`. Áp dụng giống nhau cho cả `pending` và `expired`.
2. [ ] **SePay Relation Mutual Exclusivity Enforced**: Đảm bảo toàn vẹn quan hệ `chk_sepay_target_exclusivity`: Unmatched (`order_id IS NULL AND topup_id IS NULL`), Order Payment (`order_id IS NOT NULL AND topup_id IS NULL`), Wallet Topup (`order_id IS NULL AND topup_id IS NOT NULL`). Duplicate transfer giữ nguyên reference gốc.
3. [ ] **Lock-Based Transactional Consistency Enforced (Option A)**: Toàn bộ transaction tuân thủ Read Committed + explicit row locks `FOR UPDATE` + Canonical Lock Order (1->5); loại bỏ toàn bộ claim SERIALIZABLE isolation; bảo đảm 100% invariants dưới high concurrency không deadlock.
4. [ ] **Migration Dependency DAG Executed**: Di chuyển theo 16 bước DAG Parent ➔ Child dựa trên Foreign-Key dependencies. In-memory ID mapping hoàn tất trước khi migrate bảng con; idempotent và an toàn khi restart trên partially populated Neon tables.
5. [ ] **Spigot Account Secret Boundary Preserved**: Zero secrets trên Neon (không mật khẩu, cookie, session, browser profile). Local Secret Vault giữ nguyên vẹn credential mã hóa AES-256-GCM. Neon chỉ nhận `spigot_account_refs` qua `account_id` UUID v4.
6. [ ] **Status Consistency Enforced (Option B)**: Không có bất kỳ business logic nào tham chiếu status không tồn tại trong schema. `sepay_transactions.status` không có `refunded`. Hoàn tiền thuộc độc quyền `orders.status` và `wallet_ledger.kind`.
7. [ ] **Lock Inversion Eliminated & Deadlock Tests Pass**: Toàn bộ codebase tuân thủ một canonical lock order duy nhất: `1. discount -> 2. wallet -> 3. order -> 4. topup -> 5. delivery_job`. `refundOrderWallet` khóa `wallets (#2) -> orders (#3)`. Exact payment không khóa ví. Vượt qua 4 kịch bản kiểm thử deadlock concurrency.
8. [ ] **Existing Order Wallet Settlement Policy Enforced**: Thông điệp và chính sách không hứa hẹn tính năng dùng ví thanh toán đơn đang pending (vì codebase không có). Hướng dẫn đúng hành vi được hỗ trợ: chuyển đủ tiền hoặc chờ hết hạn đặt đơn mới.
9. [ ] **Payment Freeze & Provider Assumptions Verified**: SePay kiểm tra checklist bật auto-retry trước cutover và trả 503 kèm Ingress Buffer. Card2k xác nhận hoạt động theo mô hình outbound polling (không phải webhook), khóa modal tại T-0, tạm dừng scheduler và tiếp tục sweep an toàn tại T+6 với zero dropped cards.
10. [ ] **Order Bank Payment & Underpayment Specified**: Underpayment sử dụng `ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id`, `kind = 'order_partial_credit'`; không giảm `bank_due`; không xảy ra unique conflict khi chuyển thiếu nhiều lần.
11. [ ] **SePay Retry & Resume Semantics Verified**: Phân biệt rõ terminal duplicate (no-op) với non-terminal received/unmatched (resume/reconcile dưới khóa hàng); không tạo duplicate wallet credit.
12. [ ] **Migration Checkpoint Atomicity Verified**: Dữ liệu nghiệp vụ và checkpoint với `status = 'completed'` của cùng một batch commit atomically trong 1 transaction; restart/crash nhiều lần an toàn 100%.
13. [ ] **Global Write Freeze Enforced**: Đóng băng toàn bộ 7 business writers trong thời gian cutover; không làm mất mát giao dịch.
14. [ ] **Version Business Identity Defined**: Natural key của versions là `(plugin_id, version)` có unique index; SHA256 chỉ dùng để audit và kiểm tra toàn vẹn file.
15. [ ] **Download Token Failure Policy Applied**: Endpoint kiểm tra tuần tự; nếu tệp bị thiếu trước khi stream, tự động bồi hoàn unclaim token (`used_at = NULL`) và trả HTTP 503.
16. [ ] **Delivery Job Lease & Recovery Active**: Job có `claimToken`, timeout lease 5 phút; worker crash tự động được worker khác reclaim an toàn, không sinh duplicate intent.
17. [ ] **Master Encryption Key Isolated**: Master key không nằm trong database, nạp từ `VAULT_MASTER_KEY` môi trường, kiểm tra fail-fast khi khởi động.
18. [ ] **No Production SQLite Business Writes**: Không còn câu lệnh ghi dữ liệu nghiệp vụ (orders, wallets, ledger, payments) nào vào SQLite tại runtime production.
19. [ ] **Single Source of Truth Verified**: Discord Bot và Web Dashboard cùng đọc/ghi một hàng dữ liệu đơn hàng và số dư ví trên Neon theo thời gian thực.
20. [ ] **Partial Unique Index Applied**: Sử dụng Partial Unique Index trên `wallet_ledger` và opening balance, ngăn nạp đúp tiền ở mức database mà không vi phạm cú pháp PostgreSQL.
21. [ ] **Payment Traceability Established**: Mọi bản ghi `sepay_transactions` lưu vết rõ ràng `order_id`, `topup_id`, `status` tường minh và `processed_at`.
22. [ ] **Expired Topup Handled**: Topup hết hạn chuyển trạng thái hợp lệ sang `credited` khi tiền về muộn theo Dynamic Real-Amount Credit Policy, không làm thất thoát tiền của khách.
23. [ ] **Delivery Outcome Formally Distinguished**: `requestedMethod` và `actualMethod` được phân biệt rõ; crash recovery ghi đúng `actualMethod = 'fallback_link'`.
24. [ ] **Wallet Opening Balance Reconciled**: Tự động nhận diện tính toàn vẹn của ledger; chỉ bù tối đa 1 dòng `opening_balance` khi thật sự thiếu; invariant số dư = tổng delta đạt 100%.
25. [ ] **Secret Migration Hygiene**: Artifacts cũ (db, wal, dumps) được bảo vệ, cấm commit Git, cấm log mật khẩu.
26. [ ] **Existing UX Unchanged**: Trải nghiệm nút bấm, modal, menu trên Bot Discord và Web Dashboard giữ nguyên 100%.
27. [ ] **Existing Tests Pass**: Toàn bộ 34 test suites hiện tại vượt qua 100%.

---

## 18. Risks & Mitigation

| Rủi ro kỹ thuật | Mức độ | Nguyên nhân gốc rễ | Biện pháp giảm thiểu triệt để |
| :--- | :---: | :--- | :--- |
| **Kẹt tiền nạp ví do sai lệch số tiền** | **Cao** | Khách chuyển thiếu hoặc thừa so với phiếu nạp dẫn đến pending vĩnh viễn. | **Dynamic Real-Amount Credit Policy**: Luôn credit đúng số tiền thực nhận (`receivedAmount > 0`) vào ví, áp dụng giống nhau cho cả `pending` và `expired`. |
| **Giao dịch SePay trỏ lẫn lộn Order & Topup** | **Cao** | Lỗi code gán cả `order_id` và `topup_id` trên cùng 1 transaction SePay. | **PostgreSQL CHECK Constraint**: Áp dụng `chk_sepay_target_exclusivity` ở cấp độ DB, chặn tuyệt đối việc tham chiếu cả 2 hoặc xóa rỗng reference của duplicate transfer. |
| **Claim sai Serializable Isolation** | **Cao** | Plan tuyên bố Serializable Consistency nhưng runtime chỉ dùng Read Committed. | **Chuẩn hóa Option A**: Đổi sang "Lock-based transactional consistency for defined business invariants" với Read Committed + explicit row locks `FOR UPDATE` + Canonical Lock Order. |
| **Lỗi Foreign Key khi Migrate lại sau Crash** | **Cao** | Migrate theo thứ tự file ngẫu nhiên hoặc bảng con chạy trước khi bảng cha có ID mapping. | **16-Step Dependency DAG & ID Mapping**: Bắt buộc tuân thủ thứ tự DAG Parent ➔ Child, nạp lại In-Memory ID Map từ Natural Keys trước khi chạy bảng con. |
| **Rò rỉ Spigot Credentials / Master Key** | **Nghiêm trọng** | Copy mật khẩu, session, cookies hoặc lưu master key lên Cloud Neon DB. | **Secret Boundary Tuyệt Đối**: Credentials giữ tại Local SQLite `vault_secrets.db` mã hóa AES-256-GCM; Neon chỉ nhận `spigot_account_refs` (UUID v4, label, status); Master key nạp ngoài DB. |
| **Logic tham chiếu Status không tồn tại** | **Cao** | Codebase hoặc test gọi `status = 'refunded'` trên `sepay_transactions`. | **Option B Schema Alignment**: Bỏ hoàn toàn `refunded` khỏi SePay; hoàn tiền quản lý 100% tại `orders.status` và `wallet_ledger.kind`. |
| **Deadlock do Lock Inversion** | **Cao** | `refundOrderWallet` khóa `orders -> wallets` trong khi `openOrder` và bank payment khóa `wallets -> orders`. | **Pre-Read & Canonical Lock Order**: Pre-read không lock để lấy `discordUserId`, khóa `wallets (#2)` trước `orders (#3)` trong mọi flow; exact payment không khóa ví. |
| **Hứa hẹn tính năng không tồn tại cho khách** | **Trung bình** | DM bảo khách dùng ví thanh toán nốt đơn hàng pending nhưng hệ thống không có API đó. | **Realistic Notification Policy**: Sửa DM hướng dẫn đúng 2 lựa chọn thực tế: chuyển đủ bank_due hoặc đợi đơn hết hạn để tạo đơn mới. |
| **Mất giao dịch Card2k do ngộ nhận Webhook** | **Cao** | Giả định Card2k tự retry webhook giống SePay khi gặp mã 503. | **Outbound Polling Architecture**: Nhận diện Card2k là outbound polling (`scheduler.ts:555`); tạm khóa modal tại T-0, pause sweep, migrate pending cards và resume polling tại T+6. |
| **Thất thoát Webhook SePay trong Cutover** | **Cao** | Cấu hình Auto-Retry của merchant chưa bật hoặc mạng lỗi. | **Verification Checklist & Ingress Buffer**: Xác minh dashboard tại T-10m; trang bị local durable buffer tự động replay tại T+6. |
| **Xung đột Unique khi nạp thiếu nhiều lần** | **Cao** | Dùng `ref_type = 'order'` và `ref_id = orderId` khiến lần nạp thiếu thứ hai bị trùng unique key. | **Tách Reference theo SePay Transaction**: Dùng `ref_type = 'sepay_transaction'`, `ref_id = sepay_transactions.id`, mỗi lần chuyển khoản có 1 ledger entry riêng biệt. |
| **Bỏ sót giao dịch SePay khi Crash** | **Cao** | Naive `ON CONFLICT DO NOTHING -> return duplicate` bỏ qua các giao dịch chưa xử lý xong (`status = 'received'`). | **Phân biệt Retry Semantics**: Khóa hàng `FOR UPDATE`, nếu non-terminal thì resume xử lý, nếu terminal mới no-op. |
| **Mất Token khi Tệp hỏng/mất** | **Cao** | Token bị claim (`used_at = now()`) nhưng server không tìm thấy file jar. | **Compensation Unclaim**: Tự động bồi hoàn `used_at = NULL`, trả HTTP 503 và alert Staff. |
| **Treo Delivery Job khi Worker Crash** | **Cao** | Worker nhận job đang gửi thì bị crash, job vĩnh viễn ở trạng thái `processing`. | **Lease & Stale Recovery**: Quá hạn 5 phút tự động cho phép worker khác reclaim bằng `claim_token` mới. |
| **Lệch trạng thái Checkpoint Migration** | **Cao** | Dữ liệu commit nhưng checkpoint lỗi (hoặc ngược lại). | **Batch Atomicity**: Gom mutation business data và checkpoint `status = 'completed'` của batch vào cùng 1 transaction. |
| **Đứt gãy liên kết Account khi đổi tên** | **Cao** | Dùng `label` làm khóa tự nhiên liên kết giữa Local và Neon. | **UUID Identity Bridge**: Cố định `account_id` dạng UUID v4 vĩnh viễn. |
| **Mất giao dịch khi Rollback sai cách** | **Nghiêm trọng** | Khôi phục database bằng cách ghi đè backup SQLite cũ sau cutover. | **Cấm Rollback ghi đè DB**: Chỉ Rollback Application code; nếu lỗi DB thì dùng Neon PITR. |

---

READY FOR IMPLEMENTATION

