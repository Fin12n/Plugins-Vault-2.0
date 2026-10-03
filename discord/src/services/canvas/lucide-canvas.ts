import { loadImage, type Image } from '@napi-rs/canvas';
import { icons } from 'lucide';

export type LucideIconName = keyof typeof icons;

export type DrawLucideOptions = {
  color?: string;
  size?: number;
  strokeWidth?: number;
  fill?: string;
};

// Bộ nhớ đệm Image cache để tránh load lại cùng một icon nhiều lần
const iconCache = new Map<string, Promise<Image>>();

/**
 * Tạo chuỗi SVG chuẩn từ Lucide icon definition
 */
export function getLucideSvg(
  iconName: LucideIconName,
  options: DrawLucideOptions = {},
): string {
  const { color = '#38bdf8', size = 24, strokeWidth = 2, fill = 'none' } = options;
  const iconData = icons[iconName];
  if (!iconData) {
    throw new Error(`Icon "${String(iconName)}" not found in Lucide icons catalog.`);
  }

  const children = iconData
    .map(([tag, attrs]) => {
      const attrEntries = Object.entries(attrs)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');
      return `<${tag} ${attrEntries} />`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

/**
 * Lấy đối tượng Image của Lucide Icon (có cache)
 */
export function getLucideImage(
  iconName: LucideIconName,
  options: DrawLucideOptions = {},
): Promise<Image> {
  const { color = '#38bdf8', size = 24, strokeWidth = 2, fill = 'none' } = options;
  const cacheKey = `${iconName}_${color}_${size}_${strokeWidth}_${fill}`;

  const cached = iconCache.get(cacheKey);
  if (cached) return cached;

  const svg = getLucideSvg(iconName, options);
  const promise = loadImage(Buffer.from(svg));
  iconCache.set(cacheKey, promise);
  return promise;
}

/**
 * Vẽ Lucide Icon trực tiếp lên CanvasRenderingContext2D
 */
export async function drawLucideIcon(
  ctx: any,
  iconName: LucideIconName,
  x: number,
  y: number,
  size: number,
  options: Omit<DrawLucideOptions, 'size'> = {},
): Promise<void> {
  const img = await getLucideImage(iconName, { ...options, size });
  ctx.drawImage(img, x, y, size, size);
}
