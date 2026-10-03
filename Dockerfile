#
# Kho Plugin — image chạy thật.
#
# Hai tầng: tầng builder cài dependency và biên dịch, tầng chạy chỉ nhận kết quả.
# Tách ra vì compiler C++ của `better-sqlite3` và toolchain của Vite nặng hơn cả
# phần chạy, và không có lý do gì để chúng theo lên máy khách.
#
# Node 24: mã dùng `process.loadEnvFile`, và CI ghim đúng bản này.

# ---------- Tầng builder ----------
FROM node:24-bookworm-slim AS builder
WORKDIR /app

# `better-sqlite3` dùng bản dựng sẵn khi có. Ba gói này là đường dự phòng cho lúc
# không có, nếu thiếu thì `npm ci` chết giữa bước cài chứ không báo gì rõ ràng.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifest trước nguồn: sửa một dòng code không làm mất cache lớp cài đặt.
COPY package.json package-lock.json ./
RUN npm ci
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN npm ci --prefix dashboard

COPY . .

# Đảm bảo dashboard/index.html luôn tồn tại và đúng chính tả trên Linux/Docker
RUN if [ -f dashboard/Index.html ] && [ ! -f dashboard/index.html ]; then \
      mv dashboard/Index.html dashboard/index.html; \
    fi \
    && if [ ! -s dashboard/index.html ]; then \
      printf '<!doctype html>\n<html lang="vi">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>Kho Plugin · EZStore</title>\n    <link rel="icon" type="image/png" href="/ez-mark.png" />\n    <link rel="apple-touch-icon" href="/ez-mark.png" />\n    <link rel="preconnect" href="https://fonts.googleapis.com">\n    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n' > dashboard/index.html; \
    fi

RUN npm run build && (cd dashboard && npm run build)

# Bỏ devDependency sau khi đã biên dịch xong: tầng chạy chỉ cần dependency thật,
# và `node_modules` được copy nguyên khối nên phải gọn ngay từ đây.
RUN npm prune --omit=dev

# ---------- Tầng chạy ----------
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# CloakBrowser + Puppeteer-core: Sử dụng trình duyệt Stealth Chromium với 87 C++ patches
# chống bot và mô phỏng thao tác người thật (Bézier mouse, cadence typing).
# CloakBrowser tự động tải và quản lý binary stealth của nó, không cần cài chromium/google-chrome.
# Tầng chạy chỉ cần các thư viện runtime hệ thống và Xvfb (màn hình ảo chống bị phát hiện headless).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        fonts-liberation \
        xvfb \
        procps \
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libasound2 \
        libpangocairo-1.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcb-dri3-0 \
        libxshmfence1 \
        libappindicator3-1 \
        xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY package.json ./

# Thư mục dữ liệu — compose gắn volume lên đúng ba chỗ này. `VAULT_DIR` và `TMP_DIR`
# phải cùng một filesystem: jar vào kho bằng `rename`, tách ra là lỗi EXDEV mỗi lần.
RUN mkdir -p data vault tmp

EXPOSE 3000
CMD ["node", "dist/src/index.js"]
