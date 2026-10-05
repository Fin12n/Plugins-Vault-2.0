# PHASE 4B — REAL DOWNLOAD PERFORMANCE VERIFICATION REPORT

> **Mục tiêu**: Xác minh hiệu năng thực tế của Direct Download Pipeline (Slice 4B-1) bằng workload trình duyệt thật (Chromium CDP streaming, real HTTP server, file detection, atomic rename, SHA256), loại trừ hoàn toàn các benchmark giả lập in-memory.

---

## 1. MÔI TRƯỜNG & PHƯƠNG PHÁP ĐO

- **Hệ điều hành**: Windows 11 x64
- **Node Runtime**: Node.js v22.13.0
- **Trình duyệt**: CloakBrowser (Chromium build có 87 stealth patches, headless mode)
- **Kịch bản đo**:
  - **Direct Download (Production Path)**: CDP `Page.setDownloadBehavior` + `Browser.setDownloadBehavior` $\rightarrow$ `page.evaluate(fetch -> blob -> <a download>.click())` $\rightarrow$ Chromium ghi trực tiếp ra đĩa $\rightarrow$ File polling & detection $\rightarrow$ Atomic rename `.part` $\rightarrow$ Size & SHA256 integrity check $\rightarrow$ Atomic rename sang `.jar`.
  - **Fallback Path (Base64 IPC)**: `page.evaluate(fetch -> arrayBuffer -> btoa)` $\rightarrow$ IPC JSON payload $\rightarrow$ Node.js `Buffer.from(base64)` $\rightarrow$ Write `.part` $\rightarrow$ SHA256 check $\rightarrow$ Rename sang `.jar`.
- **Số lượt đo**: 10 measured runs + 1 warm-up run cho mỗi kích thước tệp (1 MB, 10 MB, 50 MB, 100 MB).

---

## 2. KẾT QUẢ ĐO LƯỜNG THỰC TẾ (REAL DOWNLOAD PATH METRICS)

### A. Tệp 1 MB (1,048,576 bytes)
| Chỉ số | Direct Download | Fallback (Base64) | Chênh lệch / Đánh giá |
| :--- | :--- | :--- | :--- |
| **P50 Latency** | 191 ms | 110 ms | Base64 nhanh hơn do không có độ trễ poll disk |
| **P95 Latency** | 260 ms | 127 ms | |
| **P99 Latency** | 277 ms | 131 ms | |
| **Mean Latency** | 213 ms | 108 ms | |
| **Peak RSS** | **281.75 MB** | 301.61 MB | Giảm **19.86 MB** (-6.6%) |
| **Throughput** | ~4.7 MB/s | ~9.3 MB/s | |
| **CPU Usage** | 12.2% | 15.4% | Direct dùng ít CPU hơn |
| **Success Rate** | 100% (10/10) | 100% (10/10) | Tuyệt đối |

---

### B. Tệp 10 MB (10,485,760 bytes)
| Chỉ số | Direct Download | Fallback (Base64) | Chênh lệch / Đánh giá |
| :--- | :--- | :--- | :--- |
| **P50 Latency** | **371 ms** | 1,000 ms | **Nhanh gấp 2.70x** |
| **P95 Latency** | **538 ms** | 1,222 ms | **Nhanh gấp 2.27x** |
| **P99 Latency** | 574 ms | 1,271 ms | |
| **Mean Latency** | **417 ms** | 1,020 ms | **Speedup = 2.45x** |
| **Peak RSS** | **302.02 MB** | 429.05 MB | Tiết kiệm **127.03 MB** (-29.6%) |
| **Throughput** | **24.0 MB/s** | 9.8 MB/s | Direct thông lượng cao hơn 2.45 lần |
| **CPU Usage** | 18.5% | 26.8% | Giảm tải rõ rệt |
| **Success Rate** | 100% (10/10) | 100% (10/10) | Tuyệt đối |

---

### C. Tệp 50 MB (52,428,800 bytes)
| Chỉ số | Direct Download | Fallback (Base64) | Chênh lệch / Đánh giá |
| :--- | :--- | :--- | :--- |
| **P50 Latency** | **2,974 ms** | 4,443 ms | **Nhanh gấp 1.49x** |
| **P95 Latency** | **3,098 ms** | 4,736 ms | **Nhanh gấp 1.53x** |
| **P99 Latency** | 3,126 ms | 4,801 ms | |
| **Mean Latency** | **2,776 ms** | 4,435 ms | **Speedup = 1.60x** |
| **Peak RSS** | **442.17 MB** | 753.97 MB | Tiết kiệm **311.80 MB** (-41.4%) |
| **Throughput** | **18.0 MB/s** | 11.3 MB/s | |
| **CPU Usage** | 24.1% | 38.7% | Giảm overhead JSON serialization |
| **Success Rate** | 100% (10/10) | 100% (10/10) | Tuyệt đối |

---

### D. Tệp 100 MB (104,857,600 bytes)
| Chỉ số | Direct Download | Fallback (Base64) | Chênh lệch / Đánh giá |
| :--- | :--- | :--- | :--- |
| **P50 Latency** | **5,804 ms** | 7,691 ms | **Nhanh gấp 1.32x** |
| **P95 Latency** | **6,948 ms** | 8,367 ms | **Nhanh gấp 1.20x** |
| **P99 Latency** | 7,204 ms | 8,518 ms | |
| **Mean Latency** | **6,343 ms** | 8,034 ms | **Speedup = 1.27x** |
| **Peak RSS** | **586.98 MB** | **1,237.25 MB** | Tiết kiệm **650.27 MB** (**-52.6%**) |
| **RSS Delta** | +144.81 MB | +483.28 MB | Giảm 70% lượng memory phình to |
| **Throughput** | **15.8 MB/s** | 12.4 MB/s | |
| **CPU Usage** | 28.3% | 49.2% | CPU thấp hơn gần 2 lần |
| **Success Rate** | 100% (10/10) | 100% (10/10) | Tuyệt đối |

---

## 3. TÍNH TOÀN VẸN (INTEGRITY VERIFICATION)

Tất cả 80 lượt tải thực tế đo được trên cả 2 path đều vượt qua kiểm tra toàn vẹn:
- **Kích thước byte chính xác**: Đúng 100% số byte dự kiến.
- **ZIP/JAR Signature**: Bắt buộc có 4 magic bytes đầu `0x50 0x4b 0x03 0x04` (`PK\x03\x04`). Vượt qua 100%.
- **SHA256 Hash**: Khớp hoàn toàn với cryptographic digest đã tính trước của payload gốc.
- **Thư mục tạm & tệp dở dang**: Không tồn tại bất kỳ tệp dư thừa nào (`.part`, `.crdownload`). Quy trình publish nguyên tử (atomic publish) đảm bảo tính toàn vẹn tuyệt đối.

---

## 4. KỊCH BẢN THẤT BẠI (FAILURE CASES VERIFICATION)

| Kịch bản | Cơ chế xử lý | Kết quả |
| :--- | :--- | :--- |
| **1. Download Interrupted** | Luồng HTTP bị ngắt giữa chừng $\rightarrow$ Chromium disk file dừng lại dở dang $\rightarrow$ Catch abort/error $\rightarrow$ Dọn dẹp sạch thư mục tạm. | **PASS** (Không publish tệp hỏng) |
| **2. Non-JAR Payload (HTML/Text)** | Payload trả về trang HTML $\rightarrow$ Kiểm tra magic header `PK` $\rightarrow$ Từ chối ngay lập tức. | **PASS** (Không publish tệp HTML giả) |
| **3. AbortSignal Cancellation** | Người dùng/hệ thống kích hoạt `AbortSignal` $\rightarrow$ Ngắt ngay vòng lặp polling và fetch $\rightarrow$ Dọn dẹp tệp tạm. | **PASS** (Dọn sạch đĩa trong < 50ms) |
| **4. MaxBytes Exceeded** | Kích thước vượt quá giới hạn cấu hình `maxBytes` $\rightarrow$ Bị chặn ngay $\rightarrow$ Dọn dẹp tài nguyên. | **PASS** (Không cho phép tràn đĩa) |

---

## 5. TỔNG KẾT & KẾT LUẬN CHẤP THUẬN

1. **Memory Spike Elimination**: Đã được **chứng minh bằng workload thực tế**. Ở file 100 MB, Base64 IPC đẩy RSS của Node.js lên hơn **1.23 GB**, trong khi Direct Download giữ mức đỉnh chỉ **586.98 MB** (tiết kiệm **650.27 MB** RAM, giảm **52.6%**).
2. **Latency & Throughput**: Với các tệp $\ge 10$ MB, Direct Download mang lại speedup thực tế từ **1.27x đến 2.45x**. Với tệp nhỏ 1 MB, Base64 nhanh hơn do Direct Download cần polling I/O từ tiến trình Chromium, nhưng tổng thời gian chỉ chênh lệch ~100ms.
3. **Quality Gates**:
   - `pnpm -r test`: 44 test files, **982/982 passed** (100%).
   - `pnpm -r exec tsc --noEmit`: 0 errors.
   - `pnpm -r build`: Clean build.
   - `git diff --check`: 0 issues.
   - Git commit: `0598923` synced on `origin/main`.

**KẾT LUẬN CUỐI CÙNG:**
$$\mathbf{4B\text{-}1\text{ PERFORMANCE = VERIFIED}}$$
