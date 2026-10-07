# PHASE 4C-3: SESSION RECOVERY & ATOMIC COOKIE STORAGE BÁO CÁO NGHIỆM THU

> **Mục tiêu**: Tối ưu hóa toàn diện độ tin cậy của chu trình sống phiên làm việc (Session Lifecycle), phân loại lỗi thông minh dựa trên bằng chứng thực nghiệm (Failure Classification), lưu trữ tệp cookie nguyên tử (Atomic Cookie Persistence), cơ chế cách ly tệp hỏng chống rò rỉ dữ liệu (Corruption Quarantine), và điều phối phục hồi phiên đồng thời (Concurrent Recovery Serialization) mà **KHÔNG** làm thay đổi bất kỳ cơ chế CAPTCHA, Turnstile, anti-bot hay stealth nào.

---

## 1. MÁY TRẠNG THÁI PHIÊN LÀM VIỆC (SESSION STATE MACHINE)

Hệ thống định nghĩa 7 trạng thái chuẩn tắc cho phiên làm việc của từng tài khoản Spigot:
- **`VALID`**: Session đã được xác thực danh tính đầy đủ, cookies hợp lệ và sẵn sàng phục vụ các tác vụ download/browse.
- **`UNKNOWN`**: Chưa đủ bằng chứng để kết luận session đã chết (gặp lỗi mạng, timeout, hoặc HTTP 403 không rõ nguyên nhân).
- **`NEEDS_LOGIN`**: Có bằng chứng rõ ràng chứng minh phiên xác thực đã bị hủy (Explicit login redirect hoặc kiểm tra authenticated-user thất bại).
- **`CORRUPTED`**: Cấu trúc tệp lưu trữ cookies/session bị hỏng (malformed JSON, rỗng, bị cắt ngắn, hoặc sai schema).
- **`QUARANTINED`**: Tệp cookies bị lỗi đã được bóc tách và di chuyển vào khu vực cách ly an toàn, ngăn chặn việc tái sử dụng tệp hỏng.
- **`RECOVERING`**: Hệ thống đang trong tiến trình tạo lập/khởi tạo lại phiên làm việc mới.
- **`READY`**: Quá trình phục hồi hoàn tất thành công, phiên mới đã được kiểm chứng và sẵn sàng sử dụng.

> 🔴 **Quy tắc bất biến**: Tuyệt đối không biến mọi lỗi mạng tạm thời (network error) thành `NEEDS_LOGIN`.

---

## 2. PHÂN LOẠI LỖI PHIÊN DỰA TRÊN BẰNG CHỨNG (FAILURE CLASSIFICATION)

Mô hình phân loại tại [`classifySessionFailure`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/session-recovery-manager.ts#L79) tuân thủ nghiêm ngặt các điều kiện:
1. **Explicit Login Redirect**: Chuyển hướng tới `/login/` hoặc `spigotmc.org/login` $\to$ **`NEEDS_LOGIN`**.
2. **Authenticated-User Verification Failure**: Trên các trang người dùng (ví dụ `/account/`), thiếu hoàn toàn các dấu hiệu định danh đăng nhập (`data-logged-in="true"`, `/logout/?`, `p-navgroup--member`) $\to$ **`NEEDS_LOGIN`**.
3. **Mã phản hồi HTTP 401**: Unauthorized rõ ràng $\to$ **`NEEDS_LOGIN`**.
4. **Mã phản hồi HTTP 403 (Cơ chế đặc biệt)**:
   - **KHÔNG ĐƯỢC MẶC ĐỊNH 403 LÀ `NEEDS_LOGIN`**. HTTP 403 thường xuyên sinh ra bởi Cloudflare Turnstile, WAF, Rate limit, hoặc CDN edge cache.
   - Chỉ khi HTTP 403 đi kèm bằng chứng xác thực thất bại (ví dụ: kiểm tra trang cá nhân xác nhận đã logout hoặc redirect login) mới chuyển sang **`NEEDS_LOGIN`**.
   - Nếu không có bằng chứng mất xác thực: Phân loại thành **`TRANSIENT`** và giữ nguyên cookies!
5. **Lỗi Mạng Tạm Thời & Hạ Tầng**:
   - Network timeout (`TimeoutError`, `net::ERR_TIMED_OUT`, `Navigation timeout`).
   - Socket reset (`ECONNRESET`, `net::ERR_CONNECTION_RESET`, `socket hang up`).
   - CDP failure (`Protocol error`, `Target closed`, `Session closed`, `browser disconnected`).
   - Browser crash (`page crashed`, `chrome process exited`).
   - Temporary DNS / HTTP 429/502/503/504 $\to$ **`TRANSIENT`** (Tuyệt đối không xóa cookie của người dùng).
6. **Lỗi Lưu Trữ (Storage Failure)**:
   - Malformed JSON, truncated file, 0-byte file $\to$ **`CORRUPTED`** $\to$ Chuyển sang Quarantine.

---

## 3. LƯU TRỮ COOKIE NGUYÊN TỬ (ATOMIC COOKIE PERSISTENCE)

Hàm [`atomicWriteJsonFile`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/session-recovery-manager.ts#L162) giải quyết triệt để vấn đề tệp bị cắt cụt (truncated) hoặc rỗng (zero-byte):
1. **Serialize**: Chuẩn hóa dữ liệu thành chuỗi JSON hợp lệ.
2. **Ghi tệp tạm cùng thư mục**: Tạo tệp `.tmp.<filename>.<pid>.<timestamp>.<random>` trên cùng một filesystem.
3. **Đồng bộ hóa đĩa (fsync)**: Gọi `fsyncSync` để đẩy toàn bộ buffer từ OS cache xuống physical storage.
4. **Thay thế nguyên tử (Atomic Replace)**: Sử dụng `renameSync` để tráo đổi directory entry nguyên tử.
5. **Cấm tuyệt đối**: Không bao giờ thực hiện chuỗi `delete target -> rename temp`.
6. **Bảo đảm**: Tại bất kỳ thời điểm nào, tiến trình đọc đều chỉ nhìn thấy `VALID OLD FILE` hoặc `VALID NEW FILE`, không bao giờ đọc phải tệp 0-byte hoặc JSON dở dang.

---

## 4. AN TOÀN TRÊN NỀN TẢNG WINDOWS (WINDOWS SAFETY)

- Trên Windows NT (NTFS/ReFS), `MoveFileEx` được bọc với cơ chế retry có backoff ngắn (5 lượt) để phòng ngừa các tiến trình hệ thống như Windows Defender, Search Indexer tạm thời khóa file.
- Đã kiểm chứng thực tế: Chạy **100 chu kỳ ghi đè nguyên tử liên tiếp** (`TEST-SR13`). Kết quả: **100/100 lượt đọc đều hợp lệ**, zero file bị lỗi hoặc cắt ngắn.
- **Fail-closed**: Nếu không thể bảo đảm thay thế nguyên tử, hệ thống giữ nguyên tệp cookie hợp lệ cũ thay vì phá hủy nó.

---

## 5. CÔ LẬP TỆP HỎNG (CORRUPTION QUARANTINE)

Hàm [`quarantineCorruptedFile`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/session-recovery-manager.ts#L254):
- Khi phát hiện tệp cookie bị hỏng: Tự động đổi tên sang `cookies.json.corrupt.<timestamp>.<random>`.
- **Chống trùng lặp (Anti-Collision)**: Tạo suffix ngẫu nhiên kết hợp kiểm tra `existsSync`, bảo đảm không bao giờ ghi đè lên các artifact cách ly trước đó (`TEST-SR15`).
- **An toàn bảo mật (Zero Secret Leakage)**:
  - Tên tệp cách ly tuyệt đối không chứa password, token hay cookie values.
  - Log console chỉ hiển thị tên file cách ly, không bao giờ in nội dung cookie (`TEST-SEC01`).

---

## 6. QUY TRÌNH PHỤC HỒI & ĐỒNG BỘ HÓA ĐỒNG THỜI (RECOVERY & CONCURRENCY)

- **Bảo vệ bằng Account Mutex (Phase 4C-2)**:
  - Khi hai Job A và Job B cùng nhận diện phiên của tài khoản bị hỏng, cả hai đều yêu cầu khóa tài khoản qua [`accountMutexManager.acquire(accountLabel)`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/upstream/account-mutex-manager.ts#L86).
  - **Single Recovery Owner**: Job A nhận khóa và tiến hành phục hồi. Job B được xếp hàng chờ an toàn.
  - Sau khi Job A hoàn thành và cập nhật trạng thái `READY` / `VALID`, Job B thức dậy, nhận thấy session đã sẵn sàng và tái sử dụng ngay lập tức mà **KHÔNG** chạy lại worker phục hồi lần 2 (`TEST-SR12`).
- **Bảo toàn khi Thất bại Giữa Chừng (Partial Failure Safety)**:
  - Nếu tiến trình phục hồi gặp sự cố nửa chừng (ví dụ challenge giải thất bại), tệp cookie hợp lệ cũ trên đĩa vẫn được giữ nguyên vẹn 100%, không bị xóa sạch (`TEST-SR14`).

---

## 7. MA TRẬN KIỂM CHỨNG TOÀN DIỆN (RECOVERY TEST MATRIX)

File kiểm thử: [`discord/tests/session-recovery-atomic-cookies.test.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/tests/session-recovery-atomic-cookies.test.ts)

| Mã Kiểm Thử | Kịch Bản Thử Nghiệm | Kỳ Vọng (Expected Behavior) | Kết Quả Thực Tế |
| :--- | :--- | :--- | :--- |
| **TEST-SR01** | Valid cookie $\to$ load $\to$ authenticated | Trạng thái chuyển `VALID` $\to$ `READY`, nhận diện marker đăng nhập. | **PASS** |
| **TEST-SR02** | Malformed JSON cookie file | Tệp hỏng bị cách ly (`.corrupt.`), kích hoạt phục hồi session mới thành công. | **PASS** |
| **TEST-SR03** | Truncated cookie file | Cách ly tệp bị cắt ngắn, tạo lại session sạch sẽ. | **PASS** |
| **TEST-SR04** | Empty cookie file (zero-byte) | Cách ly tệp rỗng, nạp phiên mới an toàn. | **PASS** |
| **TEST-SR05** | Network timeout | Giữ nguyên cookies, không chuyển thành `NEEDS_LOGIN`. | **PASS** |
| **TEST-SR06** | Socket reset (ECONNRESET) | Giữ nguyên cookies, phân loại `TRANSIENT`. | **PASS** |
| **TEST-SR07** | CDP failure / Target closed | Giữ nguyên cookies, phân loại `TRANSIENT`. | **PASS** |
| **TEST-SR08** | Explicit login redirect | Phát hiện redirect tới `/login/` $\to$ chuyển `NEEDS_LOGIN`. | **PASS** |
| **TEST-SR09** | Authenticated-user check fails | Trang trả về guest layout $\to$ chuyển `NEEDS_LOGIN`. | **PASS** |
| **TEST-SR10** | HTTP 403 không có auth evidence | **CẤM** suy diễn thành `NEEDS_LOGIN`, giữ nguyên cookies. | **PASS** |
| **TEST-SR11** | HTTP 403 kèm auth failure | Có bằng chứng mất phiên kèm 403 $\to$ chuyển `NEEDS_LOGIN`. | **PASS** |
| **TEST-SR12** | Concurrent recovery cùng account | Chỉ duy nhất 1 worker phục hồi chạy, job sau tái sử dụng session `READY`. | **PASS** |
| **TEST-SR13** | 100 consecutive atomic writes | 100 lượt ghi liên tiếp $\to$ Zero lỗi parse, zero tệp rỗng, toàn vẹn 100%. | **PASS** |
| **TEST-SR14** | Recovery thất bại giữa chừng | Worker ném ngoại lệ $\to$ Cookie hợp lệ cũ trên đĩa vẫn còn nguyên vẹn. | **PASS** |
| **TEST-SR15** | Trùng lặp tên quarantine (Collision) | Tạo 2 tệp hỏng liên tiếp $\to$ Cả 2 được lưu thành 2 file riêng biệt, không ghi đè. | **PASS** |
| **TEST-SEC01** | Bảo mật thông tin nhạy cảm | Tên tệp cách ly và log không bao giờ chứa cookie values hay passwords. | **PASS** |

---

## 8. BÁO CÁO HỒI QUY TOÀN DIỆN (FULL REGRESSION GATES)

| Bộ Kiểm Thử (Test Suite) | Tập Tin Kiểm Thử | Số Lượng Tests | Trạng Thái |
| :--- | :--- | :--- | :--- |
| **Phase 4C-3 Suite** | `tests/session-recovery-atomic-cookies.test.ts` | **16/16** | **PASS (100%)** |
| **Phase 4C-2 Suite** | `tests/browser-timeout-lock-lifecycle.test.ts` | **23/23** | **PASS (100%)** |
| **Phase 4C-1 Suite** | `tests/browser-lifecycle-safety.test.ts` | **10/10** | **PASS (100%)** |
| **Phase 4B-2 Real E2E** | `tests/cloak-browser-download-e2e.test.ts` | **7/7** | **PASS (100%)** |
| **Phase 4B-2 Real Pipeline** | `tests/real-download-reliability.test.ts` | **7/7** | **PASS (100%)** |
| **Spigot Cookie Files** | `tests/spigot-cookie-files.test.ts` | **7/7** | **PASS (100%)** |
| **Toàn Bộ Repository** | `pnpm -r test` | **49/49 files (1,045 tests)** | **PASS (100%)** |

---

## 9. CHẤT LƯỢNG MÃ NGUỒN & BIÊN DỊCH (STATIC ANALYSIS & BUILD)

1. **TypeScript Typecheck**:
   ```bash
   pnpm -r exec tsc --noEmit
   # Exit code: 0 (Zero errors)
   ```
2. **Biên dịch Production (Build)**:
   ```bash
   pnpm -r build
   # Client và Server biên dịch thành công hoàn hảo: Exit code 0
   ```
3. **Kiểm tra Git Whitespace / Conflict Markers**:
   ```bash
   git diff --check HEAD~1
   # Exit code: 0 (Zero warnings, zero issues)
   ```
4. **Git Commit SHA**:
   - `673beecb893122c608f7db7d3b36fae70a3013c7`
   - Message: `feat(phase-4c-3): implement session recovery, failure classification, and atomic cookie storage`

---

## 10. KẾT LUẬN

Hệ thống đã đáp ứng 100% tất cả các tiêu chí nghiệm thu của **Phase 4C-3**:
- [x] Lỗi mạng tạm thời không bao giờ phá hủy các phiên làm việc hợp lệ.
- [x] Phân loại lỗi mất phiên hoàn toàn dựa trên bằng chứng thực nghiệm, không tự suy diễn bừa bãi từ HTTP 403.
- [x] Tệp lưu trữ cookie bị hỏng được tự động cô lập an toàn, không rò rỉ secret token.
- [x] Ghi đè cookie đạt tính nguyên tử tuyệt đối trên cả Windows và POSIX.
- [x] Phục hồi phiên đồng thời được tuần tự hóa an toàn qua Account Mutex, bảo đảm đúng 1 recovery owner.
- [x] Giữ nguyên toàn bộ cơ chế bảo vệ anti-bot, stealth và CAPTCHA.
- [x] Vượt qua 100% bài test hồi quy của tất cả các Phase trước đó.

```
==================================================
PHASE 4C-3 = CLOSED
==================================================
```
