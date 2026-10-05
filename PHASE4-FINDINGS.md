# PHASE4-FINDINGS.md — Out-of-Scope Findings & Architectural Records

> **Tài liệu ghi nhận các phát hiện ngoài phạm vi trong quá trình kiểm thử và tối ưu hóa hiệu năng Phase 4B.**
> Tuân thủ kỷ luật: Không tự ý thay đổi hành vi anti-bot, CAPTCHA, chính sách tài khoản, thanh toán hoặc giao hàng.

---

## 📌 1. Giới hạn Giấy phép Phiên Đồng thời của CloakBrowser (CloakBrowser Concurrency Limit)

- **Phát hiện:** CloakBrowser Pro hạn chế 1 concurrent session ở cấp độ license/process (lỗi `session limit / exit code 76` nếu mở song song nhiều browser instance bằng cùng license key).
- **Hành động trong Phase 4B:** Đã triển khai hàng đợi FIFO chờ khóa phiên tại Slice 4B-2 (`CloakSessionManager`), giúp tự động xếp hàng tuần tự các tác vụ thay vì ném lỗi `SessionConflictError`.
- **Đề xuất ngoài phạm vi (Out-of-Scope):** Việc mở rộng đa luồng trình duyệt thực sự (multi-browser concurrent processes) đòi hỏi nâng cấp gói license hoặc triển khai multi-license pool. Không can thiệp vào logic cấp phép của vendor trong Phase 4B.

---

## 📌 2. Rủi ro Ô nhiễm Chéo Fingerprint & Socket Cloudflare khi Dùng Chung Trình duyệt (Cloudflare Socket/Fingerprint Affinity)

- **Phát hiện:** Mặc dù các lệnh CDP (`Network.clearBrowserCookies`, `Network.clearBrowserCache`, `Storage.clearDataForOrigin`) có thể xóa sạch cookies và storage trên trang, nhưng tiến trình Chromium vẫn giữ lại các pool kết nối HTTP/2, Session Tickets và TLS socket. Nếu tái sử dụng chung một tiến trình Chromium nền (Warm Browser) giữa Tài khoản A và Tài khoản B, Cloudflare có thể liên kết hai tài khoản qua cùng một fingerprint mạng cấp tiến trình.
- **Hành động trong Phase 4B:** Quyết định **REJECT** việc bật Warm Browser mặc định trên Production. Giữ nguyên 100% cơ chế **Cold Ephemeral Session** (`mkdtempSync` + hủy hoàn toàn profile sau khi dùng) như Phase 4A để đảm bảo cách ly tuyệt đối 100%. Tính năng Warm Browser chỉ tồn tại dưới cờ thử nghiệm `WARM_BROWSER_EXPERIMENT=true`.
- **Đề xuất ngoài phạm vi (Out-of-Scope):** Nếu muốn tái sử dụng browser process giữa các tài khoản mà không rò rỉ socket pool, cần giải pháp ở tầng Chromium C++ patch hoặc quản lý warm pool riêng biệt theo từng tài khoản (Account-Specific Warm Pools). Không triển khai trong Phase 4B.

---

## 📌 3. Giới hạn Thao tác Tải xuống Đối với Plugin Đòi hỏi Mua Thêm (Paid / Unowned Resources)

- **Phát hiện:** Các plugin chưa được mua hoặc tài khoản không sở hữu sẽ trả về trang `not_owned` hoặc `must purchase`.
- **Hành vi được bảo toàn:** Hệ thống tiếp tục phân loại chính xác thành `not_owned`, không can thiệp hay thay đổi quy trình mua sắm hoặc nghiệp vụ thanh toán Spigot.
