import { vi } from '../i18n/vi.js';

/** Shared pager used by the plugin list and the delivery log. */
export function Pager({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="pager">
      <button className="small" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        {vi.common.prev}
      </button>
      <span className="muted">{vi.common.page(page, totalPages)}</span>
      <button className="small" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        {vi.common.next}
      </button>
    </div>
  );
}
