# PHASE 4C-2: TIMEOUT, LOCK LIFECYCLE VÀ LISTENER SAFETY BÁO CÁO NGHIỆM THU

> **Mục tiêu**: Đóng gói toàn diện cơ chế kiểm soát thời gian thực thi (Absolute Acquisition Deadline), lan truyền AbortSignal chuẩn hóa (Deadline Propagation), chu trình sống của khóa cấp độ tài khoản (Account Mutex Lifecycle), thứ tự khóa chuẩn tắc (Canonical Lock Ordering), quy trình tắt hệ thống có giới hạn thời gian (Bounded Shutdown Lifecycle), và quản lý tham chiếu Event Listener chống rò rỉ bộ nhớ (Listener Safety & Idempotent Disposal).

---

## 1. TỔNG QUAN KIẾN TRÚC & NGUYÊN TẮC THIẾT KẾ (ARCHITECTURE & DESIGN PRINCIPLES)

### 1.1 Ngân sách Hạn chót Tuyệt đối (Absolute Acquisition Deadline)
- **Công thức tính toán**:
  $$\text{deadline} = \text{startedAt} + \text{jobTimeoutMs}$$
  $$\text{remainingMs} = \max(0, \text{deadline} - \text{Date.now}())$$
  $$\text{effectiveTimeout} = \min(\text{configuredTimeoutMs}, \text{remainingMs})$$
- **Nguyên tắc cốt lõi**:
  - Không cho phép bất kỳ thao tác con nào (child operation) có thời hạn vượt quá thời gian còn lại của job cha.
  - Khi $\text{remainingMs} \le 0$, hệ thống lập tức hủy tác vụ, phân loại lỗi thành `JobTimeoutError` (`code: 'JOB_TIMEOUT'`), tiến hành dọn dẹp có giới hạn và không retry vô hạn.
  - Cung cấp helper chuẩn hoá `withDeadline(budget, operation, configuredTimeoutMs, operationName)` trong [`deadline-budget.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/deadline-budget.ts) giúp quản lý tập trung và loại bỏ hoàn toàn các bộ định thời lồng nhau độc lập (nested independent timers).

### 1.2 Quản lý Khóa Tài khoản (Account Mutex Lifecycle)
- **Cô lập theo tài khoản Spigot (Account Isolation)**: Triển khai singleton [`AccountMutexManager`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/account-mutex-manager.ts). Các job cùng nhắm vào một tài khoản (`accountLabel`) được đưa vào hàng đợi FIFO tuần tự nghiêm ngặt.
- **Thực thi song song đa tài khoản (Cross-Account Concurrency)**: Các job sử dụng các tài khoản Spigot khác nhau được phép thực thi đồng thời độc lập, không gây nghẽn cổ chai.
- **Cam kết không rò rỉ khóa (Leak-Free Guarantee)**: Dù job kết thúc thành công, ném ngoại lệ, timeout, bị hủy (abort), crash trình duyệt hay shutdown, khóa tài khoản `AccountLockHandle.release()` luôn được giải phóng trong khối `finally`. Hàng đợi tự động dọn dẹp các mục rỗng trong `Map` để ngăn rò rỉ bộ nhớ.

### 1.3 Thứ tự Khóa Chuẩn tắc (Canonical Lock Ordering)
Để đảm bảo **Zero Lock-Order Inversion** (không bao giờ xảy ra deadlock giữa các tầng khóa), toàn bộ hệ thống tuân thủ nghiêm ngặt quy ước:
```
[ACQUISITION SEQUENCE]
1. Global Scheduling Admission (Kiểm tra Admission Gate & trạng thái Shutdown)
   ↓
2. Account Mutex (accountMutexManager.acquire(accountLabel))
   ↓
3. Browser Session Resource (cloakSessionManager.acquireLock(taskName))

[RELEASE SEQUENCE - REVERSE ORDER]
1. Browser Session Resource (lockHandle.release())
   ↓
2. Account Mutex (accountLock.release())
   ↓
3. Complete Global Admission
```

### 1.4 Vòng đời Event Listener & Idempotent Dispose
- Trong [`chrome-close-detector.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/chrome-close-detector.ts) và [`cloak-session-manager.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/cloak-session-manager.ts), mọi sự kiện gắn vào `browser`, `process`, và `page` đều lưu trữ biến tham chiếu hàm cụ thể (`browserHandler`, `processHandler`, `pageHandler`, `procHandler`).
- Khi gọi `dispose()`, hệ thống sử dụng chính xác `.off()` / `.removeListener()`.
- Phương thức `dispose()` đạt tính lũy biến (idempotent): Gọi nhiều lần không sinh lỗi, không nhân bản dọn dẹp, số lượng listener luôn quay về chính xác baseline (0).

---

## 2. MA TRẬN KIỂM CHỨNG CHI TIẾT (VERIFICATION MATRIX)

### 2.1 Ma trận Event Listener Lifecycle (Listener Matrix)
File test: [`discord/tests/browser-timeout-lock-lifecycle.test.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/tests/browser-timeout-lock-lifecycle.test.ts)

| Mã Test | Kịch bản kiểm tra | Kỳ vọng (Expected Behavior) | Kết quả thực tế |
| :--- | :--- | :--- | :--- |
| **TEST-L01** | Attach/dispose $\times$ 1 | Listener count của `disconnected`, `exit`, `close` trả về baseline (0). | **PASS** |
| **TEST-L02** | Attach/dispose $\times$ 20 | Không rò rỉ listener, không xuất hiện `MaxListenersExceededWarning`. | **PASS** |
| **TEST-L03** | Attach/dispose $\times$ 100 | Sau 100 chu kỳ lặp lại, listener count duy trì ổn định ở baseline (0). | **PASS** |
| **TEST-L04** | Idempotent Dispose $\times$ 3 | Gọi `dispose()` 3 lần liên tiếp: Không ném lỗi, không duplicate cleanup. | **PASS** |
| **TEST-L05** | Closure Isolation | Gắn browser mới tự động unbind sạch sẽ handler của browser cũ. | **PASS** |

### 2.2 Ma trận Account Mutex Lifecycle (Mutex Matrix A - J)
| Mã Test | Nhánh Ma trận | Kịch bản kiểm tra | Kết quả thực tế |
| :--- | :--- | :--- | :--- |
| **TEST-M01** | **Matrix A** | Cùng tài khoản Spigot $\times$ 2 jobs $\to$ Job B xếp hàng chờ Job A. | **PASS** |
| **TEST-M02** | **Matrix B** | Khác tài khoản Spigot $\times$ 2 jobs $\to$ Chạy song song không chặn nhau. | **PASS** |
| **TEST-M03** | **Matrix C** | Job 1 hoàn thành thành công $\to$ Giải phóng khóa và đánh thức Job 2. | **PASS** |
| **TEST-M04** | **Matrix D** | Job 1 gặp sự cố ngoại lệ $\to$ Khối finally giải phóng khóa, Job 2 nhận khóa bình thường. | **PASS** |
| **TEST-M05** | **Matrix E** | Job 2 timeout trong khi chờ $\to$ Waiter bị bóc tách khỏi queue, không để lại orphan. | **PASS** |
| **TEST-M06** | **Matrix F** | Job 2 bị abort trong khi chờ $\to$ Hủy waiter ngay lập tức, Job 1 release sạch sẽ. | **PASS** |
| **TEST-M07** | **Matrix G** | Trình duyệt crash $\to$ Tracker nhận diện và kích hoạt thu hồi khóa tài khoản an toàn. | **PASS** |
| **TEST-M08** | **Matrix H** | Shutdown trong khi Job 2 đang chờ $\to$ Hủy và giải tán waiter với thông báo shutdown. | **PASS** |
| **TEST-M09** | **Matrix I** | Hệ thống đang trong trạng thái shutdown $\to$ Từ chối mọi yêu cầu cấp khóa mới. | **PASS** |
| **TEST-M10** | **Matrix J** | Hủy waiter ở giữa hàng đợi (W2) $\to$ Duy trì tính toàn vẹn FIFO cho các waiter khác (W3). | **PASS** |
| **TEST-O01** | **Lock Order** | Kiểm chứng thứ tự: Admission $\to$ Account Mutex $\to$ Browser Session và giải phóng ngược lại. | **PASS** |

### 2.3 Ma trận Absolute Deadline & Timeout Propagation (Timeout Matrix A - D)
| Mã Test | Nhánh Ma trận | Kịch bản kiểm tra | Kết quả thực tế |
| :--- | :--- | :--- | :--- |
| **TEST-T01** | **Matrix A** | Parent 120s / Child 180s (đã trôi qua 47s) $\to$ Effective child timeout $\le$ remaining parent time ($\approx 73s$). | **PASS** |
| **TEST-T02** | **Matrix B** | Parent deadline chạm ngưỡng khi child operation đang chạy $\to$ Child nhận abort tức thì, ném `JobTimeoutError`. | **PASS** |
| **TEST-T03** | **Matrix C** | Child timeout ngắn hơn parent (100ms vs 60s) $\to$ Child timeout được tôn trọng chuẩn xác ($\approx 100ms$). | **PASS** |
| **TEST-T04** | **Matrix D** | Parent AbortSignal kích hoạt $\to$ Mọi child operations lập tức quan sát thấy abort signal và hủy bỏ. | **PASS** |
| **TEST-T05** | **Abort Wake** | `abortableSleep` thức dậy ngay lập tức khi nhận abort signal, không ngủ hết 5000ms. | **PASS** |
| **TEST-T06** | **Zero Budget** | `withDeadline` từ chối thực thi và ném `JobTimeoutError` ngay khi `remainingBudget <= 0`. | **PASS** |
| **TEST-S01** | **Shutdown** | `cloakSessionManager.stop()` giải tán hàng đợi và thu hồi khóa trong bounded timeout. | **PASS** |

---

## 3. KẾT QUẢ KIỂM THỬ HỒI QUY TOÀN DIỆN (FULL REGRESSION GATES)

| Bộ Kiểm Thử (Test Suite) | Tập Tin Kiểm Thử | Số Lượng Tests | Trạng Thái |
| :--- | :--- | :--- | :--- |
| **Phase 4C-2 Suite** | `tests/browser-timeout-lock-lifecycle.test.ts` | **23/23** | **PASS (100%)** |
| **Phase 4C-1 Suite** | `tests/browser-lifecycle-safety.test.ts` | **10/10** | **PASS (100%)** |
| **Phase 4B-2 Real E2E** | `tests/cloak-browser-download-e2e.test.ts` | **7/7** | **PASS (100%)** |
| **Phase 4B-2 Real Pipeline** | `tests/real-download-reliability.test.ts` | **7/7** | **PASS (100%)** |
| **Phase 4A Hardening** | `tests/browser-reliability-hardening.test.ts` | **31/31** | **PASS (100%)** |
| **Toàn Bộ Repository** | `pnpm -r test` | **48/48 files (1,029 tests)** | **PASS (100%)** |

---

## 4. TIÊU CHUẨN MÃ NGUỒN & BIÊN DỊCH (STATIC ANALYSIS & BUILD)

1. **Kiểm tra Kiểu dữ liệu (TypeScript Typecheck)**:
   ```bash
   pnpm -r exec tsc --noEmit
   # Exit code: 0 (Zero errors)
   ```
2. **Biên dịch Production (Build)**:
   ```bash
   pnpm -r build
   # Discord bot + Dashboard client/server: Exit code 0 (Hoàn thành xuất sắc)
   ```
3. **Kiểm tra Định dạng & Ký tự Trắng (Git Diff Check)**:
   ```bash
   git diff --check HEAD~1
   # Exit code: 0 (Zero whitespace errors, zero conflict markers)
   ```
4. **Git Commit Ghi nhận**:
   - **Commit SHA**: `3701b504cd7f8df626cd5399af5a4ff616038f93`
   - **Commit Message**: `feat(phase-4c-2): implement timeout, lock lifecycle, and listener safety`
   - **Tệp thay đổi**: 7 files, 1319 insertions, 26 deletions.

---

## 5. KẾT LUẬN

Hệ thống đã đáp ứng đầy đủ và vượt qua toàn bộ các tiêu chí nghiệm thu khắt khe nhất của **Phase 4C-2**:
- [x] Parent deadline mang tính tối cao, không có child operation nào sống sót vượt quá parent deadline.
- [x] Vòng đời Account Mutex hoàn toàn không rò rỉ (leak-free) trong mọi kịch bản.
- [x] Thứ tự khóa chuẩn tắc (Canonical lock ordering) loại trừ triệt để nguy cơ deadlock.
- [x] Shutdown hệ thống giải tán hàng đợi an toàn, không treo tiến trình.
- [x] Vòng đời Event listener được giải phóng chính xác và đạt tính lũy biến (idempotent).
- [x] Bảo toàn 100% tính năng tải file và bảo vệ an toàn của Phase 4B.

```
==================================================
PHASE 4C-2 = CLOSED
==================================================
```
