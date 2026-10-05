# PHASE 4B-2 REAL DOWNLOAD RELIABILITY IMPLEMENTATION REPORT

> **Mục tiêu**: Nâng cấp toàn diện cơ chế xử lý lỗi và độ tin cậy của Pipeline tải tệp (Direct Download & Fallback), biến các kịch bản kiểm thử lỗi từ "logic-only" thành **Real Pipeline Verification** với HTTP socket thật, stream thật, filesystem I/O thật, và cryptographic hash thật.

---

## 1. TỆP NGUỒN VÀ BỘ KIỂM THỬ THAY ĐỔI (FILES & TESTS CHANGED)

### Files Modified:
- [`discord/src/services/upstream/download-via-browser.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/download-via-browser.ts):
  - Bổ sung `expectedSha256?: string` và `downloadWaitMs?: number` vào `BrowserDownloadDeps`.
  - Triển khai `abortableSleep(ms, signal)` cho vòng lặp kiểm tra tệp: khi `AbortSignal` được kích hoạt, vòng lặp thức dậy và hủy ngay lập tức thay vì phải chờ hết 2 giây.
  - Tích hợp kiểm tra `expectedSha256` trên cả nhánh **Direct Download** và **Fallback Base64**: nếu SHA256 không khớp, tệp `.part` bị hủy ngay bằng `unlink`, không bao giờ publish thành `.jar`.
  - Đưa toàn bộ khởi tạo thư mục tải `mkdirSync(dir)` vào trong khối `try` để bắt và phân loại lỗi filesystem disk failure sạch sẽ (như `ENOTDIR`, `EACCES`, `ENOENT`).
  - Tối ưu luồng Direct Stream: khi đã kích hoạt `directStream: true` qua Blob download, không gọi lặp `openDownload` (`page.goto`) để tránh xung đột tải kép.

### Tests Created:
- [`discord/tests/real-download-reliability.test.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/tests/real-download-reliability.test.ts):
  - Khởi tạo local HTTP test server phục vụ các endpoint thực tế: stream ngắt giữa chừng, stream chậm mid-flight abort, oversized payload, non-JAR HTML, corrupted bytes hash mismatch, và valid payload.
  - Bao quát 7 kịch bản kiểm thử độ tin cậy và khôi phục thực tế.

---

## 2. KỊCH BẢN THẤT BẠI THỰC TẾ (REAL FAILURE SCENARIOS & ASSERTIONS)

| Kịch bản | Cơ chế thực tế | Kết quả kiểm chứng (Observable Outcome) | Trạng thái |
| :--- | :--- | :--- | :--- |
| **1. Interrupted Download** | Server gửi partial response rồi forcibly destroy socket $\rightarrow$ Chromium để lại file `.crdownload` dở dang. | Pipeline phát hiện failure. Không có file `.jar`, không sót lại `.part` hay `.crdownload`. Toàn bộ thư mục tạm được dọn sạch 100%. | **PASS** |
| **2. Abort Signal (Mid-flight)** | Server truyền stream chậm, `controller.abort()` kích hoạt sau 30ms khi đang tải dở dang. | Pipeline ngắt ngay tức thì qua `abortableSleep`, trả về `status: 'error'`, detail chứa `'đang tắt tiến trình'`. Tệp tạm bị xóa sạch. Lượt tải tiếp theo thành công ngay trên cùng page session. | **PASS** |
| **3. Max Bytes Exceeded** | Server trả về tệp 3 MB vượt quá ngưỡng `maxBytes: 1 MB`. | Pipeline từ chối tải, detail `'vượt giới hạn'`. Không có tệp `.jar` nào được publish. Lượt tải kế tiếp với kích thước hợp lệ thành công ngay. | **PASS** |
| **4. Non-JAR Payload** | Server trả về HTML Error 403 Forbidden thay vì JAR. | Pipeline kiểm tra magic bytes `PK\x03\x04`, phát hiện không phải JAR, trả về `status: 'incomplete'`, dọn sạch thư mục tạm. Page session sẵn sàng cho lượt tải sau. | **PASS** |
| **5. Corrupted Artifact** | Server trả về tệp cùng kích thước nhưng byte bên trong bị đảo bit (SHA256 mismatch). | Pipeline tính SHA256 thực tế, so khớp `expectedSha256`, phát hiện mismatch $\rightarrow$ xóa ngay `.part`, không rename sang `.jar`, detail `'SHA256 không khớp'`. | **PASS** |
| **6. Disk Failure** | Trỏ `tmpDir` vào file thông thường (không phải thư mục) để ép ném `ENOTDIR`. | Khối `try-catch` bắt lỗi filesystem, phân loại `status: 'error'`, không publish tệp hỏng dở dang. | **PASS** |
| **7. Success After Failure** | Chạy liên tiếp 3 failure scenarios (Oversized $\rightarrow$ Non-JAR $\rightarrow$ Corrupted) trên **cùng một page session**. | Cả 3 lỗi được xử lý và dọn dẹp sạch sẽ. Lượt thứ 4 tải valid JAR thành công xuất sắc mà **không cần restart trình duyệt**. | **PASS** |

---

## 3. SO SÁNH HÀNH VI ĐỘ TIN CẬY (BEFORE / AFTER RELIABILITY BEHAVIOR)

| Tiêu chí | Trước Phase 4B-2 (Baseline) | Sau Phase 4B-2 (Hardened) |
| :--- | :--- | :--- |
| **Độ trễ hủy khi Abort** | Phải chờ hết chu kỳ `sleep(2000ms)` mới kiểm tra `signal.aborted`. | `abortableSleep` hủy ngay lập tức (< 30ms) khi signal được kích hoạt. |
| **Xác thực SHA256 toàn vẹn** | Chỉ tính hash sau khi ghi đĩa; không so sánh với `expectedSha256` khi tải. | Đối soát `expectedSha256` mã hóa; xóa sạch `.part` ngay nếu hash sai lệch. |
| **Lỗi khởi tạo ổ đĩa (Disk I/O)** | `mkdirSync` nằm ngoài `try`, có thể gây crash unhandled exception nếu ổ đĩa lỗi. | Toàn bộ filesystem I/O nằm trong `try-catch`, phân loại lỗi an toàn. |
| **Tải kép không cần thiết** | Khi `directStream: true`, pipeline vẫn gọi thêm `openDownload(page.goto)`. | Nhánh Direct Stream tránh gọi lặp `page.goto`, loại trừ xung đột tải kép. |
| **Tái sử dụng phiên trình duyệt** | Sau khi lỗi tải, page có thể bị treo hoặc dở dang. | Session/Page giữ nguyên trạng thái lành lặn, lượt tải sau thành công 100%. |

---

## 4. KẾT QUẢ KIỂM TRA CHẤT LƯỢNG (QUALITY GATES)

- **Test Suite Thực tế**:
  - `tests/real-download-reliability.test.ts`: **7/7 passed** (100%).
- **Full Workspace Regression**:
  - `pnpm -r test`: **45 test files passed (45/45)**, **989 tests passed (989/989)**.
- **TypeScript Typecheck**:
  - `pnpm -r exec tsc --noEmit`: **0 errors**.
- **Production Build**:
  - `pnpm -r build`: **Clean build**.
- **Whitespace / Git Diff Check**:
  - `git diff --check`: **0 issues**.
- **Git Commit & Sync**:
  - Commit [`1bc730c`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/download-via-browser.ts) đã được đồng bộ với `origin/main`.
