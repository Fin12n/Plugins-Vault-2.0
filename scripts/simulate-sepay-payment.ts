import { signSepayPayload } from '../src/services/payment/verify-sepay-signature.js';
import { config } from '../src/config/index.js';

/**
 * Fires a signed SePay webhook at the local server, standing in for a real bank
 * transfer.
 *
 * SePay cannot reach localhost, so the deposit flow is otherwise untestable
 * without a public HTTPS origin. This signs a payload with the same secret and
 * the same `{timestamp}.{rawBody}` construction the real sender uses, so it
 * exercises the genuine verification path rather than bypassing it.
 *
 * Usage: npm run simulate-payment -- <CODE> [amount]
 * The code is printed by the bot in the QR reply; the amount defaults to the
 * plugin's deposit price being tested and may be varied to check under/overpay.
 */
async function main(): Promise<void> {
  const env = config();
  const code = process.argv[2];
  const amount = Number(process.argv[3] ?? 20000);

  if (!code) {
    console.error('Thiếu mã đơn. Dùng: npm run simulate-payment -- VNAB12CD [số tiền]');
    process.exit(1);
  }

  // A code always opens with the letter prefix from SEPAY_CODE_PREFIX, so an
  // all-digits argument is the deposit amount typed into the wrong script. Left
  // unchecked the run reaches the network and reports a connection error, which
  // sends the operator debugging the webhook instead of re-reading the command.
  if (!/^[A-Za-z]{2,5}/.test(code)) {
    console.error(
      `"${code}" không phải mã đơn — mã luôn bắt đầu bằng tiền tố chữ cái (${env.SEPAY_CODE_PREFIX}...).\n` +
        'Mã đơn nằm trong tin nhắn QR mà bot gửi khi bạn chọn phiên bản.\n' +
        'Nếu bạn muốn đặt GIÁ tạm ứng, lệnh là: npm run set-price -- 1000',
    );
    process.exit(1);
  }

  // Wall-clock in UTC+7, the format and timezone SePay sends and the parser expects.
  const vietnamNow = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const payload = {
    // Milliseconds, not seconds: sepay_id is the dedupe key, so two runs inside
    // the same second would collide and the second would be silently swallowed
    // as a retry — while the route still answers 200 and this script still
    // prints success, which reads as a broken feature rather than a no-op.
    id: Date.now(),
    gateway: 'Vietcombank',
    transactionDate: vietnamNow,
    accountNumber: env.SEPAY_ACCOUNT_NUMBER,
    subAccount: null,
    code: code.toUpperCase(),
    // Mimics a bank prepending text to the memo, which SePay matches as a substring.
    content: `CT DEN:${code.toUpperCase()} chuyen khoan`,
    transferType: 'in' as const,
    description: `Chuyen khoan ${code.toUpperCase()}`,
    transferAmount: amount,
    accumulated: 0,
    referenceCode: '',
  };

  // Signed over the exact bytes that get sent; re-serializing would change key
  // order and invalidate the signature.
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signSepayPayload(env.SEPAY_WEBHOOK_SECRET, timestamp, rawBody);

  const url = `http://127.0.0.1:${env.PORT}/webhooks/sepay`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sepay-signature': signature,
      'x-sepay-timestamp': String(timestamp),
    },
    body: rawBody,
    // A refused connection means the bot is not running, which is worth saying
    // plainly: the raw ECONNREFUSED stack names a port and an errno and reads
    // like the payment integration is broken.
  }).catch((err: unknown) => {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') {
      console.error(
        `Không kết nối được tới bot ở cổng ${env.PORT}. Bot chưa chạy — mở một cửa sổ khác ` +
          'và chạy `npm start` trước, rồi thử lại.',
      );
      process.exit(1);
    }
    throw err;
  });

  console.log(`${response.status} ${await response.text()}`);
  if (response.status === 200) {
    console.log(`Đã gửi ${amount.toLocaleString('vi-VN')} ₫ cho mã ${code.toUpperCase()}.`);
    console.log('Kiểm tra DM của bot, hoặc tab Đối soát nếu đơn treo lại.');
  }
}

main().catch((err: unknown) => {
  console.error('Mô phỏng thất bại:', err);
  process.exit(1);
});
