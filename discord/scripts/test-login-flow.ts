import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  console.log('=== TEST PROPER SUBMISSION & WATCH POST-SUBMIT ===');
  const db = new Database('./data/vault.db');
  const accounts = listEnabledSpigotAccounts(db);
  const acc = accounts[0];
  console.log(`Account: ${acc.label} (${acc.username})`);

  const probe = await probeBrowserLauncher(undefined, undefined, undefined, {
    headless: false,
    showWindow: true,
  });

  const session = await probe.launch();
  const page = session.page;

  try {
    console.log('1. Homepage warm-up...');
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 8000));

    console.log('2. Navigating to login...');
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 4000));

    console.log('3. Filling form and setting register=0...');
    await page.evaluate(`(() => {
      // Ensure 'Yes, my password is:' is checked
      const reg = document.querySelector('input[name=register][value="0"]');
      if (reg) reg.click();

      // Ensure remember is checked
      const rem = document.querySelector('input[name=remember]');
      if (rem) rem.checked = true;

      const u = document.querySelector('input[name=login]');
      if (u) { u.focus(); u.value = ''; }
    })()`);

    await page.keyboard.type(acc.username, { delay: 40 });

    await page.evaluate(`(() => {
      const p = document.querySelector('input[name=password]');
      if (p) { p.focus(); p.value = ''; }
    })()`);

    await page.keyboard.type(acc.password.reveal(), { delay: 40 });

    console.log('4. Clicking submit via evaluate...');
    await page.evaluate(`(() => {
      const form = document.querySelector('form#pageLogin') || document.querySelector('form[action*="login"]');
      if (form) {
        const btn = form.querySelector('input[type=submit], button[type=submit]');
        if (btn) btn.click();
        else form.submit();
      }
    })()`);

    console.log('5. Watching post-submit for 45s...');
    for (let i = 1; i <= 22; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const title = await page.title().catch(() => 'error');
      const url = await page.evaluate('location.href').catch(() => 'error');
      const loggedIn = await page.evaluate(`!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')`).catch(() => false);
      const errors = await page.evaluate(`(() => {
        const e = document.querySelector('.errors, .errorPanel, .error, .js-errorMessage');
        return e ? e.textContent.trim() : '';
      })()`).catch(() => '');
      console.log(`[+${i * 2}s] Title: "${title}" | URL: ${url} | LoggedIn: ${loggedIn} | Error: "${errors}"`);
      if (loggedIn) {
        console.log('🎉 SUCCESSFULLY LOGGED IN!');
        break;
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await session.close();
    console.log('Done.');
  }
}

main();
