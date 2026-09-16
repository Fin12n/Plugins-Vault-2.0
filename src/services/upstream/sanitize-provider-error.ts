/**
 * Câu báo lỗi của nhà cung cấp bên thứ ba trước khi đưa vào log.
 *
 * Câu đó do bên thứ ba viết và được in nguyên văn để chủ bot biết PHẢI làm gì ("API
 * key đã hết hạn" hữu ích hơn "gọi API thất bại"). Nhưng nguyên văn cũng có nghĩa là
 * nếu nhà cung cấp đọc lại api_key trong câu từ chối thì khoá đó vào log — nên khoá
 * bị che, dòng mới bị gộp (chống dựng dòng log giả), và độ dài bị chặn.
 *
 * Dùng chung cho mọi API trả tiền trong dự án (bể proxy, YesCaptcha): cả hai đều in
 * câu lỗi của bên thứ ba ra log, nên cả hai cần đúng một bộ lọc — viết hai lần thì
 * lần vá sau chỉ vá được một nửa.
 */

/** Che đúng một chuỗi bí mật ở mọi chỗ nó xuất hiện, kể cả dạng %-encode. */
function maskValue(text: string, secret: string): string {
  // Ngắn quá thì bỏ: che một chuỗi 3 ký tự sẽ băm nát cả câu lỗi và không che gì có
  // ý nghĩa. Mọi khoá và địa chỉ proxy thật đều dài hơn nhiều.
  if (secret.length < 6) return text;
  let out = text.split(secret).join('<đã che>');
  // Nhà cung cấp hay lặp lại tham số đầu vào sau khi đã %-encode nó, nên chuỗi thật
  // không còn khớp nguyên văn.
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join('<đã che>');
  return out;
}

/**
 * Lọc một câu lỗi của nhà cung cấp cho an toàn để log.
 *
 * `secrets` là những giá trị ĐÃ BIẾT là bí mật và đã gửi đi trong request — khoá API,
 * chuỗi proxy kèm mật khẩu. Che theo giá trị thật chứ không chỉ theo mẫu, vì một địa
 * chỉ proxy không trông giống `api_key=...` nào cả nhưng vẫn là thông tin của gói trả
 * tiền.
 */
export function sanitizeProviderError(message: string, secrets: readonly string[] = []): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = maskValue(out, secret);
  }
  return out
    .replace(/(api[_-]?key|token|secret|clientKey)\s*[=:]?\s*[\w-]{6,}/gi, '$1=<đã che>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
