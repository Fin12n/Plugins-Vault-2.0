/**
 * Phase 5A: Version Normalization Abstraction
 *
 * Chuẩn hóa chuỗi phiên bản plugin để phục vụ đối sánh và đảm bảo tính duy nhất
 * (Uniqueness: UNIQUE(plugin_id, version_normalized)).
 *
 * QUY TẮC BẤT BIẾN:
 * 1. Giữ nguyên chuỗi raw version gốc trong cơ sở dữ liệu.
 * 2. Loại bỏ các tiền tố thông dụng (như v1.0 -> 1.0, Release-2.0 -> 2.0).
 * 3. KHÔNG tự ý giả định mọi plugin đều tuân thủ SemVer 3 chữ số (x.y.z).
 * 4. Bảo toàn các định dạng build số, snapshot, commit hash hoặc timestamp.
 */

export function normalizePluginVersion(rawVersion: string | null | undefined): string {
  if (!rawVersion || typeof rawVersion !== 'string') {
    return '';
  }

  // 1. Trim khoảng trắng đầu/cuối và rút gọn khoảng trắng thừa ở giữa
  let cleaned = rawVersion.trim().replace(/\s+/g, ' ');
  if (!cleaned) return '';

  // 2. Tách tiền tố v / V nếu liền kề với chữ số (ví dụ v1.20.3, V2.1)
  if (/^[vV]\d/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }

  // 3. Tách tiền tố release / rel / ver nếu liền kề với dấu phân tách và chữ số
  // (ví dụ: "release-1.2.3", "rel_2.4", "ver 3.0", "Release 1.0")
  const prefixMatch = cleaned.match(/^(?:release|rel|ver)[\s._-]+(?=\d)/i);
  if (prefixMatch) {
    cleaned = cleaned.slice(prefixMatch[0].length);
  }

  return cleaned.trim();
}
