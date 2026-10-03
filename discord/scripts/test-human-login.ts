import { launch } from 'cloakbrowser/puppeteer';
import { listEnabledSpigotAccounts } from '../src/repositories/spigot-accounts.js';
import Database from 'better-sqlite3';

async function main() {
  const db = new Database('./data/vault.db');
  const acc = listEnabledSpigotAccounts(db)[0];
  console.log(`Account: ${acc.label} (${acc.username})`);

  const browser = await launch({
    licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY || process.env.CLOAK_API_KEY,
    headless: false,
    humanize: true,
    humanPreset: 'careful',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--start-maximized',
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    console.log('1. Homepage warm-up...');
    await page.goto('https://spigotmc.org', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 8000));

    console.log('2. Navigating to login...');
    await page.goto('https://www.spigotmc.org/login', { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 4000));

    console.log('3. Typing into #ctrl_pageLogin_login...');
    await page.click('#ctrl_pageLogin_login');
    await new Promise((r) => setTimeout(r, 200));
    await page.type('#ctrl_pageLogin_login', acc.username, { delay: 60 });
    await new Promise((r) => setTimeout(r, 400));

    console.log('4. Typing into #ctrl_pageLogin_password...');
    await page.click('#ctrl_pageLogin_password');
    await new Promise((r) => setTimeout(r, 200));
    await page.type('#ctrl_pageLogin_password', acc.password.reveal(), { delay: 60 });
    await new Promise((r) => setTimeout(r, 500));

    console.log('5. Clicking #pageLogin submit button...');
    await page.click('#pageLogin input[type="submit"]');

    console.log('Submitted. Watching page for 30s...');
    for (let i = 1; i <= 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const title = await page.title().catch(() => 'error');
      const url = page.url();
      const loggedIn = await page.evaluate(`!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')`).catch(() => false);
      const errors = await page.evaluate(`(() => {
        const e = document.querySelector('.errors, .errorPanel, .error, .js-errorMessage');
        return e ? e.textContent.trim() : '';
      })()`).catch(() => '');
      console.log(`[+${i*2}s] Title: "${title}" | URL: ${url} | LoggedIn: ${loggedIn} | Error: "${errors}"`);
      if (loggedIn) {
        console.log('🎉🎉🎉 LOGIN SUCCESSFUL!');
        break;
      }
    }
  } catch (err) {
    console.error('Error during execution:', err);
  } finally {
    await browser.close();
  }
}

main();
