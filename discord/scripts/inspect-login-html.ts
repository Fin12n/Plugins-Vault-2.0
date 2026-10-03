import { probeBrowserLauncher } from '../src/services/upstream/browser-launcher.js';

async function main() {
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

    const formInfo = await page.evaluate(() => {
      const form = document.querySelector('form#pageLogin') || document.querySelector('form[action*="login"]');
      if (!form) return { hasForm: false };
      const inputs = [...form.querySelectorAll('input, button, select')].map((el: any) => ({
        tag: el.tagName,
        type: el.type,
        name: el.name,
        id: el.id,
        value: el.value,
        checked: el.checked,
        outerHTML: el.outerHTML.slice(0, 150),
      }));
      return {
        hasForm: true,
        action: form.getAttribute('action'),
        method: form.getAttribute('method'),
        id: form.id,
        inputs,
      };
    });

    console.log('Form Info:', JSON.stringify(formInfo, null, 2));
  } finally {
    await session.close();
  }
}

main();
