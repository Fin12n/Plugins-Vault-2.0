import React, { useState, useEffect } from 'react';
import { CartItem, PromoCode, MOCK_PROMO_CODES, formatVnd, UserProfile } from '../lib/mock-store.js';
import { useToast } from './toast.js';

interface CartDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  onUpdateQuantity: (pluginId: string, delta: number) => void;
  onRemoveItem: (pluginId: string) => void;
  onClearCart: () => void;
  user: UserProfile | null;
  onSuccessOrder: (pluginIds: string[]) => void;
}

export function CartDrawer({
  isOpen,
  onClose,
  items,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  user,
  onSuccessOrder,
}: CartDrawerProps) {
  const toast = useToast();
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState<PromoCode | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [paymentStep, setPaymentStep] = useState<'cart' | 'checkout' | 'success'>('cart');
  const [countdown, setCountdown] = useState(300); // 5 minutes QR timer
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);

  // Calculate totals
  const subtotal = items.reduce((sum, item) => sum + item.plugin.priceVnd * item.quantity, 0);
  
  let discountAmount = 0;
  if (appliedPromo) {
    if (appliedPromo.discountType === 'percent') {
      discountAmount = (subtotal * appliedPromo.discountValue) / 100;
      if (appliedPromo.maxDiscountVnd && discountAmount > appliedPromo.maxDiscountVnd) {
        discountAmount = appliedPromo.maxDiscountVnd;
      }
    } else {
      discountAmount = appliedPromo.discountValue;
    }
  }

  const finalTotal = Math.max(0, subtotal - discountAmount);

  // Timer effect for VietQR checkout
  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (paymentStep === 'checkout' && countdown > 0) {
      timer = setInterval(() => setCountdown(prev => prev - 1), 1000);
    }
    return () => clearInterval(timer);
  }, [paymentStep, countdown]);

  if (!isOpen) return null;

  const handleApplyPromo = () => {
    const codeClean = promoInput.trim().toUpperCase();
    setPromoError(null);

    const found = MOCK_PROMO_CODES.find(p => p.code === codeClean && p.status === 'active');
    if (!found) {
      setPromoError('Mã giảm giá không tồn tại hoặc đã hết hạn!');
      return;
    }

    if (subtotal < found.minOrderVnd) {
      setPromoError(`Đơn hàng tối thiểu ${formatVnd(found.minOrderVnd)} để áp dụng mã này!`);
      return;
    }

    setAppliedPromo(found);
    toast.success(`Đã áp dụng mã giảm giá ${found.code}!`);
  };

  const handleSimulatePaymentDone = () => {
    setIsProcessingPayment(true);
    setTimeout(() => {
      setIsProcessingPayment(false);
      setPaymentStep('success');
      const boughtIds = items.map(i => i.plugin.id);
      onSuccessOrder(boughtIds);
      toast.success('Giao dịch SePay thành công! Plugin đã được thêm vào Tủ đồ của bạn.');
    }, 1500);
  };

  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="ez-drawer-backdrop" onClick={onClose}>
      <div className="ez-drawer-panel" onClick={(e) => e.stopPropagation()}>
        {/* Drawer Header */}
        <div className="ez-drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '20px' }}>🛒</span>
            <h3 className="ez-drawer-title">
              {paymentStep === 'cart' ? 'Giỏ Hàng Của Bạn' : paymentStep === 'checkout' ? 'Thanh Toán Tự Động VietQR' : 'Đặt Hàng Thành Công 🎉'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '20px', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>

        {/* Drawer Body */}
        <div className="ez-drawer-body">
          {paymentStep === 'cart' && (
            <>
              {items.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 0', color: '#94a3b8' }}>
                  <div style={{ fontSize: '48px', marginBottom: '12px' }}>🛒</div>
                  <p style={{ fontSize: '16px', fontWeight: '700', color: '#fff', margin: '0 0 6px' }}>Giỏ hàng đang trống</p>
                  <p style={{ fontSize: '13px' }}>Hãy dạo qua kho plugin và chọn những sản phẩm ưng ý nhé!</p>
                </div>
              ) : (
                <>
                  {/* Cart Items List */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {items.map(item => (
                      <div key={item.plugin.id} className="ez-cart-item-card">
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <span style={{ fontSize: '24px' }}>{item.plugin.icon}</span>
                          <div>
                            <strong style={{ color: '#fff', fontSize: '14px', display: 'block' }}>{item.plugin.name}</strong>
                            <span style={{ color: '#10b981', fontSize: '13px', fontWeight: '700' }}>
                              {formatVnd(item.plugin.priceVnd)}
                            </span>
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <button
                            type="button"
                            onClick={() => onRemoveItem(item.plugin.id)}
                            style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#ef4444', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px' }}
                            title="Xóa khỏi giỏ"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Promo Code Input Box */}
                  <div className="ez-promo-box">
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#10b981' }}>🎟️ Mã Giảm Giá (Discount Coupon)</span>
                    <p style={{ margin: '4px 0 8px', fontSize: '12px', color: '#94a3b8' }}>
                      Gợi ý mã thử nghiệm: <code style={{ color: '#06b6d4', background: 'rgba(0,0,0,0.3)', padding: '2px 4px', borderRadius: '4px' }}>EZSTORE2026</code> (-20%) hoặc <code style={{ color: '#06b6d4', background: 'rgba(0,0,0,0.3)', padding: '2px 4px', borderRadius: '4px' }}>VIP50K</code>
                    </p>
                    <div className="ez-promo-input-row">
                      <input
                        type="text"
                        placeholder="Nhập mã khuyến mãi..."
                        value={promoInput}
                        onChange={(e) => setPromoInput(e.target.value)}
                        style={{ flex: 1, padding: '8px 12px', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', color: '#fff', fontSize: '13px' }}
                      />
                      <button
                        type="button"
                        onClick={handleApplyPromo}
                        style={{ padding: '8px 16px', background: '#10b981', color: '#000', fontWeight: '700', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}
                      >
                        Áp Dụng
                      </button>
                    </div>
                    {promoError && <p style={{ color: '#ef4444', fontSize: '12px', margin: '6px 0 0' }}>{promoError}</p>}
                    {appliedPromo && (
                      <p style={{ color: '#10b981', fontSize: '12px', margin: '6px 0 0', fontWeight: '700' }}>
                        ✅ Đã giảm {appliedPromo.discountType === 'percent' ? `${appliedPromo.discountValue}%` : formatVnd(appliedPromo.discountValue)} (-{formatVnd(discountAmount)})
                      </p>
                    )}
                  </div>

                  {/* Summary Pricing */}
                  <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', color: '#94a3b8' }}>
                      <span>Tạm tính ({items.length} món):</span>
                      <span style={{ color: '#fff' }}>{formatVnd(subtotal)}</span>
                    </div>
                    {discountAmount > 0 && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '13px', color: '#10b981' }}>
                        <span>Giảm giá khuyến mãi:</span>
                        <span>-{formatVnd(discountAmount)}</span>
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: '8px', borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: '16px', fontWeight: '800' }}>
                      <span style={{ color: '#fff' }}>Tổng thanh toán:</span>
                      <span style={{ color: '#10b981', fontSize: '20px' }}>{formatVnd(finalTotal)}</span>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {paymentStep === 'checkout' && (
            <div className="ez-vietqr-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '12px' }}>
                <span className="ez-brand-badge" style={{ background: 'rgba(6,182,212,0.15)', color: '#06b6d4', borderColor: 'rgba(6,182,212,0.3)' }}>
                  SePay Auto Webhook
                </span>
                <span style={{ fontSize: '12px', color: '#94a3b8' }}>Quét mã QR để thanh toán</span>
              </div>

              {/* Dynamic QR Code mockup */}
              <div style={{ position: 'relative', width: '200px', margin: '0 auto' }}>
                <img
                  src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=https://ezstore.vault/pay/SEPAY9948"
                  alt="VietQR Payment Code"
                  className="ez-qr-image"
                />
              </div>

              <div style={{ background: 'rgba(0,0,0,0.4)', borderRadius: '10px', padding: '12px', margin: '14px 0', textAlign: 'left', fontSize: '13px', lineHeight: '1.6' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Ngân hàng:</span>
                  <strong style={{ color: '#fff' }}>MB Bank (Quân Đội)</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Số tài khoản:</span>
                  <strong style={{ color: '#10b981' }}>0988 776 655</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Số tiền:</span>
                  <strong style={{ color: '#10b981', fontSize: '15px' }}>{formatVnd(finalTotal)}</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: '#94a3b8' }}>Nội dung chuyển khoản:</span>
                  <strong style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.15)', padding: '0 6px', borderRadius: '4px' }}>EZ9948</strong>
                </div>
              </div>

              <div style={{ color: '#f59e0b', fontSize: '13px', fontWeight: '700', marginBottom: '16px' }}>
                ⏳ Hết hạn trong: {formatTimer(countdown)}
              </div>

              <button
                type="button"
                className="ez-btn-action"
                style={{ width: '100%', padding: '12px', fontSize: '15px' }}
                onClick={handleSimulatePaymentDone}
                disabled={isProcessingPayment}
              >
                {isProcessingPayment ? '🔄 Đang xác thực với SePay...' : '✅ Tôi Đã Chuyển Khoản (Xác Nhận Tức Thì)'}
              </button>
            </div>
          )}

          {paymentStep === 'success' && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ fontSize: '56px', marginBottom: '12px' }}>🎉</div>
              <h3 style={{ fontSize: '20px', fontWeight: '800', color: '#fff', margin: '0 0 8px' }}>Thanh Toán Hoàn Tất!</h3>
              <p style={{ color: '#94a3b8', fontSize: '14px', lineHeight: '1.6', marginBottom: '24px' }}>
                Hệ thống tự động kích hoạt key bản quyền và mở quyền tải ngay lập tức cho tài khoản của bạn.
              </p>

              <div style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '12px', padding: '16px', textAlign: 'left', marginBottom: '24px' }}>
                <span style={{ color: '#10b981', fontSize: '13px', fontWeight: '700' }}>🔑 License Key Kích Hoạt Của Bạn:</span>
                <div style={{ background: '#000', padding: '10px', borderRadius: '8px', marginTop: '6px', fontFamily: 'monospace', color: '#06b6d4', fontSize: '14px', wordBreak: 'break-all' }}>
                  EZ-KEY-2026-X992-8871-VAULT
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  type="button"
                  className="ez-btn-action"
                  style={{ flex: 1, padding: '10px' }}
                  onClick={() => {
                    onClearCart();
                    onClose();
                  }}
                >
                  Đến Tủ Đồ (My Vault)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Drawer Footer (Only on Cart view) */}
        {paymentStep === 'cart' && items.length > 0 && (
          <div style={{ padding: '20px 24px', borderTop: '1px solid var(--ez-glass-border)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <button
              type="button"
              className="ez-btn-action"
              style={{ width: '100%', padding: '14px', fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
              onClick={() => setPaymentStep('checkout')}
            >
              <span>⚡ Tiến Hành Thanh Toán VietQR</span>
              <span>({formatVnd(finalTotal)})</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
