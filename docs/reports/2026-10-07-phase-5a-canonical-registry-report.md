# BÁO CÁO TRIỂN KHAI PHASE 5A — CANONICAL PLUGIN / VERSION / ARTIFACT REGISTRY

**Ngày thực hiện**: 2026-10-07  
**Phạm vi**: PHASE 5A ONLY (Canonical Plugin, Version, Artifact, Entitlement Foundation)  
**Trạng thái**: VERIFIED / CLOSED  

---

## 1. Kiểm tra Schema Hiện Hữu & Ánh Xạ Khái Niệm (Schema Audit & Concept Mapping)

### Bảng hiện hữu đã kiểm tra:
1. `plugins` (Neon PostgreSQL via Drizzle ORM) & SQLite `plugins`: Lưu trữ danh tính plugin cấp cao, catalog metadata.
2. `versions` (Neon PostgreSQL via Drizzle ORM) & SQLite `versions`: Lưu trữ các bản phát hành version của plugin kèm SHA256 và đường dẫn lưu trữ.
3. `orders`: Giao dịch mua hàng tài chính (financial transaction / purchase).
4. `wallets` & `wallet_ledgers`: Số dư ví người dùng và nhật ký kế toán.
5. `delivery_jobs` & `download_tokens`: Token tải xuống có giới hạn thời gian và nhật ký gửi tệp Discord.

### Ánh xạ Hiện Hữu → Mục Tiêu (Existing → Target Mapping):
| Khái niệm Mục Tiêu | Thực thể Hiện Hữu | Quyết Định Thiết Kế Phase 5A | Lý Do |
| :--- | :--- | :--- | :--- |
| **Canonical Plugin** | `plugins` | **REUSE & EXTEND** | Tái sử dụng bảng `plugins`, mở rộng metadata lập lịch quét (`enabled`, `scan_interval_seconds`, `next_scan_at`, `last_scan_at`, `last_scan_status`, `last_scan_error`). Thêm ràng buộc duy nhất `UNIQUE(platform, resource_id)`. |
| **Plugin Version** | `versions` (aliased as `pluginVersions`) | **REUSE & EXTEND** | Tái sử dụng bảng `versions` để không làm đứt gãy quan hệ với `delivery_jobs` hiện có. Bổ sung các cột định danh canonical: `version_normalized`, `source_version_id`, `source_release_id`, `released_at`, `metadata`, `status`, `first_seen_at`, `last_seen_at`. Thêm ràng buộc duy nhất `UNIQUE(plugin_id, version_normalized)`. |
| **Canonical Artifact** | *Chưa có* | **CREATE `plugin_artifacts`** | Tách biệt hoàn toàn tệp vật lý khỏi danh tính logic của Version. Lưu trữ trạng thái chu trình sống tệp (`PENDING`, `DOWNLOADING`, `VERIFYING`, `READY`, `FAILED`, `CORRUPT`). Ràng buộc duy nhất `UNIQUE(plugin_version_id)` bảo đảm mỗi version có tối đa 1 canonical artifact. |
| **Version Entitlement** | *Chưa có* | **CREATE `plugin_entitlements`** | Phân tách ranh giới ủy quyền (Authorization) khỏi giao dịch tài chính (Purchase/Order). Ràng buộc duy nhất `UNIQUE(user_id, plugin_version_id)`. |

### Các khái niệm trùng lặp/song song đã bác bỏ (Rejected/Avoided Parallel Concepts):
- **Bác bỏ tạo bảng `new_plugins` / `canonical_plugins`**: Tránh phân mảnh danh tính plugin trong hệ thống kế toán và bot commands.
- **Bác bỏ lưu quyền sở hữu theo cặp (USER + PLUGIN)**: Tuân thủ quy tắc nghiệp vụ bất biến: User mua Version 1.1 chỉ sở hữu Version 1.1, KHÔNG tự động sở hữu Version 1.2.
- **Bác bỏ gộp Artifact vào Version**: Không để trạng thái tải xuống vật lý làm biến đổi hoặc ghi đè danh tính phiên bản.

---

## 2. Mô Hình Dữ Liệu Canonical (Canonical Data Models)

### A. Canonical Plugin (`plugins`)
- `id`: Serial primary key
- `plugin_id`: Mã định danh nội bộ duy nhất (`idx_plugins_plugin_id`)
- `slug`: Public identifier duy nhất (`idx_plugins_slug`)
- `display_name`, `descriptor_name`, `aliases` (text array cho GIN search)
- `platform`: Nền tảng nguồn (mặc định `'spigot'`, hỗ trợ mở rộng)
- `resource_id`: External ID trên nền tảng nguồn
- `enabled`: Cờ kích hoạt quét định kỳ
- `scan_interval_seconds`: Tần suất quét tự động (mặc định 3600s)
- `next_scan_at`, `last_scan_at`, `last_scan_status`, `last_scan_error`

### B. Canonical Plugin Version (`versions` / `pluginVersions`)
- `id`: Serial primary key
- `plugin_id`: FK trỏ tới `plugins.id`
- `version`: Chuỗi raw version gốc (ví dụ `'v1.20.3-RELEASE'`)
- `version_normalized`: Chuỗi version đã chuẩn hóa loại bỏ tiền tố thừa (`'1.20.3-RELEASE'`)
- `source_version_id`, `source_release_id`: ID phiên bản/release từ source bên ngoài
- `released_at`: Thời điểm phát hành gốc
- `metadata`: JSONB chứa thông tin mở rộng của nguồn
- `status`: Trạng thái phiên bản (`'active'`, `'deprecated'`, `'recalled'`)
- `first_seen_at`, `last_seen_at`

### C. Canonical Artifact (`plugin_artifacts`)
- `id`: Serial primary key
- `plugin_version_id`: FK trỏ tới `versions.id`, UNIQUE
- `storage_key`: Khóa định danh lưu trữ nội bộ (không lộ đường dẫn vật lý máy chủ)
- `filename`: Tên tệp lưu trữ
- `size_bytes`: Kích thước tệp (bytes)
- `sha256`: Hash kiểm tra toàn vẹn
- `mime_type`: Mặc định `'application/java-archive'`
- `jar_valid`: Kết quả kiểm tra tính hợp lệ của tệp jar
- `status`: Vòng đời tệp (`PENDING`, `DOWNLOADING`, `VERIFYING`, `READY`, `FAILED`, `CORRUPT`)
- `downloaded_at`, `verified_at`

### D. Version Entitlement Foundation (`plugin_entitlements`)
- `id`: Serial primary key
- `user_id`: ID người dùng (Discord snowflake / internal user id)
- `plugin_version_id`: FK trỏ tới `versions.id`
- `order_id`: Liên kết tới đơn hàng tài chính `orders.id` (nếu có)
- `status`: Trạng thái ủy quyền (`ACTIVE`, `REVOKED`, `SUSPENDED`)
- `granted_at`, `revoked_at`

---

## 3. Ràng Buộc Cơ Sở Dữ Liệu (Database Constraints)

- **Plugin Source Identity**: `idx_plugins_source_resource` -> `UNIQUE (platform, resource_id)` (với các bản ghi có `resource_id` hợp lệ).
- **Plugin Slug**: `idx_plugins_slug` -> `UNIQUE (slug)`.
- **Version Normalized Identity**: `idx_versions_plugin_version_normalized` -> `UNIQUE (plugin_id, version_normalized)`.
- **Artifact Version Exclusivity**: `idx_plugin_artifacts_version` -> `UNIQUE (plugin_version_id)`.
- **Entitlement User-Version Exclusivity**: `idx_plugin_entitlements_user_version` -> `UNIQUE (user_id, plugin_version_id)`.
- **Khóa ngoại (Foreign Keys)**:
  - `versions.plugin_id` -> `plugins.id` (CASCADE)
  - `plugin_artifacts.plugin_version_id` -> `versions.id` (CASCADE)
  - `plugin_entitlements.plugin_version_id` -> `versions.id` (CASCADE)
  - `plugin_entitlements.order_id` -> `orders.id` (SET NULL)

---

## 4. Chỉ Mục (Indexes)

1. `plugins`:
   - `idx_plugins_enabled_next_scan`: `(enabled, next_scan_at)` tối ưu truy vấn scanner tương lai.
   - `idx_plugins_source_resource`: `(platform, resource_id) UNIQUE`.
2. `versions`:
   - `idx_versions_plugin_released`: `(plugin_id, released_at)` tối ưu sắp xếp timeline phiên bản.
   - `idx_versions_status`: `(status)` lọc các phiên bản khả dụng.
   - `idx_versions_plugin_version_normalized`: `(plugin_id, version_normalized) UNIQUE`.
3. `plugin_artifacts`:
   - `idx_plugin_artifacts_sha256`: `(sha256)` kiểm tra trùng lặp tệp nhanh chóng.
   - `idx_plugin_artifacts_status`: `(status)` phục vụ quản lý vòng đời tệp.
4. `plugin_entitlements`:
   - `idx_plugin_entitlements_user`: `(user_id)` tối ưu truy vấn danh sách plugin sở hữu của người dùng.
   - `idx_plugin_entitlements_version`: `(plugin_version_id)` kiểm tra người dùng sở hữu phiên bản.
   - `idx_plugin_entitlements_order`: `(order_id)` đối soát với giao dịch kế toán/hoàn tiền.

---

## 5. Tầng Repository & Dịch Vụ Nghiệp Vụ (Repository & Domain Service Layer)

1. **`VersionNormalizer` (`discord/src/services/registry/version-normalizer.ts`)**:
   - Chuẩn hóa raw version: bóc tách tiền tố `v`, `release-`, `ver-`, chuẩn hóa khoảng trắng.
   - Bảo toàn chuỗi định danh nguyên bản đối với các version không theo chuẩn SemVer (không tự ý giả định hay làm sai lệch dữ liệu).
2. **`neon-plugins.ts`**:
   - `findPluginBySourceIdentity(db, platform, resourceId)`
   - `getOrCreatePlugin(db, input)`: Idempotent get-or-create với khả năng phục hồi race condition chèn đồng thời.
3. **`neon-versions.ts`**:
   - `findVersionByNormalized(db, pluginId, versionNormalized)`
   - `getOrCreatePluginVersion(db, input)`: Đảm bảo version identity bất biến, không sửa đè phiên bản cũ.
4. **`neon-artifacts.ts`**:
   - `findCanonicalArtifactByVersionId(db, versionId)`
   - `getOrCreateArtifact(db, input)`: Bảo đảm 1 version chỉ có 1 artifact duy nhất.
   - `updateArtifactStatus(db, versionId, status, patch)`: Quản lý vòng đời tệp.
   - `isArtifactUsable(artifact)`: Chỉ cho phép tệp ở trạng thái `READY` và `jarValid = true` được phục vụ tải xuống.
5. **`neon-entitlements.ts`**:
   - `getUserVersionEntitlement(db, userId, pluginVersionId)`
   - `hasUserVersionEntitlement(db, userId, pluginVersionId)`
   - `grantEntitlement(db, input)`: Cấp quyền theo từng version cụ thể, lũy biến.
   - `revokeEntitlement(db, userId, pluginVersionId, reason)`: Thu hồi quyền truy cập (chuyển sang `REVOKED`), bảo toàn dữ liệu lịch sử.
6. **`CanonicalRegistryService` (`discord/src/services/registry/canonical-registry-service.ts`)**:
   - Đóng gói toàn bộ logic nghiệp vụ canonical registry, cung cấp facade thống nhất cho các module tương lai.

---

## 6. Migration Script (`packages/db/drizzle/0006_phase_5a_canonical_registry.sql`)

- Bổ sung an toàn các cột mới vào `plugins` và `versions` với giá trị mặc định tương thích ngược.
- Tự động backfill `version_normalized = TRIM(REGEXP_REPLACE(version, '^[vV]', ''))` cho các bản ghi phiên bản lịch sử.
- Khởi tạo bảng `plugin_artifacts` và `plugin_entitlements` kèm đầy đủ constraints và indexes.
- Tuyệt đối không xóa bất kỳ bảng, cột, hoặc dữ liệu hiện hữu nào.

---

## 7. Kết Quả Kiểm Thử (Test Verification)

### A. Phase 5A Test Matrix (`discord/tests/canonical-registry.test.ts`):
- `TEST-5A-01: Create Plugin successfully initializes canonical identity` -> **PASS**
- `TEST-5A-02: Same source/resource ID is idempotent` -> **PASS**
- `TEST-5A-03: Different source/resource ID creates different Plugin` -> **PASS**
- `TEST-5A-04: Create Plugin Version creates canonical version identity` -> **PASS**
- `TEST-5A-05: Same plugin + normalized version is idempotent` -> **PASS**
- `TEST-5A-06: Same version string on different plugins is allowed` -> **PASS**
- `TEST-5A-07: Version identity is immutable (cannot mutate 1.2 to 1.3 via update)` -> **PASS**
- `TEST-5A-08: Create Artifact successfully associates physical file to Version` -> **PASS**
- `TEST-5A-09: Same Plugin Version cannot have duplicate canonical Artifact` -> **PASS**
- `TEST-5A-10: Artifact READY is the only usable state` -> **PASS**
- `TEST-5A-11: Create version-specific entitlement grants access to that specific version only` -> **PASS**
- `TEST-5A-12: Same user + same version cannot create duplicate active entitlement` -> **PASS**
- `TEST-5A-13: User owning version 1.1 does NOT own version 1.2 (BUSINESS RULE TUYỆT ĐỐI)` -> **PASS**
- `TEST-5A-14: Refund/revoke does not delete historical Plugin, Version, or Artifact` -> **PASS**
- `TEST-5A-15: Concurrent upsert does not create duplicates (idempotency guarantee)` -> **PASS**
- `TEST-5A-16: Foreign-key integrity enforces valid relationships` -> **PASS**
- `TEST-5A-17: Historical version remains queryable after new version release` -> **PASS**
- `TEST-5A-18: No duplicate/parallel schema concept was introduced` -> **PASS**
- *2 bài test chuẩn hóa version*: **PASS**
- **Tổng cộng 5A**: **20/20 PASSED** (100%)

### B. Kiểm Thử Toàn Diện Hệ Thống (Full Monorepo Regression):
- **52 test files**
- **1,092 tests PASSED** (0 failed)
- Bảo toàn tuyệt đối: Thanh toán (Payment), Giao hàng (Delivery), Kế toán (Accounting), Tính năng cô lập Browser (Context Isolation), và Độ bền kiểm thử (Soak tests).

---

## 8. Typecheck & Build

- `pnpm -r exec tsc --noEmit` -> **PASS** (Zero errors)
- `pnpm -r build` -> **PASS** (Client + Server built successfully)
- `git diff --check` -> **PASS** (Zero whitespace / conflict issues)

---

## 9. Kiểm Tra Git & Bảo Mật

- **Dedicated Commit**: `c85e016` (`feat(phase-5a): implement canonical plugin, version, artifact, and entitlement registry`)
- **LOCAL HEAD**: `c85e016a90ccce0eb5b1ff9e60ee335b2abaddae`
- **ORIGIN/MAIN**: `85b0ac92abd87757a7b7dca4db3bf545c1b3640e`
- **Security Audit**: Không có thông tin nhạy cảm, mật khẩu, session cookies, hoặc storage path nội bộ bị để lộ.

---

## 10. Tuân Thủ Ranh Giới Phạm Vi (Scope Compliance Confirmation)

- **Spiget Scanner**: **NOT IMPLEMENTED** (Không tạo background scanner / polling loop)
- **Download Orchestrator**: **NOT IMPLEMENTED** (Không tạo worker tải xuống mới)
- **Discord Commands**: **NOT IMPLEMENTED** (Không thay đổi prefix commands)
- **Dashboard**: **NOT IMPLEMENTED** (Không thay đổi UI dashboard)
- **CAPTCHA / Anti-bot / Stealth**: **UNCHANGED** (Giữ nguyên toàn bộ 87 C++ patches và cơ chế CloakBrowser)

---

## KẾT LUẬN

**PHASE 5A = VERIFIED / CLOSED**
