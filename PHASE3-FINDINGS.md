# PHASE 3 — OUT-OF-SCOPE FINDINGS

Tài liệu ghi nhận các vấn đề được phát hiện trong quá trình kiểm toán và triển khai Phase 3A nhưng nằm ngoài phạm vi cốt lõi thanh toán (Payment Core). Các vấn đề này được cách ly và đề xuất giải quyết trong các Phase kế tiếp theo đúng nguyên tắc kỷ luật.

---

### Finding 1: Delivery Claim vs Admin Refund Concurrency Race
- **File**: `discord/src/services/delivery/neon-delivery-worker.ts`
- **Status**: **RESOLVED IN PHASE 3B**
- **Resolution**: Delivery Processing = Delivery Reservation protocol, conditional atomic claim, rejection with `DELIVERY_IN_PROGRESS`, token revocation, exponential backoff, and heartbeat lease management implemented.

---

### Finding 2: Inaccurate Net Sales Accounting for Refunded Orders
- **File**: `discord/src/http/routes/dashboard-api.ts`
- **Line**: 110-145
- **Status**: **RESOLVED IN PHASE 3C**
- **Resolution**: Settled Sales lọc theo `orders.settled_amount` và `orders.paid_at` (bảo toàn ngay cả khi đơn chuyển sang `refunded`). Net Sales = Settled Sales - Refunds (tổng bút toán `wallet_ledger.order_refund`).

---

### Finding 3: Missing Immutable Settled Amount Column on Orders Schema
- **File**: `packages/db/src/schema.ts` & `discord/src/repositories/neon-orders.ts`
- **Line**: 50-80
- **Status**: **RESOLVED IN PHASE 3C**
- **Resolution**: Cột `orders.settled_amount` đã được thêm vào schema, có non-negative check constraint, index, và hàm tất toán canonical `settleOrderPaidTx`/`settleOrderWalletPaidTx`. Đã có migration `0004_settled_amount.sql`, bảng `_migration_exceptions` và script backfill an toàn.
