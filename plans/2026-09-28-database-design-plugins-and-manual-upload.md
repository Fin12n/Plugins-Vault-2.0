# Kế Hoạch Thiết Kế Schema Database: Nhóm Plugin, Phiên Bản & Upload Thủ Công

> **Dành cho Agent:** SUB-SKILL YÊU CẦU: Sử dụng `database-design`, `plan-writing`, `writing-plans`.
> **Mã kế hoạch:** `PLAN-Database-Design-Plugins-Versions-Manual-Upload-2026-09-28`
> **Mục tiêu:** Tinh chỉnh và hoàn thiện thiết kế Schema PostgreSQL (Neon.tech) bằng Drizzle ORM cho nhóm Kho Plugin, Phiên bản và Cơ chế Upload thủ công.

---

## 🎯 1. Giải Đáp Thắc Mắc Kỹ Thuật

### 1.1. Cột `is_stable` trong bảng `versions`
- **Ý nghĩa**: Đánh dấu phiên bản **chính thức, ổn định nhất** (Production Ready) của plugin.
- **Tại sao cần**:
  - Nhiều tác giả Spigot thường xuyên phát hành các bản Snapshot, Alpha, Beta, hoặc bản vá thử nghiệm (Release Candidate).
  - Khi người dùng trên Discord hoặc Web bấm "Tải ngay" hoặc tải mặc định, hệ thống sẽ ưu tiên chọn phiên bản `is_stable = true` mới nhất thay vì tải nhầm một bản thử nghiệm có thể làm crash server Minecraft của khách.

### 1.2. Cột `version_flag` trong bảng `versions`
- **Nguồn gốc**: Xuất phát từ bộ bóc tách tệp JAR (`readJarDescriptor` / `jar-descriptor-extraction`).
- **Ý nghĩa chi tiết**: Rất nhiều lập trình viên khi build plugin bằng Maven hoặc Gradle quên cấu hình resource filtering, khiến chuỗi version trong `plugin.yml` bị giữ nguyên placeholder của build tool (ví dụ: `${project.version}`, `@version@`, `git-commit-hash`).
- **Các giá trị phân loại**:
  1. `'ok'`: Chuỗi phiên bản đọc ra chuẩn xác, sạch sẽ (ví dụ: `2.9.8`, `1.0.4`).
  2. `'unresolved-placeholder'`: File jar descriptor bị lỗi placeholder chưa build xong (`${project.version}`).
  3. `'regex-recovered'`: Bot đã tự động dùng Regex bóc tách số hiệu phiên bản từ tên file gốc (ví dụ: file `Vulcan-2.9.8.jar` được bóc tách thành `2.9.8`) để cứu dữ liệu.
  4. `'manual'`: Do Admin/Staff tự gõ tay phiên bản khi tải file lên thủ công hoặc chỉnh sửa từ Dashboard.

### 1.3. Gộp bảng `plugin_aliases` thành mảng `aliases` trong `plugins`
- **Giải pháp tối ưu trên PostgreSQL**: Thay vì phải tạo bảng riêng `plugin_aliases` và thực hiện `JOIN` tốn kém mỗi khi tìm kiếm, PostgreSQL hỗ trợ kiểu dữ liệu mảng gốc: `text("aliases").array().default([]).notNull()`.
- **Tối ưu hóa tìm kiếm**:
  - Đánh chỉ mục **GIN Index**: `CREATE INDEX idx_plugins_aliases ON plugins USING GIN (aliases);`
  - Truy vấn tìm kiếm cực nhanh: `WHERE aliases @> ARRAY['worldguard']` hoặc `WHERE 'wg' = ANY(aliases)`.

---

## 🏗️ 2. Thiết Kế Chi Tiết Schema Nhóm Kho Plugin & Upload Thủ Công

### 2.1. Bảng `plugins` (Danh mục Plugin)
| Cột | Kiểu dữ liệu | Ràng buộc | Mô tả |
| :--- | :--- | :--- | :--- |
| `id` | `serial` | Primary Key | Khóa chính tự tăng |
| `plugin_id` | `varchar(64)` | Unique, Not Null | Mã định danh nội bộ (dùng link Spigot account, API) |
| `slug` | `varchar(128)` | Unique, Not Null | Định danh URL web & lệnh bot (kebab-case) |
| `display_name` | `varchar(255)` | Not Null | Tên hiển thị thân thiện trên Discord/Web |
| `descriptor_name`| `varchar(128)` | Not Null | Tên gốc khai báo trong `plugin.yml` |
| `aliases` | `text[]` | Default `[]`, Not Null | Mảng các tên phụ phục vụ tìm kiếm |
| `platform` | `varchar(32)` | Default `'spigot'`, Not Null | `spigot`, `paper`, `velocity`, `bungee` |
| `resource_id` | `integer` | Nullable | ID tài nguyên trên SpigotMC (dùng cho Spiget API) |
| `deposit_price` | `bigint` | Default `0`, Not Null | Giá mua/tải plugin (đơn vị VNĐ) |
| `is_premium` | `boolean` | Default `false`, Not Null| Plugin trả phí trên Spigot |
| `description` | `text` | Default `''`, Not Null | Mô tả tóm tắt tính năng plugin |
| `spigot_link` | `text` | Default `''`, Not Null | Link trang gốc trên SpigotMC.org |
| `created_at` | `timestamptz` | Default `now()`, Not Null| Thời gian đưa lên hệ thống |
| `updated_at` | `timestamptz` | Default `now()`, Not Null| Thời gian cập nhật thông tin |

### 2.2. Bảng `versions` (Các phiên bản tệp JAR)
| Cột | Kiểu dữ liệu | Ràng buộc | Mô tả |
| :--- | :--- | :--- | :--- |
| `id` | `serial` | Primary Key | Khóa chính tự tăng |
| `plugin_id` | `integer` | References `plugins(id)` ON DELETE CASCADE | Thuộc plugin nào |
| `version` | `varchar(64)` | Nullable | Chuỗi phiên bản đã chuẩn hóa |
| `raw_version` | `varchar(128)` | Nullable | Chuỗi phiên bản gốc đọc từ jar |
| `sha256` | `varchar(64)` | Unique, Not Null | Hash SHA-256 chống trùng lặp file |
| `rel_path` | `text` | Not Null | Đường dẫn lưu trữ Content-Addressed (`<sha[0:2]>/<sha>`) |
| `bytes` | `bigint` | Not Null | Kích thước file (bytes) |
| `original_name`| `varchar(255)` | Not Null | Tên file gốc ban đầu |
| `change_logs` | `text` | Default `''`, Not Null | Nhật ký thay đổi từ SpigotMC hoặc Admin ghi chú |
| `is_stable` | `boolean` | Default `true`, Not Null | Đánh dấu phiên bản khuyên dùng, ổn định |
| `version_flag` | `varchar(32)` | Default `'ok'`, Not Null | `'ok'`, `'unresolved-placeholder'`, `'regex-recovered'`, `'manual'` |
| `source` | `varchar(20)` | Default `'spigot_auto'`, Not Null | Nguồn: `'spigot_auto'` (bot tải) hoặc `'manual'` (upload tay) |
| `uploaded_at` | `timestamptz` | Default `now()`, Not Null| Thời gian tải lên kho |

---

## 📤 3. Thiết Kế Cơ Chế & Schema Cho File Upload Thủ Công

Khi Admin/Staff tải file `.jar` lên từ Web Dashboard, có 2 kịch bản xảy ra:
1. **Kịch bản Tự Động (Auto-Parsed)**: File jar hợp lệ, bot đọc được `plugin.yml`, tự nhận diện được plugin và version -> Đưa thẳng vào `versions` và ghi log audit.
2. **Kịch bản Cần Can Thiệp (Staging / Needs Review)**:
   - File không có descriptor (tệp zip hoặc jar obfuscate nặng).
   - Tên plugin trong file không khớp với plugin nào có sẵn trong kho (Plugin mới toanh).
   - Version bị lỗi placeholder hoặc admin muốn điều chỉnh lại giá, platform.

### Bảng 1: `manual_uploads` (Nhật ký Upload Thủ Công Thành Công)
Lưu lại lịch sử ai đã upload phiên bản nào và ghi chú của admin:
```typescript
export const manualUploads = pgTable("manual_uploads", {
  id: serial("id").primaryKey(),
  versionId: integer("version_id").references(() => versions.id, { onDelete: "cascade" }).notNull(),
  pluginId: integer("plugin_id").references(() => plugins.id, { onDelete: "cascade" }).notNull(),
  uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(), // Discord User ID của Staff
  originalName: varchar("original_name", { length: 255 }).notNull(),
  adminNote: text("admin_note").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

### Bảng 2: `pending_ingest` (Hàng đợi Tệp Cần Duyệt / Điền Thông Tin)
Dành cho các file upload thủ công chưa đủ điều kiện nhập kho ngay:
```typescript
export const pendingIngest = pgTable("pending_ingest", {
  id: serial("id").primaryKey(),
  uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(), // Ai upload
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  tmpPath: text("tmp_path").notNull(), // Đường dẫn lưu tạm trên server
  fileSize: bigint("file_size", { mode: "number" }).notNull(),
  
  // Thông tin bot tự phân tích được (nếu có)
  detectedPluginName: varchar("detected_plugin_name", { length: 128 }),
  detectedVersion: varchar("detected_version", { length: 64 }),
  detectedPlatform: varchar("detected_platform", { length: 32 }),
  
  // Trạng thái xử lý
  status: varchar("status", { length: 32 }).default("needs_review").notNull(), 
  // 'needs_review' (chờ admin bổ sung info) | 'approved' (đã duyệt) | 'rejected' (hủy bỏ)
  
  errorReason: varchar("error_reason", { length: 64 }).notNull(),
  // 'no-descriptor' | 'unreadable-zip' | 'duplicate-sha256' | 'missing-fields' | 'new-plugin'
  errorDetail: text("error_detail").default("").notNull(),
  
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
```

---

## 💻 4. Mã Nguồn Drizzle ORM Hoàn Chỉnh (TypeScript)

```typescript
// packages/db/src/schema.ts
import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================
// 1. BẢNG PLUGINS (Danh mục Plugins)
// ============================================================
export const plugins = pgTable(
  "plugins",
  {
    id: serial("id").primaryKey(),
    pluginId: varchar("plugin_id", { length: 64 }).unique().notNull(),
    slug: varchar("slug", { length: 128 }).unique().notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    descriptorName: varchar("descriptor_name", { length: 128 }).notNull(),
    aliases: text("aliases").array().default([]).notNull(),
    platform: varchar("platform", { length: 32 }).default("spigot").notNull(),
    resourceId: integer("resource_id"),
    depositPrice: bigint("deposit_price", { mode: "number" }).default(0).notNull(),
    isPremium: boolean("is_premium").default(false).notNull(),
    description: text("description").default("").notNull(),
    spigotLink: text("spigot_link").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_plugins_plugin_id").on(table.pluginId),
    uniqueIndex("idx_plugins_slug").on(table.slug),
    index("idx_plugins_resource_id").on(table.resourceId),
    index("idx_plugins_descriptor_name").on(table.descriptorName),
    index("idx_plugins_aliases").using("gin", table.aliases),
  ]
);

// ============================================================
// 2. BẢNG VERSIONS (Các phiên bản tệp JAR)
// ============================================================
export const versions = pgTable(
  "versions",
  {
    id: serial("id").primaryKey(),
    pluginId: integer("plugin_id")
      .references(() => plugins.id, { onDelete: "cascade" })
      .notNull(),
    version: varchar("version", { length: 64 }),
    rawVersion: varchar("raw_version", { length: 128 }),
    sha256: varchar("sha256", { length: 64 }).unique().notNull(),
    relPath: text("rel_path").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    descriptorKind: varchar("descriptor_kind", { length: 32 }).default("spigot").notNull(),
    isStable: boolean("is_stable").default(true).notNull(),
    versionFlag: varchar("version_flag", { length: 32 }).default("ok").notNull(),
    changeLogs: text("change_logs").default("").notNull(),
    source: varchar("source", { length: 20 }).default("spigot_auto").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_versions_plugin_id").on(table.pluginId),
    index("idx_versions_plugin_uploaded").on(table.pluginId, table.uploadedAt),
    uniqueIndex("idx_versions_sha256").on(table.sha256),
    index("idx_versions_is_stable").on(table.isStable),
  ]
);

// ============================================================
// 3. BẢNG MANUAL UPLOADS (Nhật ký tệp tải lên thủ công)
// ============================================================
export const manualUploads = pgTable(
  "manual_uploads",
  {
    id: serial("id").primaryKey(),
    versionId: integer("version_id")
      .references(() => versions.id, { onDelete: "cascade" })
      .notNull(),
    pluginId: integer("plugin_id")
      .references(() => plugins.id, { onDelete: "cascade" })
      .notNull(),
    uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(),
    originalName: varchar("original_name", { length: 255 }).notNull(),
    adminNote: text("admin_note").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_manual_uploads_plugin").on(table.pluginId),
    index("idx_manual_uploads_uploader").on(table.uploadedBy),
  ]
);

// ============================================================
// 4. BẢNG PENDING INGEST (Hàng đợi tệp upload cần duyệt)
// ============================================================
export const pendingIngest = pgTable(
  "pending_ingest",
  {
    id: serial("id").primaryKey(),
    uploadedBy: varchar("uploaded_by", { length: 32 }).notNull(),
    originalFilename: varchar("original_filename", { length: 255 }).notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    tmpPath: text("tmp_path").notNull(),
    fileSize: bigint("file_size", { mode: "number" }).notNull(),
    detectedPluginName: varchar("detected_plugin_name", { length: 128 }),
    detectedVersion: varchar("detected_version", { length: 64 }),
    detectedPlatform: varchar("detected_platform", { length: 32 }),
    status: varchar("status", { length: 32 }).default("needs_review").notNull(),
    errorReason: varchar("error_reason", { length: 64 }).notNull(),
    errorDetail: text("error_detail").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_pending_ingest_status").on(table.status),
    index("idx_pending_ingest_sha256").on(table.sha256),
  ]
);
```

---

## 📋 5. Kế Hoạch Triển Khai Chi Tiết (Bite-Sized Tasks)

### Giai đoạn 1: Chuẩn bị & Xác nhận Schema
- [ ] Task 1.1: Trình bày chi tiết bảng `plugins`, `versions`, `manual_uploads`, `pending_ingest` cho người dùng review.
- [ ] Task 1.2: Tiếp thu các góp ý tùy chỉnh từ người dùng (nếu muốn bổ sung trường nào khác).

### Giai đoạn 2: Tạo Schema Code Drizzle ORM
- [ ] Task 2.1: Viết định nghĩa Schema trong `packages/db/src/schema/plugins.ts` và `versions.ts`.
- [ ] Task 2.2: Cấu hình index GIN cho `aliases` và các chỉ mục hiệu năng tìm kiếm.
- [ ] Task 2.3: Tạo file migration `drizzle-kit generate` để kiểm tra tính hợp lệ của DDL.

### Giai đoạn 3: Tích hợp Logic Upload Thủ Công Vào Web Dashboard
- [ ] Task 3.1: Viết API Endpoint `POST /api/plugins/upload` hỗ trợ Multipart JAR upload.
- [ ] Task 3.2: Tích hợp hàm bóc tách `readJarDescriptor` đọc ZIP cấp bộ nhớ đệm:
  - Nếu phân tích thành công: Ghi trực tiếp vào `versions` + `manual_uploads`.
  - Nếu gặp lỗi hoặc plugin chưa có: Đẩy vào `pending_ingest` và trả thông báo lên UI.
- [ ] Task 3.3: Viết giao diện Modal Upload trên Dashboard kèm Form điền thủ công khi file cần duyệt.
