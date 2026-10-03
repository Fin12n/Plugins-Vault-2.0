# PHASE 1 — NEON DATABASE AUTHORITY PLAN (SPEC & EXECUTION BLUEPRINT)

> **Mục tiêu tối thượng**: Thiết lập **Neon PostgreSQL** làm **Single Source of Truth** duy nhất cho toàn bộ dữ liệu nghiệp vụ (Business Data), xóa bỏ hoàn toàn trạng thái chia tách dữ liệu (Split-Brain) giữa Discord Bot và Web Dashboard mà **không rewrite bot, không đổi UI/UX, không thêm feature mới và không can thiệp CloakBrowser**.

---

## 1. Current State (Hiện trạng Split-Brain)

1. **Discord Bot Runtime**:
   - Sử dụng tệp SQLite cục bộ (`data/deps.db` hoặc `data/vault.db`) qua thư viện `better-sqlite3` đồng bộ ([connection.ts:L23-L32](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/db/connection.ts#L23-L32)).
   - Toàn bộ giao dịch tiền bạc cốt lõi bao gồm: tạo đơn hàng ([orders.ts:L29-L61](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/orders.ts#L29-L61)), trừ số dư ví ([wallets.ts:L55-L96](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L55-L96)), ghi sổ cái ([wallets.ts:L78-L90](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/wallets.ts#L78-L90)), xử lý webhook ngân hàng SePay ([match-and-fulfil-order.ts:L156-L237](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/match-and-fulfil-order.ts#L156-L237)), nạp thẻ cào Card2k ([submit-card-topup.ts:L70-L130](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/card/submit-card-topup.ts#L70-L130)), cấp link tải một lần ([mint-download-token.ts:L17-L30](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/mint-download-token.ts#L17-L30)), và nhật ký giao file ([deliver-version.ts:L135-L163](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/deliver-version.ts#L135-L163)) đều được ghi độc quyền vào SQLite.
2. **Dashboard Backend Runtime**:
   - Khởi tạo kết nối trực tiếp tới Neon PostgreSQL thông qua gói `@vault/db` ([neon.ts:L8](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/db/neon.ts#L8)).
   - Các API truy vấn danh sách đơn hàng ([orders-routes.ts:L36-L50](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/orders-routes.ts#L36-L50)), số dư ví ([wallets-routes.ts:L21-L40](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/wallets-routes.ts#L21-L40)) hoàn toàn đọc từ Neon PostgreSQL.
3. **Hệ quả**:
   - Đơn hàng tạo từ Discord Bot không hiển thị trên Dashboard.
   - Số dư ví trên Discord Bot và Dashboard bị lệch, có nguy cơ ghi đè lẫn nhau.

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

---

## 3. SQLite Inventory Summary

| File | Function | Table / Data | Read/Write | Runtime | Replacement |
| :--- | :--- | :--- | :---: | :---: | :--- |
| `connection.ts:L23-L49` | `openDb`, `initDb` | Toàn bộ SQLite | R/W | CONFIG/LOCAL | `initNeonDb(env.DATABASE_URL)` từ `@vault/db` |
| `orders.ts:L29-L61` | `createOrder` | `orders` | Write | BUSINESS DATA | `neon-orders.ts` -> `createOrder(neonDb, input)` |
| `orders.ts:L63-L77` | `findOrderById`, `findOrderByCode` | `orders` | Read | BUSINESS DATA | `neon-orders.ts` -> `findOrderById`, `findOrderByCode` |
| `orders.ts:L79-L92` | `markOrderPaid`, `markOrderDelivered` | `orders` | Write | BUSINESS DATA | `neon-orders.ts` -> `updateOrderStatus` |
| `orders.ts:L136-L160` | `expireStaleOrders` | `orders`, `wallets` | R/W (Tx) | BUSINESS DATA | `neon-orders.ts` (Tx) |
| `orders.ts:L173-L197` | `refundOrderWallet` | `orders`, `wallets` | R/W (Tx) | BUSINESS DATA | `neon-orders.ts` (Tx atomic refund) |
| `orders.ts:L208-L242` | `recordSepayTransaction` | `sepay_transactions` | Write | BUSINESS DATA | `neon-sepay.ts` (ON CONFLICT DO NOTHING) |
| `wallets.ts:L14-L31` | `findWallet`, `getBalance` | `wallets` | Read | BUSINESS DATA | `neon-wallets.ts` -> `getWalletBalance` |
| `wallets.ts:L55-L96` | `applyLedgerEntry` | `wallets`, `wallet_ledger` | R/W (Tx) | BUSINESS DATA | `neon-wallets.ts` -> `applyLedgerEntry` (Tx + Row-Locking) |
| `wallet-topups.ts:L33-L78` | `createWalletTopup`, `markTopupCredited` | `wallet_topups` | R/W | BUSINESS DATA | Tạo mới `neon-wallet-topups.ts` |
| `card-topups.ts:L45-L162` | `createCardTopup`, `claimCardCredit` | `card_topups` | R/W (Tx) | BUSINESS DATA | Tạo mới `neon-card-topups.ts` |
| `discounts.ts:L24-L208` | `createDiscountCode`, `redeemDiscountCode`| `discount_codes`, `discount_code_redemptions` | R/W (Tx) | BUSINESS DATA | Tạo bảng Neon & chuyển sang `neon-discounts.ts` |
| `mint-download-token.ts:L17-L66`| `mintDownloadToken`, `redeemDownloadToken` | `download_tokens` | R/W | BUSINESS DATA | Tạo bảng Neon & chuyển `neon-download-tokens.ts` |
| `deliver-version.ts:L135-L163` | `recordDelivery` | `audit_log` | Write | BUSINESS DATA | Tạo bảng Neon `delivery_logs` |
| `settings-store.ts:L24-L65` | `getSettings`, `seedSettings` | `config` | R/W | CONFIG | Đọc/Ghi bảng `config` trong Neon |

---

## 4. Neon Schema Gaps (5 Bảng Cần Thêm Mới)

1. **`wallet_topups`**: Lưu phiếu nạp tiền qua tài khoản ngân hàng SePay (`id`, `code`, `discord_user_id`, `amount`, `paid_amount`, `status`, `created_at`, `expires_at`, `credited_at`).
2. **`discount_code_redemptions`**: Lưu vết sử dụng mã giảm giá (`id`, `discount_id`, `discord_user_id`, `order_id`, `discount_amount`, `redeemed_at`).
3. **`download_tokens`**: Lưu mã hash tải một lần bảo mật qua web (`token_hash`, `version_id`, `discord_user_id`, `order_id`, `expires_at`, `used_at`, `created_at`).
4. **`delivery_logs`**: Nhật ký giao nhận file plugin jar của bot (`id`, `discord_user_id`, `version_id`, `order_id`, `plugin_name`, `version_label`, `amount`, `delivery_method`, `ip`, `delivered_at`).
5. **`account_scan_state`**: Trạng thái quét trang đã mua của tài khoản Spigot (`account_label`, `last_scan_at`, `resource_count`, `last_error`).

---

## 5. Transaction Analysis & Safety Rules

1. **Row-Level Locking (`FOR UPDATE`) khi xử lý Ví**:
   - `SELECT balance FROM wallets WHERE discord_user_id = $1 FOR UPDATE` bên trong `neonDb.transaction()`.
   - Ngăn chặn triệt để tình trạng hai đơn hàng mở cùng một lúc gây âm ví hoặc trừ tiền sai lệch.
2. **Idempotency Guard cho Webhook SePay**:
   - Sử dụng `ON CONFLICT (sepay_id) DO NOTHING RETURNING id` để đảm bảo webhook gửi lại (retry) không bao giờ bị xử lý hai lần.
3. **Atomic Exactly-Once Refund**:
   - Cập nhật `UPDATE orders SET wallet_paid = 0 WHERE id = $1 AND wallet_paid > 0 RETURNING ...` trước khi hoàn trả tiền vào ví.

---

## 6. Zero Data Loss Migration Strategy

1. **Cold Backup**: Checkpoint WAL và sao lưu file vật lý `data/vault.db`.
2. **Schema Migration**: Drizzle Push / Migrate bổ sung 5 bảng còn thiếu.
3. **Data Extraction & Transformation**: Chạy script chuyển đổi kiểu dữ liệu (Unix epoch -> ISO timestamp, boolean, JSON).
4. **Financial Reconciliation**:
   - Đối chiếu số lượng dòng `COUNT(*)` giữa SQLite và Neon.
   - So sánh tổng số dư ví `SUM(wallets.balance)` và tổng tiền đơn hàng `SUM(orders.amount)`.
   - Kiểm tra `reconcileBalances` đảm bảo không có độ lệch nào giữa số dư ví và sổ cái (`wallet_ledger`).
5. **Sequence Reset**: Cập nhật giá trị sequence tự tăng trên Postgres cho toàn bộ các bảng serial.

---

## 7. Runtime Cutover & Cleanup

1. **Dependency Injection**: Thay đổi `BotDeps.db` từ SQLite `Db` sang Neon `Database`.
2. **Loại bỏ `autoSyncSqliteToNeonIfEmpty()`**: Xóa bỏ hàm đồng bộ cũ vì tiềm ẩn rủi ro logic (bị dừng nếu Neon đã có dữ liệu) và không cần thiết khi Neon đã là nguồn dữ liệu duy nhất.
3. **Lưu trữ SQLite cũ**: Đổi tên file SQLite cũ thành `data/vault_archived.db` (Read-Only) để làm dữ liệu đối soát lịch sử.
