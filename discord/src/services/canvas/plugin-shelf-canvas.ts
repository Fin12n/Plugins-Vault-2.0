import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from '../../domain/plugin.js';
import type { Db } from '../../db/connection.js';
import { listVersionsByPlugin } from '../../repositories/versions.js';
import { formatBytes, formatVnd } from '../../bot/i18n/bot-vi.js';
import { drawLucideIcon } from './lucide-canvas.js';

export type ShelfPluginCard = {
  plugin: Plugin;
  latestVersion?: string;
  fileBytes?: number;
  versionCount: number;
};

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
      join(assetsDir, 'imgs', 'spigot_premium.png'),
      join(assetsDir, 'imgs', 'spigot-premium.png'),
      join(assetsDir, 'spigot_premium.png'),
      join(assetsDir, 'spigot-premium.png'),
      join(assetsDir, '..', 'src', 'assets', 'spigot_premium.png'),
      join(assetsDir, '..', 'src', 'assets', 'spigot-premium.png'),
      join(process.cwd(), 'src', 'assets', 'spigot_premium.png'),
      join(process.cwd(), 'src', 'assets', 'spigot-premium.png'),
      join(process.cwd(), 'assets', 'imgs', 'spigot_premium.png'),
      join(process.cwd(), 'assets', 'imgs', 'spigot-premium.png'),
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
 * Render Kệ Hàng Plugins Vault (Shelves 3D Canvas)
 * Tuân thủ chuẩn /canvas-design, /banner-design và /ui-ux-pro-max
 * Sử dụng 100% Vector Lucide Icons
 */
export async function renderPluginShelfCanvas(
  db: Db,
  plugins: Plugin[],
  options: {
    page: number;
    totalPages: number;
    totalPlugins: number;
    assetsDir: string;
  },
): Promise<Buffer> {
  const width = 1200;
  const height = 780;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const assets = await getAssets(options.assetsDir);

  // 1. NỀN GRADIENT SÂU & TECH MESH
  const bgGrad = ctx.createLinearGradient(0, 0, width, height);
  bgGrad.addColorStop(0, '#070B14');
  bgGrad.addColorStop(0.45, '#0E1726');
  bgGrad.addColorStop(1, '#050811');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Grid pattern mờ ảo phía sau
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Spotlight ánh sáng phía trên (Ambient Radial Glow)
  const topSpotlight = ctx.createRadialGradient(width * 0.5, 0, 20, width * 0.5, 0, 700);
  topSpotlight.addColorStop(0, 'rgba(14, 165, 233, 0.16)');
  topSpotlight.addColorStop(0.5, 'rgba(99, 102, 241, 0.08)');
  topSpotlight.addColorStop(1, 'transparent');
  ctx.fillStyle = topSpotlight;
  ctx.fillRect(0, 0, width, 360);

  // Spotlight ánh sáng vàng ấm cho kệ hàng dưới
  const bottomSpotlight = ctx.createRadialGradient(width * 0.5, 520, 40, width * 0.5, 520, 600);
  bottomSpotlight.addColorStop(0, 'rgba(245, 158, 11, 0.09)');
  bottomSpotlight.addColorStop(1, 'transparent');
  ctx.fillStyle = bottomSpotlight;
  ctx.fillRect(0, 300, width, 480);

  // 2. HEADER BANNER CHUYÊN NGHIỆP
  // Khung huy hiệu logo (Emblem)
  const emblemX = 45;
  const emblemY = 24;
  const emblemSize = 72;

  // Hào quang sau logo
  const logoGlow = ctx.createRadialGradient(
    emblemX + emblemSize / 2,
    emblemY + emblemSize / 2,
    10,
    emblemX + emblemSize / 2,
    emblemY + emblemSize / 2,
    emblemSize,
  );
  logoGlow.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
  logoGlow.addColorStop(1, 'transparent');
  ctx.fillStyle = logoGlow;
  ctx.fillRect(emblemX - 15, emblemY - 15, emblemSize + 30, emblemSize + 30);

  roundRect(ctx, emblemX, emblemY, emblemSize, emblemSize, 16);
  const emblemBg = ctx.createLinearGradient(emblemX, emblemY, emblemX + emblemSize, emblemY + emblemSize);
  emblemBg.addColorStop(0, '#1E293B');
  emblemBg.addColorStop(1, '#0F172A');
  ctx.fillStyle = emblemBg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Vẽ icon logo bên trong chỗ PLUGINS VAULT (Ưu tiên spigot_premium.png)
  const mainIcon = assets.premium ?? assets.dotjar ?? assets.jar;
  if (mainIcon) {
    ctx.drawImage(mainIcon, emblemX + 10, emblemY + 10, emblemSize - 20, emblemSize - 20);
  } else {
    await drawLucideIcon(ctx, 'Package', emblemX + 16, emblemY + 16, emblemSize - 32, {
      color: '#F59E0B',
      strokeWidth: 2.2,
    });
  }

  // Tiêu đề Vault
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px "Segoe UI", Arial, sans-serif';
  ctx.fillText('PLUGINS VAULT', 134, 55);

  // Thanh gạch kim loại nhỏ cạnh title
  const titleAccent = ctx.createLinearGradient(350, 48, 430, 48);
  titleAccent.addColorStop(0, '#F59E0B');
  titleAccent.addColorStop(1, 'transparent');
  ctx.fillStyle = titleAccent;
  roundRect(ctx, 350, 42, 60, 4, 2);
  ctx.fill();

  // Subtitle kèm chip thống kê
  ctx.fillStyle = '#94A3B8';
  ctx.font = '600 13px "Segoe UI", Arial, sans-serif';
  ctx.fillText('KHO TÀI NGUYÊN BẢN QUYỀN TỰ ĐỘNG CẬP NHẬT', 134, 82);

  // Status Chip 1: Tổng số plugin (Lucide Layers)
  const chip1X = 490;
  const chip1Y = 38;
  roundRect(ctx, chip1X, chip1Y, 145, 34, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  await drawLucideIcon(ctx, 'Layers', chip1X + 10, chip1Y + 8, 18, {
    color: '#38BDF8',
    strokeWidth: 2,
  });
  ctx.fillStyle = '#E2E8F0';
  ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
  ctx.fillText(`${options.totalPlugins} PLUGINS`, chip1X + 36, chip1Y + 22);

  // Status Chip 2: Bảo mật & Xác thực (Lucide ShieldCheck)
  const chip2X = chip1X + 155;
  const chip2Y = 38;
  roundRect(ctx, chip2X, chip2Y, 150, 34, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  await drawLucideIcon(ctx, 'ShieldCheck', chip2X + 10, chip2Y + 8, 18, {
    color: '#22C55E',
    strokeWidth: 2,
  });
  ctx.fillStyle = '#E2E8F0';
  ctx.font = 'bold 13px "Segoe UI", Arial, sans-serif';
  ctx.fillText('AUTHENTICATED', chip2X + 36, chip2Y + 22);

  // Pagination Badge góc phải (Lucide ChevronLeft, ChevronRight)
  const pageBadgeX = width - 210;
  const pageBadgeY = 36;
  const pageBadgeW = 165;
  const pageBadgeH = 38;

  roundRect(ctx, pageBadgeX, pageBadgeY, pageBadgeW, pageBadgeH, 10);
  const pageBg = ctx.createLinearGradient(pageBadgeX, pageBadgeY, pageBadgeX + pageBadgeW, pageBadgeY);
  pageBg.addColorStop(0, 'rgba(30, 41, 59, 0.95)');
  pageBg.addColorStop(1, 'rgba(15, 23, 42, 0.95)');
  ctx.fillStyle = pageBg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Lucide Chevron icons
  await drawLucideIcon(ctx, 'ChevronLeft', pageBadgeX + 8, pageBadgeY + 11, 16, {
    color: options.page > 0 ? '#F59E0B' : '#475569',
    strokeWidth: 2.2,
  });
  await drawLucideIcon(ctx, 'ChevronRight', pageBadgeX + pageBadgeW - 24, pageBadgeY + 11, 16, {
    color: options.page + 1 < options.totalPages ? '#F59E0B' : '#475569',
    strokeWidth: 2.2,
  });

  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 14px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    `TRANG ${options.page + 1} / ${Math.max(1, options.totalPages)}`,
    pageBadgeX + pageBadgeW / 2,
    pageBadgeY + 24,
  );
  ctx.textAlign = 'left';

  // Đường phân cách ánh sáng Neon mạ vàng
  const headerLine = ctx.createLinearGradient(45, 110, width - 45, 110);
  headerLine.addColorStop(0, 'rgba(255, 255, 255, 0)');
  headerLine.addColorStop(0.15, 'rgba(245, 158, 11, 0.7)');
  headerLine.addColorStop(0.5, 'rgba(56, 189, 248, 0.8)');
  headerLine.addColorStop(0.85, 'rgba(245, 158, 11, 0.7)');
  headerLine.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.strokeStyle = headerLine;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(45, 110);
  ctx.lineTo(width - 45, 110);
  ctx.stroke();

  // 3. GRID 2 HÀNG KỆ HÀNG (2 Shelves, 3 Slots/Shelf = 6 Slots)
  const cardWidth = 350;
  const cardHeight = 236;
  const startX = 45;
  const gapX = 35;
  const rowY = [132, 420];

  // Helper vẽ thanh kệ hàng 3D dưới mỗi hàng
  function drawShelfBar(shelfY: number) {
    const shelfWidth = 1115;
    const shelfHeight = 18;
    const shelfLeft = startX;

    // Bóng đổ sâu dưới đáy kệ
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 22;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#080C14';
    roundRect(ctx, shelfLeft, shelfY, shelfWidth, shelfHeight, 6);
    ctx.fill();
    ctx.restore();

    // Thân kệ kim loại Titan
    const beamGrad = ctx.createLinearGradient(0, shelfY, 0, shelfY + shelfHeight);
    beamGrad.addColorStop(0, '#334155');
    beamGrad.addColorStop(0.2, '#1E293B');
    beamGrad.addColorStop(0.8, '#0F172A');
    beamGrad.addColorStop(1, '#080C14');
    ctx.fillStyle = beamGrad;
    roundRect(ctx, shelfLeft, shelfY, shelfWidth, shelfHeight, 6);
    ctx.fill();

    // Viền sáng LED trên mặt kệ (Light rim metallic)
    const rimGrad = ctx.createLinearGradient(shelfLeft, shelfY, shelfLeft + shelfWidth, shelfY);
    rimGrad.addColorStop(0, 'rgba(56, 189, 248, 0.2)');
    rimGrad.addColorStop(0.3, 'rgba(245, 158, 11, 0.95)');
    rimGrad.addColorStop(0.7, 'rgba(56, 189, 248, 0.95)');
    rimGrad.addColorStop(1, 'rgba(245, 158, 11, 0.2)');
    ctx.strokeStyle = rimGrad;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(shelfLeft + 4, shelfY + 1);
    ctx.lineTo(shelfLeft + shelfWidth - 4, shelfY + 1);
    ctx.stroke();

    // Chân đế đỡ kệ (4 Brackets)
    const bracketX = [shelfLeft + 45, shelfLeft + 375, shelfLeft + 740, shelfLeft + 1070];
    for (const bx of bracketX) {
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.moveTo(bx - 12, shelfY + shelfHeight);
      ctx.lineTo(bx + 12, shelfY + shelfHeight);
      ctx.lineTo(bx + 3, shelfY + shelfHeight + 14);
      ctx.lineTo(bx - 3, shelfY + shelfHeight + 14);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Lặp qua 6 slot để vẽ
  for (let i = 0; i < 6; i++) {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const cardX = startX + col * (cardWidth + gapX);
    const cardY = rowY[row]!;

    const plugin = plugins[i];

    if (!plugin) {
      // Slot trống trên kệ
      roundRect(ctx, cardX, cardY, cardWidth, cardHeight, 16);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      await drawLucideIcon(ctx, 'Package', cardX + cardWidth / 2 - 18, cardY + cardHeight / 2 - 28, 36, {
        color: 'rgba(100, 116, 139, 0.3)',
        strokeWidth: 1.5,
      });

      ctx.fillStyle = 'rgba(100, 116, 139, 0.45)';
      ctx.font = '600 14px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Ô TRỐNG TRÊN KỆ', cardX + cardWidth / 2, cardY + cardHeight / 2 + 24);
      ctx.textAlign = 'left';
      continue;
    }

    const versions = listVersionsByPlugin(db, plugin.id);
    const latestVersion = versions[0];
    const isPremium = plugin.isPremium || plugin.depositPrice > 0;

    // Card Glow & Shadow
    ctx.save();
    ctx.shadowColor = isPremium ? 'rgba(245, 158, 11, 0.22)' : 'rgba(56, 189, 248, 0.2)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;

    // Thân Card Glassmorphism
    roundRect(ctx, cardX, cardY, cardWidth, cardHeight, 16);
    const cardBg = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardHeight);
    cardBg.addColorStop(0, '#1E293B');
    cardBg.addColorStop(0.65, '#0F172A');
    cardBg.addColorStop(1, '#0B0F19');
    ctx.fillStyle = cardBg;
    ctx.fill();
    ctx.restore();

    // Viền Card mạ ánh kim phản quang
    roundRect(ctx, cardX, cardY, cardWidth, cardHeight, 16);
    const borderGrad = ctx.createLinearGradient(cardX, cardY, cardX + cardWidth, cardY + cardHeight);
    if (isPremium) {
      borderGrad.addColorStop(0, 'rgba(251, 191, 36, 0.7)');
      borderGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.3)');
      borderGrad.addColorStop(1, 'rgba(217, 119, 6, 0.6)');
    } else {
      borderGrad.addColorStop(0, 'rgba(56, 189, 248, 0.7)');
      borderGrad.addColorStop(0.5, 'rgba(99, 102, 241, 0.3)');
      borderGrad.addColorStop(1, 'rgba(16, 185, 129, 0.6)');
    }
    ctx.strokeStyle = borderGrad;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Specular Highlight ở mép trên card
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 20, cardY + 1);
    ctx.lineTo(cardX + cardWidth - 20, cardY + 1);
    ctx.stroke();

    // Pedestal bệ nâng cho JAR Icon (Tạo cảm giác 3D đặt trên kệ)
    const iconSize = 54;
    const iconX = cardX + 18;
    const iconY = cardY + 18;

    // Vòng hào quang phát sáng sau JAR
    const iconGlow = ctx.createRadialGradient(
      iconX + iconSize / 2,
      iconY + iconSize / 2,
      6,
      iconX + iconSize / 2,
      iconY + iconSize / 2,
      iconSize,
    );
    iconGlow.addColorStop(0, isPremium ? 'rgba(245, 158, 11, 0.4)' : 'rgba(56, 189, 248, 0.35)');
    iconGlow.addColorStop(1, 'transparent');
    ctx.fillStyle = iconGlow;
    ctx.fillRect(iconX - 12, iconY - 12, iconSize + 24, iconSize + 24);

    // Bệ pedestal tròn đổ bóng
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 10;
    roundRect(ctx, iconX - 2, iconY - 2, iconSize + 4, iconSize + 4, 12);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.fill();
    ctx.restore();

    const iconImg = isPremium ? (assets.premium ?? assets.dotjar ?? assets.jar) : (assets.dotjar ?? assets.jar ?? assets.premium);
    if (iconImg) {
      ctx.drawImage(iconImg, iconX, iconY, iconSize, iconSize);
    } else {
      await drawLucideIcon(ctx, 'Package', iconX + 6, iconY + 6, iconSize - 12, {
        color: isPremium ? '#F59E0B' : '#38BDF8',
        strokeWidth: 2,
      });
    }

    // Badge trạng thái góc trên phải (Dùng Lucide Crown / ShieldCheck)
    const badgeW = isPremium ? 104 : 76;
    const badgeH = 26;
    const badgeX = cardX + cardWidth - badgeW - 18;
    const badgeY = cardY + 20;

    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, 8);
    ctx.fillStyle = isPremium ? 'rgba(245, 158, 11, 0.18)' : 'rgba(16, 185, 129, 0.18)';
    ctx.fill();
    ctx.strokeStyle = isPremium ? '#F59E0B' : '#10B981';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Lucide Icon trên Badge
    if (isPremium) {
      await drawLucideIcon(ctx, 'Crown', badgeX + 8, badgeY + 5, 16, {
        color: '#FBBF24',
        strokeWidth: 2,
        fill: 'rgba(245, 158, 11, 0.2)',
      });
      ctx.fillStyle = '#FBBF24';
      ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
      ctx.fillText('PREMIUM', badgeX + 30, badgeY + 18);
    } else {
      await drawLucideIcon(ctx, 'ShieldCheck', badgeX + 7, badgeY + 5, 16, {
        color: '#34D399',
        strokeWidth: 2,
      });
      ctx.fillStyle = '#34D399';
      ctx.font = 'bold 12px "Segoe UI", Arial, sans-serif';
      ctx.fillText('FREE', badgeX + 28, badgeY + 18);
    }

    // Tên Plugin
    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 18px "Segoe UI", Arial, sans-serif';
    const cleanTitle = truncateText(ctx, cleanText(plugin.displayName), cardWidth - 36);
    ctx.fillText(cleanTitle, cardX + 18, cardY + 102);

    // ID / Descriptor
    ctx.fillStyle = '#94A3B8';
    ctx.font = '13px "Segoe UI", Arial, sans-serif';
    const subText = plugin.descriptorName
      ? `ID: #${plugin.resourceId || plugin.id} • ${cleanText(plugin.descriptorName)}`
      : `Mã Spigot: #${plugin.resourceId || plugin.id}`;
    ctx.fillText(truncateText(ctx, subText, cardWidth - 36), cardX + 18, cardY + 125);

    // Version & File Size Pill Badge (Dùng Lucide Tag + HardDrive)
    const pillY = cardY + 140;
    const vText = latestVersion?.version ? `v${latestVersion.version} (Mới nhất)` : 'vMới nhất';
    const bytesText = latestVersion?.bytes ? formatBytes(latestVersion.bytes) : null;

    roundRect(ctx, cardX + 18, pillY, cardWidth - 36, 28, 8);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Lucide Tag Icon
    await drawLucideIcon(ctx, 'Tag', cardX + 26, pillY + 6, 16, {
      color: '#A855F7',
      strokeWidth: 2,
    });

    ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
    if (bytesText) {
      ctx.fillStyle = '#94A3B8';
      const bytesW = ctx.measureText(bytesText).width;
      const bytesX = cardX + cardWidth - 28 - bytesW;
      const hardDriveX = bytesX - 22;

      await drawLucideIcon(ctx, 'HardDrive', hardDriveX, pillY + 6, 16, {
        color: '#38BDF8',
        strokeWidth: 2,
      });
      ctx.fillText(bytesText, bytesX, pillY + 19);

      const maxVW = hardDriveX - (cardX + 48) - 8;
      ctx.fillStyle = '#E2E8F0';
      ctx.fillText(truncateText(ctx, vText, maxVW), cardX + 48, pillY + 19);
    } else {
      ctx.fillStyle = '#E2E8F0';
      ctx.fillText(truncateText(ctx, vText, cardWidth - 72), cardX + 48, pillY + 19);
    }

    // Divider mỏng thanh lịch
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cardX + 18, cardY + 184);
    ctx.lineTo(cardX + cardWidth - 18, cardY + 184);
    ctx.stroke();

    // Hàng dưới cùng: Giá cọc (Lucide Coins) & Số bản lưu (Lucide Layers)
    const priceY = cardY + 214;

    // Lucide Coins
    await drawLucideIcon(ctx, 'Coins', cardX + 18, priceY - 16, 20, {
      color: plugin.depositPrice > 0 ? '#F59E0B' : '#10B981',
      strokeWidth: 2,
    });

    const priceText = plugin.depositPrice > 0 ? formatVnd(plugin.depositPrice) : 'Miễn phí';
    ctx.fillStyle = plugin.depositPrice > 0 ? '#FBBF24' : '#34D399';
    ctx.font = 'bold 16px "Segoe UI", Arial, sans-serif';
    ctx.fillText(priceText, cardX + 44, priceY);

    // Bản lưu phía bên phải (Lucide Layers)
    const availText = versions.length > 0 ? `${versions.length} bản lưu` : 'Đang theo dõi';
    const textWidth = ctx.measureText(availText).width;
    const layersIconX = cardX + cardWidth - textWidth - 42;

    await drawLucideIcon(ctx, 'Layers', layersIconX, priceY - 14, 16, {
      color: '#38BDF8',
      strokeWidth: 2,
    });
    ctx.fillStyle = '#60A5FA';
    ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
    ctx.fillText(availText, layersIconX + 22, priceY);
  }

  // Vẽ 2 thanh kệ đỡ 3D cho hàng 1 và hàng 2 (vẽ sau các card để kệ đỡ đặt phía trước mép đáy card)
  drawShelfBar(rowY[0]! + cardHeight - 4);
  drawShelfBar(rowY[1]! + cardHeight - 4);

  // 4. FOOTER STATUS BAR
  const footerY = height - 22;
  const footerText = 'Vault Engine v2.0 • Dùng menu chọn bên dưới để xem chi tiết hoặc bấm nút để chuyển trang';
  ctx.font = '500 13px "Segoe UI", Arial, sans-serif';
  const textW = ctx.measureText(footerText).width;
  const iconSize = 16;
  const gap = 8;
  const totalFooterW = iconSize + gap + textW;
  const footerStartX = (width - totalFooterW) / 2;

  await drawLucideIcon(ctx, 'Sparkles', footerStartX, footerY - 13, iconSize, {
    color: '#F59E0B',
    strokeWidth: 2,
  });

  ctx.fillStyle = '#64748B';
  ctx.textAlign = 'left';
  ctx.fillText(footerText, footerStartX + iconSize + gap, footerY);

  return canvas.toBuffer('image/png');
}
