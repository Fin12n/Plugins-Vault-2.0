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

    await page.evaluate((u: string, p: string) => {
      const loginInput = document.querySelector('#ctrl_pageLogin_login') as HTMLInputElement;
      const passInput = document.querySelector('#ctrl_pageLogin_password') as HTMLInputElement;
      const remBox = document.querySelector('#ctrl_pageLogin_remember') as HTMLInputElement;
      const reg0 = document.querySelector('#ctrl_pageLogin_registered') as HTMLInputElement;

      if (reg0) reg0.checked = true;
      if (remBox) remBox.checked = true;

      const valSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      
      if (loginInput) {
        valSetter.call(loginInput, u);
        loginInput.dispatchEvent(new Event('input', { bubbles: true }));
        loginInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (passInput) {
        valSetter.call(passInput, p);
        passInput.dispatchEvent(new Event('input', { bubbles: true }));
        passInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, acc.username, acc.password.reveal());

    await page.evaluate(() => {
      const form = document.querySelector('form#pageLogin') as HTMLFormElement;
      const btn = form?.querySelector('input[type=submit], button[type=submit]') as HTMLElement;
      if (btn) btn.click();
    });

    console.log('Submitted. Waiting 8s...');
    await new Promise((r) => setTimeout(r, 8000));

    // Handle Turnstile if present
    const frames = page.frames();
    for (const frame of frames) {
      if (frame.url().includes('challenges.cloudflare.com')) {
        const box = await frame.$('input[type=checkbox], .ctp-checkbox-label, #challenge-stage, body');
        if (box) {
          console.log('Clicking Turnstile...');
          await box.click();
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    const details = await page.evaluate(() => {
      return {
        title: document.title,
        url: location.href,
        bodyText: document.body.innerText.slice(0, 1000),
        errors: [...document.querySelectorAll('.error, .errors, .errorPanel, .blockMessage')].map((e) => e.textContent?.trim()),
        formAction: document.querySelector('form')?.getAttribute('action'),
      };
    });

    console.log('Page details:', JSON.stringify(details, null, 2));
  } finally {
    await session.close();
  }
}

main();
