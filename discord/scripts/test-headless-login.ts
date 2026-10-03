import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  const db = new Database('./data/vault.db');
  const accounts = listEnabledSpigotAccounts(db);
  const acc = accounts[0];

  console.log(`=== TEST HEADLESS: TRUE (CHẠY NGẦM) ===`);
  const probe = await probeBrowserLauncher(undefined, undefined, undefined, { headless: true, showWindow: false });
  const session = await probe.launch();
  const page = session.page as any;

  try {
    console.log('1. Warmup spigotmc.org...');
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));

    console.log('2. Goto /login...');
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4000));

    await page.evaluate((u: string, p: string) => {
      const form = document.querySelector('form#pageLogin') as HTMLFormElement;
      if (!form) return;

      const login = form.querySelector('input[name=login]') as HTMLInputElement;
      const pass = form.querySelector('input[name=password]') as HTMLInputElement;
      const reg0 = form.querySelector('input[name=register][value="0"]') as HTMLInputElement;
      const rem = form.querySelector('input[name=remember]') as HTMLInputElement;

      if (reg0) {
        reg0.checked = true;
        reg0.click();
      }
      if (rem) rem.checked = true;

      if (login) {
        login.disabled = false;
        login.value = u;
      }
      if (pass) {
        pass.disabled = false;
        pass.value = p;
      }
    }, acc.username, acc.password.reveal());

    console.log('3. Submitting form...');
    await page.evaluate(() => {
      const form = document.querySelector('form#pageLogin') as HTMLFormElement;
      const btn = form?.querySelector('input[type=submit], button[type=submit]') as HTMLElement;
      if (btn) btn.click();
      else if (form) form.submit();
    });

    console.log('4. Watching result & Turnstile...');
    let turnstileHandled = false;
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const title = await page.title().catch(() => '');
      const url = page.url();
      const loggedIn = await page.evaluate(
        `!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')`
      ).catch(() => false);

      console.log(`[+${i*2}s] Title: "${title}" | URL: ${url} | LoggedIn: ${loggedIn}`);

      if (loggedIn) {
        console.log('🎉🎉🎉 SUCCESS HEADLESS! LOGGED IN AS:', acc.label);
        const cookies = await page.cookies();
        const xfUser = cookies.find((c: any) => c.name === 'xf_user');
        console.log('xf_user:', xfUser ? xfUser.value : 'none');
        break;
      }

      // Turnstile
      if (!turnstileHandled) {
        const frames = page.frames();
        for (const frame of frames) {
          if (frame.url().includes('challenges.cloudflare.com')) {
            console.log('Found Turnstile frame! Clicking...');
            try {
              const box = await frame.$('input[type=checkbox], .ctp-checkbox-label, #challenge-stage, body');
              if (box) {
                await box.click();
                turnstileHandled = true;
                console.log('Clicked Turnstile!');
                break;
              }
            } catch (e) {
              console.log('Turnstile click error:', e);
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
