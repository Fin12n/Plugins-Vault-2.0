# BÁO CÁO TRIỂN KHAI PHASE 5B — SPIGET SCANNER & VERSION DETECTION

**Ngày thực hiện**: 2026-10-07  
**Phạm vi**: PHASE 5B ONLY (Spiget Adapter, Scanner Service, Scheduling, Version Detection, Concurrency, Deduplication)  
**Trạng thái**: VERIFIED / CLOSED  

---

## 1. Kiến Trúc Tổng Thể (Architecture)

Quy trình tuần tự canonical của Scanner:
```
Plugin Registry (DB)
        ↓
Scheduler (Eligible check: enabled = true && next_scan_at <= now)
        ↓
Plugin Mutex (Per-plugin serialization lock)
        ↓
Spiget Source Adapter (HTTP Client with timeout & retry)
        ↓
Remote Version Detection (Validate & Normalize)
        ↓
Canonical Registry (findVersionByNormalized)
        ↓
Create missing Plugin Version (getOrCreatePluginVersion)
        ↓
Update scan metadata (SUCCESS / status, next_scan_at with bounded jitter)
        ↓
Finish (Release Mutex)
```

### Ranh Giới Nghiệp Vụ Bất Biến (Absolute Boundaries):
1. **Scanner CHỈ PHÁT HIỆN danh tính phiên bản**: Đăng ký các bản ghi `plugin_versions` mới vào cơ sở dữ liệu.
2. **Scanner TUYỆT ĐỐI KHÔNG tải xuống artifact**: Không tạo/sửa đổi bất kỳ bản ghi `plugin_artifacts` nào, không tải tệp JAR.
3. **Scanner TUYỆT ĐỐI KHÔNG cấp entitlement**: Không tạo bản ghi `plugin_entitlements` cho người dùng.
4. **Scanner TUYỆT ĐỐI KHÔNG sửa đổi đơn hàng/giao dịch**: Không can thiệp vào `orders` hoặc `wallets`.
5. **Scanner TUYỆT ĐỐI KHÔNG xóa dữ liệu lịch sử**: Khi remote 404 hoặc phiên bản cũ biến mất khỏi Spiget, dữ liệu lịch sử trong DB vẫn được giữ nguyên vẹn.

---

## 2. Hạ Tầng Tái Sử Dụng (Existing Infrastructure Reused)

1. **Phase 5A Canonical Registry**:
   - `plugins`: Tái sử dụng bảng `plugins` và metadata lập lịch quét (`enabled`, `scan_interval_seconds`, `next_scan_at`, `last_scan_at`, `last_scan_status`, `last_scan_error`).
   - `versions` (`pluginVersions`): Tái sử dụng bảng phiên bản kèm ràng buộc `UNIQUE(plugin_id, version_normalized)`.
   - `normalizePluginVersion`: Tái sử dụng hàm chuẩn hóa từ `version-normalizer.ts`.
   - `getOrCreatePluginVersion`: Tái sử dụng hàm upsert an toàn race condition từ `neon-versions.ts`.
2. **Hệ Thống Cấu Hình**:
   - Mở rộng `envSchema` trong [`discord/src/config/env.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/config/env.ts) bổ sung các biến cấu hình `SCANNER_*` với giá trị mặc định tương thích ngược 100%.

---

## 3. Spiget Source Adapter (`SpigetPluginSourceAdapter`)

Tạo abstraction [`PluginSourceAdapter`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/registry/source-adapter.ts) và triển khai cụ thể [`SpigetPluginSourceAdapter`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/registry/spiget-source-adapter.ts):
- **Cô lập hoàn toàn URL**: Business logic không chứa URL Spiget thô; endpoint `/resources/{id}/versions/latest` được đóng gói trong adapter.
- **Định danh nguồn chuẩn**: Nhận diện theo cặp `(platform: 'spigot', resourceId)`, tuyệt đối không dựa vào display name.
- **Quản lý Timeout**: Bounded timeout sử dụng `AbortSignal.timeout(timeoutMs)` (mặc định 10s).
- **Phân loại lỗi**:
  - `TRANSIENT`: HTTP 408, 500, 502, 503, 504, lỗi kết nối mạng.
  - `RATE_LIMITED`: HTTP 429 (tự động phân tích header `Retry-After`).
  - `NOT_FOUND`: HTTP 404 (trả về `null`, không coi là lỗi nghiêm trọng).
  - `PERMANENT`: HTTP 400, 401, 403 (không retry vô ích).
  - `INVALID_RESPONSE`: JSON lỗi hoặc thiếu các trường bắt buộc (`name`, `releaseDate`, `id`/`uuid`).
- **Retry với Exponential Backoff & Jitter**: Chỉ retry các lỗi `TRANSIENT` và `RATE_LIMITED` với trần số lần retry (mặc định 3 lần) và thời gian chờ tối đa `maxDelayMs`.

---

## 4. Dịch Vụ Quét Phiên Bản (`PluginScannerService`)

Triển khai tại [`discord/src/services/registry/plugin-scanner-service.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/registry/plugin-scanner-service.ts):
- **Quét Đơn Lẻ (`scanPlugin`)**:
  - Kiểm tra Mutex per-plugin.
  - Đọc plugin từ DB, bỏ qua nếu `enabled = false` (zero network calls).
  - Gọi adapter, xác thực phản hồi, chuẩn hóa version.
  - Kiểm tra tính tồn tại: nếu đã có -> idempotent tái sử dụng; nếu chưa có -> tạo bản ghi `versions` mới.
  - Cập nhật scan metadata và tính toán `next_scan_at`.
- **Quét Danh Sách (`scanEligiblePlugins`)**:
  - Lấy các plugin thỏa mãn điều kiện `enabled = true` và `next_scan_at <= now`.
  - Thực thi qua Bounded Concurrency Pool (giới hạn tối đa `maxConcurrentScans`).
  - Tổng hợp kết quả: `SweepSummary`.

---

## 5. Nhận Diện & Đối Sánh Phiên Bản (Version Detection & Comparison)

Triển khai module [`version-comparator.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/registry/version-comparator.ts):
- **So sánh số học đa phân đoạn (`comparePluginVersions`)**:
  - Tuyệt đối không so sánh chuỗi thô (loại bỏ lỗi "1.10.0" < "1.9.0").
  - Xử lý mượt mà các phân đoạn số học: `1.10.0 > 1.9.0`, `1.20.4 > 1.20.3`, `2.0 > 1.99.9`.
  - Xử lý tiền tố `v`, `V`, `release-`, `ver-`.
  - Quy ước SemVer release vs prerelease: bản phát hành chính thức lớn hơn prerelease (`1.0.0 > 1.0.0-SNAPSHOT`, `1.0.0-beta.2 > 1.0.0-beta.1`).
- **An toàn trước phiên bản dị thường (Ambiguous / Unknown)**:
  - Nếu phiên bản không thể phân tích an toàn theo số học (ví dụ: chuỗi ký tự tự do `"CommunityBuild"` vs `"SpecialEdition"`), trả về `null` (`isAmbiguous: true`).
  - Tuyệt đối không tự ý bịa đặt thứ tự cho các phiên bản không thể so sánh.
- **Định nghĩa "Phiên Bản Mới" (Section 7)**:
  - Một phiên bản là MỚI khi và chỉ khi danh tính `(plugin_id, version_normalized)` chưa từng tồn tại trong DB.
  - Không định nghĩa "mới" dựa trên phép so sánh lớn hơn (`remote > latest`), đảm bảo không bỏ sót các nhánh song song.

---

## 6. Lập Lịch Quét & Chống Cộng Hưởng (Scheduling & Jitter)

- **Nguyên tắc Lập Lịch**:
  - Điều kiện kích hoạt: `NOW >= next_scan_at` (hoặc `next_scan_at IS NULL`).
  - Sau khi quét thành công: `next_scan_at = now + configured_interval + jitter`.
  - Luôn tính từ `now`, tuyệt đối không tính cộng dồn từ lịch cũ để loại bỏ hiện tượng quét dồn toa (runaway catch-up).
- **Công Thức Bounded Jitter**:
  - `jitterMs = (Math.abs(pluginId * 17) % jitterMaxSeconds) * 1000`.
  - Đảm bảo jitter luôn dương, có chặn trên, và tất định theo từng plugin giúp kiểm thử ổn định đồng thời phân bổ đều các yêu cầu mạng.

---

## 7. Xử Lý Giới Hạn Tần Suất & Thử Lại (Retry & Rate Limit)

- **HTTP 429**: Tôn trọng header `Retry-After` khi nguồn ngoài cung cấp (hỗ trợ cả định dạng số giây và HTTP Date).
- Khi bị giới hạn tần suất, scanner cập nhật `last_scan_status = 'RATE_LIMITED'` và đặt `next_scan_at` lùi lại theo thời gian phạt của server thay vì dồn dập gửi request.
- Các lỗi vĩnh viễn (400, 401, 403, 404) thất bại ngay lập tức, không retry.

---

## 8. Quản Lý Đồng Thời (Concurrency & Mutex)

- **Global Concurrency**: Bounded concurrency thông qua Promise pool với trần `maxConcurrentScans` (mặc định 5).
- **Same-Plugin Serialization**: Mutex `Set<number>` theo từng plugin ID. Nếu scheduler gọi quét khi một plugin đang trong quá trình quét, lượt gọi thứ hai lập tức trả về `SKIPPED_ALREADY_RUNNING` mà không tạo thêm HTTP request.

---

## 9. Cô Lập Thất Bại (Failure Isolation)

- Mỗi plugin được thực thi độc lập trong khối `try...catch`.
- Thất bại của một plugin (như timeout, lỗi 500, lỗi 429) không làm gián đoạn hoặc hủy bỏ tiến trình quét của các plugin khác trong cùng lượt quét.

---

## 10. Thay Đổi Cơ Sở Dữ Liệu (Database Changes)

- **Schema Drizzle**: Không cần migration phá hủy hay thay đổi bảng mới; tái sử dụng hoàn toàn bảng `plugins` và `versions` từ Phase 5A.
- **Repository Helpers**:
  - Bổ sung `listEligiblePluginsForScan(db, now, limit)` trong [`discord/src/repositories/neon-plugins.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-plugins.ts).
  - Bổ sung `updatePluginScanResult(db, id, patch)` trong [`discord/src/repositories/neon-plugins.ts`](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-plugins.ts).

---

## 11. Kết Quả Kiểm Thử (Tests)

### A. Ma Trận Kiểm Thử Phase 5B (`discord/tests/spiget-scanner.test.ts`):
- `TEST-5B-01`: Successful Spiget response over real HTTP transport -> **PASS**
- `TEST-5B-02`: Existing version is reused without creating duplicate rows -> **PASS**
- `TEST-5B-03`: New version is inserted on discovery -> **PASS**
- `TEST-5B-04`: Repeated scan (5 times) is strictly idempotent -> **PASS**
- `TEST-5B-05`: v-prefix normalization preserves version identity and ordering -> **PASS**
- `TEST-5B-06`: Numeric version comparison handles arbitrary segment lengths -> **PASS**
- `TEST-5B-07`: Ambiguous version does not silently invent ordering (returns null) -> **PASS**
- `TEST-5B-08`: Malformed API response throws INVALID_RESPONSE and avoids fake version -> **PASS**
- `TEST-5B-09`: 404 does not delete Plugin or historical Versions -> **PASS**
- `TEST-5B-10`: 429 honors Retry-After header over real HTTP transport -> **PASS**
- `TEST-5B-11`: Transient 503 failure retries and succeeds over real HTTP -> **PASS**
- `TEST-5B-12`: Permanent failure (403 Forbidden) does not retry indefinitely -> **PASS**
- `TEST-5B-13`: Request timeout triggers TIMEOUT error cleanly -> **PASS**
- `TEST-5B-14`: One plugin failure does not stop subsequent plugins in sweep -> **PASS**
- `TEST-5B-15`: Global concurrency limit restricts parallel active scans -> **PASS**
- `TEST-5B-16`: Same plugin cannot scan concurrently (mutex serialization) -> **PASS**
- `TEST-5B-17`: Duplicate scheduler tick skips without duplicating HTTP request -> **PASS**
- `TEST-5B-18`: Disabled plugin produces zero API requests -> **PASS**
- `TEST-5B-19`: Concurrent workers cannot create duplicate Plugin Version -> **PASS**
- `TEST-5B-20`: Successful scan updates next_scan_at and records SUCCESS status -> **PASS**
- `TEST-5B-21`: Failed scan records failure state and error message -> **PASS**
- `TEST-5B-22`: Remote version disappearance does not delete local version -> **PASS**
- `TEST-5B-23`: Scanner does NOT create Artifact records -> **PASS**
- `TEST-5B-24`: Scanner does NOT create Entitlement records -> **PASS**
- `TEST-5B-25`: Scanner does NOT modify Order/Purchase records -> **PASS**
- **Tổng cộng Phase 5B**: **25/25 PASSED** (100%)

### B. Kiểm Thử Toàn Diện Hệ Thống (Full Monorepo Regression):
- **53 test files** (Bao gồm Phase 5A + Phase 5B + toàn bộ các module thanh toán, browser, delivery, accounting)
- **1,117 tests PASSED** (0 failed)

---

## 12. Typecheck

- Lệnh: `pnpm -r exec tsc --noEmit`
- Kết quả: **PASS** (Zero errors)

---

## 13. Build

- Lệnh: `pnpm -r build`
- Kết quả: **PASS** (Client + Server build thành công)

---

## 14. Git & Đồng Bộ Remote

- **Code Commit Phase 5B**: `7ed5c5b` (`feat(phase-5b): implement canonical Spiget scanner and version detection`)
- **LOCAL HEAD**: Khớp `origin/main` sau khi push
- **Working Tree**: CLEAN (không có file test tạm, secret, credentials, hay jar files)

---

## 15. Tuân Thủ Ranh Giới Phạm Vi (Scope Compliance)

- **Plugin Registry**: UNCHANGED / REUSED
- **Plugin Version Registry**: REUSED (chỉ chèn danh tính phiên bản)
- **Spiget Scanner**: **IMPLEMENTED**
- **Version Detection**: **IMPLEMENTED**
- **Artifact Download**: **NOT IMPLEMENTED** (Không tải JAR)
- **Download Worker**: **NOT IMPLEMENTED**
- **Entitlement Logic**: **NOT IMPLEMENTED** (Không cấp quyền cho user)
- **Payment / Orders**: **UNCHANGED**
- **Delivery / Discord Commands**: **UNCHANGED**
- **Browser / CAPTCHA / Anti-bot / Stealth**: **UNCHANGED**
- **Dashboard**: **NOT IMPLEMENTED**

---

## FINAL

**PHASE 5B = VERIFIED / CLOSED**
