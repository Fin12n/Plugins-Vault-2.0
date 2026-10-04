import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/connection.js';
import type { SepayWebhookPayload } from '../../domain/order.js';
import type { DeliveryDeps } from '../../services/delivery/deliver-version.js';
import type { Database } from '../../db/neon.js';
import { applySepayTransferNeon } from '../../services/payment/neon-payment-flow.js';
import { getWalletBalance } from '../../repositories/neon-wallets.js';
import { verifySepaySignature } from '../../services/payment/verify-sepay-signature.js';
import { botVi } from '../../bot/i18n/bot-vi.js';
import { processNextDeliveryJob } from '../../services/delivery/neon-delivery-worker.js';

/**
 * SePay's payload. `code` is nullable and `subAccount` optional; `transferAmount`
 * is positive even for outgoing transfers, which the service guards on.
 */
const payloadSchema = z.object({
  id: z.number().int(),
  gateway: z.string().default(''),
  transactionDate: z.string().default(''),
  accountNumber: z.string().default(''),
  subAccount: z.string().nullable().default(null),
  code: z.string().nullable().default(null),
  content: z.string().default(''),
  transferType: z.enum(['in', 'out']),
  description: z.string().default(''),
  transferAmount: z.number(),
  accumulated: z.number().default(0),
  referenceCode: z.string().default(''),
});

/**
 * Incoming-transfer webhook.
 *
 * SePay considers a delivery acknowledged only when all three hold: status 200 or
 * 201, a body of exactly {"success": true}, and a response inside 30 seconds.
 * Failing any one triggers up to seven retries. So the handler writes the
 * transaction row synchronously (fast), answers, and only then dispatches
 * delivery — which involves Discord and could otherwise blow the deadline.
 */
export function registerSepayWebhook(
  app: FastifyInstance,
  deps: { db: Db; neonDb?: Database; env: Env; delivery?: DeliveryDeps },
): void {
  app.post(
    '/webhooks/sepay',
    {
      // Route-scoped raw body. The signature covers the exact bytes received, so
      // letting the global JSON parser consume the body first and re-serializing
      // it would change key order and Unicode escaping — the most common reason
      // this integration silently never verifies.
      config: { rawBody: true },
    },
    async (request, reply) => {
      const raw = (request as { rawBody?: Buffer | string }).rawBody;
      if (raw === undefined) {
        request.log.error('rawBody chưa được bật cho route webhook');
        return reply.code(500).send({ success: false, message: 'server misconfigured' });
      }

      const verdict = verifySepaySignature({
        rawBody: raw,
        signatureHeader: request.headers['x-sepay-signature'] as string | undefined,
        timestampHeader: request.headers['x-sepay-timestamp'] as string | undefined,
        secret: deps.env.SEPAY_WEBHOOK_SECRET,
      });

      if (!verdict.ok) {
        request.log.warn({ reason: verdict.reason }, 'webhook SePay bị từ chối');
        return reply.code(401).send({ success: false, message: verdict.reason });
      }

      const parsed = payloadSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn({ issues: parsed.error.issues }, 'payload SePay sai định dạng');
        return reply.code(400).send({ success: false, message: 'invalid payload' });
      }

      const payload = parsed.data as SepayWebhookPayload;

      // Raw memo fields are logged for the first weeks of live traffic: whether
      // Vietnamese banks alter the memo is undocumented, and this is the only way
      // to observe what actually arrives per bank.
      request.log.info(
        {
          sepayId: payload.id,
          gateway: payload.gateway,
          code: payload.code,
          content: payload.content,
          description: payload.description,
          transferType: payload.transferType,
          amount: payload.transferAmount,
        },
        'webhook SePay nhận được',
      );

      if (!deps.neonDb) {
        request.log.error('Neon PostgreSQL không khả dụng cho webhook SePay — Từ chối để SePay retry (Fail-Closed)');
        return reply.code(503).send({ success: false, message: 'database unavailable' });
      }

      const outcome = await applySepayTransferNeon(deps.neonDb, payload);

      // The literal body matters; Fastify's default empty 200 counts as a failure
      // and would trigger retries.
      await reply.code(200).send({ success: true });

      if (outcome.handled === 'topup') {
        // The money is already in the wallet, which is the part that matters. The
        // DM is a courtesy, so a blocked DM is logged and dropped rather than
        // treated as a failure — there is nothing to retry.
        request.log.info(
          { topupId: outcome.topupId, credited: outcome.credited },
          'đã nạp ví qua chuyển khoản',
        );
        if (deps.delivery) {
          const client = deps.delivery.client;
          // Balance read after crediting, so the message states where they now
          // stand rather than only what moved.
          const balance = await getWalletBalance(deps.neonDb, outcome.discordUserId);
          void client.users
            .fetch(outcome.discordUserId)
            .then((user) => user.send(botVi.topupCredited(outcome.credited, balance)))
            .catch((err: unknown) => {
              request.log.warn(
                { topupId: outcome.topupId, err: err instanceof Error ? err.message : String(err) },
                'không nhắn được cho người nạp ví',
              );
            });
        }
        return reply;
      }

      if (outcome.handled === 'paid') {
        if (!deps.delivery) {
          // The transfer is recorded and the order marked paid, so the reconcile
          // view can release it manually. Losing the automatic delivery is far
          // better than answering a real payment with an error and having SePay
          // retry against an endpoint that cannot succeed either.
          request.log.error(
            { orderId: outcome.orderId },
            'đã nhận thanh toán nhưng bot chưa sẵn sàng — cần giao thủ công',
          );
          return reply;
        }
        const delivery = deps.delivery;
        void processNextDeliveryJob({
          neonDb: deps.neonDb,
          client: delivery.client,
          vaultDir: delivery.vaultDir,
          publicBaseUrl: delivery.publicBaseUrl,
          attachMaxBytes: delivery.attachMaxBytes,
          tokenTtlMinutes: delivery.tokenTtlMinutes,
        }).then((res) => {
          if (!res.success && res.processed) {
            request.log.error(
              { orderId: outcome.orderId, reason: res.reason },
              'giao hàng Neon thất bại sau khi thanh toán',
            );
          }
        });
      }

      return reply;
    },
  );
}
