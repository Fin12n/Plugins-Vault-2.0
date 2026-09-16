#!/usr/bin/env bash
# ==============================================================================
# Script Tự Động Thiết Lập & Tối Ưu Hóa 100% Cho Linux (Ubuntu / Debian)
# Kho Plugin - Discord Bot & Vault Web Service
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 1. Kiểm tra quyền root
if [ "$(id -u)" -ne 0 ]; then
  log_error "Vui lòng chạy script này với quyền root hoặc sudo: sudo bash scripts/setup-linux.sh"
  exit 1
fi

ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
log_info "Kiến trúc hệ thống: ${ARCH}"

# 2. Cập nhật hệ thống và cài đặt các gói phụ thuộc cốt lõi
log_info "Đang cập nhật APT và cài đặt gói hệ thống cần thiết..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  curl wget git sqlite3 ca-certificates gnupg procps \
  xvfb fonts-liberation build-essential python3 systemd-timesyncd

# 3. Đồng bộ thời gian hệ thống (bắt buộc cho SePay Webhook - chống stale timestamp)
log_info "Kích hoạt đồng bộ thời gian NTP qua systemd-timesyncd..."
systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true
timedatectl set-ntp true >/dev/null 2>&1 || true
log_success "Thời gian hệ thống đã được đồng bộ."

# 4. Kiểm tra và cài đặt Node.js 24
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "${NODE_VER}" -ge 24 ]; then
    NODE_OK=1
    log_success "Node.js đã được cài đặt: $(node -v)"
  fi
fi

if [ "${NODE_OK}" -eq 0 ]; then
  log_info "Đang cài đặt Node.js v24 từ NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
  log_success "Đã cài đặt Node.js: $(node -v)"
fi

# 5. Cài đặt Trình duyệt (Chrome trên AMD64 hoặc Chromium trên ARM64)
if [ "${ARCH}" = "amd64" ] || [ "${ARCH}" = "x86_64" ]; then
  if ! command -v google-chrome >/dev/null 2>&1 && ! command -v google-chrome-stable >/dev/null 2>&1; then
    log_info "Đang tải và cài đặt Google Chrome Stable chính thức cho AMD64..."
    wget -qO /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    apt-get install -y --no-install-recommends /tmp/chrome.deb || apt-get install -fy
    rm -f /tmp/chrome.deb
  fi
  log_success "Trình duyệt Google Chrome: $(google-chrome --version 2>/dev/null || echo 'đã cài đặt')"
else
  log_info "Kiến trúc ARM64 phát hiện - Đang cài đặt Chromium..."
  apt-get install -y --no-install-recommends chromium
  if [ ! -f /usr/bin/google-chrome ] && [ -f /usr/bin/chromium ]; then
    ln -sf /usr/bin/chromium /usr/bin/google-chrome
  fi
  log_success "Trình duyệt Chromium: $(chromium --version 2>/dev/null || echo 'đã cài đặt')"
fi

# 6. Kiểm tra cấu hình bộ nhớ Swap cho VPS RAM nhỏ (<= 2GB)
TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
if [ "${TOTAL_MEM_KB}" -lt 2500000 ]; then
  TOTAL_SWAP_KB=$(grep SwapTotal /proc/meminfo | awk '{print $2}')
  if [ "${TOTAL_SWAP_KB}" -lt 1000000 ]; then
    log_warn "VPS có ít hơn 2.5GB RAM và chưa có Swap. Đang tự động tạo 2GB Swapfile để chống tràn RAM khi Chrome chạy..."
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    if ! grep -q '/swapfile' /etc/fstab; then
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
    fi
    log_success "Đã kích hoạt 2GB Swapfile thành công."
  fi
fi

# 7. Tạo cấu trúc thư mục dữ liệu đồng nhất
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${SCRIPT_DIR}"

log_info "Chuẩn hóa thư mục dữ liệu (data, vault, tmp) tại ${SCRIPT_DIR}..."
mkdir -p data vault tmp
chmod 750 data vault tmp
if [ -d data/chrome-profile ]; then
  chmod 700 data/chrome-profile
fi

# 8. Cài đặt dependency và build dự án
log_info "Kiểm tra tính toàn vẹn của node_modules..."
# Tự động dọn dẹp nếu phát hiện tàn dư symlink pnpm hoặc node_modules sao chép từ môi trường khác
if [ -d "node_modules/.pnpm" ] || [ -d "dashboard/node_modules/.pnpm" ] || [ -L "dashboard/node_modules/.bin/tsc" ] || [ ! -f "dashboard/node_modules/typescript/bin/tsc" ] && [ -d "dashboard/node_modules" ]; then
  log_warn "Phát hiện node_modules cũ/lỗi symlink từ máy khác. Đang xóa để cài đặt lại sạch sẽ chuẩn Linux..."
  rm -rf node_modules dashboard/node_modules
fi

log_info "Cài đặt dependencies và biên dịch dự án..."
npm ci || npm install
npm --prefix dashboard ci || npm --prefix dashboard install
npm run build
npm run dashboard:build
log_success "Biên dịch dự án và Dashboard hoàn tất."

# 9. Thiết lập Systemd Service
log_info "Cấu hình Systemd Service..."
SERVICE_FILE="/etc/systemd/system/plugin-vault.service"
sed "s|/srv/plugin-vault-bot|${SCRIPT_DIR}|g" scripts/plugin-vault.service > "${SERVICE_FILE}"
systemctl daemon-reload

log_success "=================================================================="
log_success " HỆ THỐNG ĐÃ ĐƯỢC TỐI ƯU HÓA 100% CHO LINUX HOÀN TẤT!"
log_success "=================================================================="
echo ""
echo "Các bước tiếp theo:"
echo " 1. Sao chép và điền tệp cấu hình nếu chưa có: cp .env.example .env && nano .env"
echo " 2. Đăng nhập tài khoản Spigot: npm run spigot-login"
echo " 3. Kích hoạt và khởi chạy service:"
echo "      sudo systemctl enable --now plugin-vault"
echo " 4. Xem log hoạt động theo thời gian thực:"
echo "      sudo journalctl -u plugin-vault -f"
echo ""
