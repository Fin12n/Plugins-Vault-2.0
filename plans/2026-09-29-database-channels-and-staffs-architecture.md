# Kế Hoạch Triển Khai: Quản Lý Discord Channels & Tái Cấu Trúc Bảng Staffs Đa Nền Tảng

> **Dành cho Agent:** SUB-SKILL YÊU CẦU: Sử dụng `plan-writing`, `writing-plans`, `database-design`.  
> **Mã kế hoạch:** `PLAN-Database-Channels-And-Staffs-2026-09-29`  
> **Mục tiêu:** Chuyển đổi cấu hình kênh Discord (`DISCORD_NOTIFY_CHANNEL_ID`, v.v.) từ `.env` vào Database PostgreSQL (Neon.tech), tái cấu trúc bảng `dashboard_staff` thành `staffs` (hỗ trợ liên kết Email cho Dashboard và Discord User ID cho Bot), đồng thời bổ sung bảng `audit_logs` phục vụ giám sát toàn diện.

---

## 🎯 1. Bối Cảnh & Mục Tiêu Kỹ Thuật

1. **Vấn đề cấu hình tĩnh trong `.env`**:
   - Hiện tại, `DISCORD_NOTIFY_CHANNEL_ID` được lưu cố định trong file `.env`. Mỗi khi server Discord thay đổi cấu trúc kênh hoặc muốn phân tách các loại thông báo (báo lỗi, thông báo đơn hàng mới, thông báo nạp tiền, thông báo duyệt plugin), quản trị viên buộc phải can thiệp vào VPS và restart Bot.
   - Giải pháp: Chuyển toàn bộ cấu hình kênh thành động trong Database qua bảng `discord_channels`, có in-memory cache để truy vấn tốc độ cao (0ms lag) và fallback an toàn về `.env`.
2. **Nhu cầu đồng bộ Nhân sự giữa Web Dashboard & Discord Bot**:
   - Bảng cũ `dashboard_staff` chỉ lưu `discord_user_id` đơn giản. Khi Dashboard phát triển hoàn chỉnh với xác thực Email/Google OAuth, hệ thống cần một bảng `staffs` duy nhất làm Single Source of Truth cho cả 2 nền tảng:
     - `email`: Dùng đăng nhập Web Dashboard.
     - `discord_user_id`: Dùng nhận diện Staff khi gõ lệnh trên Discord Bot.
     - `role` & `permissions`: Phân quyền RBAC (Role-Based Access Control) để giới hạn ai được duyệt plugin, ai được sửa giá, ai được đổi kênh thông báo.
3. **Audit Log & Giám sát**:
   - Bổ sung bảng `audit_logs` để ghi nhận toàn bộ thao tác quan trọng (thêm/xóa staff, sửa giá plugin, upload file jar thủ công, đổi kênh notify).

---

## 🏗️ 2. Thiết Kế Schema Chi Tiết (PostgreSQL / Drizzle ORM)

### 2.1. Bảng `discord_channels` (Quản lý Kênh Discord Động)
Lưu trữ danh sách các kênh chức năng của hệ thống:

```typescript
export const discordChannels = pgTable(
  "discord_channels",
  {
    id: serial("id").primaryKey(),
    purpose: varchar("purpose", { length: 32 }).unique().notNull(), // 'notify' | 'orders' | 'audit' | 'panel'
    channelId: varchar("channel_id", { length: 32 }).notNull(),     // Snowflake ID kênh
    channelName: varchar("channel_name", { length: 100 }),          // Tên hiển thị (ví dụ: #bao-cao-loi)
    guildId: varchar("guild_id", { length: 32 }),                   // Server Discord ID
    isEnabled: boolean("is_enabled").default(true).notNull(),       // Bật/tắt thông báo vào kênh này
    updatedBy: varchar("updated_by", { length: 32 }),               // Staff ID hoặc Discord User ID sửa
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_discord_channels_purpose").on(table.purpose),
  ]
);
```

**Các mục đích (Purpose) tiêu chuẩn:**
- `'notify'`: Nhận báo cáo sự cố từ lệnh `/report` và thông báo lỗi hệ thống (thay thế `DISCORD_NOTIFY_CHANNEL_ID`).
- `'orders'`: Kênh tự động bắn thông báo khi khách mua plugin hoặc chuyển khoản thành công qua SePay/Card2k.
- `'audit'`: Kênh log khi Staff thực hiện hành động quản trị (upload file jar, đổi giá, thêm bớt staff).
- `'panel'`: Kênh chỉ định mặc định để gửi bảng điều khiển mua hàng (`/panel-sent`).

---

### 2.2. Bảng `staffs` (Nhân sự Đa Nền Tảng - Thay thế `dashboard_staff`)
Hợp nhất tài khoản Web Dashboard và Discord Admin:

```typescript
export const staffs = pgTable(
  "staffs",
  {
    id: serial("id").primaryKey(),
    
    // Nhận diện tài khoản & Ánh xạ đa nền tảng
    email: varchar("email", { length: 255 }).unique(),                  // Khóa ánh xạ với Email từ Dashboard Auth DB
    dashboardUserId: varchar("dashboard_user_id", { length: 64 }).unique(), // UUID / User ID từ Dashboard Auth DB (nếu có)
    discordUserId: varchar("discord_user_id", { length: 32 }).unique(), // Snowflake ID của Staff trên Discord Bot
    username: varchar("username", { length: 64 }).notNull(),             // Tên tài khoản hiển thị
    displayName: varchar("display_name", { length: 100 }),               // Tên hiển thị thân thiện
    avatarUrl: text("avatar_url"),                                       // Ảnh đại diện
    
    // Phân quyền & Vai trò (RBAC)
    role: varchar("role", { length: 32 }).default("staff").notNull(),   // 'owner' | 'admin' | 'moderator' | 'support'
    permissions: text("permissions").array().default([]).notNull(),      // Chi tiết quyền hạn
    
    // Trạng thái & Vết
    isActive: boolean("is_active").default(true).notNull(),              // Khóa tài khoản tức thì khi cần
    addedBy: varchar("added_by", { length: 32 }),                        // ID người tạo tài khoản
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_staffs_email").on(table.email),
    uniqueIndex("idx_staffs_dashboard_user_id").on(table.dashboardUserId),
    uniqueIndex("idx_staffs_discord_user_id").on(table.discordUserId),
    index("idx_staffs_role").on(table.role),
    index("idx_staffs_is_active").on(table.isActive),
  ]
);
```

> 💡 **Lưu ý Kiến trúc Tách biệt (Decoupled Authentication Architecture):**
> - **Dashboard Auth DB (Riêng biệt)**: Đảm nhiệm xác thực người dùng (Auth, Password Hash, Sessions, OAuth tokens, Thông tin khách hàng/Members).
> - **Vault DB (`EZStore`)**: Đóng vai trò là Store Core & RBAC Engine. Bảng `staffs` trong Vault DB **chỉ lưu thông tin phân quyền** và dùng `email` hoặc `dashboard_user_id` làm cầu nối (Cross-database Foreign Reference).
> - **Lợi ích**: Không lưu trữ mật khẩu hay thông tin nhạy cảm trong Vault DB, đảm bảo nguyên tắc Zero Credential Leakage và dễ dàng thay thế/nâng cấp hệ thống Auth của Dashboard sau này.

**Bảng quyền hạn chi tiết (`permissions: text[]`):**
- `'plugins.manage'`: Thêm, sửa, xóa plugin và đổi giá.
- `'plugins.upload'`: Upload file jar thủ công hoặc duyệt file từ `pending_ingest`.
- `'orders.manage'`: Xem chi tiết đơn hàng, hoàn tiền, điều chỉnh trạng thái đơn.
- `'channels.manage'`: Cài đặt kênh thông báo bot (`/setup channel`).
- `'staffs.manage'`: Thêm, sửa, cấp quyền và khóa nhân sự.

---

### 2.3. Bảng `audit_logs` (Nhật ký Hoạt Động Hệ Thống)
Theo dõi mọi biến động dữ liệu và hành động của nhân sự:

```typescript
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    staffId: integer("staff_id").references(() => staffs.id, { onDelete: "set null" }),
    discordUserId: varchar("discord_user_id", { length: 32 }),
    action: varchar("64").notNull(),                   // 'channel.update', 'plugin.price_set', 'staff.add', etc.
    targetType: varchar("target_type", { length: 32 }), // 'channel', 'plugin', 'version', 'staff', 'wallet'
    targetId: varchar("target_id", { length: 64 }),
    details: jsonb("details").default({}).notNull(),   // Dữ liệu cũ và mới (diff)
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("idx_audit_logs_staff_id").on(table.staffId),
    index("idx_audit_logs_action").on(table.action),
    index("idx_audit_logs_created_at").on(table.createdAt),
  ]
);
```

---

## ⚡ 3. Cơ Chế Vận Hành & Fallback Tối Ưu

### 3.1. In-Memory Cache cho Channels
- Bot Discord thường xuyên gửi thông báo (khi có báo cáo lỗi, đơn hàng mới, log hệ thống).
- Thay vì mỗi tin nhắn đều phải `SELECT` từ database Neon qua mạng (gây chậm 50-100ms), service `discord-channel-service.ts` sẽ duy trì một bộ nhớ đệm (Cache) trong RAM:
  - Cache có thời gian sống (TTL): **60 giây**.
  - Khi quản trị viên thay đổi kênh qua lệnh `/setup channel`, cache lập tức được làm mới (Invalidate Cache).

### 3.2. Fallback An Toàn 3 Lớp (Graceful Degradation)
1. **Lớp 1 (Database)**: Kiểm tra bảng `discord_channels` với `purpose = 'notify'`.
2. **Lớp 2 (Environment)**: Nếu trong DB chưa có bản ghi, tự động lấy giá trị từ `process.env.DISCORD_NOTIFY_CHANNEL_ID`.
3. **Lớp 3 (Auto-Seed)**: Lần đầu tiên Bot khởi động, nếu `discord_channels` trống, tự động seed giá trị từ `.env` vào DB.

### 3.3. Tự Động Khởi Tạo Owner Ban Đầu (Auto-Seed Owner)
- Trong quá trình boot Bot ([index.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/index.ts)):
  - Kiểm tra bảng `staffs`. Nếu bảng chưa có ai và có biến `DISCORD_OWNER_ID`:
  - Tự động tạo bản ghi Staff đầu tiên:
    - `discordUserId = env.DISCORD_OWNER_ID`
    - `username = 'Owner'`
    - `role = 'owner'`
    - `permissions = ['*']`
    - `isActive = true`
  - Đảm bảo chủ sở hữu luôn có toàn quyền điều khiển bot ngay cả khi chưa vào Dashboard.

---

## 📋 4. Kế Hoạch Thực Thi Từng Bước (Bite-Sized Actionable Tasks)

### 🔹 Giai đoạn 1: Database Schema & Migration
- [x] **Task 1.1**: Cập nhật [packages/db/src/schema.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/schema.ts):
  - Thêm bảng `discordChannels`.
  - Thay thế bảng `dashboardStaff` bằng bảng `staffs`.
  - Thêm bảng `auditLogs`.
  - Khai báo quan hệ `relations` tương ứng.
- [x] **Task 1.2**: Cập nhật [packages/db/src/types.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/packages/db/src/types.ts):
  - Export types: `DiscordChannel`, `NewDiscordChannel`, `Staff`, `NewStaff`, `AuditLog`, `NewAuditLog`.
- [x] **Task 1.3**: Chạy migration Drizzle Kit:
  - `pnpm --filter @vault/db db:generate`
  - `pnpm --filter @vault/db db:migrate`
  - Kiểm tra các bảng mới trên Neon PostgreSQL.

### 🔹 Giai đoạn 2: Services & Repositories
- [x] **Task 2.1**: Tạo [discord/src/repositories/neon-channels.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-channels.ts):
  - Các hàm: `getChannelByPurpose`, `setChannelPurpose`, `listActiveChannels`.
- [x] **Task 2.2**: Tạo [discord/src/services/channel-manager.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/services/channel-manager.ts):
  - Quản lý In-Memory Cache và fallback `.env`.
- [x] **Task 2.3**: Tạo [discord/src/repositories/neon-staffs.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/repositories/neon-staffs.ts):
  - Các hàm: `findStaffByDiscordId`, `findStaffByEmail`, `createStaff`, `updateStaff`, `hasPermission`.
  - Hàm tự động seed Owner ban đầu `ensureOwnerStaffExists`.

### 🔹 Giai đoạn 3: Tích Hợp Vào Discord Bot & Cập Nhật Lệnh
- [x] **Task 3.1**: Cập nhật [core-commands.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/src/bot/commands/core-commands.ts):
  - Sửa hàm gửi báo cáo `/report`: lấy kênh notify từ `channelManager.getNotifyChannelId()` thay vì biến tĩnh `env.DISCORD_NOTIFY_CHANNEL_ID`.
  - Sửa hàm kiểm tra quyền Admin: kiểm tra qua bảng `staffs` (hoặc fallback role).
- [x] **Task 3.2**: Bổ sung Slash Command `/setup`:
  - `/setup channel [purpose] [channel]`: Chỉ định kênh nhận thông báo/đơn hàng.
  - `/setup staff add [@user] [role]`: Cấp quyền nhân sự trực tiếp trên Discord.
- [x] **Task 3.3**: Cập nhật file đăng ký lệnh [deploy-commands.ts](file:///e:/Codebase/Plugins%20Vault%20v2.0/discord/scripts/deploy-commands.ts).

### 🔹 Giai đoạn 4: Kiểm Thử & Nghiệm Thu
- [x] **Task 4.1**: Chạy `pnpm typecheck` trên toàn bộ workspace (`@vault/db`, `@vault/discord`, `@vault/dashboard`).
- [x] **Task 4.2**: Viết unit test cho `channel-manager` và `neon-staffs`.
- [x] **Task 4.3**: Chạy thử nghiệm lệnh `/setup channel` và gửi thử `/report` để kiểm tra tin nhắn bắn đúng kênh từ Database.

---

## 🛡️ 5. Tiêu Chuẩn Nghiệm Thu (Verification Criteria)

1. `drizzle-kit migrate` chạy hoàn tất 100%, tạo đúng 3 bảng `discord_channels`, `staffs`, `audit_logs` trên Neon DB.
2. Không còn tồn tại bảng cũ `dashboard_staff` trên database.
3. Bot khởi động tự động nhận diện `DISCORD_OWNER_ID` và tạo tài khoản `owner` trong bảng `staffs`.
4. Khi gọi lệnh `/setup channel purpose:notify channel:#kenh-moi`, kênh mới được lưu ngay vào Neon DB và bot gửi thông báo `/report` vào đúng kênh mới mà không cần restart bot.
5. Mã nguồn tuân thủ toàn bộ TypeScript strict mode, không có bất kỳ lỗi cú pháp hay lint error nào.
