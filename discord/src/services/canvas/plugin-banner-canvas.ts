import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from '../../domain/plugin.js';
import type { Db } from '../../db/connection.js';
import { listVersionsByPlugin } from '../../repositories/versions.js';
import { formatBytes, formatVnd } from '../../bot/i18n/bot-vi.js';
import { drawLucideIcon } from './lucide-canvas.js';

let cachedDotJarIcon: Image | null = null;
let cachedPremiumIcon: Image | null = null;

async function getAssets(assetsDir: string) {
  if (!cachedDotJarIcon) {
    const candidatePaths = [
      join(assetsDir, 'imgs', 'dotjarlogo.png'),
      join(assetsDir, 'dotjarlogo.png'),
      join(assetsDir, '..', 'src', 'assets', 'dotjarlogo.png'),
      join(process.cwd(), 'src', 'assets', 'dotjarlogo.png'),
      join(process.cwd(), 'assets', 'imgs', 'dotjarlogo.png'),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        cachedDotJarIcon = await loadImage(p).catch(() => null);
        if (cachedDotJarIcon) break;
      }
    }
  }
  if (!cachedPremiumIcon) {
    const candidatePaths = [
      join(assetsDir, 'imgs', 'spigot-premium.png'),
      join(assetsDir, 'spigot-premium.png'),
      join(assetsDir, '..', 'src', 'assets', 'spigot-premium.png'),
      join(process.cwd(), 'src', 'assets', 'spigot-premium.png'),
    ];
    for (const p of candidatePaths) {
      if (existsSync(p)) {
        cachedPremiumIcon = await loadImage(p).catch(() => null);
        if (cachedPremiumIcon) break;
      }
    }
  }
  return {
    jar: cachedDotJarIcon,
    dotjar: cachedDotJarIcon,
    premium: cachedPremiumIcon,
  };
}

function cleanText(str: string): string {
  return str
    .replace(/[「【]/g, '[')
    .replace(/[」】]/g, ']')
    .replace(/[★☆✨🏷️📦✅💡•\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    .trim();
}

function roundRect(
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function truncateText(ctx: any, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let str = text;
  while (str.length > 0 && ctx.measureText(str + '...').width > maxWidth) {
    str = str.slice(0, -1);
  }
  return str + '...';
}

/**
 * Render Plugin Hero Banner Canvas tỉ lệ 3:1 (960x320px)
 * Tuân thủ tiêu chuẩn /banner-design và /ui-ux-pro-max
 */
export async function renderPluginBannerCanvas(
  db: Db,
  plugin: Plugin,
  options: {
    assetsDir: string;
  },
): Promise<Buffer> {
  const width = 960;
  const height = 320;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const assets = await getAssets(options.assetsDir);
  const versions = listVersionsByPlugin(db, plugin.id);
  const latestVersion = versions[0];
  const isPremium = plugin.isPremium || plugin.depositPrice > 0;

  // 1. NỀN GRADIENT & CYBER MESH
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#070B14');
  bgGrad.addColorStop(0.5, '#0E1726');
  bgGrad.addColorStop(1, '#050811');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Subtle grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Radial Spotlight phát sáng chủ đề (Vàng gold cho Premium, Xanh cyan cho Free)
  const themeGlow = ctx.createRadialGradient(200, 160, 20, 200, 160, 400);
  if (isPremium) {
    themeGlow.addColorStop(0, 'rgba(245, 158, 11, 0.22)');
    themeGlow.addColorStop(0.6, 'rgba(217, 119, 6, 0.08)');
  } else {
    themeGlow.addColorStop(0, 'rgba(6, 182, 212, 0.22)');
    themeGlow.addColorStop(0.6, 'rgba(59, 130, 246, 0.08)');
  }
  themeGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = themeGlow;
  ctx.fillRect(0, 0, width, height);

  // 2. KHUNG NÂNG ĐỠ ICON PEDESTAL (BÊN TRÁI)
  const pedestalX = 40;
  const pedestalY = 40;
  const pedestalSize = 240;

  // Vòng hào quang đa lớp
  const haloGlow = ctx.createRadialGradient(
    pedestalX + pedestalSize / 2,
    pedestalY + pedestalSize / 2,
    20,
    pedestalX + pedestalSize / 2,
    pedestalY + pedestalSize / 2,
    130,
  );
  haloGlow.addColorStop(0, isPremium ? 'rgba(245, 158, 11, 0.35)' : 'rgba(56, 189, 248, 0.35)');
  haloGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = haloGlow;
  ctx.fillRect(pedestalX - 20, pedestalY - 20, pedestalSize + 40, pedestalSize + 40);

  // Khung kính bệ nổi
  roundRect(ctx, pedestalX, pedestalY, pedestalSize, pedestalSize, 20);
  const pedBg = ctx.createLinearGradient(pedestalX, pedestalY, pedestalX, pedestalY + pedestalSize);
  pedBg.addColorStop(0, 'rgba(30, 41, 59, 0.7)');
  pedBg.addColorStop(1, 'rgba(15, 23, 42, 0.85)');
  ctx.fillStyle = pedBg;
  ctx.fill();

  // Viền bệ
  roundRect(ctx, pedestalX, pedestalY, pedestalSize, pedestalSize, 20);
  ctx.strokeStyle = isPremium ? 'rgba(245, 158, 11, 0.5)' : 'rgba(56, 189, 248, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Vẽ Icon JAR chính giữa bệ
  const jarImg = isPremium ? (assets.premium ?? assets.dotjar ?? assets.jar) : (assets.dotjar ?? assets.jar ?? assets.premium);
  const jarDrawSize = 130;
  const jarX = pedestalX + (pedestalSize - jarDrawSize) / 2;
  const jarY = pedestalY + (pedestalSize - jarDrawSize) / 2 - 12;

  if (jarImg) {
    ctx.drawImage(jarImg, jarX, jarY, jarDrawSize, jarDrawSize);
  } else {
    await drawLucideIcon(ctx, 'Package', jarX + 15, jarY + 15, 100, {
      color: isPremium ? '#F59E0B' : '#38BDF8',
      strokeWidth: 2,
    });
  }

  // Chân bệ đế 3D nhỏ dưới icon
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.beginPath();
  ctx.ellipse(pedestalX + pedestalSize / 2, jarY + jarDrawSize + 8, 55, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // Nhãn JAR phía dưới chân bệ
  roundRect(ctx, pedestalX + 30, pedestalY + pedestalSize - 42, pedestalSize - 60, 26, 6);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fill();
  ctx.strokeStyle = isPremium ? 'rgba(245, 158, 11, 0.4)' : 'rgba(56, 189, 248, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = isPremium ? '#FBBF24' : '#38BDF8';
  ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    plugin.platform.toUpperCase() + ' • JAVA ARTIFACT',
    pedestalX + pedestalSize / 2,
    pedestalY + pedestalSize - 25,
  );
  ctx.textAlign = 'left';

  // 3. THÔNG TIN PLUGIN (BÊN PHẢI)
  const infoX = 310;
  const infoY = 38;
  const infoW = width - infoX - 40;

  // Badge bản quyền góc trên
  const badgeW = isPremium ? 110 : 80;
  const badgeH = 26;
  roundRect(ctx, infoX, infoY, badgeW, badgeH, 6);
  ctx.fillStyle = isPremium ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.2)';
  ctx.fill();
  ctx.strokeStyle = isPremium ? '#F59E0B' : '#10B981';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (isPremium) {
    await drawLucideIcon(ctx, 'Crown', infoX + 8, infoY + 5, 16, {
      color: '#FBBF24',
      strokeWidth: 2,
      fill: 'rgba(245, 158, 11, 0.2)',
    });
    ctx.fillStyle = '#FBBF24';
    ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
    ctx.fillText('PREMIUM', infoX + 32, infoY + 18);
  } else {
    await drawLucideIcon(ctx, 'ShieldCheck', infoX + 8, infoY + 5, 16, {
      color: '#34D399',
      strokeWidth: 2,
    });
    ctx.fillStyle = '#34D399';
    ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
    ctx.fillText('FREE', infoX + 30, infoY + 18);
  }

  // Tên Plugin
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 26px "Segoe UI", Arial, sans-serif';
  const cleanTitle = truncateText(ctx, cleanText(plugin.displayName), infoW);
  ctx.fillText(cleanTitle, infoX, infoY + 58);

  // Slug & Resource ID
  ctx.fillStyle = '#94A3B8';
  ctx.font = '500 13px "Segoe UI", Arial, sans-serif';
  const subText = plugin.descriptorName
    ? `Slug: ${plugin.slug}  |  ID: #${plugin.resourceId || plugin.id}  |  Main: ${cleanText(plugin.descriptorName)}`
    : `Slug: ${plugin.slug}  |  Resource: #${plugin.resourceId || plugin.id}`;
  ctx.fillText(truncateText(ctx, subText, infoW), infoX, infoY + 80);

  // 4. BENTO GRID 4 THẺ THÔNG SỐ (2 CỘT x 2 HÀNG)
  const bentoY = infoY + 98;
  const bentoGap = 16;
  const cardW = (infoW - bentoGap) / 2;
  const cardH = 66;

  // Helper vẽ thẻ bento
  async function drawBentoCard(
    bx: number,
    by: number,
    icon: any,
    iconColor: string,
    label: string,
    val: string,
  ) {
    roundRect(ctx, bx, by, cardW, cardH, 12);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Lucide Icon
    await drawLucideIcon(ctx, icon, bx + 16, by + 19, 26, {
      color: iconColor,
      strokeWidth: 2,
    });

    ctx.fillStyle = '#94A3B8';
    ctx.font = '600 11px "Segoe UI", Arial, sans-serif';
    ctx.fillText(label.toUpperCase(), bx + 52, by + 26);

    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 15px "Segoe UI", Arial, sans-serif';
    ctx.fillText(truncateText(ctx, val, cardW - 58), bx + 52, by + 50);
  }

  // Bento 1: Phiên bản
  const vStr = latestVersion?.version ? `v${latestVersion.version} (Mới nhất)` : 'Chưa có file';
  await drawBentoCard(infoX, bentoY, 'Tag', '#A855F7', 'Phiên bản mới nhất', vStr);

  // Bento 2: Dung lượng
  const sizeStr = latestVersion?.bytes ? formatBytes(latestVersion.bytes) : 'Chưa cập nhật';
  await drawBentoCard(infoX + cardW + bentoGap, bentoY, 'HardDrive', '#38BDF8', 'Dung lượng file', sizeStr);

  // Bento 3: Giá cọc / Giá bán
  const priceStr = plugin.depositPrice > 0 ? formatVnd(plugin.depositPrice) : 'Miễn phí tải về';
  await drawBentoCard(infoX, bentoY + cardH + 14, 'Coins', isPremium ? '#F59E0B' : '#10B981', 'Giá niêm yết', priceStr);

  // Bento 4: Số bản lưu trữ
  const countStr = `${versions.length} phiên bản trong Vault`;
  await drawBentoCard(infoX + cardW + bentoGap, bentoY + cardH + 14, 'Layers', '#06B6D4', 'Bản lưu trữ', countStr);

  return canvas.toBuffer('image/png');
}
