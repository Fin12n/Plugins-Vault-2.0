# Kế Hoạch Tối Giản Slash Command & Triển Khai UI Panel Components V2 Cho Bot Discord

> **Mục tiêu**: Rút gọn toàn bộ hệ thống Slash Command của Bot Discord còn đúng 5 lệnh cốt lõi (`/menu`, `/panel-sent`, `/info`, `/find`, `/report`), đồng thời xây dựng giao diện Panel chuẩn Discord Components V2 với hình ảnh banner và Select Menu hiển thị số lượng phiên bản, giá VNĐ và Coins.

---

## 📌 1. Tổng Quan & Yêu Cầu Kỹ Thuật

- **Mục tiêu**: Tối ưu hóa trải nghiệm người dùng trên Discord, loại bỏ các lệnh thừa thãi, chuyển các thao tác tra cứu, tìm kiếm, báo cáo và mua plugin sang giao diện tương tác cao cấp (Components V2, Modal Dialog, String Select Menu).
- **Kiến trúc**:
  - **Slash Commands**: Chỉ giữ lại và đăng ký đúng 5 lệnh:
    1. `/menu`: Mở kệ hàng xem toàn bộ plugin trong kho (Ephemeral/Canvas/Components V2).
    2. `/panel-sent [ID_CHANNEL]`: Đặt bảng chọn plugin cố định (Admin) với giao diện Components V2 Banner và Select Menu.
    3. `/info [query]`: Tra cứu thông tin chi tiết plugin theo `plugin_id`, `id`, `slug` hoặc tên (hỗ trợ Autocomplete).
    4. `/find`: Kích hoạt Modal Dialog cho người dùng nhập từ khóa tìm kiếm plugin.
    5. `/report`: Kích hoạt Modal Dialog để người dùng gửi báo cáo sự cố/lỗi về cho Ban Quản Trị.
  - **UI Panel Components V2**:
    - Sử dụng `flags: 32768` (`MessageFlags.IsComponentsV2`).
    - Khối Text Display (Type 10): Tiêu đề Chào mừng & Hướng dẫn.
    - Khối Divider/Separator (Type 14).
    - Khối Media Gallery (Type 12): Banner chính thức `https://discord-webhook.com/uploads/e60133f9f684500d481a74cf37bd40a0.png`.
    - Khối Divider/Separator (Type 14).
    - Khối String Select Menu (Type 3 trong ActionRow):
      - Placeholder: `🔻 Chọn plugin bạn muốn xem hoặc mua...`
      - Options: Danh sách các plugin đang bán lấy trực tiếp từ Neon PostgreSQL.
      - **Title**: `plugin.displayName`
      - **Descr**: `{numbers} Phiên bản | {xxx} VND | {xxx} Coins!`
      - **Value**: `plugin.pluginId` (hoặc `String(plugin.id)`)
- **Tech Stack**: Discord.js v14 (Components V2 Builder API), Drizzle ORM, Neon Serverless PostgreSQL, Node.js 24+.

---

## 🗂️ 2. Danh Sách 5 Slash Commands Chi Tiết

| Lệnh | Mô tả | Tham số | Phân quyền | Loại phản hồi |
| :--- | :--- | :--- | :--- | :--- |
| `/menu` | Mở kệ hàng danh mục plugin hiện có | `[trang]` (Tùy chọn) | Tất cả thành viên | Ephemeral UI (Components V2) |
| `/panel-sent` | Gửi UI Panel chọn plugin vào kênh chỉ định | `[channel]` (Tùy chọn, mặc định = hiện tại) | Quản trị viên (Admin) | Tin nhắn vĩnh viễn (Public Panel) |
| `/info` | Xem thông tin chi tiết plugin | `[query]` (Bắt buộc, Autocomplete) | Tất cả thành viên | Ephemeral/Public Container V2 |
| `/find` | Mở hộp thoại nhập tên plugin cần tìm | Không có | Tất cả thành viên | Discord Modal Dialog |
| `/report` | Mở hộp thoại báo cáo sự cố về cho Admin | Không có | Tất cả thành viên | Discord Modal Dialog |

---

## 🎨 3. Cấu Trúc UI Panel Components V2

Khối JSON cấu trúc của Panel được xây dựng thông qua `ContainerBuilder` và `ActionRowBuilder`:

```json
{
  "flags": 32768,
  "components": [
    {
      "type": 10,
      "content": "## Welcome to EZStore\n\n>>> `Choose your product you want !`\n"
    },
    {
      "type": 14,
      "spacing": 1,
      "divider": true
    },
    {
      "type": 12,
      "items": [
        {
          "media": {
            "url": "https://discord-webhook.com/uploads/e60133f9f684500d481a74cf37bd40a0.png"
          }
        }
      ]
    },
    {
      "type": 14,
      "spacing": 1,
      "divider": true
    },
    {
      "type": 1,
      "components": [
        {
          "type": 3,
          "custom_id": "panel:select_plugin",
          "placeholder": "🔻 Chọn plugin bạn muốn xem hoặc mua...",
          "options": [
            {
              "label": "ItemsAdder",
              "description": "6 Phiên bản | 75.000 VND | 75.000 Coins!",
              "value": "itemsadder"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 📋 4. Bóc Tách Các Bước Thực Hiện (Task Breakdown)

### Task 1: Mở rộng Repository truy vấn Plugin kèm số lượng Version (Neon DB)
- **File**: `discord/src/repositories/neon-plugins.ts`
- **Nội dung**:
  - Viết hàm `listPluginsWithVersionStats(db: Database, limit = 25)` kết hợp bảng `plugins` và đếm số lượng `versions` tương ứng.
  - Định dạng sẵn chuỗi hiển thị: `{numbers} Phiên bản | {xxx} VND | {xxx} Coins!`.
- **Kiểm tra**: Viết test/script xác nhận dữ liệu trả về đúng định dạng.

### Task 2: Xây dựng hàm tạo UI Panel Components V2
- **File**: `discord/src/bot/components/build-v2-containers.ts`
- **Nội dung**:
  - Tạo hàm `createStorePanelPayload(pluginsWithStats: PluginWithStats[])`:
    - Tạo `ContainerBuilder`.
    - Thêm TextDisplay `# Welcome to EZStore\n\n>>> \`Choose your product you want !\``.
    - Thêm Separator divider.
    - Thêm MediaGallery chứa URL ảnh banner `https://discord-webhook.com/uploads/e60133f9f684500d481a74cf37bd40a0.png`.
    - Thêm Separator divider.
    - Thêm ActionRow chứa `StringSelectMenuBuilder` với `customId: 'panel:select_plugin'`.
    - Đặt placeholder: `🔻 Chọn plugin bạn muốn xem hoặc mua...`.
    - Gán các options với format Label là tên plugin, Description là `{count} Phiên bản | {xxx} VND | {xxx} Coins!`.
- **Kiểm tra**: Validate container tạo đúng JSON structure theo yêu cầu.

### Task 3: Triển khai 5 Slash Commands Mới
- **File**: `discord/src/bot/commands/streamlined-commands.ts`
  1. `menuCommand`: `/menu [trang]`
  2. `panelSentCommand`: `/panel-sent [channel]` (kiểm tra quyền Admin, lấy channel được chọn hoặc current channel, gửi UI Panel).
  3. `infoCommand`: `/info <query>` (hỗ trợ Autocomplete tìm theo tên, slug, pluginId, aliases).
  4. `findCommand`: `/find` (gọi `interaction.showModal()` mở Modal `modal:find_plugin`).
  5. `reportCommand`: `/report` (gọi `interaction.showModal()` mở Modal `modal:report_issue`).

### Task 4: Triển khai Modal Handlers & Select Menu Interaction
- **File**: `discord/src/bot/client.ts` & `discord/src/bot/components/handle-component-interaction.ts`
- **Nội dung**:
  - Bắt sự kiện `interaction.isModalSubmit()`:
    - `modal:find_plugin`: Đọc từ khóa tìm kiếm -> truy vấn Neon DB -> trả về kết quả tìm kiếm kèm nút xem chi tiết.
    - `modal:report_issue`: Đọc tiêu đề và nội dung -> gửi thông báo embed về kênh Admin `DISCORD_NOTIFY_CHANNEL_ID` -> phản hồi cảm ơn cho user.
  - Bắt sự kiện `interaction.isStringSelectMenu()`:
    - `panel:select_plugin`: Khi user chọn plugin từ Panel -> hiển thị chi tiết plugin (`handlePluginDetail`) dạng Ephemeral kèm nút Mua / Tải / Xem phiên bản.

### Task 5: Tinh gọn tập lệnh đăng ký (`deploy-commands.ts`)
- **File**: `discord/scripts/deploy-commands.ts`
- **Nội dung**:
  - Xóa toàn bộ các lệnh cũ không cần thiết (`shelf`, `plugin-info`, `panel`, `vi`, `nap`, `spigot`, `spigot-account`).
  - Đăng ký đúng 5 lệnh: `menuCommand`, `panelSentCommand`, `infoCommand`, `findCommand`, `reportCommand`.
  - Chạy `pnpm run deploy-commands` để cập nhật danh sách lệnh lên Discord API Gateway.

### Task 6: Kiểm thử toàn diện & TypeCheck
- Chạy `pnpm --filter plugin-vault-bot typecheck`.
- Thử nghiệm các luồng:
  - Gõ `/panel-sent` để gửi Panel vào kênh.
  - Chọn 1 plugin từ Select Menu trên Panel.
  - Gõ `/find` và submit Modal tìm kiếm.
  - Gõ `/report` và submit Modal báo cáo lỗi.
  - Gõ `/info` với autocomplete.
  - Gõ `/menu` mở kệ hàng cá nhân.
