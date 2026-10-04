import { mkdirSync } from 'node:fs';
import { createBotClient } from './bot/client.js';
import { config } from './config/index.js';
import { closeDb, initDb } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { getSettings, seedSettings } from './db/settings-store.js';
import { buildServer } from './http/server.js';
import { sweepOrphanedTemps } from './services/ingest/assign-pending-ingest.js';
import { startMaintenance, type MaintenanceHandle } from './services/maintenance/scheduler.js';
import { isCard2kConfigured } from './services/card/card2k-client.js';
import { isBenignBrowserCleanupError } from './services/upstream/browser-cleanup-error.js';
import { createChallengeResumeHandler } from './services/upstream/challenge-resume.js';
import { SpigotChallengeSessionManager } from './services/upstream/spigot-challenge-session.js';
import { autoMigrateJsonAccountsToDb } from './repositories/spigot-accounts.js';
import { initNeonDb, type Database } from './db/neon.js';
import { autoSeedDefaultChannels } from './services/channel-manager.js';
import { ensureOwnerStaffExists } from './repositories/neon-staffs.js';

/** Teardown callbacks registered by the HTTP server and Discord client. */
const shutdownHooks: (() => Promise<void> | void)[] = [];

export function onShutdown(hook: () => Promise<void> | void): void {
  shutdownHooks.push(hook);
}

/**
 * Boot order matters: config must validate before anything touches disk, and
 * migrations must finish before any service reads a table.
 *
 * The HTTP server and Discord bot share this process deliberately — the SePay
 * webhook arrives over HTTP but must trigger a Discord DM, so both need the same
 * in-process service layer.
 */
async function main(): Promise<void> {
  const env = config();

  // 0o750: on a shared VPS the archived jars and the token/audit tables must not
  // be world-readable.
  mkdirSync(env.VAULT_DIR, { recursive: true, mode: 0o750 });
  mkdirSync(env.TMP_DIR, { recursive: true, mode: 0o750 });

  const database = initDb(env.DB_PATH);
  const result = migrate(database);
  console.log(
    result.applied.length > 0
      ? `Đã áp dụng migration: ${result.applied.join(', ')} (schema v${result.to})`
      : `Schema đã ở phiên bản mới nhất (v${result.to})`,
  );

  let neonDb: Database | undefined;
  if (env.DATABASE_URL) {
    try {
      neonDb = initNeonDb(env.DATABASE_URL);
      console.log('Neon PostgreSQL: Đã khởi tạo kết nối cơ sở dữ liệu');
      await autoSeedDefaultChannels(env);
      await ensureOwnerStaffExists(neonDb, env.DISCORD_OWNER_ID);
    } catch (neonErr) {
      console.warn('Neon PostgreSQL: Chưa thể kết nối:', neonErr instanceof Error ? neonErr.message : neonErr);
    }
  }

  seedSettings(database, env);
  const settings = getSettings(database, env);
  console.log(`Cấu hình: ${settings.adminRoleIds.length} role admin, giữ ${settings.pruneKeepCount} bản mỗi plugin`);

  const migratedAccounts = autoMigrateJsonAccountsToDb(
    database,
    env.SPIGOT_CREDENTIALS_FILE,
    env.SPIGOT_ACCOUNTS_FILE,
  );
  if (migratedAccounts > 0) {
    console.log(`Đã tự động chuyển đổi & mã hóa ${migratedAccounts} tài khoản Spigot vào SQLite`);
  }

  // Must run before the HTTP server accepts uploads: it deletes temp files no
  // pending row owns, which would include an ingest currently in flight.
  const swept = await sweepOrphanedTemps(database, env.TMP_DIR);
  if (swept > 0) console.log(`Đã dọn ${swept} tệp tạm còn lại từ lần chạy trước`);

  const orderConfig = {
    accountNumber: env.SEPAY_ACCOUNT_NUMBER,
    bankCode: env.SEPAY_BANK_CODE,
    codePrefix: env.SEPAY_CODE_PREFIX,
    codeSuffixLength: env.SEPAY_CODE_SUFFIX_LENGTH,
    ttlMinutes: settings.orderTtlMinutes,
  };

  const cardConfig = {
    baseUrl: env.CARD2K_BASE_URL,
    partnerId: env.CARD2K_PARTNER_ID,
    partnerKey: env.CARD2K_PARTNER_KEY,
    signFields: env.CARD2K_SIGN_FIELDS,
    commandCharge: env.CARD2K_COMMAND_CHARGE,
    commandCheck: env.CARD2K_COMMAND_CHECK,
    timeoutMs: env.CARD2K_TIMEOUT_MS,
  };

  // Stated at boot because the failure is otherwise invisible: /nap simply
  // refuses cards, and the reason lives in a config file nobody re-reads.
  if (isCard2kConfigured(cardConfig)) {
    console.log('Nạp thẻ cào: đã cấu hình card2k');
  } else {
    console.log(
      'Nạp thẻ cào: TẮT — thiếu CARD2K_PARTNER_ID/KEY, CARD2K_SIGN_FIELDS hoặc CARD2K_COMMAND_*. ' +
        'Lấy các giá trị này ở card2k.com/partner. Nạp ví qua chuyển khoản vẫn hoạt động.',
    );
  }

  const deliveryConfig = {    db: database,
    vaultDir: env.VAULT_DIR,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    attachMaxBytes: settings.attachMaxBytes,
    tokenTtlMinutes: settings.downloadTokenTtlMinutes,
  };

  let maintenance: MaintenanceHandle | null = null;
  const challengeSessions = new SpigotChallengeSessionManager();
  onShutdown(() => challengeSessions.close());
  const maintenanceControl = {
    triggerUpdateCheck: (forcePurchasedScan?: boolean) => maintenance?.triggerUpdateCheck(forcePurchasedScan) ?? false,
    triggerFullBatchDownload: (options?: { autoResolveIds?: boolean }) => maintenance?.triggerFullBatchDownload(options) ?? false,
    triggerScanOnly: () => maintenance?.triggerScanOnly?.() ?? false,
    triggerOrderedDownload: (options?: { targetResourceId?: number }) => maintenance?.triggerOrderedDownload?.(options) ?? false,
    getUpdateStatus: () => maintenance?.getUpdateStatus() ?? ({ running: false, lastStartedAt: null, lastFinishedAt: null }),
    getCurrentOperation: () => maintenance?.getCurrentOperation?.() ?? 'idle',
    isReady: () => maintenance !== null,
    abortSweep: async () => (maintenance?.abortSweep ? maintenance.abortSweep() : false),
    rotateProxy: async () =>
      maintenance?.rotateProxy
        ? maintenance.rotateProxy()
        : { ok: false, currentProxyIp: null, error: 'Dịch vụ bảo trì chưa sẵn sàng' },
  };

  // The client object exists immediately; login is what can fail. Building the
  // server against it means the webhook and manual release have a real client to
  // deliver through, while a bad token degrades the bot rather than taking the
  // dashboard down with it — the owner needs the dashboard reachable precisely
  // when the token is wrong.
  const { client, login } = createBotClient({
    db: database,
    env,
    delivery: deliveryConfig,
    orders: orderConfig,
    card: cardConfig,
    maintenance: maintenanceControl,
  });
  onShutdown(() => client.destroy());

  const app = await buildServer({
    db: database,
    neonDb,
    env,
    delivery: { ...deliveryConfig, client },
    maintenance: maintenanceControl,
    challengeSessions,
  });
  onShutdown(() => app.close());
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  console.log(`HTTP đang chạy tại cổng ${env.PORT}`);

  try {
    await login();
  } catch (err) {
    console.error('Bot Discord không đăng nhập được — dashboard vẫn chạy:', err instanceof Error ? err.message : err);
    console.error('Kiểm tra DISCORD_TOKEN rồi khởi động lại.');
  }

  maintenance = startMaintenance({
    db: database,
    env,
    vaultDir: env.VAULT_DIR,
    client,
    card: cardConfig,
    challengeSessions,
  });
  challengeSessions.setResolvedHandler(createChallengeResumeHandler(() => maintenance));
  onShutdown(() => maintenance.stop());

  console.log('Khởi động hoàn tất.');
}

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nNhận ${signal}, đang dừng...`);

  // Stop accepting work before closing the database, or an in-flight request
  // hits a closed handle.
  for (const hook of shutdownHooks.reverse()) {
    try {
      await hook();
    } catch (err) {
      console.error('Lỗi khi dừng:', err);
    }
  }
  closeDb();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

/**
 * Phase 5 dispatches delivery as a deliberately unawaited promise after
 * answering the SePay webhook. Node's default behavior on an unhandled rejection
 * is to terminate — which here would take down Fastify AND the Discord bot
 * because they share one process. Log and keep serving instead.
 */
process.on('unhandledRejection', (reason) => {
  console.error('Promise bị reject nhưng không được xử lý:', reason);
});

process.on('uncaughtException', (err) => {
  if (isBenignBrowserCleanupError(err)) {
    console.warn('Chrome đã đóng nhưng thư viện cleanup không đọc được danh sách process con; tiếp tục chạy.');
    return;
  }
  console.error('Lỗi không bắt được:', err);
  void shutdown('uncaughtException', 1);
});

main().catch((err: unknown) => {
  console.error('Khởi động thất bại:', err);
  closeDb();
  process.exit(1);
});
