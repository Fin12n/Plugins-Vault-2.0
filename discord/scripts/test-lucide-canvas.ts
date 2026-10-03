import { createCanvas, loadImage } from '@napi-rs/canvas';
import { icons } from 'lucide';
import { writeFileSync } from 'node:fs';

function getLucideSvg(
  iconName: keyof typeof icons,
  options: { color?: string; size?: number; strokeWidth?: number } = {},
): string {
  const { color = '#38bdf8', size = 24, strokeWidth = 2 } = options;
  const iconData = icons[iconName];
  if (!iconData) {
    throw new Error(`Icon ${String(iconName)} not found in lucide icons`);
  }
  const children = iconData
    .map(([tag, attrs]) => {
      const attrEntries = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrEntries} />`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

async function run() {
  const canvas = createCanvas(400, 200);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, 400, 200);

  const testIcons: Array<{ name: keyof typeof icons; color: string; label: string }> = [
    { name: 'Package', color: '#38bdf8', label: 'Package' },
    { name: 'Crown', color: '#eab308', label: 'Crown' },
    { name: 'ShieldCheck', color: '#22c55e', label: 'Shield' },
    { name: 'Coins', color: '#f59e0b', label: 'Coins' },
    { name: 'Layers', color: '#a855f7', label: 'Layers' },
  ];

  let x = 30;
  for (const item of testIcons) {
    const svg = getLucideSvg(item.name, { color: item.color, size: 36, strokeWidth: 2.2 });
    const img = await loadImage(Buffer.from(svg));
    ctx.drawImage(img, x, 40, 36, 36);

    ctx.fillStyle = item.color;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(item.label, x - 5, 100);

    x += 70;
  }

  const buf = canvas.toBuffer('image/png');
  writeFileSync('tmp/test-lucide.png', buf);
  console.log('Generated tmp/test-lucide.png successfully! Size:', buf.length);
}

run().catch(console.error);
