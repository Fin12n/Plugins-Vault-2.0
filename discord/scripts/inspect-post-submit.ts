import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  const db = new Database('./data/vault.db');
  const acc = listEnabledSpigotAccounts(db)[0];

  const probe = await probeBrowserLauncher(undefined, undefined, undefined, { headless: false });
  const session = await probe.launch();
  const page = session.page as any;

  try {
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4000));

    await page.evaluate(`(() => {
      const reg = document.querySelector('input[name=register][value="0"]');
      if (reg) reg.click();
      const u = document.querySelector('input[name=login]');
      if (u) { u.focus(); u.value = ''; }
    })()`);
    await page.keyboard.type(acc.username, { delay: 40 });

    await page.evaluate(`(() => {
      const p = document.querySelector('input[name=password]');
      if (p) { p.focus(); p.value = ''; }
    })()`);
    await page.keyboard.type(acc.password.reveal(), { delay: 40 });

    await page.evaluate(`(() => {
      const btn = document.querySelector('form#pageLogin input[type=submit], form[action*="login"] input[type=submit]');
      if (btn) btn.click();
    })()`);

    await new Promise((r) => setTimeout(r, 5000));

    const title = await page.title();
    console.log('Post submit title:', title);

    await page.screenshot({ path: 'post_submit_challenge.png' });
    console.log('Saved screenshot to post_submit_challenge.png');

    const htmlSnippet = await page.evaluate(`(() => {
      return {
        bodyText: (document.body ? document.body.textContent || '' : '').slice(0, 1000),
        iframes: [...document.querySelectorAll('iframe')].map(f => f.src),
        forms: [...document.querySelectorAll('form')].map(f => f.id || f.action),
        hasTurnstile: !!document.querySelector('#cf-chl-widget-container, iframe[src*="cloudflare"], input[name="cf-turnstile-response"]')
      };
    })()`);
    console.log('HTML details:', htmlSnippet);
  } finally {
    await session.close();
  }
}

main();
