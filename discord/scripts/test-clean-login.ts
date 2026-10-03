import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  const db = new Database('./data/vault.db');
  const acc = listEnabledSpigotAccounts(db)[0];
  console.log(`Testing account: ${acc.label} (${acc.username})`);

  const probe = await probeBrowserLauncher(undefined, undefined, undefined, { headless: false });
  const session = await probe.launch();
  const page = session.page as any;

  try {
    console.log('1. Warmup homepage...');
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));

    console.log('2. Goto /login...');
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4000));

    // Focus & type username
    console.log('3. Typing username...');
    await page.click('#ctrl_pageLogin_login');
    await page.type('#ctrl_pageLogin_login', acc.username, { delay: 50 });
    await new Promise((r) => setTimeout(r, 300));

    // Focus & type password
    console.log('4. Typing password...');
    await page.click('#ctrl_pageLogin_password');
    await page.type('#ctrl_pageLogin_password', acc.password.reveal(), { delay: 50 });
    await new Promise((r) => setTimeout(r, 500));

    // Check state before submit
    const stateBefore = await page.evaluate(() => {
      const reg0 = document.querySelector('input[name=register][value="0"]') as HTMLInputElement;
      const reg1 = document.querySelector('input[name=register][value="1"]') as HTMLInputElement;
      const u = document.querySelector('#ctrl_pageLogin_login') as HTMLInputElement;
      const p = document.querySelector('#ctrl_pageLogin_password') as HTMLInputElement;
      const rem = document.querySelector('#ctrl_pageLogin_remember') as HTMLInputElement;
      const submit = document.querySelector('form#pageLogin input[type=submit]') as HTMLInputElement;
      return {
        loginVal: u?.value,
        passLen: p?.value?.length,
        reg0Checked: reg0?.checked,
        reg1Checked: reg1?.checked,
        remChecked: rem?.checked,
        submitVal: submit?.value,
      };
    });
    console.log('State before submit:', stateBefore);

    // Submit form by clicking submit button
    console.log('5. Clicking submit...');
    await page.click('form#pageLogin input[type=submit]');

    console.log('6. Watching for Turnstile or result for 45s...');
    let turnstileClicked = false;
    for (let i = 1; i <= 22; i++) {
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
        console.log('🎉🎉🎉 DANG NHAP THANH CONG!');
        // Lay cookies
        const cookies = await page.cookies();
        console.log('Cookies count:', cookies.length);
        const xfUser = cookies.find((c: any) => c.name === 'xf_user');
        const xfSession = cookies.find((c: any) => c.name === 'xf_session');
        console.log('xf_user:', xfUser ? xfUser.value.slice(0, 20) + '...' : 'none');
        console.log('xf_session:', xfSession ? xfSession.value.slice(0, 20) + '...' : 'none');
        break;
      }

      // If we see turnstile frame and haven't clicked yet
      if (!turnstileClicked) {
        const frames = page.frames();
        for (const frame of frames) {
          if (frame.url().includes('challenges.cloudflare.com')) {
            console.log('Found Turnstile frame! Attempting click...');
            try {
              const box = await frame.$('input[type=checkbox], .ctp-checkbox-label, #challenge-stage, body');
              if (box) {
                console.log('Clicking Turnstile element...');
                await box.click();
                turnstileClicked = true;
                break;
              }
            } catch (e) {
              console.log('Turnstile frame click error:', e);
            }
          }
        }
      }
    }

    await page.screenshot({ path: 'test_after_submit.png' });
    console.log('Screenshot saved to test_after_submit.png');
  } finally {
    await session.close();
  }
}

main();
