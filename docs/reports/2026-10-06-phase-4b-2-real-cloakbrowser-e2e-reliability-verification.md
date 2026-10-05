# PHASE 4B-2 REAL CLOAKBROWSER E2E RELIABILITY VERIFICATION REPORT

> **Mục tiêu**: Nâng cấp toàn diện cơ chế xác minh độ tin cậy từ "Real HTTP server + Mocked BrowserPage" thành **REAL CLOAKBROWSER + REAL PAGE + REAL HTTP SOCKET + REAL FILESYSTEM**. Kiểm chứng thực tế mọi kịch bản lỗi mạng, ngắt socket, hủy luồng, quá dung lượng, payload HTML, sai lệch hash, và phục hồi phiên trình duyệt sau sự cố.

---

## 1. MÔI TRƯỜNG & KIẾN TRÚC TEST FIXTURE (TEST FIXTURE ARCHITECTURE)

- **Trình duyệt**: CloakBrowser Chromium (Headless, 87 C++ stealth patches, phiên bản `0.5.11`).
- **Khởi tạo Browser**: Khởi chạy trực tiếp thông qua `probeBrowserLauncher().launch({ headless: true, ephemeral: true })`.
- **Thực thi trên trang (Page Context)**: Sử dụng chính `session.page` từ CloakBrowser, hoàn toàn **KHÔNG MOCK**:
  - Không mock `page.evaluate()`, lệnh JS được nạp và thực thi trực tiếp trong Chromium V8 engine.
  - Không tự ghi đè `writeFileSync` để tạo `.crdownload` hay `.part` từ test; Chromium nhị phân tự quản lý tải ra đĩa thông qua CDP `Page.setDownloadBehavior` & `Browser.setDownloadBehavior`.
- **Local HTTP Test Server**: Chạy trên `http://127.0.0.1:<random_port>` với khả năng thao tác trực tiếp socket TCP (`res.socket?.destroy()`), điều phối stream chunk, và thiết lập headers.

---

## 2. KẾT QUẢ KIỂM CHỨNG TRÊN CLOAKBROWSER THẬT (REAL PIPELINE RESULTS)

| Kịch bản | Cơ chế thực tế trên CloakBrowser | Kết quả kiểm chứng (Observable Outcome) | Trạng thái |
| :--- | :--- | :--- | :--- |
| **1. Real Interrupted Socket** | Chromium gọi `fetch('/download/interrupted')`, server ngắt kết nối TCP đột ngột giữa chừng (`socket.destroy()`). | Chromium nhận lỗi mạng thật (`net::ERR_CONNECTION_RESET` / socket hang up). Pipeline bắt lỗi, không publish `.jar`, không để lại `.part` hay `.crdownload`. Thư mục tạm sạch 100%. | **PASS** |
| **2. Real Abort Signal** | Chromium đang tải stream chậm từ server, `controller.abort()` kích hoạt sau 40ms. | Pipeline ngắt tức thì qua `abortableSleep`, trả về `status: 'error'`, detail chứa `'đang tắt tiến trình'`. Thư mục tạm dọn sạch. Ngay sau đó, tải hợp lệ thành công ngay trên **cùng page session** đó. | **PASS** |
| **3. Real Max Bytes** | Server gửi tệp 3 MB thật; `maxBytes` đặt 1 MB. | Chromium ghi nhận kích thước vượt ngưỡng, pipeline từ chối tải (`'vượt giới hạn'`). Zero file `.jar` xuất hiện trên đĩa. Lượt tải sau thành công ngay. | **PASS** |
| **4. Real Non-JAR Payload** | Server trả về HTML 403 Forbidden thật (`<!DOCTYPE html>...`). | Chromium tải về tệp, pipeline đọc 200 bytes đầu từ đĩa, phát hiện thiếu magic bytes `PK\x03\x04` $\rightarrow$ từ chối với status `'incomplete'`, detail `'không phải jar'`. | **PASS** |
| **5. Real Corrupt Artifact** | Server trả về tệp nhị phân có cùng kích thước nhưng các byte bên trong bị đảo bit (corrupted). | Pipeline tính cryptographic SHA256 digest thực tế, phát hiện không khớp với `deps.expectedSha256` $\rightarrow$ xóa ngay tệp `.part`, detail `'SHA256 không khớp'`. | **PASS** |
| **6. Real Disk Failure** | Trỏ `tmpDir` vào một tệp tin thông thường trên hệ điều hành để ép `mkdirSync` / `open` ném `ENOTDIR` / `EEXIST`. | Khối `try-catch` của pipeline bắt lỗi và phân loại thành `status: 'error'`, không gây crash tiến trình, dọn dẹp an toàn. | **PASS** |
| **7. Real Success After Failure** | Chạy chuỗi liên tiếp: `oversized` $\rightarrow$ `non-JAR` $\rightarrow$ `corrupted` $\rightarrow$ `valid` trên **DUY NHẤT một CloakBrowser page**. | Cả 3 failure cases đều được xử lý và dọn dẹp sạch sẽ. Lượt thứ 4 tải valid JAR thành công 100% với kích thước và SHA256 hoàn hảo mà **KHÔNG cần restart trình duyệt**. | **PASS** |

---

## 3. SỨC KHỎE TRÌNH DUYỆT SAU SỰ CỐ (BROWSER HEALTH AFTER FAILURES)

Sau mỗi kịch bản lỗi xảy ra, hệ thống tự động kiểm tra sức khỏe của phiên Chromium:
- `page.title()`: Phản hồi bình thường, trả về chuỗi tiêu đề hợp lệ.
- `page.evaluate('1 + 1')`: V8 engine của Chromium tính toán và trả về chính xác `2`.
- `page.createCDPSession()`: Kết nối CDP mới được thiết lập và detach trơn tru.
- **Kết luận**: Mọi sự cố tải tệp (interrupted stream, abort, format lỗi, hash sai) đều được cô lập tuyệt đối, **không làm nhiễm độc (poison) hay làm hỏng phiên CloakBrowser**.

---

## 4. BÁO CÁO KIỂM THỬ CHẤT LƯỢNG (QUALITY GATES)

- **CloakBrowser E2E Reliability Suite**:
  - `tests/cloak-browser-download-e2e.test.ts`: **7/7 tests passed** (100%).
- **Full Workspace Regression**:
  - `pnpm -r test`: **46/46 test files passed**, **996/996 tests passed** (100%).
- **TypeScript Typecheck**:
  - `pnpm -r exec tsc --noEmit`: **0 errors**.
- **Production Build**:
  - `pnpm -r build`: **Clean build** (Client và Server thành công 100%).
- **Whitespace / Git Diff Check**:
  - `git diff --check`: **0 issues**.
- **Git Commit SHA**:
  - `9a2d85fdc41321559dcdc253fdd37e66d3403f2d` synced on `origin/main`.
