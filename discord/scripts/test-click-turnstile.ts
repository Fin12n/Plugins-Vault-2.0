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

    console.log('Submitted. Waiting 6s for challenge to render...');
    await new Promise((r) => setTimeout(r, 6000));

    console.log('Finding Turnstile checkbox...');
    // Look for Turnstile iframe
    const frames = page.frames();
    console.log(`Found ${frames.length} frames`);
    let clicked = false;
    for (const frame of frames) {
      const url = frame.url();
      console.log('Frame URL:', url);
      if (url.includes('challenges.cloudflare.com')) {
        console.log('Found Turnstile frame! Searching for checkbox inside frame...');
        try {
          const box = await frame.$('input[type=checkbox], .ctp-checkbox-label, #challenge-stage, body');
          if (box) {
            console.log('Found element inside frame, clicking it...');
            await box.click();
            clicked = true;
            break;
          }
        } catch (e) {
          console.error('Frame click error:', e);
        }
      }
    }

    if (!clicked) {
      console.log('Trying clicking via coordinates or main page selector...');
      const cfContainer = await page.$('#cf-chl-widget-container, iframe[src*="cloudflare"]');
      if (cfContainer) {
        const rect = await cfContainer.boundingBox();
        console.log('Bounding box:', rect);
        if (rect) {
          // Click in the left side where checkbox is (approx x + 30, y + rect.height / 2)
          await page.mouse.click(rect.x + 30, rect.y + rect.height / 2);
          clicked = true;
        }
      }
    }

    console.log('Clicked Turnstile:', clicked);
    console.log('Waiting 15s to observe result...');
    for (let i = 1; i <= 8; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const title = await page.title().catch(() => '');
      const url = await page.evaluate('location.href').catch(() => '');
      const loggedIn = await page.evaluate(`!!document.querySelector('.accountUsername, [data-logged-in="true"], a[href*="logout"]')`).catch(() => false);
      console.log(`[+${i*2}s] Title: "${title}" | URL: ${url} | LoggedIn: ${loggedIn}`);
      if (loggedIn) {
        console.log('SUCCESS!');
        break;
      }
    }
  } finally {
    await session.close();
  }
}

main();
