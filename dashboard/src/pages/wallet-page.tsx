import { useState } from 'react';
import { Pager } from '../components/pager.js';
import { useToast } from '../components/toast.js';
import { EmptyState, ErrorState, RefreshButton, Stat, TableSkeleton, TimeAgo } from '../components/ui.js';
import { formatCoins, formatTimestampExact, formatVnd, ledgerKindLabel, toCoins, vi } from '../i18n/vi.js';
import {
  api,
  ApiError,
  type BalanceDriftView,
  type CardCostView,
  type CardTopupView,
  type LedgerView,
  type WalletView,
} from '../lib/api-client.js';
import { useAsync } from '../lib/use-async.js';

type WalletsResponse = {
  items: WalletView[];
  drift: BalanceDriftView[];
  /** Tổng số dư của MỌI ví, không theo bộ lọc. */
  balanceSum: number;
  page: number;
  totalPages: number;
  total: number;
};

type LedgerResponse = { items: LedgerView[]; balance: number; page: number; totalPages: number };

type CardsResponse = {
  items: CardTopupView[];
  review: (CardTopupView & { code?: string })[];
  month: string;
  cost: CardCostView;
  page: number;
  totalPages: number;
};

/**
 * Wallet tab: balances, ledgers, card top-ups, and the fee the owner absorbs.
 *
 * The fee figure is the reason this page exists rather than a row on the stats
 * tab: card top-ups credit the card's full value while card2k pays out less, and
 * that gap appears nowhere else in the system.
 */
export function WalletPage() {
  const [walletPage, setWalletPage] = useState(1);
  const [cardPage, setCardPage] = useState(1);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const walletQuery = new URLSearchParams({ page: String(walletPage), pageSize: '25' });
  if (search) walletQuery.set('q', search);
  const wallets = useAsync<WalletsResponse>(`/api/wallets?${walletQuery}`);
  const cards = useAsync<CardsResponse>(`/api/cards?page=${cardPage}&pageSize=25`);

  const reload = (): void => {
    void wallets.reload();
    void cards.reload();
  };

  return (
    <>
      <div className="content-head">
        <h2>{vi.wallet.heading}</h2>
        <div className="button-row">
          {wallets.data && (
            <span className="muted">
              {vi.wallet.walletsHeaderTotal(wallets.data.total, formatVnd(wallets.data.balanceSum))}
            </span>
          )}
          <RefreshButton onClick={reload} busy={wallets.refreshing || cards.refreshing} />
        </div>
      </div>
      <p className="hint" style={{ marginBottom: 16 }}>
        {vi.wallet.explain}
      </p>

      {wallets.error && <ErrorState message={wallets.error} onRetry={() => void wallets.reload()} />}

      {wallets.data && wallets.data.drift.length > 0 && (
        // Never expected to render. If it does, some write path skipped the ledger
        // and the balances can no longer be trusted.
        <div className="panel error-state">
          <p className="error" style={{ marginTop: 0 }}>
            {vi.wallet.driftWarning}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.wallet.user}</th>
                  <th className="right">{vi.wallet.balance}</th>
                  <th className="right">{vi.wallet.ledgerSum}</th>
                  {/* Cột lệch được tính hộ: trừ hai số bảy chữ số bằng mắt trong đúng
                      cái bảng nói "số dư không đáng tin" là chỗ dễ đọc sai nhất. */}
                  <th className="right">{vi.wallet.colDiscrepancy}</th>
                </tr>
              </thead>
              <tbody>
                {wallets.data.drift.map((row) => (
                  <tr key={row.discordUserId}>
                    <td className="nowrap mono">{row.discordUserId}</td>
                    <td className="right nowrap">{formatVnd(row.balance)}</td>
                    <td className="right nowrap">{formatVnd(row.ledgerSum)}</td>
                    <td className="right nowrap error" style={{ margin: 0 }}>
                      {row.balance - row.ledgerSum > 0 ? '+' : '−'}
                      {formatVnd(Math.abs(row.balance - row.ledgerSum))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {cards.data && cards.data.review.length > 0 && (
        <div className="panel">
          <h3>{vi.wallet.reviewHeading}</h3>
          <p className="hint">{vi.wallet.reviewExplain}</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.wallet.user}</th>
                  <th>{vi.wallet.card}</th>
                  <th className="right">{vi.wallet.declared}</th>
                  <th>{vi.wallet.colWaitingSince}</th>
                  <th>{vi.wallet.status}</th>
                  <th>{vi.wallet.providerMessage}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {cards.data.review.map((card) => (
                  <ReviewRow key={card.id} card={card} onDone={reload} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="panel">
        <h3>{vi.wallet.balancesHeading}</h3>
        <AdjustForm onDone={reload} />

        <hr className="panel-divider" />

        <form
          className="row"
          style={{ marginBottom: 12 }}
          onSubmit={(event) => {
            event.preventDefault();
            setWalletPage(1);
            setSearch(draft.trim());
          }}
        >
          <input
            type="search"
            inputMode="numeric"
            placeholder={vi.wallet.searchPlaceholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label={vi.wallet.searchAriaLabel}
          />
          <button type="submit">{vi.wallet.searchSubmit}</button>
          {search !== '' && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setDraft('');
                setSearch('');
                setWalletPage(1);
              }}
            >
              {vi.wallet.clearFilter}
            </button>
          )}
        </form>

        {wallets.loading && <TableSkeleton rows={4} cols={4} />}
        {wallets.data && wallets.data.items.length === 0 && (
          <p className="muted">{search ? vi.wallet.noWalletSearch(search) : vi.wallet.noWallets}</p>
        )}
        {wallets.data && wallets.data.items.length > 0 && (
          <div className={wallets.refreshing ? 'refreshing' : undefined}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{vi.wallet.user}</th>
                    <th className="right">{vi.wallet.balance}</th>
                    <th className="right">{vi.wallet.coins}</th>
                    <th>{vi.wallet.updated}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {wallets.data.items.map((wallet) => {
                    // Số coin làm tròn xuống, nên phần lẻ dưới 1.000 ₫ không hiện ở cột
                    // coin. Nói ra trong tooltip thay vì để hai cột trông như lệch nhau.
                    const remainder = wallet.balance - toCoins(wallet.balance) * 1000;
                    return (
                      <tr key={wallet.discordUserId}>
                        <td className="nowrap mono">{wallet.discordUserId}</td>
                        <td className="right nowrap">{formatVnd(wallet.balance)}</td>
                        <td
                          className="right nowrap"
                          title={remainder > 0 ? vi.wallet.remainderTooltip(formatVnd(remainder)) : undefined}
                        >
                          {formatCoins(toCoins(wallet.balance))}
                          {remainder > 0 && <span className="muted">{vi.wallet.remainderBadge}</span>}
                        </td>
                        <td className="muted nowrap">
                          <TimeAgo unixSeconds={wallet.updatedAt} />
                        </td>
                        <td className="right">
                          <button
                            className="small"
                            aria-expanded={selected === wallet.discordUserId}
                            onClick={() =>
                              setSelected(selected === wallet.discordUserId ? null : wallet.discordUserId)
                            }
                          >
                            {selected === wallet.discordUserId ? vi.wallet.hideLedger : vi.wallet.showLedger}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={wallets.data.page} totalPages={wallets.data.totalPages} onChange={setWalletPage} />
          </div>
        )}
      </div>

      {selected && <LedgerPanel discordUserId={selected} onClose={() => setSelected(null)} />}

      <CardsPanel cards={cards} page={cardPage} onPage={setCardPage} />
    </>
  );
}

/** Lịch sử nạp thẻ và phí mà chủ kho chịu. */
function CardsPanel({
  cards,
  page,
  onPage,
}: {
  cards: ReturnType<typeof useAsync<CardsResponse>>;
  page: number;
  onPage: (next: number) => void;
}) {
  return (
    <div className="panel">
      <h3>{vi.wallet.cardsHeading}</h3>
      {cards.data && (
        <div className="stat-grid" style={{ marginBottom: 14 }}>
          <Stat label={vi.wallet.creditedStat(cards.data.month)} value={formatVnd(cards.data.cost.credited)} />
          <Stat label={vi.wallet.providerPayout} value={formatVnd(cards.data.cost.received)} />
          <Stat label={vi.wallet.absorbFee} value={formatVnd(cards.data.cost.cost)} tone="warn" />
        </div>
      )}

      {cards.error && <ErrorState message={cards.error} onRetry={() => void cards.reload()} />}
      {cards.loading && <TableSkeleton rows={4} cols={5} />}
      {cards.data && cards.data.items.length === 0 && <p className="muted">{vi.wallet.noCards}</p>}

      {cards.data && cards.data.items.length > 0 && (
        <div className={cards.refreshing ? 'refreshing' : undefined}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{vi.wallet.user}</th>
                  <th>{vi.wallet.card}</th>
                  <th className="right">{vi.wallet.declared}</th>
                  <th className="right">{vi.wallet.actual}</th>
                  <th className="right">{vi.wallet.received}</th>
                  <th>{vi.wallet.status}</th>
                  <th>{vi.wallet.created}</th>
                </tr>
              </thead>
              <tbody>
                {cards.data.items.map((card) => (
                  <tr key={card.id}>
                    <td className="nowrap mono">{card.discordUserId}</td>
                    <td className="nowrap">
                      {card.telco} · <span className="muted mono">{card.serial}</span>
                    </td>
                    <td className="right nowrap">{formatVnd(card.declaredValue)}</td>
                    <td className="right nowrap">
                      {card.actualValue === null ? <span className="muted">—</span> : formatVnd(card.actualValue)}
                    </td>
                    <td className="right nowrap">
                      {card.netAmount === null ? <span className="muted">—</span> : formatVnd(card.netAmount)}
                    </td>
                    <td className="nowrap">
                      <span className={cardBadge(card.status)}>
                        {vi.wallet.cardStatuses[card.status] ?? card.status}
                      </span>
                      {card.status === 'wrong_amount' && (
                        <span className="badge" style={{ marginLeft: 6 }} title={vi.wallet.badgeWrongAmountTooltip}>
                          {vi.wallet.badgeWrongAmount}
                        </span>
                      )}
                    </td>
                    <td className="muted nowrap">
                      <TimeAgo unixSeconds={card.creditedAt ?? card.createdAt} />
                      {card.creditedAt !== null && <span className="hint">{vi.wallet.creditedHint}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={cards.data.page} totalPages={cards.data.totalPages} onChange={onPage} />
        </div>
      )}
    </div>
  );
}

/**
 * Màu theo hệ quả về tiền, không theo cảm giác "tốt/xấu".
 *
 * Đọc từ src/domain/card-topup.ts: `wrong_amount` VẪN là một lần cộng tiền (theo giá
 * trị thật của thẻ), nên nó xanh chứ không vàng. `failed` nghĩa là không lấy gì của
 * ai — đó là trạng thái trung tính, không phải tai hoạ. Còn `timeout` mới là thứ đáng
 * đỏ: thẻ CÓ THỂ đã bị tiêu mà chưa cộng cho ai.
 */
function cardBadge(status: string): string {
  if (status === 'success' || status === 'wrong_amount') return 'badge ok';
  if (status === 'pending') return 'badge';
  if (status === 'failed') return 'badge';
  return 'badge danger';
}

/** Lịch sử biến động của một ví. */
function LedgerPanel({ discordUserId, onClose }: { discordUserId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const ledger = useAsync<LedgerResponse>(`/api/wallets/${discordUserId}/ledger?page=${page}&pageSize=25`);

  return (
    <div className="panel">
      <div className="account-panel-heading">
        <h3 style={{ margin: 0 }}>{vi.wallet.ledgerHeading(discordUserId)}</h3>
        <div className="button-row">
          {ledger.data && <span className="muted">{vi.wallet.currentBalance(formatVnd(ledger.data.balance))}</span>}
          <button className="ghost small" onClick={onClose}>
            {vi.common.close}
          </button>
        </div>
      </div>

      {/* Trước đây một lần đọc lỗi để lại chữ "Đang tải..." mãi mãi, vì catch đặt
          data về null và không có trạng thái lỗi nào. */}
      {ledger.error && <ErrorState message={ledger.error} onRetry={() => void ledger.reload()} />}
      {ledger.loading && <TableSkeleton rows={4} cols={5} />}
      {ledger.data && ledger.data.items.length === 0 && <p className="muted">{vi.wallet.noActivity}</p>}

      {ledger.data && ledger.data.items.length > 0 && (
        <div className={ledger.refreshing ? 'refreshing' : undefined}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="right">{vi.wallet.delta}</th>
                  <th className="right">{vi.wallet.balanceAfter}</th>
                  <th>{vi.wallet.reason}</th>
                  <th>{vi.wallet.colSource}</th>
                  <th>{vi.wallet.note}</th>
                  <th>{vi.wallet.created}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.data.items.map((entry) => (
                  <tr key={entry.id}>
                    {/* Tiền ra không được mờ hơn tiền vào: cả hai đều phải đọc được, và
                        dấu trừ là thứ dễ bỏ sót nhất trong một cột số. */}
                    <td className={`right nowrap ${entry.delta >= 0 ? 'status-ok' : 'status-danger'}`}>
                      {entry.delta >= 0 ? '+' : '−'}
                      {formatVnd(Math.abs(entry.delta))}
                    </td>
                    <td className="right nowrap">{formatVnd(entry.balanceAfter)}</td>
                    <td className="nowrap">{ledgerKindLabel(entry.kind)}</td>
                    {/* refType/refId đã có trong API từ đầu nhưng chưa bao giờ hiện: không
                        có nó thì một khoản giữ cho đơn hàng không lần được về đơn nào. */}
                    <td className="nowrap muted mono">
                      {entry.refId === null ? '—' : `${entry.refType}#${entry.refId}`}
                    </td>
                    <td>{entry.note || <span className="muted">—</span>}</td>
                    <td className="muted nowrap" title={formatTimestampExact(entry.createdAt)}>
                      {formatTimestampExact(entry.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={ledger.data.page} totalPages={ledger.data.totalPages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}

/** Chấp nhận "1.000.000", "1 000 000", "1000000" — dán từ Discord ra dạng nào cũng có. */
function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[.\s,]/g, '');
  if (!/^-?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

/** Số tiền một lần chỉnh tay mà vượt mức này thì gần như chắc chắn là gõ thừa số 0. */
const ADJUST_SANITY_LIMIT = 10_000_000;

/**
 * Manual balance adjustment.
 *
 * A note is required by the API, not merely encouraged: an unexplained adjustment
 * is indistinguishable from a bug when it is read back months later.
 *
 * Có bước xác nhận và có biên nhận, vì đây là đường ghi tiền DUY NHẤT không
 * idempotent (repositories/wallets.ts nói rõ: gọi hai lần thì cộng hai lần). Trước đây
 * nó vừa không hỏi lại, vừa không hiện số dư mới — nên phản ứng tự nhiên khi không
 * thấy gì xảy ra là bấm thêm một lần nữa.
 */
function AdjustForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const parsed = parseAmount(amount);
  const idValid = /^\d{17,20}$/.test(userId.trim());
  const ready = idValid && parsed !== null && parsed !== 0 && note.trim() !== '';

  const submit = async (): Promise<void> => {
    if (!ready || parsed === null) return;
    const sign = parsed > 0 ? vi.wallet.signCredit : vi.wallet.signDebit;
    const confirmed = confirm(
      vi.wallet.confirmAdjust(
        sign,
        formatVnd(Math.abs(parsed)),
        formatCoins(Math.abs(toCoins(parsed))),
        userId.trim(),
        note.trim(),
      ),
    );
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await api.post<{ balance: number }>('/api/wallets/adjust', {
        discordUserId: userId.trim(),
        delta: parsed,
        note: note.trim(),
      });
      setUserId('');
      setAmount('');
      setNote('');
      // Biên nhận có số dư mới: câu trả lời cho "vừa rồi có ăn không?".
      toast.success(
        vi.wallet.toastAdjusted(sign.toLowerCase(), formatVnd(Math.abs(parsed)), formatVnd(result.balance)),
      );
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : vi.common.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="row">
        <label htmlFor="adjust-user">
          <span>{vi.wallet.adjustUser}</span>
          <input
            id="adjust-user"
            inputMode="numeric"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            aria-invalid={userId !== '' && !idValid}
            placeholder="123456789012345678"
          />
        </label>
        <label htmlFor="adjust-amount">
          <span>{vi.wallet.adjustAmount}</span>
          <input
            id="adjust-amount"
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={amount !== '' && parsed === null}
            placeholder="-50000"
          />
        </label>
        <label htmlFor="adjust-note">
          <span>{vi.wallet.adjustNote}</span>
          <input
            id="adjust-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={vi.wallet.adjustNotePlaceholder}
          />
        </label>
        <button className="primary" type="submit" disabled={busy || !ready} aria-busy={busy}>
          {vi.wallet.adjust}
        </button>
      </div>

      {/* Nói ra vì sao nút chưa bấm được, thay vì chỉ làm nó mờ đi. */}
      {userId !== '' && !idValid && <p className="hint">{vi.wallet.invalidUserIdHint}</p>}
      {amount !== '' && parsed === null && <p className="hint">{vi.wallet.amountDigitsHint}</p>}
      {parsed !== null && parsed !== 0 && (
        <p className="hint">
          {parsed > 0 ? vi.wallet.creditVerb : vi.wallet.debitVerb} {formatVnd(Math.abs(parsed))} = {formatCoins(Math.abs(toCoins(parsed)))} coin
          {Math.abs(parsed) > ADJUST_SANITY_LIMIT && (
            <strong className="error">{vi.wallet.amountSanityWarning}</strong>
          )}
        </p>
      )}
    </form>
  );
}

/** A card the poll could not settle. Credit it or close it, both audited. */
function ReviewRow({ card, onDone }: { card: CardTopupView & { code?: string }; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(String(card.actualValue ?? card.declaredValue));
  const [busy, setBusy] = useState<'credit' | 'reject' | null>(null);
  const parsed = parseAmount(amount);
  // Ô tiền được điền sẵn bằng giá trị THẬT nếu card2k đã trả về, còn không thì bằng
  // giá trị khách khai. Hai thứ đó khác nhau về hệ quả, nên phải nói rõ đang là cái nào.
  const prefillSource = card.actualValue === null ? vi.wallet.prefillDeclared : vi.wallet.prefillActual;

  const act = async (credit: boolean): Promise<void> => {
    if (credit && (parsed === null || parsed <= 0)) return;
    const question = credit
      ? vi.wallet.confirmCreditCard(formatVnd(parsed ?? 0), card.discordUserId, card.telco, card.serial)
      : vi.wallet.confirmRejectCard(card.serial);
    if (!confirm(question)) return;

    setBusy(credit ? 'credit' : 'reject');
    try {
      await api.post(
        `/api/cards/${card.id}/resolve`,
        credit ? { credit: true, amount: parsed } : { credit: false },
      );
      toast.success(
        credit
          ? vi.wallet.toastCardCredited(formatVnd(parsed ?? 0), card.discordUserId)
          : vi.wallet.toastCardRejected,
      );
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : vi.common.error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <tr>
      <td className="nowrap mono">{card.discordUserId}</td>
      <td className="nowrap">
        {card.telco} · <span className="muted mono">{card.serial}</span>
        {/* PIN chỉ có ở phiếu đang chờ, và chủ kho cần nó để tự tra trên card2k. */}
        {card.code && (
          <div className="hint mono">
            PIN {card.code}{' '}
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                void navigator.clipboard?.writeText(card.code ?? '').then(() => toast.success(vi.wallet.toastPinCopied))
              }
            >
              copy
            </button>
          </div>
        )}
      </td>
      <td className="right nowrap">{formatVnd(card.declaredValue)}</td>
      <td className="muted nowrap">
        <TimeAgo unixSeconds={card.createdAt} />
        {card.attempts > 0 && <span className="hint">{vi.wallet.attemptsCount(card.attempts)}</span>}
      </td>
      <td className="nowrap">
        <span className="badge warn">{vi.wallet.cardStatuses[card.status] ?? card.status}</span>
      </td>
      <td className="muted">
        {card.providerMessage || '—'}
        {card.providerStatus !== null && <span className="muted"> ({card.providerStatus})</span>}
      </td>
      <td className="right nowrap">
        <label style={{ marginBottom: 6 }}>
          <span>{vi.wallet.creditAmountLabel(prefillSource)}</span>
          <input
            style={{ width: 130 }}
            inputMode="numeric"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            aria-invalid={parsed === null}
          />
        </label>
        <div className="button-row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="primary small"
            disabled={busy !== null || parsed === null || parsed <= 0}
            aria-busy={busy === 'credit'}
            onClick={() => void act(true)}
          >
            {vi.wallet.creditCard}
          </button>
          <button
            className="small danger"
            disabled={busy !== null}
            aria-busy={busy === 'reject'}
            onClick={() => void act(false)}
          >
            {vi.wallet.rejectCard}
          </button>
        </div>
        {parsed === null && <p className="hint">{vi.wallet.unreadableAmount}</p>}
      </td>
    </tr>
  );
}
