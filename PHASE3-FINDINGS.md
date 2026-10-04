# PHASE 3 — OUT-OF-SCOPE FINDINGS

Tài liệu ghi nhận các vấn đề được phát hiện trong quá trình kiểm toán và triển khai Phase 3A nhưng nằm ngoài phạm vi cốt lõi thanh toán (Payment Core). Các vấn đề này được cách ly và đề xuất giải quyết trong các Phase kế tiếp theo đúng nguyên tắc kỷ luật.

---

### Finding 1: Delivery Claim vs Admin Refund Concurrency Race
- **File**: `discord/src/services/delivery/neon-delivery-worker.ts`
- **Line**: 40-75
- **Issue**: Tiến trình delivery worker claim `delivery_job` và thực hiện I/O ngoại vi (gửi Discord DM / file) có khả năng diễn ra đồng thời với thao tác admin hoàn tiền đơn hàng (`refundOrderWallet`). Cần một locking/state-machine protocol cấp worker để đảm bảo nếu đơn đã bước vào quá trình bàn giao hoặc đã hoàn tiền thì worker không gửi lặp hoặc sai trạng thái.
- **Why out of scope**: Thuộc phạm vi của Delivery Worker & Scheduler. Phase 3A cấm tuyệt đối sửa đổi Delivery Worker.
- **Suggested future phase**: Phase 3B — Delivery Worker Hardening.

---

### Finding 2: Inaccurate Net Sales Accounting for Refunded Orders
- **File**: `discord/src/http/routes/dashboard-api.ts`
- **Line**: 110-145
- **Issue**: Truy vấn tổng doanh thu đang sử dụng `SUM(orders.amount) WHERE status IN ('paid', 'wallet_paid', 'delivered')`. Khi một đơn hàng đã hoàn tiền chuyển status sang `'refunded'`, số tiền thanh toán thực tế của đơn hàng đó bị loại khỏi tổng Settled Sales, dẫn đến công thức kế toán `Net Sales = Settled Sales - Refunds` bị trừ trùng 2 lần số tiền hoàn.
- **Why out of scope**: Thuộc hệ thống Reporting & Analytics trên Dashboard. Phase 3A chỉ tập trung vào Payment/Wallet Core ACID transaction.
- **Suggested future phase**: Phase 3C — Accounting & Financial Reporting Hardening.

---

### Finding 3: Missing Immutable Settled Amount Column on Orders Schema
- **File**: `packages/db/src/schema.ts` & `discord/src/repositories/neon-orders.ts`
- **Line**: 50-80
- **Issue**: Schema hiện tại chưa có cột `settled_amount` bất biến để chốt chính xác số tiền thực tế đã tất toán tại thời điểm thanh toán thành công (phải dựa vào tính toán `paidAmount ?? (status === 'wallet_paid' ? 0 : bankDue)`).
- **Why out of scope**: Đòi hỏi migration database và backfill dữ liệu lịch sử, không được thực hiện trong Phase 3A.
- **Suggested future phase**: Phase 3C — Accounting & Schema Migration.
