import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  const db = new Database('./data/vault.db');
  const acc = listEnabledSpigotAccounts(db)[0];
  console.log(`Account: ${acc.label} (${acc.username})`);

  const probe = await probeBrowserLauncher(undefined, undefined, undefined, { headless: false });
  const session = await probe.launch();
  const page = session.page as any;

  try {
    console.log('1. Warmup...');
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));

    console.log('2. Goto /login...');
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4000));

    // Điền bằng DOM Native Setter + Dispatch Events để đảm bảo 100% giá trị được nhận
    await page.evaluate((u: string, p: string) => {
      const loginInput = document.querySelector('#ctrl_pageLogin_login') as HTMLInputElement;
      const passInput = document.querySelector('#ctrl_pageLogin_password') as HTMLInputElement;
      const remBox = document.querySelector('#ctrl_pageLogin_remember') as HTMLInputElement;
      const reg0 = document.querySelector('#ctrl_pageLogin_registered') as HTMLInputElement;

      if (reg0) reg0.checked = true;
      if (remBox) remBox.checked = true;

      const valSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      
      if (loginInput) {
        loginInput.focus();
        valSetter.call(loginInput, u);
        loginInput.dispatchEvent(new Event('input', { bubbles: true }));
        loginInput.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (passInput) {
        passInput.focus();
        valSetter.call(passInput, p);
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, acc.username, acc.password.reveal());

    const checkState = await page.evaluate(() => {
      const u = (document.querySelector('#ctrl_pageLogin_login') as HTMLInputElement)?.value;
      const p = (document.querySelector('#ctrl_pageLogin_password') as HTMLInputElement)?.value;
      return { u, pLen: p?.length };
    });
    console.log('Fields filled:', checkState);

    // Click Submit
    console.log('3. Clicking submit button...');
    await page.evaluate(() => {
      const form = document.querySelector('form#pageLogin') as HTMLFormElement;
      const btn = form?.querySelector('input[type=submit], button[type=submit]') as HTMLElement;
      if (btn) btn.click();
      else if (form) form.submit();
    });

    console.log('4. Watching result & Turnstile...');
    let turnstileClicked = false;
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const title = await page.title().catch(() => '');
      const url = page.url();
      const loggedIn = await page.evaluate(
        `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')`
      ).catch(() => false);
      const errors = await page.evaluate(`(() => {
        const e = document.querySelector('.errors, .errorPanel, .error, .js-errorMessage');
        return e ? e.textContent.trim() : '';
      })()`).catch(() => '');

      console.log(`[+${i*2}s] Title: "${title}" | URL: ${url} | LoggedIn: ${loggedIn} | Error: "${errors}"`);

      if (loggedIn) {
        console.log('🎉🎉🎉 ĐĂNG NHẬP THÀNH CÔNG VÀO SPIGOTMC!');
        const cookies = await page.cookies();
        const xfUser = cookies.find((c: any) => c.name === 'xf_user');
        console.log('xf_user token:', xfUser ? xfUser.value : 'chưa có');
        break;
      }

      // Xử lý Turnstile nếu xuất hiện
      if (!turnstileClicked) {
        const frames = page.frames();
        for (const frame of frames) {
          if (frame.url().includes('challenges.cloudflare.com')) {
            console.log('🛡️ Phát hiện Turnstile frame! Đang click checkbox...');
            try {
              const box = await frame.$('input[type=checkbox], .ctp-checkbox-label, #challenge-stage, body');
              if (box) {
                await box.click();
                turnstileClicked = true;
                console.log('✅ Đã click Turnstile box!');
                break;
              }
            } catch (e) {
              console.log('Lỗi click Turnstile:', e);
            }
          }
        }
      }
    }
  } finally {
    await session.close();
  }
}

main();
