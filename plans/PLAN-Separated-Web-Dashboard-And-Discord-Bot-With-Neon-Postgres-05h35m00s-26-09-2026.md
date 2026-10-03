# Ke Hoach Tach Biet: Bot Discord Truoc, Admin Dashboard Sau (Neon.tech PostgreSQL)

> **For Agent:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.
> **Ma ke hoach:** `PLAN-Separated-Discord-Bot-First-Then-Admin-Dashboard-With-Neon-Postgres-05h35m00s-26-09-2026`
> **Ap dung Skills & Workflows:** `/plan-writing`, `/writing-plans`, `/plan`, `/api`, `/database-design`, `/ui-ux-pro-max`, `/design`
> **Tuan thu 4 Bo Rules:**
> 1. code-quality.md (Clean code, zero any, typed, < 50 dong/ham, kebab-case file, JSDoc)
> 2. security.md (Argon2 hash, AES-256-GCM cho Spigot, Parameterized queries, No hardcoded secrets)
> 3. backend.md (Controller -> Service -> Repository -> DB, Response { success, data, error }, snake_case DB)
> 4. frontend.md (Neumorphism / Glassmorphism 2.0, Atomic Design, TanStack Query !== Zustand)
> **Thu tu toi thuong**: LAM BOT DISCORD & CLOAK BROWSER TRUOC (Giai doan 2) => LAM ADMIN DASHBOARD SAU (Giai doan 3).

---

## Muc Tieu Du An

1. **Uu tien so 1: Bot Discord** - CloakBrowser (Chromium Stealth C++), vuot Cloudflare Turnstile, tu dong quet & tai plugin Spigot, xu ly thanh toan SePay VietQR va gan Role.
2. **Uu tien so 2: Admin Dashboard** - Sau khi Bot hoan chinh, xay dung API Backend va nang cap giao dien Admin Dashboard duy nhat (Stateless, khong SQLite, ket noi chung DB Neon.tech).
3. **Pham vi Dashboard**: Chi 1 Admin Dashboard (Overview, Plugins, Orders, Discounts, Wallets, Spigot Accounts, Settings, Logs, Stats). Khong them trang public nao.
4. **Bao ton ma nguon cu**: Toan bo ma nguon cu va schema SQLite cu tai thu muc `old/`.

---

## He Thong Xac Thuc API Dashboard (SHA-256 Auth Protocol)

Bot Internal API (`/internal/*`) duoc bao ve boi **SHA-256 HMAC** - 2 truong hop:

### Truong Hop 1 - Fetch tu Vercel/Dashboard (Production)

```
Signature = SHA-256(
  ISO_TIMESTAMP_UTC12      // Moc thoi gian chuan (UTC+12)
  + BOT_DISCORD_TOKEN      // Token Bot Discord (env)
  + BOT_CLIENT_SECRET      // Discord App Client Secret (env)
  + BOT_CLIENT_ID          // Discord App Client ID (env)
)
```

- **Client** gui header: `X-Auth-Signature: <hash>` + `X-Auth-Timestamp: <iso>`
- **Server** kiem tra: timestamp khong lech qua +-5 phut, tinh lai SHA-256 va constant-time compare.
- Tra ve `401 Unauthorized` neu khong khop.

### Truong Hop 2 - Dev / Local Test (Whitelist IP)

- Cho phep 1 hoac nhieu IPv4 co dinh fetch truc tiep, **khong can signature**.
- Cau hinh qua env: `ALLOWED_DEV_IPS=127.0.0.1,192.168.1.100`
- Middleware kiem tra IP truoc -> neu khop whitelist thi bypass hoan toan.

```typescript
// Pseudo-code: auth-middleware.ts
function authMiddleware(req: FastifyRequest): void {
  if (ALLOWED_DEV_IPS.includes(req.ip)) return; // Case 2: Dev bypass
  const signature = req.headers["x-auth-signature"] as string;
  const timestamp  = req.headers["x-auth-timestamp"] as string;
  if (!isTimestampValid(timestamp)) throw unauthorized("Timestamp expired");
  if (!isValidSignature(signature, timestamp)) throw unauthorized("Invalid signature");
}
```

---

## Thiet Ke Co So Du Lieu Neon.tech (Schema 3NF - v2)

**Thay doi v2 so voi v1:**
- `plugins`: Gop `aliases` vao `TEXT[]` (xoa bang `plugin_aliases`), them `plugin_id`, `spigot_link`, `description`.
- `versions`: Them `change_logs` (TEXT), `source` (spigot_auto | manual).
- `manual_uploads`: Bang moi - tracking upload thu cong tu Dashboard.
- Tong: **14 bang** (v1 co 12 bang).

```typescript
// packages/db/src/schema.ts
import {
  pgTable, serial, varchar, text, integer, boolean,
  timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ============================================================
// NHOM 1: KHO PLUGIN & TEP TIN
// ============================================================

// 1. BANG PLUGIN (PLUGINS) - v2: pluginId, aliases[], spigotLink, description
export const plugins = pgTable("plugins", {
  id:             serial("id").primaryKey(),
  // Ma noi bo phan biet plugin (Bot & Dashboard dung, linked Spigot account)
  pluginId:       varchar("plugin_id", { length: 64 }).unique().notNull(),
  // Danh sach ten phu de tim kiem (thay the bang plugin_aliases cu)
  aliases:        text("aliases").array().default([]).notNull(),
  slug:           varchar("slug", { length: 128 }).unique().notNull(),
  displayName:    varchar("display_name", { length: 255 }).notNull(),
  descriptorName: varchar("descriptor_name", { length: 128 }).notNull(),
  platform:       varchar("platform", { length: 32 }).default("spigot").notNull(),
  resourceId:     integer("resource_id"),
  depositPrice:   integer("deposit_price").default(0).notNull(),
  isPremium:      boolean("is_premium").default(false).notNull(),
  description:    text("description").default("").notNull(),
  spigotLink:     text("spigot_link").default("").notNull(),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  updatedAt:      timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_plugins_plugin_id").on(table.pluginId),
  index("idx_plugins_descriptor_name").on(table.descriptorName),
  index("idx_plugins_resource_id").on(table.resourceId),
  index("idx_plugins_platform").on(table.platform),
]);

// 2. BANG PHIEN BAN (VERSIONS) - v2: changeLogs, source
export const versions = pgTable("versions", {
  id:             serial("id").primaryKey(),
  pluginId:       integer("plugin_id").references(() => plugins.id, { onDelete: "cascade" }).notNull(),
  version:        varchar("version", { length: 64 }),
  rawVersion:     varchar("raw_version", { length: 128 }),
  sha256:         varchar("sha256", { length: 64 }).unique().notNull(),
  relPath:        text("rel_path").notNull(),
  bytes:          integer("bytes").notNull(),
  originalName:   varchar("original_name", { length: 255 }).notNull(),
  descriptorKind: varchar("descriptor_kind", { length: 32 }).notNull(),
  isStable:       boolean("is_stable").default(true).notNull(),
  versionFlag:    varchar("version_flag", { length: 32 }).default("ok").notNull(),
  // Changelog cua phien ban (lay tu Spiget API hoac nhap tay khi upload)
  changeLogs:     text("change_logs").default("").notNull(),
  // Nguon: "spigot_auto" | "manual"
  source:         varchar("source", { length: 20 }).default("spigot_auto").notNull(),
  uploadedAt:     timestamp("uploaded_at").defaultNow().notNull(),
}, (table) => [
  index("idx_versions_plugin_uploaded").on(table.pluginId, table.uploadedAt),
  index("idx_versions_sha256").on(table.sha256),
  index("idx_versions_source").on(table.source),
]);

// 3. BANG UPLOAD THU CONG (MANUAL_UPLOADS) - Bang hoan toan moi
export const manualUploads = pgTable("manual_uploads", {
  id:           serial("id").primaryKey(),
  versionId:    integer("version_id").references(() => versions.id, { onDelete: "cascade" }).notNull(),
  pluginId:     integer("plugin_id").references(() => plugins.id, { onDelete: "cascade" }).notNull(),
  uploadedBy:   varchar("uploaded_by", { length: 32 }).notNull(),
  originalName: varchar("original_name", { length: 255 }).notNull(),
  adminNote:    text("admin_note").default("").notNull(),
  createdAt:    timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_manual_uploads_version_id").on(table.versionId),
  index("idx_manual_uploads_plugin_id").on(table.pluginId),
  index("idx_manual_uploads_uploaded_by").on(table.uploadedBy),
]);

// ============================================================
// NHOM 2: GIAO DICH & THANH TOAN
// ============================================================

// 4. BANG DON HANG (ORDERS)
export const orders = pgTable("orders", {
  id:            serial("id").primaryKey(),
  code:          varchar("code", { length: 32 }).unique().notNull(),
  discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
  versionId:     integer("version_id").references(() => versions.id, { onDelete: "set null" }),
  pluginName:    varchar("plugin_name", { length: 255 }).notNull(),
  versionLabel:  varchar("version_label", { length: 64 }).default("").notNull(),
  amount:        integer("amount").notNull(),
  walletPaid:    integer("wallet_paid").default(0).notNull(),
  bankDue:       integer("bank_due").default(0).notNull(),
  paidAmount:    integer("paid_amount"),
  status:        varchar("status", { length: 20 }).default("pending").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  expiresAt:     timestamp("expires_at").notNull(),
  paidAt:        timestamp("paid_at"),
  deliveredAt:   timestamp("delivered_at"),
}, (table) => [
  index("idx_orders_status").on(table.status),
  index("idx_orders_user").on(table.discordUserId),
  index("idx_orders_version_id").on(table.versionId),
  index("idx_orders_code").on(table.code),
]);

// 5. BANG GIAO DICH SEPAY (SEPAY_TRANSACTIONS - Idempotency)
export const sepayTransactions = pgTable("sepay_transactions", {
  id:           serial("id").primaryKey(),
  sepayId:      integer("sepay_id").unique().notNull(),
  orderId:      integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  amount:       integer("amount").notNull(),
  transferType: varchar("transfer_type", { length: 10 }).notNull(),
  code:         varchar("code", { length: 64 }),
  content:      text("content").default("").notNull(),
  rawPayload:   jsonb("raw_payload").notNull(),
  receivedAt:   timestamp("received_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sepay_tx_sepay_id").on(table.sepayId),
  index("idx_sepay_tx_code").on(table.code),
]);

// ============================================================
// NHOM 3: VI TIEN & SO CAI
// ============================================================

// 6. BANG VI (WALLETS)
export const wallets = pgTable("wallets", {
  discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
  balance:       integer("balance").default(0).notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  updatedAt:     timestamp("updated_at").defaultNow().notNull(),
});

// 7. BANG SO CAI VI (WALLET_LEDGER - Append-only, khong xoa)
export const walletLedger = pgTable("wallet_ledger", {
  id:            serial("id").primaryKey(),
  discordUserId: varchar("discord_user_id", { length: 32 }).notNull(),
  delta:         integer("delta").notNull(),
  balanceAfter:  integer("balance_after").notNull(),
  kind:          varchar("kind", { length: 30 }).notNull(),
  refType:       varchar("ref_type", { length: 20 }).default("").notNull(),
  refId:         integer("ref_id"),
  note:          text("note").default("").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_wallet_ledger_user").on(table.discordUserId, table.createdAt),
]);

// ============================================================
// NHOM 4: KHUYEN MAI
// ============================================================

// 8. BANG MA GIAM GIA (DISCOUNT_CODES)
export const discountCodes = pgTable("discount_codes", {
  id:          serial("id").primaryKey(),
  code:        varchar("code", { length: 32 }).unique().notNull(),
  type:        varchar("type", { length: 10 }).notNull(),
  value:       integer("value").notNull(),
  minOrder:    integer("min_order").default(0).notNull(),
  maxDiscount: integer("max_discount"),
  maxUses:     integer("max_uses"),
  usedCount:   integer("used_count").default(0).notNull(),
  expiresAt:   timestamp("expires_at"),
  isActive:    boolean("is_active").default(true).notNull(),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_discount_codes_code").on(table.code),
  index("idx_discount_codes_active").on(table.isActive),
]);

// ============================================================
// NHOM 5: TAI KHOAN SPIGOT & QUET UPSTREAM
// ============================================================

// 9. BANG TAI KHOAN SPIGOT (SPIGOT_ACCOUNTS)
export const spigotAccounts = pgTable("spigot_accounts", {
  id:                  serial("id").primaryKey(),
  label:               varchar("label", { length: 64 }).unique().notNull(),
  username:            varchar("username", { length: 128 }).notNull(),
  passwordEncrypted:   text("password_encrypted").notNull(),
  xfUserEncrypted:     text("xf_user_encrypted").default("").notNull(),
  xfSessionEncrypted:  text("xf_session_encrypted").default("").notNull(),
  status:              varchar("status", { length: 20 }).default("ok").notNull(),
  isEnabled:           boolean("is_enabled").default(true).notNull(),
  lastVerifiedAt:      timestamp("last_verified_at"),
  createdAt:           timestamp("created_at").defaultNow().notNull(),
  updatedAt:           timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_spigot_accounts_status").on(table.status),
  index("idx_spigot_accounts_enabled").on(table.isEnabled),
]);

// 10. BANG QUYEN SO HUU SPIGOT (RESOURCE_OWNERSHIP)
export const resourceOwnership = pgTable("resource_ownership", {
  id:           serial("id").primaryKey(),
  resourceId:   integer("resource_id").notNull(),
  accountLabel: varchar("account_label", { length: 64 }).notNull(),
  state:        varchar("state", { length: 20 }).notNull(),
  checkedAt:    timestamp("checked_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_resource_ownership_pair").on(table.resourceId, table.accountLabel),
  index("idx_resource_ownership_state").on(table.resourceId, table.state),
]);

// 11. BANG TRANG THAI QUET UPSTREAM (UPSTREAM_STATE)
export const upstreamState = pgTable("upstream_state", {
  pluginId:      integer("plugin_id").primaryKey().references(() => plugins.id, { onDelete: "cascade" }),
  versionUuid:   varchar("version_uuid", { length: 64 }).notNull(),
  versionName:   varchar("version_name", { length: 64 }).notNull(),
  releaseDateMs: text("release_date_ms").notNull(),
  checkedAt:     timestamp("checked_at").defaultNow().notNull(),
});

// 12. BANG HANG DOI TAI XUONG (PENDING_DOWNLOAD)
export const pendingDownload = pgTable("pending_download", {
  id:            serial("id").primaryKey(),
  pluginId:      integer("plugin_id").references(() => plugins.id, { onDelete: "cascade" }).notNull(),
  versionUuid:   varchar("version_uuid", { length: 64 }).notNull(),
  versionName:   varchar("version_name", { length: 64 }).notNull(),
  attempts:      integer("attempts").default(0).notNull(),
  lastError:     text("last_error").default("").notNull(),
  nextAttemptAt: timestamp("next_attempt_at").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_pending_download_pair").on(table.pluginId, table.versionUuid),
  index("idx_pending_download_due").on(table.nextAttemptAt),
]);

// ============================================================
// NHOM 6: HE THONG ADMIN
// ============================================================

// 13. BANG NHAN SU ADMIN (DASHBOARD_STAFF)
export const dashboardStaff = pgTable("dashboard_staff", {
  discordUserId: varchar("discord_user_id", { length: 32 }).primaryKey(),
  username:      varchar("username", { length: 64 }).default("").notNull(),
  displayName:   varchar("display_name", { length: 100 }).default("").notNull(),
  avatar:        text("avatar"),
  addedBy:       varchar("added_by", { length: 32 }).notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
});

// 14. BANG CAU HINH (CONFIG)
export const config = pgTable("config", {
  key:       varchar("key", { length: 64 }).primaryKey(),
  value:     text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

### So Do Quan He (ERD)

```
plugins (14 cot + aliases[])
  | id
  +---> versions (plugin_id) ---> orders ---> sepay_transactions
  |         |
  |         +---> manual_uploads (versionId + pluginId + uploadedBy)
  +---> upstream_state (pluginId PK)
  +---> pending_download (pluginId)
  +---> resource_ownership (resourceId, accountLabel)

wallets ---> wallet_ledger (discordUserId)
discount_codes (standalone)
spigot_accounts (standalone)
dashboard_staff (standalone)
config (key-value store)
```

---

## Ke Hoach Thuc Hien Chi Tiet (BOT TRUOC => WEB SAU)

---

### GIAI DOAN 1: Nen Tang Du Lieu Neon.tech & Drizzle Schema

- [ ] **Task 1.1: Khoi Tao Ket Noi Neon.tech & Drizzle Kit**
  - Cai dat: @neondatabase/serverless, drizzle-orm, drizzle-kit, dotenv.
  - Tao schema.ts voi day du **14 bang** chuan 3NF v2.
  - Tao connection.ts: Drizzle Client voi Neon Pooling, doc DATABASE_URL tu process.env.
  - Xac minh: `drizzle-kit push` len Neon.tech thanh cong 100%.

- [ ] **Task 1.2: Xay Dung Tang Repositories (Data Access Layer)**
  - plugin-repository.ts: listPlugins, findById, findBySlug, findByPluginId, searchByAlias, createPlugin, updatePlugin.
  - version-repository.ts: listByPlugin, createVersion, findBySha256, listBySource.
  - manual-upload-repository.ts: createManualUpload, listByPlugin, listByUploader.
  - order-repository.ts: createOrder, findByCode, updateStatus, listOrders.
  - spigot-account-repository.ts: listAccounts, upsertAccount, updateCookies, updateStatus.
  - wallet-repository.ts: getBalance, creditBalance (atomic transaction + wallet_ledger).
  - discount-repository.ts: findByCode, toggleDiscount, createDiscount.
  - ownership-repository.ts: getOwnership, setOwnership, listOwnedResources.
  - upstream-repository.ts: getState, setState, enqueueDownload, dequeueDownload.
  - Xac minh: Vitest CRUD tests tren Neon DB.

---

### GIAI DOAN 2: Bot Discord & CloakBrowser [UU TIEN SO 1]

- [ ] **Task 2.1: Clean discord/ & Connect Neon**
  - Xoa SQLite vault.db cu, tich hop Drizzle Client -> Neon.tech.
  - Cau hinh Discord.js v14 Client voi Gateway Intents day du (Guilds, GuildMembers, GuildMessages).
  - Xac minh: Bot khoi dong, Neon DB Ready.

- [ ] **Task 2.2: CloakBrowser Stealth (browser-launcher.ts)**
  - Profile an danh tu nhien, headless/debug mode, CDP download path.
  - Xac minh: Mo SpigotMC khong bi phat hien automation.

- [ ] **Task 2.3: Cloudflare Turnstile Solver (turnstile-solver.ts)**
  - Warm-up 8s trang chu SpigotMC, tryClickTurnstile(), Early Bailout 25s.
  - Xac minh: Vuot Turnstile tren SpigotMC login 100%.

- [ ] **Task 2.4: Spigot Sweep & Download Worker**
  - SpigotLoginWorker: dang nhap AES-256-GCM decrypt, vuot Turnstile, luu cookie ma hoa.
  - PurchasedResourcesScanner: quet "Resources You Have Purchased" -> cap nhat resource_ownership.
  - SpigotDownloadWorker: nhan tu pending_download, tai .jar, kiem tra sha256, ghi vao versions (source='spigot_auto', change_logs tu Spiget API).

- [ ] **Task 2.5: Slash Commands**
  - /panel: Bang dieu khien mua sam chinh.
  - /menu: Danh muc plugin theo nen tang.
  - /find <ten>: Tim kiem theo tu khoa/alias (query aliases[] trong plugins).
  - /my-plugins: Danh sach plugin da mua.
  - /download <plugin>: Link tai .jar bao mat.
  - /wallet: Kiem tra so du vi.
  - /nap <so_tien>: Tao ma VietQR SePay.
  - /sync: Dong bo lai Role.
  - Bat buoc: deferReply({ ephemeral: true }) < 200ms (chong loi 10062).

- [ ] **Task 2.6: SePay VietQR Webhook**
  - HTTP webhook nhe trong discord/, idempotency check sepayId.
  - Tu dong cong vi / gach don, cap role @Khach Hang / VIP.

- [ ] **Task 2.7: Bot Internal API (SHA-256 Auth)**
  - Fastify HTTP server + auth-middleware.ts:
    - Case 1 (Production): Validate X-Auth-Signature + X-Auth-Timestamp tu Vercel.
    - Case 2 (Dev): Whitelist IP tu ALLOWED_DEV_IPS -> bypass.
  - Endpoints:
    - GET /internal/plugins (kem aliases[], spigot_link, description)
    - GET /internal/versions/:pluginId (kem change_logs, source)
    - GET /internal/orders
    - GET /internal/wallets/:discordUserId
    - GET /internal/spigot-accounts
    - GET /internal/stats
  - Xac minh: Postman signature hop le -> 200 OK; sai -> 401.

- [ ] **Task 2.8: Bot Quality Gate**
  - vitest run: repos, services, SePay webhook, SHA-256 middleware, Turnstile solver.
  - Bot chay doc lap 100%, khong log loi.

---

### GIAI DOAN 3: Admin Dashboard [TRIEN KHAI SAU]

- [ ] **Task 3.1: Fastify Proxy Backend (dashboard/server/)**
  - sha256-auth-client.ts: Ky va gui X-Auth-Signature den Bot Internal API.
  - session-middleware.ts: Discord OAuth2 / Admin Token (doi chieu dashboard_staff).
  - global-error-handler.ts: { success: false, data: null, error: { code, message } }.
  - zod-validator.ts: Validate body/params.

- [ ] **Task 3.2: REST API Routes Admin**
  - GET /api/session, /api/overview.
  - GET+POST+PUT /api/plugins.
  - POST /api/plugins/upload:
    - Trich xuat metadata tu .jar (plugin.yml).
    - Tinh SHA-256, kiem tra trung lap (findBySha256).
    - Ghi versions (source='manual') + manual_uploads (uploadedBy, adminNote).
  - GET /api/orders (loc status, tim discord ID / ma don).
  - GET+POST+PATCH /api/discounts, /api/discounts/:id/toggle.
  - GET /api/wallets + /api/wallets/:discordUserId/ledger.
  - GET+PUT /api/spigot-accounts + POST /api/spigot-accounts/test-login.
  - GET+PUT /api/settings.
  - GET+POST+DELETE /api/staff.
  - Xac minh: 100% response { success: true, data, error: null }.

- [ ] **Task 3.3: Frontend Upgrade (dashboard/src/)**
  - @tanstack/react-query + zustand, api-client.ts.
  - Giu nguyen Neumorphism / Glassmorphism 2.0.
  - Plugins Page: Hien thi aliases[], spigot_link, description.
  - Versions Page: Hien thi change_logs, badge source (Auto / Manual).
  - Cac trang: Overview, Orders, Discounts, Wallets, Spigot Accounts, Settings, Logs, Stats.
  - Xac minh: Khong con SQLite, 100% tu Neon.tech.

---

### GIAI DOAN 4: DevOps & Handover

- [ ] **Task 4.1: Docker**
  - discord/Dockerfile: Multi-stage, Bot Discord + Chromium CloakBrowser.
  - dashboard/Dockerfile: Multi-stage, Vite bundle + Fastify Proxy.
  - docker-compose.yml: 2 services, chung DATABASE_URL Neon.tech.

- [ ] **Task 4.2: Security Audit & Docs**
  - .gitignore check (khong lot .env, secret).
  - ALLOWED_DEV_IPS khong bi commit.
  - README.md cap nhat huong dan van hanh.

---

## Bang So Sanh v1 vs v2

| Tieu chi | v1 (Cu) | v2 (Moi) |
| :--- | :--- | :--- |
| **Thu tu** | Lam Web truoc, Bot sau | **Bot Discord & CloakBrowser truoc => Admin Dashboard sau** |
| **Pham vi Dashboard** | Du kien them shop/landing | **Chi 1 Admin Dashboard, khong them trang public** |
| **CSDL** | SQLite cuc bo | **Neon.tech Serverless PostgreSQL + Drizzle ORM** |
| **plugins.plugin_id** | Khong co | **Co** |
| **plugins.aliases** | Bang rieng plugin_aliases | **TEXT[] gop vao bang plugins** |
| **plugins.spigot_link** | Khong co | **Co** |
| **plugins.description** | Khong co | **Co** |
| **Bang plugin_aliases** | Co (12 bang tong) | **Bo - gop vao plugins.aliases TEXT[]** |
| **versions.change_logs** | Khong co | **Co** |
| **versions.source** | Khong co | **Co (spigot_auto / manual)** |
| **Bang manual_uploads** | Khong co | **Bang moi - tracking upload thu cong** |
| **Tong bang DB** | 12 bang | **14 bang** |
| **API Auth** | Khong co | **SHA-256 HMAC (Case 1: Vercel, Case 2: IP Whitelist)** |
| **CloakBrowser** | Chua phan vai | **Giao toan quyen cho discord/** |

---

## Quy Tac Chap Nhan (Plan Sign-off)

1. **Chi len ke hoach, khong tu y sua code**: Moi thay doi code chi bat dau khi co chi thi ro rang.
2. **Ky luat thu tu**: Giai doan 1 (Neon DB) => Giai doan 2 (Bot & CloakBrowser) => Giai doan 3 (Dashboard).
3. **CloakBrowser & Turnstile**: Bot Discord lam chu hoan toan qua trinh tu dong hoa Spigot.
4. **Zero SQLite in Dashboard**: Khong con .sqlite hay better-sqlite3 trong thu muc dashboard/.
5. **SHA-256 Auth bat buoc**: Moi /internal/* endpoint phai qua middleware, ngoai tru IP trong ALLOWED_DEV_IPS.
6. **Manual Upload tracking**: Moi .jar upload thu cong phai ghi dong thoi vao versions (source='manual') VA manual_uploads (uploadedBy, adminNote).
