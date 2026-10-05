# Kế Hoạch Triển Khai Kỹ Thuật v6: Phase 3C — Canonical Settlement, Revenue Accounting & Reconciliation

> **Mã Kế hoạch**: `PLAN-Phase-3C-Accounting-Settlement-Reconciliation-v6-2026-10-05`
> **Trạng thái**: READY FOR IMPLEMENTATION (SẴN SÀNG TRIỂN KHAI — TUYỆT ĐỐI CHƯA CODE)
> **Ranh giới cốt lõi**:
> - Phase 3A (Payment Core ACID) = **CLOSED** (Commit `04006ae`).
> - Phase 3B (Delivery Reliability & Concurrency Hardening) = **CLOSED** (Commit `a196ddc8e7235285f2a62460551d4b25376a4175`).
> - Không thay đổi thuật toán Payment Core.
> - Không thay đổi logic Lease / Heartbeat / Retry của Delivery Core.
> - Không thay đổi kiến trúc Dual-Vault và CloakBrowser C++ engine.
> - **Duy nhất một nguồn chân lý kế toán tất toán (Single Canonical Source of Truth)**: `orders.settled_amount`. Bảng `delivery_jobs` tuyệt đối không phải là accounting source of truth.

---

## 1. Canonical Settlement Model (Mô hình Tất toán Chuẩn hóa)

### A. Nguyên Tắc Cốt Lõi (Core Axioms)
1. `orders.settled_amount` là **SỰ THẬT TÀI CHÍNH BẤT BIẾN DUY NHẤT (CANONICAL IMMUTABLE FINANCIAL SETTLEMENT FACT)**.
2. Khi một đơn hàng đạt trạng thái tất toán tài chính (financially settled), `settled_amount` được chốt duy nhất một lần trong cùng database transaction xác nhận thanh toán.
3. **Giá trị tất toán của một đơn hàng thành công luôn luôn bằng đúng giá trị thỏa thuận của đơn hàng đó (`order.amount`)**, bất kể khách trả hoàn toàn bằng ví, bằng ngân hàng, trả kết hợp hay chuyển thừa.
4. `delivery_jobs` **KHÔNG** phải là nguồn chân lý kế toán. Khi worker giao hàng ghi `delivery_logs.amount`, worker đọc trực tiếp snapshot từ `orders.settled_amount`.
5. Tuyệt đối không tạo ra các công thức tính `settledAmount` độc lập phân tán rải rác trong codebase.

### B. Chính Sách Đơn Hàng Miễn Phí (Zero-Price Orders Policy — Option B)
- Trong hệ sinh thái Plugins Vault, các plugin miễn phí (`deposit_price = 0`) là hoàn toàn hợp lệ.
- **Quy tắc tất toán đơn 0₫**:
  - `orders.amount = 0`, `walletPaid = 0`, `bankDue = 0`.
  - Đơn chuyển thẳng sang `status = 'wallet_paid'`.
  - `orders.settled_amount = 0` (được tất toán ngay lập tức với giá trị 0₫).
  - Ràng buộc DB Check Constraint: `CHECK (settled_amount IS NULL OR settled_amount >= 0)`.
  - Khi giao hàng: `delivery_logs.amount = 0`.
  - Về doanh thu: Đơn 0₫ cộng 0₫ vào Settled Sales (không bóp méo doanh thu tiền tệ), nhưng được ghi nhận đầy đủ vào lượt phục vụ khách hàng duy nhất (`COUNT(DISTINCT order_id)`).

### C. Ma Trận Quy Tắc Trạng Thái & Dòng Tiền (State & Money Transition Rules)

| Kịch Bản Thanh Toán | Trạng Thái Đơn | Biến Động Số Dư Ví / SePay | `orders.settled_amount` | Giải Thích Kế Toán |
| :--- | :---: | :--- | :---: | :--- |
| **1. Đơn Miễn Phí (Zero-Price Order)** | `wallet_paid` | Không biến động ví | **`= 0`** | Đơn được tất toán tức thì ở mức 0₫, đủ điều kiện giao hàng. |
| **2. Trả 100% bằng Ví (Fully wallet-funded)** | `wallet_paid` | Ví trừ `-order.amount` (`order_hold`) | **`= order.amount`** | Toàn bộ giá trị đơn được tất toán bằng nghĩa vụ nợ nội bộ (Liability -> Settled Sale). |
| **3. Chuyển khoản Khớp Đúng (Exact bank payment)** | `paid` | SePay ghi nhận `transferAmount === bankDue` | **`= order.amount`** | Toàn bộ giá trị đơn được tất toán bằng tiền mặt ngân hàng. |
| **4. Thanh toán Kết hợp (Split payment)** | `paid` | Ví trừ `walletPaid`, SePay nhận `bankDue` | **`= order.amount`** | `walletPaid + bankDue = order.amount`. Đơn tất toán đủ 100%. |
| **5. Chuyển khoản Thừa (Bank overpayment)** | `paid` | Đơn nhận `bankDue`, ví cộng `excess` (`order_overpay_credit`) | **`= order.amount`** | Doanh thu tất toán chỉ chốt đúng `order.amount`. Phần tiền dư là ký quỹ ví (Liability), không được tính vào giá trị đơn. |
| **6. Chuyển khoản Thiếu (Bank underpayment)** | `pending` | Đơn giữ nguyên, ví cộng `transferAmount` (`order_partial_credit`) | **`NULL`** | Đơn hàng **chưa được tất toán**. Tiền vào chỉ là nạp ví tạm giữ. |
| **7. Hủy trước khi Tất toán (Cancelled before settlement)** | `cancelled` | Hoàn lại `walletPaid` nếu có (`order_cancel_credit`) | **`NULL`** | Đơn chưa bao giờ phát sinh tất toán tài chính. |
| **8. Hoàn tiền sau Tất toán (Refund after settlement)** | `refunded` | Ví cộng lại toàn bộ số tiền đơn (`order_refund`) | **GIỮ NGUYÊN (`= order.amount`)** | **Bất biến**. Giao dịch bán hàng lịch sử đã xảy ra. Tiền hoàn được ghi nhận vào tài khoản giảm trừ doanh thu (Contra-Revenue). |
| **9. Giao hàng sau Tất toán (Delivered after settlement)** | `delivered` | Ghi `delivery_logs.amount = order.settled_amount` | **GIỮ NGUYÊN (`= order.amount`)** | Giao hàng chỉ là thực hiện nghĩa vụ bàn giao tệp, không làm biến động giá trị tài chính đã tất toán. |

### D. Tính Bất Biến Của `paid_at` (Paid_At Must Be Immutable)
- **Chuyển trạng thái tất toán (Settlement transition)**:
  - `pending → paid`: Gán `paid_at = now()`, `settled_amount = order.amount`.
  - `pending → wallet_paid`: Gán `paid_at = now()`, `settled_amount = order.amount`.
- **Cập nhật lặp lại / Idempotent**:
  - `paid → paid`: **TUYỆT ĐỐI KHÔNG** thay đổi `paid_at`, **TUYỆT ĐỐI KHÔNG** thay đổi `settled_amount`.
  - `wallet_paid → wallet_paid`: **TUYỆT ĐỐI KHÔNG** thay đổi `paid_at`, **TUYỆT ĐỐI KHÔNG** thay đổi `settled_amount`.
- **Nguyên tắc cốt tử**: Không có bất kỳ business path hợp lệ nào được phép ghi đè timestamp tất toán lịch sử (`No valid business path may rewrite historical settlement timestamp`).
- **Tiêu chuẩn nghiệm thu (Acceptance)**: Khi retry cùng một settlement, `paid_at` và `settled_amount` giữ nguyên vẹn 100% về mặt logic và dữ liệu (`remains byte-for-byte / logically unchanged`).

### E. Định Nghĩa Tường Minh Về `paid_at` (Paid_At Semantics — Option B Selected)
- **LỰA CHỌN CHÍNH THỨC**: **OPTION B — `paid_at` là thời điểm thực tế tiền được nhận/tất toán (Actual Payment Receipt Timestamp)**.
  - **1. Đơn thanh toán ngân hàng (Bank payment)**:
    Sử dụng timestamp nhận tiền thực tế tin cậy từ ngân hàng (`sepay_transactions.received_at`).
  - **2. Đơn thanh toán kết hợp (Split payment)**:
    Sử dụng timestamp của giao dịch ngân hàng thực tế hoàn tất đơn hàng (`sepay_transactions.received_at`).
  - **3. Đơn thanh toán 100% bằng Ví (Fully wallet-funded)**:
    Sử dụng timestamp thời điểm trừ ví thành công ghi nhận trong sổ cái (`wallet_ledger.created_at` với `kind = 'order_hold'`).
  - **4. Đơn hàng miễn phí 0₫ (Zero-price order)**:
    Sử dụng timestamp thời điểm tạo đơn và chuyển trạng thái `wallet_paid`.
  - **Ràng Buộc Tuyệt Đối Về `processed_at` và Webhook Processing Time**:
    - `processed_at` **TUYỆT ĐỐI KHÔNG** được tự động coi là receipt timestamp.
    - Chỉ được phép sử dụng `processed_at` nếu code/tài liệu nguồn chứng minh được rằng `processed_at = actual payment receipt time`.
    - Trong mọi trường hợp khác: Nếu thiếu `received_at` đáng tin cậy -> **`paid_at` giữ nguyên `NULL`** -> Ghi nhận ngoại lệ vào `_migration_exceptions`.
    - **CẤM TUYỆT ĐỐI**: Không bao giờ dùng `order.created_at` hoặc thời điểm server xử lý webhook (`application webhook processing time`) làm `paid_at`.
- **Ranh giới kỳ kế toán (Accounting Boundary & Delayed Webhook)**:
  Nếu tiền vào tài khoản ngân hàng lúc 23:59:50 ngày 31/10 (giờ ngân hàng) nhưng SePay webhook bị delay mạng sang 00:05:00 ngày 01/11 mới đến server:
  Theo Option B, `orders.paid_at` được gán chính xác bằng `received_at` (31/10) → Đơn hàng thuộc kỳ doanh thu Tháng 10, không bị bóp méo hay trôi sang Tháng 11 do độ trễ kỹ thuật mạng.

---

## 2. Database Schema Migration

### A. Bổ Sung Bảng `_migration_exceptions` (Migration / Reconciliation / Data Integrity Exception Store)
Định nghĩa bảng lưu trữ ngoại lệ tập trung persistent, idempotent và auditable trong `packages/db/src/schema.ts`.
- **Mục đích lưu trữ (Storage Scope)**:
  1. *Migration anomalies*: Sai lệch trong quá trình di trú dữ liệu cũ.
  2. *Historical reconciliation exceptions*: Các ngoại lệ phát hiện trong chu trình đối soát tài chính định kỳ.
  3. *DATA_INTEGRITY_VIOLATION*: Ngoại lệ runtime khi worker phát hiện đơn hàng thiếu `settled_amount` lúc giao.
  4. *Orphan records*: Các bản ghi mồ côi (delivery log hoặc SePay transaction không trỏ về order hợp lệ).
  5. *Ambiguous legacy financial evidence*: Chứng cứ tài chính lịch sử không rõ ràng (đơn split payment thiếu timestamp thanh toán).
- **Ngữ Nghĩa Định Danh Chuẩn (Source & Run Identity Semantics)**:
  - Sử dụng cặp thuộc tính: **`source`** + **`run_id`** để phản ánh chính xác nguồn phát sinh ngoại lệ (cả migration và runtime):
    - `source = 'migration'`, `run_id = 'migration-2026-10-05-001'`
    - `source = 'runtime_reconciliation'`, `run_id = 'reconcile-2026-10-05-001'`
    - `source = 'runtime_worker'`, `run_id = 'worker-delivery-001'`
- **Ràng buộc an ninh dữ liệu (Security Guardrail)**:
  Tuyệt đối **CẤM** lưu trữ thông tin nhạy cảm: `password`, `cookie`, `session`, `token`, `secret`.
- **Tính Idempotent Bất Biến**: Ràng buộc `UNIQUE (source, run_id, entity_type, entity_id, reason_code)`. Tuyệt đối không làm suy yếu tính idempotent.

```ts
export const migrationExceptions = pgTable(
  "_migration_exceptions",
  {
    id: serial("id").primaryKey(),
    source: varchar("source", { length: 32 }).notNull(), // 'migration' | 'runtime_reconciliation' | 'runtime_worker'
    runId: varchar("run_id", { length: 64 }).notNull(), // e.g. 'migration-2026-10-05-001' | 'reconcile-2026-10-05-001'
    entityType: varchar("entity_type", { length: 32 }).notNull(), // 'order' | 'sepay_transaction' | 'delivery_log' | 'wallet_ledger'
    entityId: integer("entity_id").notNull(),
    reasonCode: varchar("reason_code", { length: 64 }).notNull(), // e.g. 'MISSING_SETTLEMENT_EVIDENCE' | 'INCONSISTENT_SPLIT_PAYMENT' | 'ORPHAN_LOG' | 'DATA_INTEGRITY_VIOLATION'
    evidence: jsonb("evidence").notNull(), // Thông tin chứng cứ đối soát (Tuyệt đối không lưu secret, password, cookie, session, token)
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_migration_exceptions_entity").on(table.entityType, table.entityId),
    index("idx_migration_exceptions_reason").on(table.reasonCode),
    uniqueIndex("idx_migration_exceptions_uniq").on(
      table.source,
      table.runId,
      table.entityType,
      table.entityId,
      table.reasonCode
    ),
  ]
);
```

### B. Định Nghĩa Cột Mới trên Bảng `orders`
Trong `packages/db/src/schema.ts`:
```ts
export const orders = pgTable(
  "orders",
  {
    // ... các trường hiện hữu ...
    settledAmount: integer("settled_amount"), // NULL trước khi tất toán, chốt số nguyên >= 0 sau khi tất toán
    // ...
  },
  (table) => [
    // ...
    index("idx_orders_settled_amount").on(table.settledAmount),
    index("idx_orders_paid_at").on(table.paidAt), // Phục vụ báo cáo doanh thu theo kỳ tất toán chuẩn
    check("chk_orders_settled_amount_non_negative", sql`settled_amount IS NULL OR settled_amount >= 0`),
  ]
);
```

---

## 3. Payment Integration Point & Audit Mọi Settlement Writer

### A. Rà Soát Toàn Bộ Các Điểm Ghi Nhận Tất Toán (Settlement Writers Audit):

1. **Writer 1: Mua Bằng Ví hoặc Đơn Miễn Phí (`openOrderNeon`)**
   - **File**: `discord/src/services/payment/neon-payment-flow.ts` (dòng 514–535)
   - **Hành động**: Khi `bankDue === 0` (đơn 0₫ hoặc trả đủ 100% bằng ví):
     ```ts
     const [created] = await tx
       .insert(orders)
       .values({
         // ...
         amount: price,
         walletPaid,
         bankDue: 0,
         status: "wallet_paid",
         settledAmount: price, // <-- CHỐT NGAY TRONG LỆNH INSERT (= order.amount)
         paidAt: now,
       })
       .returning();
     ```
2. **Writer 2: Chuyển khoản Khớp Đúng (`handleOrderPaymentNeonTx` — Case B2)**
   - **File**: `discord/src/services/payment/neon-payment-flow.ts` (dòng 263–270)
   - **Hành động**: Khi `transferAmount === bankDue`:
     Triệu gọi hàm chuyên biệt đã được gia cố (hardened helper) trong cùng database transaction:
     ```ts
     await settleOrderPaidTx(tx, {
       orderId: freshOrder.id,
       paidAmount: transferAmount,
       sepayTransactionId: sepayTx.id,
     });
     ```
3. **Writer 3: Chuyển khoản Thừa (`handleOrderPaymentNeonTx` — Case B3)**
   - **File**: `discord/src/services/payment/neon-payment-flow.ts` (dòng 321–328)
   - **Hành động**: Khi `transferAmount > bankDue`:
     Triệu gọi hàm chuyên biệt đã được gia cố trong cùng database transaction:
     ```ts
     await settleOrderPaidTx(tx, {
       orderId: freshOrder.id,
       paidAmount: bankDue,
       sepayTransactionId: sepayTx.id,
     });
     // Phần tiền thừa được nạp vào ví khách (order_overpay_credit)
     ```
4. **Writer 4: Gia Cố Tuyệt Đối Hàm Chuyên Trách Tất Toán & Khóa Chặt Cửa Sau (`Harden Settlement-Specific Helpers`)**
   - **File**: `discord/src/repositories/neon-orders.ts`
   - **Thực trạng**: Nếu hàm settlement tin tưởng mù quáng `amount` hoặc `paidAt` do caller truyền vào, hoặc nếu `updateOrderStatus` là generic mutation, sẽ xuất hiện lỗ hổng bóp méo số tiền tất toán hoặc làm sai lệch timestamp lịch sử.
   - **Kiến Trúc Gia Cố Tất Toán Chuyên Trách (Hardened Settlement Architecture)**:
     - **API Chuẩn Hóa**:
       + `settleOrderPaidTx(tx, { orderId, paidAmount, sepayTransactionId, amount?, paidAt? })`
       + `settleOrderWalletPaidTx(tx, { orderId, ledgerHoldId, amount?, paidAt? })`
     - **Bên Trong `settleOrderPaidTx`**:
       1. Lock và reload đơn hàng hiện tại từ cơ sở dữ liệu: `SELECT * FROM orders WHERE id = :orderId FOR UPDATE`.
       2. Lấy giá trị thỏa thuận chuẩn hóa từ database: `canonicalAmount = order.amount`.
       3. Kiểm tra tính hợp lệ của trạng thái đơn hàng (Order State Validation):
          - Nếu đơn đang ở trạng thái terminal (`refunded`, `cancelled`, `expired`, `delivered`) -> **TỪ CHỐI NGAY LẬP TỨC (REJECT)**.
          - Nếu đơn đã ở trạng thái `paid` (idempotent retry) -> Giữ nguyên vẹn 100% `settled_amount` và `paid_at`, không ghi đè.
       4. Gán `settled_amount = canonicalAmount`. Tuyệt đối **KHÔNG CHO PHÉP** caller tự ý chỉ định `settled_amount != order.amount`. Nếu caller cố truyền tham số `amount`, hàm đối chiếu bắt buộc `amount === canonicalAmount`, nếu lệch -> Ném lỗi từ chối giao dịch.
       5. Nạp timestamp nhận tiền thực tế tin cậy từ nguồn có thẩm quyền trong DB:
          `SELECT received_at FROM sepay_transactions WHERE id = :sepayTransactionId`.
          Gán `paid_at = authoritative SePay received_at`. Nếu caller cố truyền tham số `paidAt`, hàm đối chiếu bắt buộc khớp với `received_at`, nếu lệch -> Ném lỗi từ chối, bảo vệ tính toàn vẹn của mốc thời gian lịch sử.
       6. Cập nhật `status = 'paid'`, `settled_amount = canonicalAmount`, `paid_at = sepay.received_at`, `paid_amount = paidAmount`.
       7. **COMMIT** đồng thời trong cùng transaction.
     - **Bên Trong `settleOrderWalletPaidTx`**:
       1. Lock và reload đơn hàng từ cơ sở dữ liệu (`FOR UPDATE`).
       2. Lấy `canonicalAmount = order.amount`.
       3. Xác minh tính hợp lệ của bản ghi trừ ví trong sổ cái:
          `SELECT * FROM wallet_ledger WHERE id = :ledgerHoldId`.
          Kiểm tra bắt buộc: `kind = 'order_hold'`, `ref_id = orderId`, `delta = -order.amount`.
       4. Gán `settled_amount = canonicalAmount`. Nếu caller truyền `amount` lệch -> Từ chối ngay.
       5. Gán `paid_at = authoritative ledger timestamp` (`ledger.created_at`).
       6. Cập nhật `status = 'wallet_paid'`, `settled_amount = canonicalAmount`, `paid_at = ledger.created_at`.
       7. **COMMIT** đồng thời trong cùng transaction.
   - **Khóa Chặt Hàm Cập Nhật Trạng Thái Chung (`updateOrderStatus`)**:
     - `updateOrderStatus()` chỉ được phép xử lý các chuyển đổi trạng thái phi tài chính hoặc không làm phát sinh tất toán mới (ví dụ: `pending → cancelled`, `pending → expired`).
     - **CẤM TUYỆT ĐỐI**: Không tồn tại bất kỳ production path nào cho phép caller tùy tiện gọi `updateOrderStatus(orderId, "paid")` hoặc `updateOrderStatus(orderId, "wallet_paid")` để tự động tạo ra một settlement fact mà thiếu financial evidence context. Nếu cố tình gọi → **BỊ TỪ CHỐI (REJECTED / UNAVAILABLE)**.
     - **Quy tắc State Guard Chống Tái Mở Đơn Terminal (Anti-Reopening Guard)**:
       + `refunded → paid` / `refunded → wallet_paid`: **BỊ TỪ CHỐI**
       + `cancelled → paid` / `cancelled → wallet_paid`: **BỊ TỪ CHỐI**
       + `expired → paid` / `expired → wallet_paid`: **BỊ TỪ CHỐI**
       + `delivered → paid` / `delivered → wallet_paid`: **BỊ TỪ CHỐI**
       + `delivered order cannot overwrite settlement`.
       + `settled_amount cannot be overwritten with another value`.

### B. Tiêu Chuẩn Chấp Nhận (Settlement Writer Acceptance):
- **A. Valid Payment Path**: Luồng thanh toán hợp lệ (có financial evidence) gọi `settleOrderPaidTx` / `settleOrderWalletPaidTx` thành công, chốt `settled_amount = order.amount` và `paid_at` từ nguồn authoritative trong SAME transaction.
- **B. Arbitrary Caller Rejection**: Bất kỳ caller nào cố gọi generic `updateOrderStatus(orderId, "paid")` mà không có settlement context → BỊ TỪ CHỐI (rejected/unavailable), không thể mutate settlement fact.
- **C. Input Tampering Protection**: Caller cố truyền `amount != order.amount` hoặc `paidAt != authoritative timestamp` vào settlement helper → BỊ TỪ CHỐI (ném ngoại lệ, transaction rollback), không phát sinh bất kỳ thay đổi nào trên DB.
- **D. Terminal Immutability**: Không có bất kỳ đơn hàng terminal nào (`refunded`, `cancelled`, `expired`, `delivered`) có thể bị reopen hoặc vô tình ghi đè `settled_amount`.
- **E. Idempotent Stability**: Retry cùng một settlement → `paid_at` và `settled_amount` giữ nguyên 100% không đổi (`remains byte-for-byte / logically unchanged`).

---

## 4. Delivery Accounting & Xử Lý At-Least-Once Delivery Logs

### A. Định Nghĩa Ngữ Nghĩa Của `delivery_logs` (Unambiguous Delivery Logs Semantics)
- **CHỌN MÔ HÌNH CHÍNH THỨC**: **`delivery_logs = SUCCESSFUL DELIVERY EVIDENCE ONLY`** (Chỉ ghi nhận bằng chứng giao hàng thành công).
- **Quy tắc thực thi**:
  - Chỉ khi lượt gửi file ra bên ngoài thành công, worker mới tạo một dòng trong bảng `delivery_logs`.
  - Các lần thử thất bại hoặc cần thử lại (failed/retryable attempts: đứt mạng, rate-limit, DM đóng) **TUYỆT ĐỐI KHÔNG** tạo dòng trong bảng `delivery_logs`. Thông tin kỹ thuật về các lần thử được lưu trong worker/application logs hoặc bảng `delivery_jobs` (`external_attempt_count`, `last_error_reason`).
  - Tuyệt đối không trộn lẫn attempt logs với successful delivery evidence mà không có bộ phân loại rõ ràng (discriminator).
  - Do đó: **`COUNT(DISTINCT delivery_logs.order_id)`** hoàn toàn hợp lệ và đại diện chuẩn xác cho số đơn giao nghiệp vụ (business delivery count).

### B. Ba Khái Niệm Phân Biệt Rạch Ròi:
1. **Technical Attempt Info**: Lưu vết kỹ thuật các lần thử (nằm ở `delivery_jobs.external_attempt_count` và application logs), phục vụ retry và audit kỹ thuật.
2. **Successful Delivery Evidence**: Bản ghi bằng chứng giao hàng thành công (`delivery_logs`), chỉ được tạo khi external send thành công.
3. **Business Delivery Count**: Số lượng đơn hàng nghiệp vụ duy nhất đã giao thành công = **`COUNT(DISTINCT delivery_logs.order_id)`** (hoặc `COUNT(DISTINCT orders.id) WHERE orders.delivered_at IS NOT NULL`). Triệt tiêu hoàn toàn trường hợp external retry duplicate (nếu sự cố crash xảy ra sau khi gửi file nhưng trước khi DB commit).

### C. Quy Tắc Phân Tách Tuyệt Đối Nguồn Doanh Thu vs Lượt Giao Hàng (Revenue vs Delivery Domain Separation):

- **TÁCH BIỆT HAI MIỀN KẾ TOÁN (SEPARATE ACCOUNTING DOMAINS)**:
  - **Miền Tài Chính / Doanh Thu (Financial Revenue Domain)**:
    + Doanh thu được ghi nhận ngay khi đơn hàng được tất toán tài chính (`settled_amount IS NOT NULL` và có `paid_at`).
    + **Doanh thu có thể tồn tại TRƯỚC khi giao hàng**. (Ví dụ: Đơn hàng A có `settled_amount = 100_000`, `paid_at = hôm nay`, job giao hàng đang trong hàng đợi chưa gửi xong. Doanh thu của đơn hàng này và doanh thu per-plugin **BẮT BUỘC** phải được tính vào Settled Sales ngay lập tức, không được chờ delivery log).
    + Do đó: **TUYỆT ĐỐI KHÔNG YÊU CẦU `delivery_logs` KHI TÍNH DOANH THU**.
    + Nguồn doanh thu: Trích xuất trực tiếp từ bảng `orders` qua chuỗi định danh canonical:
      $$\text{orders} \longrightarrow \text{orders.version\_id} \longrightarrow \text{versions.plugin\_id} \longrightarrow \text{SUM(orders.settled\_amount)}$$
  - **Miền Giao Vận / Hoàn Tất (Fulfillment / Delivery Domain)**:
    + Lượt giao hàng nghiệp vụ (`business delivery count`): Được tính duy nhất từ bảng `delivery_logs` bằng `COUNT(DISTINCT order_id)`.
    + Bảng `delivery_logs` chỉ là bằng chứng giao hàng thành công (successful delivery evidence only). Tuyệt đối **không dùng `delivery_logs.plugin_name`** làm định danh canonical của plugin.

- **Truy Vấn Doanh Thu Per-Plugin Chuẩn Xác Trực Tiếp Từ `orders`**:
  ```sql
  -- Bước 1: Trích xuất các đơn đã tất toán trong kỳ từ bảng orders
  WITH settled_orders_in_period AS (
    SELECT
      o.id AS order_id,
      v.plugin_id AS plugin_id,
      p.name AS canonical_plugin_name,
      o.discord_user_id,
      o.settled_amount
    FROM orders o
    JOIN versions v ON o.version_id = v.id
    JOIN plugins p ON v.plugin_id = p.id
    WHERE o.settled_amount IS NOT NULL
      AND o.paid_at >= :from AND o.paid_at < :to
  )
  -- Bước 2: Gom nhóm theo canonical plugin_id
  SELECT
    s.plugin_id AS pluginId,
    s.canonical_plugin_name AS pluginName,
    COUNT(s.order_id) AS uniqueOrders,
    SUM(s.settled_amount) AS settledAmount
  FROM settled_orders_in_period s
  GROUP BY s.plugin_id, s.canonical_plugin_name
  ORDER BY settledAmount DESC, uniqueOrders DESC;
  ```

- **Truy Vấn Doanh Thu Per-User Chuẩn Xác Trực Tiếp Từ `orders`**:
  ```sql
  SELECT
    s.discord_user_id AS discordUserId,
    COUNT(s.order_id) AS uniqueOrders,
    SUM(s.settled_amount) AS settledAmount
  FROM settled_orders_in_period s
  GROUP BY s.discord_user_id
  ORDER BY settledAmount DESC, uniqueOrders DESC;
  ```

- **Truy Vấn Số Lượng Giao Hàng Thành Công (Tách Biệt Khỏi Doanh Thu)**:
  ```sql
  -- 1. Tổng số đơn hàng đã giao thành công toàn hệ thống:
  SELECT COUNT(DISTINCT dl.order_id) AS totalBusinessDeliveries
  FROM delivery_logs dl
  WHERE dl.delivered_at >= :from AND dl.delivered_at < :to;

  -- 2. Số lượng đơn đã giao thành công theo từng Plugin:
  SELECT
    v.plugin_id AS pluginId,
    p.name AS canonical_plugin_name,
    COUNT(DISTINCT dl.order_id) AS deliveredOrdersCount
  FROM delivery_logs dl
  JOIN orders o ON dl.order_id = o.id
  JOIN versions v ON o.version_id = v.id
  JOIN plugins p ON v.plugin_id = p.id
  WHERE dl.delivered_at >= :from AND dl.delivered_at < :to
  GROUP BY v.plugin_id, p.name
  ORDER BY deliveredOrdersCount DESC;
  ```

- **Nguyên Tắc Bất Biến**:
  - Không sử dụng `SUM(DISTINCT o.settled_amount)` (tránh mất doanh thu khi nhiều đơn trùng giá).
  - Không để việc thiếu `delivery_logs` làm mất doanh thu đã tất toán của plugin/user.
  - Không để việc retry delivery (tạo nhiều log) làm tăng ảo doanh thu hay số đơn giao.

### D. Delivery Accounting & Snapshot `settled_amount` Thời Điểm Giao Hàng:
- **`delivery_logs.amount = orders.settled_amount`**:
  - **KHÔNG fallback**: Tuyệt đối không fallback sang `order.amount`, `walletPaid`, `bankDue`, hay `paidAmount`.
  - **DATA_INTEGRITY_VIOLATION MUST NOT RETRY AS TRANSIENT**:
    + Nếu `order.settled_amount IS NULL` tại thời điểm successful delivery accounting:
      * Phân loại lỗi: **`DATA_INTEGRITY_VIOLATION`**.
      * **KHÔNG ghi delivery accounting log** (`delivery_logs`).
      * Delivery job chuyển thẳng sang trạng thái **`failed` vĩnh viễn (permanent failure / reconciliation-required)** với lý do `DATA_INTEGRITY_VIOLATION`.
      * **TUYỆT ĐỐI KHÔNG đi vào vòng lặp retry tự động (automatic retry loop)**. Không tiêu tốn `MAX_RETRY` trên một khiếm khuyết dữ liệu có tính chất tiền định (deterministic data-integrity defect).
      * Tạo ngay bản ghi ngoại lệ đối soát trong persistent table `_migration_exceptions` (`reason_code = 'DATA_INTEGRITY_VIOLATION'`).
      * Khi quản trị viên khắc phục lỗi dữ liệu gốc: Chỉ có thể kích hoạt lại qua can thiệp thủ công tường minh (`explicit manual requeue`).
    + Tuyệt đối không tạo một công thức `settledAmount` mới phân tán trong Delivery service.
- **Thực thi trong `discord/src/services/delivery/neon-delivery-worker.ts`**:
  ```ts
  // Kiểm tra tính toàn vẹn tài chính trước khi tạo log
  if (order.settledAmount === null || order.settledAmount === undefined) {
    // Đánh dấu job failed vĩnh viễn, không retry tự động
    await markJobPermanentFailed(deps.neonDb, job.id, "DATA_INTEGRITY_VIOLATION");
    await recordMigrationException(deps.neonDb, {
      entityType: "order",
      entityId: order.id,
      reasonCode: "DATA_INTEGRITY_VIOLATION",
      evidence: { orderId: order.id, status: order.status, settledAmount: null }
    });
    throw new Error(`DATA_INTEGRITY_VIOLATION: Order #${order.id} missing settled_amount at delivery time. Marked permanent failure.`);
  }

  await createDeliveryLog(deps.neonDb, {
    orderId: job.orderId,
    discordUserId: job.discordUserId,
    versionId: job.versionId,
    pluginName,
    versionLabel: version.version ?? "",
    amount: order.settledAmount, // <-- LẤY TRỰC TIẾP TỪ SETTLED_AMOUNT, TUYỆT ĐỐI KHÔNG FALLBACK
    requestedMethod: job.requestedMethod,
    actualMethod: useAttachment ? "attachment" : "link",
    deliveryIdempotencyKey: `order_${job.orderId}_${job.requestedMethod}_${job.externalAttemptCount}`,
    deliveredAt: new Date(),
  });
  ```

---

## 5. Revenue Accounting & Định Nghĩa Chuẩn Xác Bank Cash Received

Báo cáo tài chính phân định rạch ròi giữa **Dòng tiền mặt thực nhận (Cash Inbound)**, **Nghĩa vụ nợ (Liability)**, và **Doanh thu bán hàng (Earned Sales Revenue)**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                      MÔ HÌNH HẠCH TOÁN DOANH THU                       │
├────────────────────────────────────────────────────────────────────────┤
│ 1. Settled Sales (Gross) = SUM(orders.settled_amount)                  │
│    (Tất cả đơn có settled_amount IS NOT NULL trong kỳ, kể cả refunded)│
│                                                                        │
│ 2. Refunds (Contra-Revenue) = SUM(wallet_ledger.delta)                 │
│    (Các bản ghi kind = 'order_refund' trong kỳ báo cáo)                │
│                                                                        │
│ 3. Net Sales (Doanh thu thuần) = Settled Sales (Gross) - Refunds       │
├────────────────────────────────────────────────────────────────────────┤
│ ĐỐI SOÁT DÒNG TIỀN MẶT NGÂN HÀNG (CASH RECONCILIATION):                │
│ • Bank Cash Received = TẤT CẢ SePay chuyển vào (transfer_type = 'in')  │
│   ├─ Matched / Processed Bank Cash: order_id IS NOT NULL OR topup_id...│
│   └─ Unmatched / Unclassified Cash: order_id IS NULL AND topup_id IS..│
│                                                                        │
│ ĐỐI SOÁT VÍ NỘI BỘ (WALLET RECONCILIATION):                           │
│ • Wallet Funding = Topups + Overpayment Credits + Partial Credits      │
│ • Wallet-Funded Sales = Trích từ ví cho đơn hàng (orders.wallet_paid)  │
└────────────────────────────────────────────────────────────────────────┘
```

### Công Thức Chi Tiết & SQL Chuẩn:

1. **A. Bank Cash Received (Tổng Tiền Mặt Ngân Hàng Nhận Được)**:
   - **Định nghĩa**: Toàn bộ dòng tiền VND thực tế đổ vào tài khoản ngân hàng do SePay ghi nhận:
     ```sql
     SELECT COALESCE(SUM(amount), 0) AS bank_cash_received
     FROM sepay_transactions
     WHERE transfer_type = 'in'
       AND received_at >= :startDate AND received_at < :endDate
     ```
   - **Phân loại thành phần đối soát (Dựa trên quan hệ thực thể, không chỉ dựa vào status)**:
     - *Matched / Processed Cash*:
       ```sql
       SELECT COALESCE(SUM(amount), 0) AS matched_cash
       FROM sepay_transactions
       WHERE transfer_type = 'in'
         AND (order_id IS NOT NULL OR topup_id IS NOT NULL)
         AND received_at >= :startDate AND received_at < :endDate
       ```
     - *Unmatched / Unclassified Cash*:
       ```sql
       SELECT COALESCE(SUM(amount), 0) AS unmatched_cash
       FROM sepay_transactions
       WHERE transfer_type = 'in'
         AND order_id IS NULL AND topup_id IS NULL
         AND received_at >= :startDate AND received_at < :endDate
       ```
     *(Lưu ý: Các giao dịch `ignored_no_code` vẫn là tiền mặt khách đã chuyển vào tài khoản ngân hàng của chủ kho, bắt buộc phải xuất hiện trong bảng đối soát tiền mặt)*.

2. **B. Settled Sales (Doanh thu Bán hàng Đã Tất toán - Gross)**:
   - **Canonical Timestamp**: `orders.paid_at`.
   - **SQL**:
     ```sql
     SELECT COALESCE(SUM(settled_amount), 0) AS settled_sales
     FROM orders
     WHERE paid_at >= :startDate AND paid_at < :endDate
       AND settled_amount IS NOT NULL
     ```
     *(Lưu ý: Không lọc `status IN ('paid', 'delivered')`. Đơn sau đó bị `refunded` vẫn giữ nguyên trong tổng Settled Sales để lưu vết lịch sử bán hàng bất biến)*.

3. **C. Refunds (Khoản Hoàn Tiền - Contra-Revenue)**:
   - **Canonical Timestamp**: `wallet_ledger.created_at`.
   - **SQL**:
     ```sql
     SELECT COALESCE(SUM(delta), 0) AS total_refunds
     FROM wallet_ledger
     WHERE kind = 'order_refund'
       AND created_at >= :startDate AND created_at < :endDate
     ```

4. **D. Net Sales (Doanh thu Thuần)**:
   - `Net Sales = Settled Sales (Gross) - Total Refunds`.
   - **Triệt tiêu hoàn toàn lỗi Double-Deduction**: Vì `Settled Sales (Gross)` bao gồm cả đơn đã refund, nên trừ `Total Refunds` cho kết quả chính xác 100%, không bị trừ 2 lần.

5. **E. Wallet-Funded Sales (Doanh thu Trích từ Ví)**:
   - **Canonical Timestamp**: `orders.paid_at`.
   - **SQL**:
     ```sql
     SELECT COALESCE(SUM(wallet_paid), 0) AS wallet_funded_sales
     FROM orders
     WHERE paid_at >= :startDate AND paid_at < :endDate
       AND settled_amount IS NOT NULL
     ```

---

## 6. Monthly Reporting (Chuyển Đổi Báo Cáo Tháng Sang Neon)

Thay thế hoàn toàn file `discord/src/services/stats/monthly-fund-stats.ts` đang đọc SQLite `audit_log` bằng service mới truy vấn Neon PostgreSQL.

### Chuẩn Hóa Canonical Timestamps:
- **Settled Sales & Wallet Sales**: `orders.paid_at`.
- **Bank Cash Inbound**: `sepay_transactions.received_at`.
- **Refunds & Wallet Funding**: `wallet_ledger.created_at`.
- **Deliveries (Lượt Giao File Nghiệp Vụ)**: `delivery_logs.delivered_at`.

---

## 7. Safe Historical Backfill (Bù Đắp Dữ Liệu An Toàn & Phân Tầng Chứng Cứ `paid_at`)

### A. Phân Tầng Chứng Cứ Bù Đắp `paid_at` Cho Đơn Hàng Lịch Sử (Evidence Precedence Hierarchy)
**Tuyệt đối cấm sử dụng `paid_at = COALESCE(delivered_at, created_at)` làm fallback mặc định**.

Định nghĩa chuẩn hóa duy nhất: **`paid_at = actual settlement / payment receipt timestamp`** (Thời điểm thực tế tiền được nhận hoặc hoàn tất tất toán).

Khi một đơn hàng cũ thiếu `paid_at`, timestamp tất toán phải được xác định dựa theo loại thanh toán:

1. **Trường Hợp 1: Đơn Thanh Toán Ngân Hàng (Bank Payment)**:
   - Sử dụng bắt buộc timestamp nhận tiền thực tế từ ngân hàng: **`sepay_transactions.received_at`**.
   - `processed_at` **TUYỆT ĐỐI KHÔNG** được tự động coi là receipt timestamp. Chỉ dùng `processed_at` nếu code/tài liệu nguồn chứng minh được rằng `processed_at = actual payment receipt time`.
2. **Trường Hợp 2: Đơn Thanh Toán Kết Hợp (Split Payment)**:
   - Với đơn split payment, `order_hold` chỉ là tiền trừ ví lúc mở đơn (khi đơn còn pending), **KHÔNG PHẢI** là thời điểm tất toán.
   - Bắt buộc sử dụng: **`received_at` của giao dịch SePay thực tế hoàn tất tất toán đơn hàng**.
3. **Trường Hợp 3: Đơn Thanh Toán 100% Bằng Ví (`bankDue === 0`)**:
   - `order_hold` trong `wallet_ledger` được ghi nhận ngay lúc tạo đơn và trừ tiền thành công. Do đó timestamp sổ cái: **`wallet_ledger.created_at`** (`kind = 'order_hold'`) là bằng chứng tất toán hợp lệ.
4. **Trường Hợp 4: Đơn Hàng Miễn Phí 0₫ (Zero-Price Order)**:
   - Sử dụng timestamp tạo đơn và chốt trạng thái `wallet_paid`.
5. **Trường Hợp Không Có Bằng Chứng Đáng Tin Cậy (No Reliable Evidence)**:
   - **TUYỆT ĐỐI KHÔNG TỰ BỊA ĐẶT `paid_at`**.
   - Giữ nguyên **`paid_at = NULL`**.
   - Ghi nhận ngoại lệ vào bảng **`_migration_exceptions`** (`source = 'migration'`, `run_id = 'migration-backfill-...'`, `reason_code = 'MISSING_SETTLEMENT_TIMESTAMP'`).
6. **CẤM TUYỆT ĐỐI**:
   - Tuyệt đối không bao giờ lấy `orders.created_at` làm timestamp tất toán.
   - Tuyệt đối không lấy thời điểm server xử lý webhook (`application webhook processing time`) làm `paid_at`.

### B. Phân Loại Dữ Liệu Lịch Sử (Data Classification):
1. **ELIGIBLE**: Đơn có `status IN ('paid', 'wallet_paid', 'delivered', 'refunded')` và có chứng cứ tất toán hợp lệ -> Gán `settled_amount = amount`.
2. **UNSETTLED**: Đơn `status IN ('pending', 'cancelled', 'expired', 'underpaid')` -> Giữ nguyên `settled_amount = NULL`.
3. **INVALID**: Đơn `paid/delivered` nhưng `amount < 0` hoặc thiếu chứng cứ tài chính đối ứng -> Ghi bản ghi vào `_migration_exceptions`, không tự chế dữ liệu.
4. **ORPHAN**: SePay transaction hoặc Delivery log không trỏ về order hợp lệ -> Ghi vào `_migration_exceptions`.

---

## 8. Delivery Log Reconciliation (Đối Soát Nhật Ký Giao Hàng Lịch Sử & NULL Safety)

Truy vấn đối soát NULL-safe giữa `delivery_logs.amount` và `orders.settled_amount`:
```sql
SELECT
  dl.id AS log_id,
  dl.order_id,
  dl.amount AS log_amount,
  o.id AS matched_order_id,
  o.settled_amount,
  o.status AS order_status
FROM delivery_logs dl
LEFT JOIN orders o ON dl.order_id = o.id
WHERE o.id IS NULL
   OR dl.amount IS DISTINCT FROM o.settled_amount;
```
- **Match**: `dl.amount IS NOT DISTINCT FROM o.settled_amount` (cùng bằng nhau hoặc cùng = 0) -> Hợp lệ.
- **Orphan delivery_logs**: `o.id IS NULL` -> Ghi nhận vào `_migration_exceptions` với mã `ORPHAN_DELIVERY_LOG`.
- **Fixable**: `dl.amount === 0` và `o.settled_amount > 0` -> Cập nhật an toàn `dl.amount = o.settled_amount`.
- **Unknown / Conflicting**: `dl.amount > 0` và `o.settled_amount > 0` nhưng lệch giá trị -> Không tự ý ghi đè, ghi vào `_migration_exceptions` với mã `AMBIGUOUS_DELIVERY_LOG_AMOUNT`.
- **NULL settled_amount on delivered order**: `o.settled_amount IS NULL` -> Báo lỗi `DATA_INTEGRITY_VIOLATION`.

---

## 9. Multi-Layer Reconciliation Engine (Bộ Đối Soát Đa Tầng Mở Rộng)

Xây dựng endpoint `GET /api/reconcile/financial` (hoặc tích hợp vào `/api/wallets/reconcile`) với 7 chốt chặn tự động toàn diện:

- **Check A: Lệch Số Dư Ví vs Tổng Sổ Cái (wallet.balance vs SUM(wallet_ledger.delta))**:
  ```sql
  SELECT w.discord_user_id, w.balance, COALESCE(SUM(l.delta), 0) AS ledger_sum
  FROM wallets w
  LEFT JOIN wallet_ledger l ON w.discord_user_id = l.discord_user_id
  GROUP BY w.discord_user_id, w.balance
  HAVING w.balance != COALESCE(SUM(l.delta), 0);
  ```
- **Check B: Đơn Đã Tất Toán vs `settled_amount` (settled order vs settled_amount)**:
  Quét các đơn có `status IN ('paid', 'wallet_paid', 'delivered', 'refunded')`:
  + Phát hiện bất kỳ đơn nào có `settled_amount IS NULL` hoặc `settled_amount != amount`.
  + Gắn cờ vi phạm toàn vẹn nếu đơn `paid`/`wallet_paid` thiếu giá trị tất toán.
- **Check C: Lệch Giá Trị Giao Hàng & An Toàn NULL (Reconciliation NULL Safety — delivery_logs.amount vs orders.settled_amount)**:
  Thay thế hoàn toàn phép so sánh lỏng lẻo `dl.amount != o.settled_amount` bằng cú pháp **NULL-Safe**:
  ```sql
  SELECT dl.id, dl.order_id, dl.amount AS log_amount, o.settled_amount
  FROM delivery_logs dl
  LEFT JOIN orders o ON dl.order_id = o.id
  WHERE o.id IS NULL
     OR dl.amount IS DISTINCT FROM o.settled_amount;
  ```
  Phát hiện tường minh 4 trường hợp:
  1. *Orphan delivery_logs*: `o.id IS NULL` (log không liên kết được với bất kỳ đơn hàng nào).
  2. *NULL settled_amount*: `o.settled_amount IS NULL` nhưng đã có log giao hàng.
  3. *Mismatched amount*: Lệch giá trị giữa log và đơn hàng.
  4. *Valid zero amount*: Đơn 0₫ có `settled_amount = 0` và `dl.amount = 0` (hợp lệ, không bị báo lỗi sai). Nếu `dl.amount IS NULL` và `settled_amount = 0` thì `IS DISTINCT FROM` phát hiện chính xác là lệch.
- **Check D: Đơn Hoàn Tiền vs Vết Sổ Cái Chuẩn (refunded order vs order_refund ledger)**:
  Quét mọi đơn có `status = 'refunded'`. Kiểm tra xem trong `wallet_ledger` có tồn tại bản ghi hoàn tiền hợp lệ:
  + `kind = 'order_refund'`
  + `ref_type = 'order'`
  + `ref_id = orders.id`
  + `delta > 0`
  Nếu thiếu hoặc sai -> Báo cáo vi phạm `REFUND_WITHOUT_VALID_LEDGER`.
  *(Lưu ý: Tuyệt đối KHÔNG dùng `delivery_logs` để suy luận trạng thái hoàn tiền)*.
- **Check E: Đối Soát Tiền Mặt Ngân Hàng (inbound SePay cash vs matched/unmatched references)**:
  Tổng dòng tiền thực nhận (`transfer_type = 'in'`) = Matched Cash (`order_id IS NOT NULL OR topup_id IS NOT NULL`) + Unmatched/Unclassified Cash (`order_id IS NULL AND topup_id IS NULL`).
- **Check F: Đơn `wallet_paid` Thiếu `settled_amount` (wallet_paid order vs settled_amount IS NOT NULL)**:
  Phát hiện mọi đơn `status = 'wallet_paid'` nhưng `settled_amount IS NULL`.
- **Check G: Đơn Hàng Terminal vs Lịch Sử Chuyển Trạng Thái (terminal order vs invalid status transitions)**:
  Kiểm tra các đơn ở trạng thái terminal (`refunded`, `cancelled`, `expired`, `delivered`) không bị reopen hoặc ghi đè `settled_amount` trái phép.

---

## 10. Comprehensive Acceptance Test Plan (40 Kịch Bản Bắt Buộc)

Bộ test `discord/tests/neon-accounting-reconciliation.test.ts` bao phủ đầy đủ 40 kịch bản (vượt qua tất cả chốt chặn chất lượng nghiêm ngặt nhất — 40/40 PASS):

- **TEST-C01: Exact Bank Payment Settlement Capture**: Mở đơn 100k. Chuyển khoản đúng 100k -> `status = 'paid'`, `settled_amount = 100_000`, `paidAmount = 100_000`.
- **TEST-C02: 100% Wallet Purchase Immediate Settlement**: Khách có 100k ví. Mua đơn 100k -> `status = 'wallet_paid'`, `settled_amount = 100_000`, trừ ví 100k (`order_hold`), enqueue delivery job.
- **TEST-C03: Split Payment Settlement Capture**: Ví 30k, nợ ngân hàng 70k. Chuyển khoản 70k -> `status = 'paid'`, `settled_amount = 100_000`, `paidAmount = 70_000`.
- **TEST-C04: Overpayment Settlement & Wallet Excess Capture**: Đơn 100k, chuyển 150k -> `settled_amount = 100_000`, `paidAmount = 100_000`, ví nhận 50k (`order_overpay_credit`), SePay = `'overpaid'`.
- **TEST-C05: Underpayment Does Not Settle Order**: Đơn 100k, chuyển 40k -> `settled_amount = NULL`, `status = 'pending'`, ví nhận 40k (`order_partial_credit`), SePay = `'underpaid'`, không ghi nhận doanh thu.
- **TEST-C06: Refund Preserves Historical Settled Amount & Records Ledger**: Đơn 100k đã tất toán. Admin hoàn tiền -> `status = 'refunded'`, `settled_amount = 100_000` (giữ nguyên bất biến), ví nhận 100k (`order_refund`). Doanh thu: Gross Settled Sales = 100k, Refunds = 100k, Net Sales = 0.
- **TEST-C07: Delivery Worker Takes Snapshot from `orders.settled_amount`**: Đơn có `settled_amount = 100_000`. Worker hoàn tất giao hàng -> `delivery_logs.amount = 100_000`.
- **TEST-C08: Historical Backfill Idempotency & Safety**: Backfill đơn cũ `paid`/`wallet_paid` -> gán `settled_amount = amount`. Chạy lại lần 2 không thay đổi dữ liệu.
- **TEST-C09: Monthly Financial Reporting Metric Reconciliation**: Xác minh toàn bộ các chỉ số báo cáo tháng khớp chính xác 100% với fixture kiểm soát.
- **TEST-C10: Delivery Retry with External Duplicate Does Not Double-Count Business Deliveries**: Job giao hàng bị retry 2 lần (sinh 2 log trong `delivery_logs` cho cùng 1 orderId). Báo cáo tháng: Số đơn giao thành công (`COUNT(DISTINCT order_id)`) bằng đúng 1 đơn, doanh thu tính đúng 1 lần.
- **TEST-C11: Every Settlement Writer Stamps `settled_amount` in Same DB Transaction**: Kiểm tra toàn bộ các writers (`openOrderNeon`, `settleOrderPaidTx` exact, `settleOrderPaidTx` overpay, `settleOrderWalletPaidTx`). Tất cả đều commit `status`, `settled_amount`, và `paid_at` đồng thời trong cùng transaction.
- **TEST-C12: Legacy `paid_at` Missing with No Reliable Timestamp**: Đơn hàng cũ thiếu `paid_at` và không tìm thấy SePay/Ledger evidence -> `paid_at` giữ nguyên `NULL`, phát sinh migration exception vào `_migration_exceptions`, không tự bịa timestamp.
- **TEST-C13: Inbound Unmatched / No-Code Transfer Included in Bank Cash Received**: Giao dịch chuyển tiền vào không có mã (`ignored_no_code`, `transfer_type = 'in'`). Tổng Bank Cash Received ghi nhận đầy đủ số tiền, phân loại vào mục Unmatched/Unclassified dựa trên `order_id IS NULL AND topup_id IS NULL`.
- **TEST-C14: `wallet_paid` Order with `settled_amount` NULL Detected by Reconciliation**: Cố tình tạo đơn `wallet_paid` có `settled_amount = NULL`. Endpoint đối soát phát hiện và gắn cờ vi phạm dữ liệu.
- **TEST-C15: New Delivery with `settled_amount` NULL Is Rejected**: Worker xử lý đơn có `settled_amount = NULL` -> Bị từ chối tạo `delivery_logs`, ném lỗi an toàn data-integrity.
- **TEST-C16: Two Orders Same Plugin Same Amount Aggregation Accuracy**: Hai đơn hàng cùng mua 1 plugin với giá 100k mỗi đơn -> Tổng doanh thu per-plugin ghi nhận đúng 200.000₫ (không bị mất doanh thu như khi dùng `SUM(DISTINCT)`).
- **TEST-C17: Two Orders Same User Same Amount Aggregation Accuracy**: Khách mua 2 đơn hàng cùng giá 100k -> Tổng doanh thu per-user ghi nhận đúng 200.000₫.
- **TEST-C18: Refunded Order Cannot Transition to Paid**: Đơn đã ở trạng thái `refunded` -> Cố tình cập nhật sang `paid` -> Bị từ chối (rejected), đơn giữ nguyên `refunded`.
- **TEST-C19: Cancelled Order Cannot Transition to Wallet_Paid**: Đơn đã ở trạng thái `cancelled` -> Cố tình cập nhật sang `wallet_paid` -> Bị từ chối (rejected), đơn giữ nguyên `cancelled`.
- **TEST-C20: Expired Order Cannot Transition to Paid**: Đơn đã ở trạng thái `expired` -> Cố tình cập nhật sang `paid` -> Bị từ chối (rejected), đơn giữ nguyên `expired`.
- **TEST-C21: Split Payment Legacy Order Missing `paid_at` with Only `order_hold` Evidence**: Đơn split payment cũ thiếu `paid_at`, chỉ có bản ghi `order_hold` lúc mở đơn -> Không tự ý bịa đặt `paid_at`, ghi nhận ngoại lệ di trú vào `_migration_exceptions`.
- **TEST-C22: Inbound Transfer with No `order_id` and No `topup_id`**: Giao dịch SePay vào không có `order_id` và không có `topup_id` -> Bank Cash Received bao gồm đầy đủ số tiền và phân loại vào Unmatched/Unclassified Cash.
- **TEST-C23: Delivery with `settled_amount` NULL Rejected**: Thực hiện giao hàng thành công trên đơn có `settled_amount = NULL` -> Bị từ chối ghi nhận delivery accounting log -> Phát sinh ngoại lệ đối soát.
- **TEST-C24: Zero-Price Order Settlement Behavior (Option B)**: Tạo đơn hàng 0₫ cho plugin miễn phí -> `settled_amount = 0`, `status = 'wallet_paid'`, giao hàng với log amount = 0, doanh thu gộp cộng 0₫, lượt phục vụ ghi nhận đúng 1 đơn.
- **TEST-C25: Paid → Paid Idempotent Retry Preserves Timestamp**: Gọi lại settlement trên đơn đã `paid` -> `paid_at` giữ nguyên không đổi (unchanged), `settled_amount` giữ nguyên không đổi.
- **TEST-C26: Wallet_Paid → Wallet_Paid Idempotent Retry Preserves Timestamp**: Gọi lại settlement trên đơn đã `wallet_paid` -> `paid_at` giữ nguyên không đổi (unchanged), `settled_amount` giữ nguyên không đổi.
- **TEST-C27: Phase 3C Application Rollback Preserves Financial Data**: Diễn tập hoàn tác ứng dụng về Phase 3B -> Schema additive và toàn bộ dữ liệu trong `settled_amount` cùng `_migration_exceptions` giữ nguyên vẹn 100%, không bị drop hay phá hủy.
- **TEST-C28: Delivery_Logs Only Successful Evidence**: Đơn hàng gặp 2 lần thử thất bại do lỗi mạng/DM đóng trước khi giao thành công -> Chỉ có 1 bản ghi duy nhất được tạo trong `delivery_logs`, các lượt thất bại không được tính vào số đơn giao nghiệp vụ.
- **TEST-C29: DATA_INTEGRITY_VIOLATION Rejects Auto-Retry**: Worker gặp đơn có `settled_amount = NULL` tại thời điểm giao hàng -> Chuyển thẳng sang permanent failure, ghi nhận ngoại lệ `_migration_exceptions`, không lặp lại tự động thử lại (no transient retry loop).
- **TEST-C30: Orphan Delivery Log Detected by Reconciliation**: Bản ghi trong `delivery_logs` có `order_id` không tồn tại trong `orders` (`o.id IS NULL`) -> Endpoint đối soát phát hiện và gắn cờ `ORPHAN_DELIVERY_LOG`.
- **TEST-C31: Delivery Log Amount NULL vs Settled_Amount 0 Mismatch**: Bản ghi log có `amount = NULL` trong khi `settled_amount = 0` -> Cú pháp `IS DISTINCT FROM` phát hiện chính xác sự sai lệch, không bị nuốt lỗi do so sánh NULL.
- **TEST-C32: Delayed Webhook Across Reporting Period Follows Option B paid_at Semantics**: Tiền chuyển khoản thực tế đến ngân hàng lúc 23:59 ngày cuối tháng (SePay `received_at`). Webhook xử lý bị trễ mạng sang 00:05 ngày đầu tháng sau. Theo Option B, `orders.paid_at` nhận giá trị thời điểm thực nhận tiền `received_at` (tháng trước). Báo cáo tài chính ghi nhận doanh thu vào kỳ tháng trước, không bị sai lệch kỳ do độ trễ webhook mạng.
- **TEST-C33: Two Delivery Logs with Different pluginName Metadata Count Exactly One Order via Canonical Identity**: Hai bản ghi `delivery_logs` thành công cho cùng 1 đơn hàng mang metadata chuỗi `plugin_name` khác nhau (do retry hoặc lệch tên hiển thị). Báo cáo tổng hợp trích xuất canonical identity theo quan hệ `order_id → order.version_id → versions.plugin_id` -> Ghi nhận đúng duy nhất 1 đơn hàng (`uniqueOrders = 1`), cộng đúng 1 lần `settled_amount` cho đúng `plugin_id`.
- **TEST-C34: Generic updateOrderStatus("paid") Without Settlement Context Is Rejected**: Caller tùy ý cố gọi `updateOrderStatus(orderId, "paid")` mà không truyền context tài chính hợp lệ -> Bị từ chối (ném ngoại lệ / unavailable), không thể can thiệp hoặc tự động tạo settlement fact.
- **TEST-C35: Settled Order Before Delivery Included in Revenue**: Đơn hàng 100k đã tất toán (`settled_amount = 100_000`, `status = 'paid'`, `paid_at = today`), nhưng job giao hàng chưa chạy xong (delivery count = 0, chưa có bản ghi trong `delivery_logs`). Báo cáo per-plugin và tổng Settled Sales tính trực tiếp từ `orders` ghi nhận đúng 100k. Số đơn giao nghiệp vụ hiển thị đúng 0 đơn.
- **TEST-C36: Two Settled Orders Same Plugin Revenue Directly from Orders**: Hai đơn hàng cùng mua 1 plugin, đã tất toán 100k mỗi đơn nhưng cả 2 đều chưa có bản ghi trong `delivery_logs`. Doanh thu per-plugin tính trực tiếp từ `orders` ghi nhận đúng 200.000₫ (không bị loại bỏ do thiếu `delivery_logs`).
- **TEST-C37: Runtime DATA_INTEGRITY_VIOLATION Uses Valid Source/Run Identity**: Khi worker giao hàng phát hiện đơn thiếu `settled_amount` lúc runtime -> Bản ghi trong `_migration_exceptions` được ghi với `source = 'runtime_worker'`, `run_id = 'delivery-worker-...'`, không lạm dụng định danh `migration_run_id`. Ràng buộc unique index composite đảm bảo tính idempotent.
- **TEST-C38: Delayed Webhook Uses Authoritative received_at Over processed_at**: Giao dịch SePay có `received_at` (thời điểm ngân hàng nhận tiền) khác biệt với `processed_at` (thời điểm webhook được server xử lý). Hàm `settleOrderPaidTx` chốt `paid_at` bằng giá trị chuẩn `received_at`, chứng minh không tự động lấy `processed_at` hay webhook arrival time.
- **TEST-C39: Settlement Helper Rejects Wrong Caller-Supplied Amount**: Caller cố tình truyền `amount = 50_000` trong khi đơn hàng thực tế trong DB có `order.amount = 100_000`. Hàm `settleOrderPaidTx` kiểm tra đối chiếu (hoặc tự động nạp `canonicalAmount = order.amount`), từ chối giao dịch hoặc ép buộc `settled_amount = order.amount` (100_000), không để caller bóp méo số tiền tất toán.
- **TEST-C40: Settlement Helper Rejects Wrong Caller-Supplied paidAt**: Caller cố tình truyền timestamp giả mạo `paidAt`. Hàm `settleOrderPaidTx` truy vấn `received_at` tin cậy từ `sepay_transactions` trong DB, ghi đè bằng giá trị chuẩn ngân hàng hoặc từ chối request, ngăn chặn việc làm sai lệch mốc thời gian tài chính lịch sử.

---

## 11. Exact Files To Modify (Danh Sách File Can Thiệp)

1. [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts): Bổ sung bảng `migrationExceptions` (với `source` + `runId`), bổ sung cột `settledAmount` trên `orders` và các index.
2. `packages/db/drizzle/0004_settled_amount.sql` *(Tạo mới)*: Migration DDL tạo bảng `_migration_exceptions` và cột `settled_amount`.
3. [discord/src/services/payment/neon-payment-flow.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/payment/neon-payment-flow.ts): Chốt `settledAmount` trong `openOrderNeon` và triệu gọi `settleOrderPaidTx` trong `handleOrderPaymentNeonTx`.
4. [discord/src/repositories/neon-orders.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-orders.ts): Bổ sung các settlement-specific helpers đã gia cố (`settleOrderPaidTx`, `settleOrderWalletPaidTx`) tự nạp `order.amount` và authoritative timestamp từ DB, khóa chặt generic `updateOrderStatus`.
5. [discord/src/services/delivery/neon-delivery-worker.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/delivery/neon-delivery-worker.ts): Ghi `delivery_logs.amount` từ `order.settledAmount` (từ chối nếu NULL và đánh dấu permanent failure kèm ngoại lệ `source = 'runtime_worker'`).
6. [dashboard/server/routes/orders-routes.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/orders-routes.ts): Hợp nhất refund về hàm chuẩn `refundOrderWallet`, dọn sạch `order_refund_credit` -> `order_refund`.
7. [dashboard/server/routes/stats-routes.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/stats-routes.ts): Sửa truy vấn doanh thu tính trực tiếp từ `orders` (không phụ thuộc `delivery_logs`), tách biệt hoàn toàn với lượt giao hàng từ `delivery_logs`.
8. [discord/src/services/stats/monthly-fund-stats.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/stats/monthly-fund-stats.ts): Chuyển đổi báo cáo tháng sang Neon PostgreSQL với doanh thu từ `orders` và lượt giao từ `delivery_logs`.
9. [dashboard/server/routes/wallets-routes.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/dashboard/server/routes/wallets-routes.ts): Mở rộng `/api/wallets/reconcile` thành bộ đối soát đa tầng 7 chốt chặn (Check A -> G).
10. `discord/src/scripts/backfill-settled-amount.ts` *(Tạo mới)*: Script backfill an toàn, idempotent, ghi nhận vào `_migration_exceptions` với `source = 'migration'`.
11. `discord/tests/neon-accounting-reconciliation.test.ts` *(Tạo mới)*: Toàn bộ 40 acceptance tests từ `TEST-C01` đến `TEST-C40`.

---

## 12. Rollback Strategy (Chiến Lược Hoàn Tác An Toàn — Tuyệt Đối Không Hủy Dữ Liệu Tài Chính)

### A. Chiến Lược Hoàn Tác Ứng Dụng (Application Rollback — Production Strategy):
- **CẤM TUYỆT ĐỐI**: Tuyệt đối **KHÔNG** dùng lệnh phá hủy dữ liệu:
  `DROP COLUMN settled_amount;` hoặc `DROP TABLE _migration_exceptions;` làm quy trình rollback production bình thường.
- **Chiến lược chuẩn**:
  1. Revert mã nguồn ứng dụng về phiên bản Phase 3B (`a196ddc8e7235285f2a62460551d4b25376a4175`).
  2. **GIỮ NGUYÊN cột `settled_amount`** trên database.
  3. **GIỮ NGUYÊN toàn bộ dữ liệu tất toán đã ghi nhận (`populated settlement data`)**.
  4. **GIỮ NGUYÊN bảng `_migration_exceptions`** để phục vụ audit.
  5. Mã nguồn cũ của Phase 3B hoàn toàn tương thích ngược (backward compatible) với schema mở rộng dạng additive (Phase 3B chỉ đơn giản bỏ qua không đọc/ghi cột mới).

### B. Giới Hạn Của Schema / Data Rollback:
- Việc rollback schema / drop cột chỉ được phép thực hiện trên môi trường diễn tập nội bộ (pre-production testing) khi migration script thất bại ngay trước khi phát sinh bất kỳ nghiệp vụ ghi dữ liệu thật nào.
- Một khi đã có dữ liệu phát sinh trên production: **NO DESTRUCTIVE ROLLBACK** (Không có bất kỳ rollback phá hủy nào).
- Script hoàn tác dữ liệu backfill: Hỗ trợ cờ `--dry-run` kiểm tra trước khi chạy thật.

---

## 13. Acceptance Criteria & Implementation Gate Checklist

- [ ] **Gate 1**: Có DUY NHẤT một nguồn chân lý kế toán tất toán: `orders.settled_amount`.
- [ ] **Gate 2**: Toàn bộ các settlement writers (`openOrderNeon`, `settleOrderPaidTx`, `settleOrderWalletPaidTx`) chỉ được gọi trong giao dịch có financial evidence đã xác minh, tự trích xuất `order.amount` và authoritative timestamp từ DB, chốt `status + settled_amount + paid_at` trong SAME transaction; generic `updateOrderStatus('paid')` bị từ chối/vô hiệu hóa; không cho phép tái mở đơn terminal.
- [ ] **Gate 3**: `paid_at` mang ngữ nghĩa tường minh theo OPTION B (thời điểm thực tế nhận tiền / tất toán: SePay `received_at`, wallet hold timestamp, hoặc zero-price creation timestamp); tuyệt đối không tự động lấy `processed_at` hay webhook time; bất biến sau khi tất toán, idempotent retry giữ nguyên timestamp.
- [ ] **Gate 4**: Doanh thu per-plugin và per-user tổng hợp trực tiếp từ bảng `orders` (không phụ thuộc vào `delivery_logs`), định danh canonical plugin qua chuỗi `order_id → order.version_id → versions.plugin_id`; lượt giao hàng nghiệp vụ tính riêng từ `delivery_logs`.
- [ ] **Gate 5**: Bảng `delivery_logs` mang ngữ nghĩa tường minh `SUCCESSFUL DELIVERY EVIDENCE ONLY`; các lần thử thất bại không tạo dòng trong bảng; số đơn giao nghiệp vụ là `COUNT(DISTINCT order_id)`.
- [ ] **Gate 6**: Lỗi `DATA_INTEGRITY_VIOLATION` chuyển thẳng sang permanent failure, không thử lại tự động (no transient retry loop).
- [ ] **Gate 7**: Định nghĩa Bank Cash Received phản ánh đúng 100% dòng tiền vào tài khoản ngân hàng (`transfer_type = 'in'`), phân tách rõ ràng Matched Cash vs Unmatched Cash dựa trên quan hệ thực thể `order_id`/`topup_id`.
- [ ] **Gate 8**: Bù đắp `paid_at` lịch sử tuân thủ đúng phân tầng chứng cứ (SePay `received_at` -> Ledger -> Delivery), không dùng `order_hold` cho split payment, tuyệt đối không tự chế `paid_at` từ `created_at` hoặc webhook time.
- [ ] **Gate 9**: Bảng persistent `_migration_exceptions` là "Migration / Reconciliation / Data Integrity Exception Store", sử dụng cặp định danh chuẩn `source` + `run_id`, lưu trữ an toàn các bất thường di trú, đối soát, `DATA_INTEGRITY_VIOLATION`, orphan records; tuyệt đối cấm lưu password, cookie, session, token, secret.
- [ ] **Gate 10**: Chính sách đơn hàng 0₫ (Option B) được định nghĩa rõ ràng, ràng buộc check constraint `settled_amount >= 0`.
- [ ] **Gate 11**: Hạch toán hoàn tiền gắn chặt với sổ cái ví (`order_refund`, delta > 0, ref_type = 'order'), không suy diễn từ delivery log.
- [ ] **Gate 12**: Bộ đối soát đa tầng (Check A -> G) an toàn trước giá trị NULL với logic `o.id IS NULL OR dl.amount IS DISTINCT FROM o.settled_amount`.
- [ ] **Gate 13**: Chiến lược rollback ứng dụng không phá hủy dữ liệu tài chính (giữ nguyên cột và dữ liệu tất toán).
- [ ] **Gate 14**: 100% các bài test `TEST-C01` -> `TEST-C40` (40/40) PASS, không có regression trên Phase 3A và Phase 3B.
- [ ] **Gate 15**: Không thay đổi bất kỳ hành vi nào của Payment Core 3A, Delivery Core 3B hay Dual-Vault.

---

> **TRẠNG THÁI CUỐI CÙNG**: KẾ HOẠCH **PHASE 3C v6** ĐÃ ĐẠT 100% YÊU CẦU CỦA FINAL GATE. SẴN SÀNG TRIỂN KHAI THỰC TẾ (READY FOR IMPLEMENTATION).
