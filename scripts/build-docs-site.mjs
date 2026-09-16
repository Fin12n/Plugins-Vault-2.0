/*
 * Sinh trang tài liệu HTML từ các tệp Markdown trong repo.
 *
 * Vì sao có tệp này thay vì viết HTML tay: nội dung phải có MỘT nguồn duy nhất.
 * Guide là tệp .md được đọc trên GitHub và trong editor; bản web chỉ là cách trình
 * bày khác của đúng nội dung đó. Viết tay hai bản là bảo đảm chúng lệch nhau sau
 * lần sửa thứ hai.
 *
 * Chỉ hỗ trợ đúng những gì các tệp .md đó dùng: tiêu đề, đoạn văn, bảng, khối lệnh,
 * danh sách (có cả danh sách lồng và bảng kiểm), `code`, **đậm**, liên kết. Không
 * cài thư viện markdown nào — đây là chỗ duy nhất cần biết cú pháp, và giữ nó nhỏ
 * dễ hơn là kéo thêm phụ thuộc vào một repo chỉ để dựng ba trang HTML.
 *
 * Chạy: npm run docs:web
 * Kết quả: docs/web/*.html (assets/site.css và site.js viết tay, không sinh lại).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'web');

/** Thứ tự này cũng là thứ tự thanh điều hướng trên đầu trang. */
const PAGES = [
  {
    source: 'README.md',
    file: 'index.html',
    nav: 'Tổng quan',
    title: 'Kho Plugin — tài liệu',
    description: 'Hệ thống lưu trữ plugin Minecraft đã mua, giao qua Discord, thu cọc bằng VietQR.',
    landing: true,
  },
  {
    source: 'docs/hosting-setup-guide.md',
    file: 'hosting-setup-guide.html',
    nav: 'Dựng lên hosting',
    title: 'Dựng hệ thống lên hosting',
    description: 'Runbook từ VPS trắng tới hệ thống chạy thật: HTTPS, systemd, tường lửa, sao lưu.',
  },
  {
    source: 'docs/deployment-guide.md',
    file: 'deployment-guide.html',
    nav: 'Chi tiết triển khai',
    title: 'Hướng dẫn triển khai',
    description: 'Cấu hình Discord, SePay, ví coin, card2k và tự động tải từ Spigot.',
  },
];

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Neo tiêu đề, cùng luật với GitHub: bỏ dấu câu, hạ chữ thường, khoảng trắng thành
 * gạch ngang, giữ nguyên chữ có dấu. Phải khớp để mọi liên kết `#...` viết trong .md
 * vẫn nhảy đúng chỗ khi đọc bản web.
 */
function slugify(rawText) {
  return rawText
    .toLowerCase()
    .replace(/`|\*\*|\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[.,:;!?"'’“”/\\|()[\]{}<>@#$%^&~+=]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Liên kết giữa các tệp .md trở thành liên kết giữa các trang .html. */
function rewriteHref(href) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  return href.replace(/^(?:\.\/)?(?:docs\/)?([\w-]+)\.md(#.*)?$/, '$1.html$2');
}

/**
 * Nhãn liên kết là tên tệp thì đổi thành tên trang.
 *
 * Trong .md, câu "xem deployment-guide.md" là tự nhiên vì người đọc đang xem tệp.
 * Trên web thì tệp đó không còn tồn tại dưới cái tên ấy, nên nhãn phải nói tên
 * trang. Nhãn do người viết đặt (ví dụ "mục 5b của deployment-guide") được giữ nguyên.
 */
function linkLabel(label, href) {
  if (!/^(?:\.\/)?(?:docs\/)?[\w-]+\.md$/.test(label.trim())) return label;
  const target = PAGES.find((page) => page.file === rewriteHref(href));
  return target ? target.nav : label;
}

/**
 * Định dạng trong dòng. Mã và liên kết được cất vào token trước khi xử lý phần còn
 * lại, nên một URL trong `code` không bị biến thành liên kết và dấu `**` trong lệnh
 * không bị hiểu là chữ đậm.
 */
function inline(raw) {
  const tokens = [];
  const keep = (html) => `\u0000${tokens.push(html) - 1}\u0000`;

  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) =>
    keep(`<a href="${rewriteHref(href)}">${linkLabel(label, href)}</a>`),
  );
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_, before, url) => `${before}${keep(`<a href="${url}">${url}</a>`)}`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  return s;
}

/**
 * Tô màu khối lệnh ở mức tối thiểu: chú thích và chuỗi trong ngoặc.
 *
 * Cố ý không dùng bộ highlight đầy đủ. Người đọc sẽ copy nguyên khối lệnh vào máy
 * chủ thật, nên nguy cơ tô sai làm hiểu sai một lệnh lớn hơn lợi ích thẩm mỹ. Chỉ
 * hai thứ này là nhận dạng được chắc chắn mà không cần biết cú pháp từng shell.
 */
function highlight(line, lang) {
  const hasComments = lang !== 'json';
  let out = '';
  let plain = '';
  const flush = () => {
    if (plain !== '') out += escapeHtml(plain);
    plain = '';
  };

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (hasComments && ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      flush();
      return `${out}<span class="c">${escapeHtml(line.slice(i))}</span>`;
    }
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      if (end > i) {
        flush();
        out += `<span class="s">${escapeHtml(line.slice(i, end + 1))}</span>`;
        i = end;
        continue;
      }
    }
    plain += ch;
  }
  flush();
  return out;
}

function renderCode(lang, body) {
  const label = lang || 'text';
  const code = body.map((line) => highlight(line, lang)).join('\n');
  return (
    `<figure class="code"><div class="bar"><span class="lang">${label}</span>` +
    `<button class="copy" type="button">Copy</button></div>` +
    `<pre><code class="language-${label}">${code}</code></pre></figure>`
  );
}

/** Tách một dòng bảng thành các ô, tôn trọng dấu `\|` được escape trong ô. */
const splitRow = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

const alignAttr = (spec) => {
  if (/^:-+:$/.test(spec)) return ' style="text-align:center"';
  if (/^-+:$/.test(spec)) return ' style="text-align:right"';
  return '';
};

/**
 * Bảng ba cột trở lên được gắn class `wide` để cột đầu xuống dòng được — bảng "triệu
 * chứng / nguyên nhân / cách sửa" mà giữ cột đầu một dòng thì tràn ngang màn hình.
 */
function renderTable(header, specs, rows) {
  const wide = header.length >= 3 ? ' class="wide"' : '';
  const th = header.map((cell, i) => `<th${alignAttr(specs[i] ?? '')}>${inline(cell)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell, i) => `<td${alignAttr(specs[i] ?? '')}>${inline(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="table-wrap"><table${wide}><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Bảng kiểm thành ô tick thật.
 *
 * Mục 15 của guide hosting là việc phải làm trên máy chủ, không phải đoạn văn để
 * đọc; site.js nhớ trạng thái đã tick nên đóng tab giữa lúc dựng không mất dấu.
 */
function renderChecklist(items) {
  const li = items
    .map(
      (item) =>
        `<li><label><input type="checkbox"${item.done ? ' checked' : ''}><span>${inline(item.text)}</span></label></li>`,
    )
    .join('');
  return `<ul class="checklist">${li}</ul>`;
}

const MARKER = { ul: /^[-*]\s+(.*)$/, ol: /^(\d+)\.\s+(.*)$/, task: /^[-*]\s+\[([ xX])\]\s+(.*)$/ };

/**
 * Đọc một danh sách từ dòng `start`, trả về HTML và dòng kế tiếp.
 *
 * Xử lý hai thứ mà guide đang dùng thật: dòng tiếp nối thụt lề (một mục dài viết
 * xuống hai ba dòng) và gạch đầu dòng lồng trong mục có số. Thiếu hai thứ đó thì
 * mục 5 của guide triển khai vỡ thành các đoạn rời.
 */
function readList(lines, start) {
  const first = lines[start];
  const kind = MARKER.task.test(first) ? 'task' : MARKER.ol.test(first) ? 'ol' : 'ul';
  const items = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      const next = lines[i + 1] ?? '';
      if (!MARKER.ul.test(next) && !MARKER.ol.test(next) && !/^\s+\S/.test(next)) break;
      i++;
      continue;
    }

    const task = MARKER.task.exec(line);
    const ol = MARKER.ol.exec(line);
    const ul = MARKER.ul.exec(line);

    if (kind === 'task' && task) items.push({ text: task[2], done: task[1].toLowerCase() === 'x', children: [] });
    else if (kind === 'ol' && ol) items.push({ text: ol[2], number: Number(ol[1]), children: [] });
    else if (kind === 'ul' && ul && !task) items.push({ text: ul[1], children: [] });
    else if (/^\s+[-*]\s+/.test(line) && items.length > 0) items.at(-1).children.push(line.replace(/^\s+[-*]\s+/, ''));
    else if (/^\s+\S/.test(line) && items.length > 0) {
      const item = items.at(-1);
      if (item.children.length > 0) item.children[item.children.length - 1] += ` ${line.trim()}`;
      else item.text += ` ${line.trim()}`;
    } else break;
    i++;
  }

  if (kind === 'task') return { html: renderChecklist(items), next: i };

  const body = items
    .map((item) => {
      const nested = item.children.length > 0 ? `<ul>${item.children.map((c) => `<li>${inline(c)}</li>`).join('')}</ul>` : '';
      return `<li>${inline(item.text)}${nested}</li>`;
    })
    .join('');
  const startAttr = kind === 'ol' && items[0]?.number !== 1 ? ` start="${items[0]?.number}"` : '';
  return { html: kind === 'ol' ? `<ol${startAttr}>${body}</ol>` : `<ul>${body}</ul>`, next: i };
}

/** Chuyển một tệp Markdown thành thân trang và mục lục của nó. */
function render(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = [];
  const toc = [];
  const used = new Map();
  let ledeDone = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // dòng ``` đóng
      out.push(renderCode(fence[1], body));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const base = slugify(text) || `muc-${toc.length + 1}`;
      const count = used.get(base) ?? 0;
      used.set(base, count + 1);
      const slug = count === 0 ? base : `${base}-${count}`;

      if (level === 1) {
        out.push(`<h1>${inline(text)}</h1>`);
      } else {
        const anchor = `<a class="heading-link" href="#${slug}" aria-label="Liên kết tới mục này">#</a>`;
        out.push(`<h${level} id="${slug}">${inline(text)}${anchor}</h${level}>`);
        if (level <= 3) toc.push({ level, slug, text: inline(text) });
      }
      i++;
      continue;
    }

    if (line.startsWith('|') && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const specs = splitRow(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i++]));
      out.push(renderTable(header, specs, rows));
      continue;
    }

    if (MARKER.task.test(line) || MARKER.ul.test(line) || MARKER.ol.test(line)) {
      const list = readList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    // Đoạn văn: gom tới dòng trống hoặc tới chỗ một khối khác bắt đầu.
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const next = lines[i];
      if (/^```/.test(next) || /^#{1,6}\s/.test(next) || next.startsWith('|')) break;
      if (paragraph.length > 0 && (MARKER.ul.test(next) || MARKER.ol.test(next))) break;
      paragraph.push(next.trim());
      i++;
    }
    if (paragraph.length > 0) {
      // Đoạn đầu tiên sau tiêu đề trang được in to hơn một chút: nó luôn là câu nói
      // tài liệu này dùng để làm gì, và đó là câu đáng đọc nhất trên trang.
      const cls = !ledeDone && out.length === 1 && out[0].startsWith('<h1') ? ' class="lede"' : '';
      if (cls) ledeDone = true;
      out.push(`<p${cls}>${inline(paragraph.join(' '))}</p>`);
    }
  }

  return { blocks: out, toc };
}

/** Mục lục dạng lồng: h2 là mục chính, h3 thụt vào dưới nó. */
function renderToc(toc) {
  const items = toc
    .map((entry) => `<li class="lvl-${entry.level}"><a href="#${entry.slug}">${entry.text}</a></li>`)
    .join('');
  return `<ol>${items}</ol>`;
}

/** Hai thẻ mở đầu trang chủ, để không ai phải đoán nên đọc tài liệu nào trước. */
const CARDS = `<div class="cards">
  <a class="card" href="hosting-setup-guide.html">
    <p class="kicker">Bắt đầu ở đây</p>
    <h2>Dựng lên hosting</h2>
    <p>Từ VPS trắng tới hệ thống chạy thật: Node 24, systemd, HTTPS, tường lửa, sao lưu, và bảng kiểm trước khi giao cho admin.</p>
    <span class="go">Mở runbook →</span>
  </a>
  <a class="card" href="deployment-guide.html">
    <p class="kicker">Tra cứu theo tính năng</p>
    <h2>Chi tiết triển khai</h2>
    <p>Discord, SePay, ví coin, nạp thẻ cào card2k, và tự động tải từ Spigot — từng phần một, kèm cách xử lý khi sai.</p>
    <span class="go">Mở hướng dẫn →</span>
  </a>
</div>`;

function pageHtml(page, body, toc) {
  const nav = PAGES.map(
    (item) => `<a href="${item.file}"${item.file === page.file ? ' aria-current="page"' : ''}>${item.nav}</a>`,
  ).join('');

  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<link rel="stylesheet" href="assets/site.css">
<script>
  /* Đặt chủ đề trước khi trang được vẽ, nếu không sẽ nháy sáng rồi mới sang tối. */
  (function () {
    try {
      var saved = localStorage.getItem('docs-theme');
      var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } catch (err) {
      document.documentElement.dataset.theme = 'light';
    }
  })();
</script>
</head>
<body>
<div id="progress"></div>
<header class="site">
  <button id="menu-toggle" class="icon" type="button" aria-controls="toc" aria-expanded="false" aria-label="Mở mục lục">☰</button>
  <a class="brand" href="index.html">Kho Plugin <span>· tài liệu</span></a>
  <nav class="docs" aria-label="Danh sách tài liệu">${nav}</nav>
  <span class="spacer"></span>
  <button id="theme-toggle" class="icon" type="button">☾ Tối</button>
</header>
<div class="layout">
  <aside class="toc" id="toc">
    <p class="toc-title">Trong trang này</p>
    <input id="toc-filter" type="search" placeholder="Tìm trong mục lục…" aria-label="Lọc mục lục">
    ${renderToc(toc)}
  </aside>
  <main>
    <article>
${body}
    </article>
    <footer class="site">
      <p>Trang này sinh từ <code>${page.source}</code> bằng <code>npm run docs:web</code>. Sửa tệp Markdown rồi chạy lại — đừng sửa HTML tay.</p>
    </footer>
  </main>
</div>
<script src="assets/site.js" defer></script>
</body>
</html>
`;
}

mkdirSync(join(outDir, 'assets'), { recursive: true });

for (const page of PAGES) {
  const markdown = readFileSync(join(root, page.source), 'utf8');
  const { blocks, toc } = render(markdown);

  if (page.landing) {
    // Ngay sau câu mở đầu, trước phần còn lại của README.
    const afterLede = blocks.findIndex((block) => block.startsWith('<p'));
    blocks.splice(afterLede + 1, 0, CARDS);
  }

  writeFileSync(join(outDir, page.file), pageHtml(page, blocks.join('\n'), toc));
  console.log(`docs/web/${page.file}  ←  ${page.source}  (${toc.length} mục trong mục lục)`);
}

