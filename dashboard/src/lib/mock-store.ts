/**
 * Mock Store Data Engine for EZStore Web Preview.
 * Contains high-fidelity mock datasets and state management for client storefront,
 * cart, checkout, services, user vault, and admin management.
 */

export interface PluginItem {
  id: string;
  name: string;
  tagline: string;
  description: string;
  category: 'protection' | 'economy' | 'rpg' | 'custom-items' | 'gui-menus' | 'optimization' | 'chat' | 'utility';
  categoryLabel: string;
  versions: string[];
  nativeVersion: string;
  priceVnd: number;
  originalPriceVnd?: number;
  rating: number;
  reviewCount: number;
  downloads: number;
  author: string;
  icon: string;
  bannerGradient: string;
  badge?: 'HOT' | 'SALE' | 'NEW' | 'PRO';
  spigotId?: number;
  fileSize: string;
  dependencies: string[];
  changelog: { version: string; date: string; notes: string[] }[];
  screenshots: string[];
}

export interface ServicePackage {
  id: string;
  title: string;
  subtitle: string;
  category: 'setup' | 'optimization' | 'development' | 'security';
  priceVnd: number;
  deliveryTime: string;
  badge?: string;
  features: string[];
  description: string;
  popular?: boolean;
}

export interface PromoCode {
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: number; // e.g. 20 for 20% or 50000 for 50k VND
  minOrderVnd: number;
  maxDiscountVnd?: number;
  usageLimit: number;
  usedCount: number;
  expiryDate: string;
  status: 'active' | 'expired' | 'disabled';
}

export interface CartItem {
  plugin: PluginItem;
  quantity: number;
}

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  email: string;
  avatar: string;
  discordId: string;
  discordTag: string;
  discordLinked: boolean;
  vipRank: 'Member' | 'Bronze' | 'Silver' | 'Gold' | 'Diamond';
  walletBalanceVnd: number;
  totalSpentVnd: number;
  purchasedPluginIds: string[];
  licenseKeys: Record<string, string>;
}

export interface RoleDefinition {
  id: string;
  name: string;
  color: string;
  description: string;
  userCount: number;
  permissions: {
    canManagePlugins: boolean;
    canApproveOrders: boolean;
    canManageDiscounts: boolean;
    canManageRoles: boolean;
    canViewAnalytics: boolean;
    canFreeDownload: boolean;
    canManageSpigotAccounts: boolean;
  };
}

export const MOCK_PLUGINS: PluginItem[] = [
  {
    id: 'itemsadder',
    name: 'ItemsAdder',
    tagline: 'Tùy biến 1000+ vật phẩm, giáp 3D, emoji, GUI đồ họa đỉnh cao không cần mod',
    description: 'ItemsAdder là plugin cách mạng hóa Minecraft Server! Thêm vô số vật phẩm tùy chỉnh, cánh 3D, mũ, khoáng sản, nội thất, cây cối, âm thanh và giao diện HUD độc quyền thông qua Resource Pack tự động.',
    category: 'custom-items',
    categoryLabel: 'Custom Items & 3D',
    versions: ['1.16', '1.17', '1.18', '1.19', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 450000,
    originalPriceVnd: 550000,
    rating: 4.9,
    reviewCount: 412,
    downloads: 14200,
    author: 'LoneDev',
    icon: '📦',
    bannerGradient: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)',
    badge: 'HOT',
    spigotId: 73355,
    fileSize: '18.4 MB',
    dependencies: ['ProtocolLib', 'Vault (Khuyên dùng)', 'PlaceholderAPI'],
    changelog: [
      { version: '3.6.4-beta', date: '2026-02-15', notes: ['Hỗ trợ đầy đủ Minecraft 1.21.4', 'Tối ưu hóa tốc độ tải Resource Pack', 'Sửa lỗi va chạm mô hình 3D khối vuông'] },
      { version: '3.6.3', date: '2026-01-20', notes: ['Thêm hiệu ứng hoạt ảnh vũ khí', 'Tương thích BetterRTP và MythicMobs 5.6'] }
    ],
    screenshots: ['itemsadder-preview-1.jpg', 'itemsadder-preview-2.jpg']
  },
  {
    id: 'mythicmobs',
    name: 'MythicMobs Premium',
    tagline: 'Hệ thống quái vật Custom, Boss World, Skill AI ma thuật phức tạp',
    description: 'Tạo quái vật, Boss thế giới với kỹ năng ma thuật, đòn combo, thanh máu đặc biệt, và bảng rơi đồ RPG cực khủng.',
    category: 'rpg',
    categoryLabel: 'RPG & Monster AI',
    versions: ['1.16', '1.17', '1.18', '1.19', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 380000,
    originalPriceVnd: 450000,
    rating: 4.95,
    reviewCount: 380,
    downloads: 18500,
    author: 'Xikage',
    icon: '🐉',
    bannerGradient: 'linear-gradient(135deg, #8b5cf6 0%, #ec4899 100%)',
    badge: 'PRO',
    spigotId: 5702,
    fileSize: '12.8 MB',
    dependencies: ['MythicLib', 'ProtocolLib', 'PlaceholderAPI'],
    changelog: [
      { version: '5.7.0', date: '2026-02-10', notes: ['Hỗ trợ Entity AI 1.21+', 'Cơ chế Target Selector nâng cao', 'Hiệu ứng hạt Particle theo Raycast'] }
    ],
    screenshots: ['mythicmobs-1.jpg']
  },
  {
    id: 'spartan-anticheat',
    name: 'Spartan AntiCheat Advanced',
    tagline: 'Phát hiện Killaura, Fly, Speed, Baritone bằng AI học máy thời gian thực',
    description: 'Hệ thống chống hack toàn diện hàng đầu thế giới với engine phát hiện sai lệch gói tin, chặn đứng hack client hiện đại không gây lag server.',
    category: 'protection',
    categoryLabel: 'Bảo mật & AntiCheat',
    versions: ['1.12', '1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 420000,
    originalPriceVnd: 500000,
    rating: 4.85,
    reviewCount: 290,
    downloads: 9800,
    author: 'Vagdedes',
    icon: '🛡️',
    bannerGradient: 'linear-gradient(135deg, #ef4444 0%, #f59e0b 100%)',
    badge: 'HOT',
    spigotId: 25638,
    fileSize: '9.2 MB',
    dependencies: ['ProtocolLib'],
    changelog: [
      { version: 'Phase 532', date: '2026-02-22', notes: ['Cập nhật cơ chế chặn Grim/Meteor Client 1.21', 'Giảm tải CPU 35%'] }
    ],
    screenshots: ['spartan-1.jpg']
  },
  {
    id: 'deluxemenus',
    name: 'DeluxeMenus Ultra',
    tagline: 'Tạo GUI Menu tùy biến vô hạn, liên kết Shop, Warp, Nhiệm vụ',
    description: 'Plugin tạo bảng menu GUI đa năng nhất Minecraft. Hỗ trợ điều kiện phức tạp, PlaceholderAPI, hoạt ảnh icon và âm thanh sống động.',
    category: 'gui-menus',
    categoryLabel: 'GUI & Menus',
    versions: ['1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 120000,
    rating: 4.9,
    reviewCount: 512,
    downloads: 32000,
    author: 'clip',
    icon: '📋',
    bannerGradient: 'linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)',
    badge: 'HOT',
    spigotId: 11734,
    fileSize: '4.1 MB',
    dependencies: ['PlaceholderAPI', 'Vault'],
    changelog: [
      { version: '1.14.0', date: '2026-01-14', notes: ['Hỗ trợ HeadDatabase textures 1.21', 'Thêm click requirement regex'] }
    ],
    screenshots: ['deluxemenus-1.jpg']
  },
  {
    id: 'citizens2',
    name: 'Citizens 2 Premium',
    tagline: 'Tạo NPC thông minh, giao tiếp, bán đồ, dẫn đường theo kịch bản',
    description: 'Hệ thống NPC chân thực nhất. Hỗ trợ gán skin người chơi, di chuyển theo lộ trình, tương tác kịch bản thoại và liên kết Sentinel chiến đấu.',
    category: 'utility',
    categoryLabel: 'NPC & Utilities',
    versions: ['1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 250000,
    rating: 4.88,
    reviewCount: 340,
    downloads: 24000,
    author: 'fullwall',
    icon: '🧑‍🤝‍🧑',
    bannerGradient: 'linear-gradient(135deg, #10b981 0%, #6366f1 100%)',
    badge: 'NEW',
    spigotId: 13811,
    fileSize: '7.5 MB',
    dependencies: ['ProtocolLib'],
    changelog: [
      { version: '2.0.35', date: '2026-02-05', notes: ['Tương thích Paper 1.21.4', 'Sửa lỗi AI pathfinder vượt chướng ngại'] }
    ],
    screenshots: ['citizens-1.jpg']
  },
  {
    id: 'vault-economy',
    name: 'Vault Pro & Eco Core',
    tagline: 'Cầu nối API tiền tệ, quyền hạn và hệ thống kinh tế máy chủ',
    description: 'Chuẩn giao thức kết nối kinh tế và phân quyền kinh điển không thể thiếu cho bất kỳ máy chủ nào. Tối ưu bộ nhớ đệm cực nhanh.',
    category: 'economy',
    categoryLabel: 'Kinh Tế & Economy',
    versions: ['1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 90000,
    rating: 4.98,
    reviewCount: 920,
    downloads: 85000,
    author: 'MilkBowl',
    icon: '💰',
    bannerGradient: 'linear-gradient(135deg, #f59e0b 0%, #10b981 100%)',
    badge: 'HOT',
    spigotId: 34315,
    fileSize: '1.2 MB',
    dependencies: ['LuckPerms'],
    changelog: [
      { version: '1.7.4', date: '2025-12-30', notes: ['Tối ưu cache transaction đa luồng', 'Async Vault events'] }
    ],
    screenshots: ['vault-1.jpg']
  },
  {
    id: 'chunky-pregen',
    name: 'Chunky World Pregenerator Pro',
    tagline: 'Tải trước bản đồ thế giới siêu tốc, loại bỏ 100% lag khi người chơi khám phá',
    description: 'Tối ưu hóa máy chủ bằng cách kết xuất trước toàn bộ chunk bản đồ. Giúp CPU không bị quá tải khi người chơi di chuyển ra vùng xa.',
    category: 'optimization',
    categoryLabel: 'Tối ưu hóa Server',
    versions: ['1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 150000,
    rating: 4.96,
    reviewCount: 215,
    downloads: 15400,
    author: 'pop4959',
    icon: '⚡',
    bannerGradient: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    badge: 'PRO',
    spigotId: 81534,
    fileSize: '2.8 MB',
    dependencies: [],
    changelog: [
      { version: '1.4.15', date: '2026-02-18', notes: ['Tăng tốc độ sinh thế giới lên 40% trên Paper/Folia', 'Tự động dừng khi đĩa cứng dưới 5GB'] }
    ],
    screenshots: ['chunky-1.jpg']
  },
  {
    id: 'tab-modern',
    name: 'TAB Reborn Master',
    tagline: 'Tablist đẹp mắt, Nametag 3D trên đầu, BossBar, Scoreboard mượt mà',
    description: 'Plugin trang trí Tablist và Scoreboard được đánh giá cao nhất. Không giật lag, hiển thị prefix rank, ping, máu, xu mượt mà không nhấp nháy.',
    category: 'chat',
    categoryLabel: 'Giao Diện & Chat',
    versions: ['1.16', '1.18', '1.20', '1.21+'],
    nativeVersion: '1.21.4',
    priceVnd: 220000,
    rating: 4.94,
    reviewCount: 460,
    downloads: 38000,
    author: 'NEZNAMY',
    icon: '🏷️',
    bannerGradient: 'linear-gradient(135deg, #ec4899 0%, #8b5cf6 100%)',
    badge: 'HOT',
    spigotId: 57806,
    fileSize: '5.1 MB',
    dependencies: ['PlaceholderAPI', 'LuckPerms'],
    changelog: [
      { version: '5.0.2', date: '2026-01-28', notes: ['Hỗ trợ Folia đa luồng', 'Gradient màu RGB thế hệ mới'] }
    ],
    screenshots: ['tab-1.jpg']
  }
];

export const MOCK_SERVICES: ServicePackage[] = [
  {
    id: 'srv-server-setup',
    title: 'Cài Đặt Server Trọn Gói (Full Setup)',
    subtitle: 'Xây dựng máy chủ Minecraft từ A-Z theo phong cách bạn muốn',
    category: 'setup',
    priceVnd: 1500000,
    deliveryTime: '2 - 3 Ngày',
    badge: 'BÁN CHẠY NHẤT',
    popular: true,
    description: 'Đội ngũ kỹ thuật viên kinh nghiệm sẽ setup hoàn chỉnh toàn bộ máy chủ: Cấu hình phân quyền, Shop GUI, Hệ thống Nạp thẻ, Anti-Cheat, Spawn Map và tích hợp Bot Discord.',
    features: [
      'Cấu hình hoàn chỉnh 40+ Plugin đồng bộ 100%',
      'Tích hợp Bot Discord tự động thông báo & đồng bộ Rank',
      'Cổng nạp tiền tự động VietQR / MoMo / Thẻ cào',
      'Tối ưu hóa cấu hình Paper/Purpur TPS 20.0',
      'Bảo hành & Hỗ trợ kỹ thuật 30 ngày'
    ]
  },
  {
    id: 'srv-tps-optimization',
    title: 'Tối Ưu Hóa TPS & Khử Lag Chuyên Sâu',
    subtitle: 'Giải quyết triệt để tình trạng giật lag, drop TPS khi đông người chơi',
    category: 'optimization',
    priceVnd: 600000,
    deliveryTime: 'Trong 24 Giờ',
    badge: 'HIỆU QUẢ CAO',
    description: 'Phân tích Spark Profiler và Timings chuyên sâu. Tinh chỉnh cấu hình JVM flags, nén chunk, giảm tải tick entity, tối ưu bộ nhớ đệm RAM.',
    features: [
      'Phân tích biểu đồ Spark / Timings tìm gốc rễ lag',
      'Tối ưu hóa thông số server.properties, paper.yml, purpur.yml',
      'Cấu hình Aikar JVM Flags cho bộ thu gom rác ZGC/G1GC',
      'Cam kết tăng ít nhất 30-50% hiệu năng TPS'
    ]
  },
  {
    id: 'srv-custom-plugin-dev',
    title: 'Lập Trình Plugin Java Độc Quyền',
    subtitle: 'Hiện thực hóa mọi ý tưởng tính năng riêng biệt cho máy chủ của bạn',
    category: 'development',
    priceVnd: 2000000,
    deliveryTime: '3 - 7 Ngày',
    badge: 'CAO CẤP',
    description: 'Viết mã nguồn Java Spigot/Paper theo đúng thiết kế và yêu cầu kỹ thuật của bạn. Code sạch, tối ưu đa luồng, bàn giao kèm Source Code và tài liệu HDSD.',
    features: [
      'Lập trình theo đúng kịch bản game design yêu cầu',
      'Tương thích cơ sở dữ liệu MySQL / SQLite / Redis',
      'Bàn giao đầy đủ Source Code (GitHub Repo)',
      'Hỗ trợ sửa lỗi và cập nhật phiên bản 3 tháng'
    ]
  },
  {
    id: 'srv-ddos-protection',
    title: 'Bảo Vệ Toàn Diện & Chống DDoS / Bot Flood',
    subtitle: 'Lá chắn vững chắc trước mọi cuộc tấn công mạng phá hoại máy chủ',
    category: 'security',
    priceVnd: 850000,
    deliveryTime: 'Trong 12 Giờ',
    badge: 'AN TOÀN',
    description: 'Triển khai tường lửa FlameCord / TCPShield / BungeeGuard và cấu hình IP whitelist an toàn, ngăn chặn bot tấn công cổng game.',
    features: [
      'Chặn đứng 99.9% các cuộc tấn công Bot Flood & Null Ping',
      'Cấu hình Proxy TCPShield & BungeeGuard bảo mật backend',
      'Giám sát tấn công và cảnh báo trực tiếp về Discord',
      'Hỗ trợ setup tường lửa Linux UFW / Iptables'
    ]
  }
];

export const MOCK_PROMO_CODES: PromoCode[] = [
  {
    code: 'EZSTORE2026',
    discountType: 'percent',
    discountValue: 20,
    minOrderVnd: 200000,
    maxDiscountVnd: 100000,
    usageLimit: 500,
    usedCount: 142,
    expiryDate: '2026-12-31',
    status: 'active'
  },
  {
    code: 'VIP50K',
    discountType: 'fixed',
    discountValue: 50000,
    minOrderVnd: 300000,
    usageLimit: 200,
    usedCount: 88,
    expiryDate: '2026-06-30',
    status: 'active'
  },
  {
    code: 'MINECRAFT10',
    discountType: 'percent',
    discountValue: 10,
    minOrderVnd: 100000,
    usageLimit: 1000,
    usedCount: 310,
    expiryDate: '2026-12-31',
    status: 'active'
  }
];

export const INITIAL_USER: UserProfile = {
  id: 'usr_ez_8849',
  username: 'AlexMiner',
  displayName: 'Alex Henderson',
  email: 'alex.minecraft@gmail.com',
  avatar: 'https://images.unsplash.com/photo-1566492031773-4f4e44671857?w=150&auto=format&fit=crop&q=80',
  discordId: '492817290184719280',
  discordTag: 'alex_miner#1337',
  discordLinked: true,
  vipRank: 'Gold',
  walletBalanceVnd: 350000,
  totalSpentVnd: 1850000,
  purchasedPluginIds: ['itemsadder', 'deluxemenus'],
  licenseKeys: {
    itemsadder: 'EZ-IA-9948-2841-BETA',
    deluxemenus: 'EZ-DM-1182-9472-PRO'
  }
};

export const MOCK_ROLES: RoleDefinition[] = [
  {
    id: 'super-admin',
    name: 'Super Admin',
    color: '#ef4444',
    description: 'Toàn quyền tối cao quản trị toàn bộ hệ sinh thái EZStore',
    userCount: 2,
    permissions: {
      canManagePlugins: true,
      canApproveOrders: true,
      canManageDiscounts: true,
      canManageRoles: true,
      canViewAnalytics: true,
      canFreeDownload: true,
      canManageSpigotAccounts: true
    }
  },
  {
    id: 'manager',
    name: 'Store Manager',
    color: '#f59e0b',
    description: 'Quản lý kho plugin, duyệt đơn hàng và phát hành mã giảm giá',
    userCount: 4,
    permissions: {
      canManagePlugins: true,
      canApproveOrders: true,
      canManageDiscounts: true,
      canManageRoles: false,
      canViewAnalytics: true,
      canFreeDownload: true,
      canManageSpigotAccounts: true
    }
  },
  {
    id: 'vip-gold',
    name: 'VIP Gold Member',
    color: '#10b981',
    description: 'Khách hàng VIP vàng hưởng chiết khấu 15% và tải trước bản beta',
    userCount: 48,
    permissions: {
      canManagePlugins: false,
      canApproveOrders: false,
      canManageDiscounts: false,
      canManageRoles: false,
      canViewAnalytics: false,
      canFreeDownload: false,
      canManageSpigotAccounts: false
    }
  },
  {
    id: 'customer',
    name: 'Customer',
    color: '#64748b',
    description: 'Thành viên thông thường có quyền mua sắm và quản lý tủ đồ cá nhân',
    userCount: 1250,
    permissions: {
      canManagePlugins: false,
      canApproveOrders: false,
      canManageDiscounts: false,
      canManageRoles: false,
      canViewAnalytics: false,
      canFreeDownload: false,
      canManageSpigotAccounts: false
    }
  }
];

export function formatVnd(amount: number): string {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}
