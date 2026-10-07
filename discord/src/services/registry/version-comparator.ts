import { normalizePluginVersion } from './version-normalizer.js';

/**
 * Phase 5B: Dedicated Version Comparator Abstraction
 *
 * So sánh các chuỗi phiên bản plugin một cách an toàn và tất định,
 * TUYỆT ĐỐI KHÔNG sử dụng so sánh chuỗi nguyên bản (lexical comparison như "1.10.0" < "1.9.0").
 *
 * QUY TẮC BẤT BIẾN:
 * 1. Xử lý chính xác các phiên bản số học phân đoạn (numeric segments).
 * 2. Tự động chuẩn hóa tiền tố v/V trước khi phân tích.
 * 3. Bảo toàn chuỗi raw version gốc, không làm biến đổi dữ liệu.
 * 4. Không giả định mọi phiên bản là SemVer chuẩn.
 * 5. Nếu chuỗi phiên bản không thể diễn giải an toàn (ambiguous/unknown):
 *    -> Phân loại là ambiguous và trả về null, KHÔNG tự ý suy diễn thứ tự.
 */

export type VersionParseResult = {
  raw: string;
  normalized: string;
  isAmbiguous: boolean;
  numericSegments: number[];
  prereleaseTag?: string;
};

const COMMON_PRERELEASE_RANKS: Record<string, number> = {
  alpha: 1,
  preview: 1,
  beta: 2,
  b: 2,
  rc: 3,
  snapshot: 0,
  pre: 1,
};

/**
 * Phân tích cú pháp chuỗi phiên bản để trích xuất các phân đoạn số học.
 */
export function parsePluginVersion(rawVersion: string): VersionParseResult {
  const normalized = normalizePluginVersion(rawVersion);

  if (!normalized) {
    return {
      raw: rawVersion,
      normalized: '',
      isAmbiguous: true,
      numericSegments: [],
    };
  }

  // Regex khớp phân đoạn số dạng 1, 1.2, 1.20.4, 1.20.4.1 kèm theo hậu tố (nếu có)
  const match = normalized.match(/^(\d+(?:\.\d+)*)(?:[-._+ ](.+))?$/);

  if (!match || !match[1]) {
    // Không chứa phân đoạn số mở đầu an toàn -> Phân loại ambiguous
    return {
      raw: rawVersion,
      normalized,
      isAmbiguous: true,
      numericSegments: [],
    };
  }

  const segments = match[1].split('.').map((part) => parseInt(part, 10));
  const prereleaseTag = match[2] ? match[2].trim() : undefined;

  return {
    raw: rawVersion,
    normalized,
    isAmbiguous: false,
    numericSegments: segments,
    prereleaseTag,
  };
}

/**
 * So sánh hai phiên bản plugin:
 * Trả về:
 *   1  nếu a > b
 *  -1  nếu a < b
 *   0  nếu a == b
 *  null nếu không thể xác định an toàn (ambiguous/unknown)
 */
export function comparePluginVersions(a: string, b: string): number | null {
  // 1. Kiểm tra bằng chuỗi sau chuẩn hóa
  const normA = normalizePluginVersion(a);
  const normB = normalizePluginVersion(b);
  if (normA === normB) {
    return 0;
  }

  // 2. Phân tích cú pháp
  const parsedA = parsePluginVersion(a);
  const parsedB = parsePluginVersion(b);

  // 3. Nếu một trong hai phiên bản không thể phân tích an toàn
  if (parsedA.isAmbiguous || parsedB.isAmbiguous) {
    return null;
  }

  // 4. So sánh từng phân đoạn số học
  const maxLength = Math.max(
    parsedA.numericSegments.length,
    parsedB.numericSegments.length,
  );

  for (let i = 0; i < maxLength; i++) {
    const segA = parsedA.numericSegments[i] ?? 0;
    const segB = parsedB.numericSegments[i] ?? 0;

    if (segA > segB) return 1;
    if (segA < segB) return -1;
  }

  // 5. Nếu phân đoạn số bằng nhau, so sánh hậu tố prerelease (nếu có)
  // SemVer convention: bản phát hành chính thức (không có tag) lớn hơn bản prerelease
  if (!parsedA.prereleaseTag && parsedB.prereleaseTag) {
    return 1; // a là official release, b là prerelease
  }
  if (parsedA.prereleaseTag && !parsedB.prereleaseTag) {
    return -1; // a là prerelease, b là official release
  }
  if (parsedA.prereleaseTag && parsedB.prereleaseTag) {
    const tagA = parsedA.prereleaseTag.toLowerCase();
    const tagB = parsedB.prereleaseTag.toLowerCase();

    // Thử so sánh các tag định danh phổ biến (alpha, beta, rc, snapshot)
    const rankA = extractPrereleaseRank(tagA);
    const rankB = extractPrereleaseRank(tagB);

    if (rankA !== null && rankB !== null) {
      if (rankA > rankB) return 1;
      if (rankA < rankB) return -1;
    }

    // Nếu tag giống nhau nhưng kèm số (ví dụ beta.1 vs beta.2)
    const numMatchA = tagA.match(/\d+$/);
    const numMatchB = tagB.match(/\d+$/);
    if (numMatchA && numMatchB) {
      const numA = parseInt(numMatchA[0], 10);
      const numB = parseInt(numMatchB[0], 10);
      if (numA > numB) return 1;
      if (numA < numB) return -1;
    }

    if (tagA === tagB) return 0;

    // Không thể chắc chắn thứ tự của hai tag lạ -> ambiguous
    return null;
  }

  return 0;
}

function extractPrereleaseRank(tag: string): number | null {
  for (const [key, rank] of Object.entries(COMMON_PRERELEASE_RANKS)) {
    if (tag.startsWith(key)) {
      return rank;
    }
  }
  return null;
}
