# PHASE 4C-1: PROCESS SAFETY VÀ POST-LAUNCH EXCEPTION SAFETY BÁO CÁO NGHIỆM THU

> **Mục tiêu**: Loại trừ nguy cơ mồ côi tiến trình Chromium (Orphan Chromium Process Risk) trên cả Windows và Linux/POSIX, ngăn chặn PID reuse, thiết lập cơ chế sở hữu tiến trình nghiêm ngặt, và bảo đảm an toàn ngoại lệ toàn diện trong giai đoạn hậu khởi chạy (Post-Launch Exception Safety).

---

## 1. TỔNG QUAN KIẾN TRÚC & NGUYÊN TẮC THIẾT KẾ (ARCHITECTURE & DESIGN PRINCIPLES)

### 1.1 Quản trị Cây Tiến trình & Chống Tái sử dụng PID (Process Tree Killer & PID Reuse Protection)
- **Tập tin triển khai**: [`process-tree-killer.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/process-tree-killer.ts)
- **Thu thập danh tính tiến trình (Process Identity Capture)**:
  - Trước khi thực thi bất kỳ thao tác kết liễu nào, hệ thống chụp lại `ProcessIdentity` gồm: PID, tên tệp thực thi (`name`), đường dẫn thực thi (`commandPath`), và thời điểm khởi tạo (`creationDate`).
  - Trên Windows: Sử dụng PowerShell CIM query `Get-CimInstance Win32_Process` để lấy thuộc tính `CreationDate`.
- **Bảo vệ chống tái sử dụng PID (PID Reuse Protection)**:
  - Đối chiếu danh tính hiện tại tại thời điểm chuẩn bị kill với danh tính đã chụp lúc khởi chạy trình duyệt (`verifyProcessIdentity`).
  - Nếu PID đã bị hệ điều hành cấp phát lại cho một tiến trình khác (hoặc `CreationDate` / tên tiến trình sai lệch), hệ thống lập tức từ chối kill để bảo vệ các ứng dụng khác của người dùng.
- **Snapshot Hậu duệ (Descendant Snapshotting)**:
  - Thu thập toàn bộ danh sách các tiến trình con (`snapshotDescendants`) thuộc về `ownedPid`.
  - Trên Windows: Chạy lệnh `taskkill /PID <ownedPid> /T /F` có mục tiêu chính xác, tuyệt đối không dùng `taskkill /IM chrome.exe`.
  - Trên Linux/POSIX: Gửi tín hiệu `SIGKILL` tới toàn bộ Process Group (`-pid`).
  - Xác minh hậu kiểm (`verifyClean`): Kiểm tra từng PID trong snapshot hậu duệ để bảo đảm 100% tiến trình con và cha đã biến mất hoàn toàn.

### 1.2 An toàn Ngoại lệ Hậu Khởi chạy (Post-Launch Exception Safety)
- Toàn bộ chuỗi thao tác cấu hình sau khi tiến trình Chrome vừa xuất hiện:
  $$\text{browser.pages()} \to \text{browser.newPage()} \to \text{page.authenticate()} \to \text{tracker.attachBrowser()} \to \text{cookie injection}$$
  đều được đặt trong khối `try-catch` bảo vệ tuyệt đối.
- Bất kỳ lỗi nào phát sinh tại bất kỳ mắt xích nào trong chuỗi này đều kích hoạt quy trình phục hồi khẩn cấp:
  1. `tracker.dispose()`
  2. `closeBrowser()` kết hợp `terminateProcessTree()` để hủy sạch Chrome
  3. `lockHandle.release()` giải phóng Session Lock
  4. `accountLock.release()` giải phóng Account Lock
  5. Xóa sạch thư mục profile tạm thời (`rmSync(dir, { recursive: true, force: true })`)

---

## 2. MA TRẬN KIỂM CHỨNG CHI TIẾT (VERIFICATION MATRIX)

File test: [`discord/tests/browser-lifecycle-safety.test.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/tests/browser-lifecycle-safety.test.ts)

### 2.1 Ma trận Kiểm soát Cây Tiến trình (Process-Tree Matrix)
| Mã Test | Kịch bản kiểm tra | Kỳ vọng (Expected Behavior) | Kết quả thực tế |
| :--- | :--- | :--- | :--- |
| **TEST-PT01** | Capture & Verify Process Identity | Đọc chính xác PID, tên tiến trình và xác thực danh tính trùng khớp. | **PASS** |
| **TEST-PT02** | Terminate Parent & Descendants | Sinh parent process kèm child process $\to$ Snapshot descendants $\to$ Kill tree $\to$ Xác minh cả 2 đều đã chết. | **PASS** |
| **TEST-PT03** | PID Reuse Protection | Giả lập sai lệch Process Identity (tên hoặc creation date) $\to$ Hệ thống từ chối kill, trả về `identity_mismatched`. | **PASS** |
| **TEST-PT04** | Already Exited Process | Tiến trình mục tiêu đã tắt từ trước $\to$ Báo cáo `already_exited`, không ném lỗi. | **PASS** |

### 2.2 Ma trận Ngoại lệ Hậu Khởi chạy (Post-Launch Failure Matrix)
| Mã Test | Vị trí phát sinh lỗi | Hành động dọn dẹp & giải phóng | Kết quả thực tế |
| :--- | :--- | :--- | :--- |
| **TEST-FM01** | Lỗi tại `browser.pages()` | Đóng Chrome, kill process tree, giải phóng lock, xóa thư mục profile tạm. | **PASS** |
| **TEST-FM02** | Lỗi tại `browser.newPage()` | Đóng Chrome, kill process tree, giải phóng lock, xóa thư mục profile tạm. | **PASS** |
| **TEST-FM03** | Lỗi tại `page.authenticate()` | Đóng Chrome, kill process tree, giải phóng lock, xóa thư mục profile tạm. | **PASS** |
| **TEST-FM04** | Luồng thành công bình thường | Thiết lập quyền sở hữu, gọi `close()` dọn dẹp trơn tru. | **PASS** |
| **TEST-FM05** | Lỗi tại `tracker.attachBrowser()` | Đóng Chrome, kill process tree, giải phóng lock, xóa thư mục profile tạm. | **PASS** |
| **TEST-FM06** | Lỗi tại nạp Spigot Cookie | Đóng Chrome, kill process tree, giải phóng lock, xóa thư mục profile tạm. | **PASS** |

---

## 3. KẾT QUẢ KIỂM THỬ TỔNG THỂ (QUALITY GATES)

- **Test Suite**: `tests/browser-lifecycle-safety.test.ts`: **10/10 tests passed** (100%).
- **TypeScript Typecheck**: `pnpm -r exec tsc --noEmit` $\to$ **Exit code 0**.
- **Production Build**: `pnpm -r build` $\to$ **Exit code 0**.
- **Git Commit SHA**: `03d3cb566b74f80756e57ca048a2397544163c98`.

---

```
==================================================
PHASE 4C-1 = CLOSED
==================================================
```
