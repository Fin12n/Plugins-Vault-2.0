import { launch } from 'cloakbrowser/puppeteer';

interface FingerprintData {
    webdriver: boolean | undefined;
    hasChrome: boolean;
    pluginsCount: number;
    hardwareConcurrency: number;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// Thông tin tài khoản kiểm thử do bạn cung cấp
const TEST_ACCOUNT = {
    username: 'fluid46@gmail.com',
    password: '007007win',
};

process.on('unhandledRejection', (reason) => {
    console.warn('⚠️ Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.warn('⚠️ Uncaught Exception:', err);
});

/**
 * Click chuột siêu tốc & an toàn qua CDP
 */
async function clickViaCDP(page: any, x: number, y: number, label = 'Tọa độ'): Promise<void> {
    console.log(`🎯 Di chuyển & Click tại ${label} (X=${x.toFixed(1)}, Y=${y.toFixed(1)})...`);
    try {
        const client = await page.target().createCDPSession();
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: Math.round(x),
            y: Math.round(y),
        });
        await sleep(100);
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
            clickCount: 1,
        });
        await sleep(120);
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: Math.round(x),
            y: Math.round(y),
            button: 'left',
            clickCount: 1,
        });
        await client.detach().catch(() => { });
        console.log(`✓ Đã gửi sự kiện Click phần cứng (CDP) thành công!`);
    } catch (cdpErr) {
        console.warn(`⚠️ CDP Click lỗi:`, cdpErr);
    }
}

/**
 * Tự động phát hiện và giải quyết Cloudflare Turnstile Challenge
 */
async function solveTurnstileIfPresent(page: any, contextLabel: string): Promise<boolean> {
    console.log(`🔍 [${contextLabel}] Đang kiểm tra Cloudflare Challenge / Turnstile...`);
    await sleep(1500);
    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');
    const isBlocked =
        title.includes('Just a moment') ||
        title.includes('Security') ||
        title.includes('verification') ||
        content.includes('challenge-platform') ||
        content.includes('cf-turnstile');

    if (!isBlocked) {
        console.log(`✓ [${contextLabel}] Không vướng Cloudflare Challenge.`);
        return false;
    }

    console.log(`👉 [${contextLabel}] Phát hiện Cloudflare: "${title}"! Đang quét Turnstile Frame qua CDP...`);
    let clicked = false;
    for (let poll = 1; poll <= 15; poll++) {
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
            if (
                frameUrl.includes('challenges.cloudflare.com') ||
                frameUrl.includes('challenge-platform') ||
                frameUrl.includes('turnstile')
            ) {
                try {
                    const frameEl = await frame.frameElement();
                    if (frameEl) {
                        const box = await frameEl.boundingBox();
                        if (box && box.width > 0 && box.height > 0) {
                            const clickX = box.x + 30;
                            const clickY = box.y + box.height / 2;
                            console.log(`📍 [${contextLabel}] Phát hiện Turnstile Box: X=${box.x.toFixed(1)}, Y=${box.y.toFixed(1)}`);
                            await clickViaCDP(page, clickX, clickY, `Hộp kiểm Turnstile (${contextLabel})`);
                            clicked = true;
                            break;
                        }
                    }
                } catch { }
            }
        }
        if (clicked) break;
        console.log(`⏳ [${contextLabel}] Đang đợi Turnstile Frame (giây ${poll}/15)...`);
        await sleep(1000);
    }

    if (clicked) {
        console.log(`⏳ [${contextLabel}] Đợi 4 giây để Cloudflare hoàn tất cấp phép...`);
        await sleep(4000);
    }
    return clicked;
}

(async (): Promise<void> => {
    console.log('====================================================');
    console.log('🚀 BẬT CỬA SỔ TRÌNH DUYỆT CHROMIUM TRÊN MÀN HÌNH');
    console.log(`👤 Tài khoản: ${TEST_ACCOUNT.username} | Mật khẩu: ******`);
    console.log('====================================================');

    console.log('[1/3] Đang khởi chạy Chromium GUI của CloakBrowser (MỞ TRỰC TIẾP TRÊN DESKTOP)...');
    console.log('⚡ Sử dụng Free Stealth Engine (C++ anti-detect, không phụ thuộc license server, không lo session limit)...');

    const browser = await launch({
        headless: false, // BẮT BUỘC MỞ CỬA SỔ TRỰC QUAN TRÊN WINDOWS DESKTOP
        // humanize: true, 
        // humanPreset: 'careful',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-position=100,60',
            '--window-size=1450,920',
        ],
        defaultViewport: null, // Sử dụng toàn bộ khung nhìn thật của cửa sổ
    });

    try {
        const pages = await browser.pages();
        const page = pages[0] || (await browser.newPage());
        page.setDefaultNavigationTimeout(60000);

        // Mở trực tiếp trang /login
        console.log('\n[2/3] 🔑 Đang điều hướng đến: https://www.spigotmc.org/login...');
        await page.goto('https://www.spigotmc.org/login', { waitUntil: 'load' }).catch((e) => {
            console.warn('⚠️ Ghi nhận điều hướng ban đầu:', e instanceof Error ? e.message : String(e));
        });

        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => { });
        console.log(`* URL hiện tại: "${page.url()}"`);
        console.log(`* Tiêu đề: "${await page.title().catch(() => '')}"`);

        const ARTIFACT_DIR = 'C:/Users/Fin12n/.gemini/antigravity-ide/brain/42c1a023-2a49-4325-ba49-304a42dec82d';

        // Giải Turnstile nếu có
        await solveTurnstileIfPresent(page, 'Trang /login');
        await page.screenshot({ path: `${ARTIFACT_DIR}/spigot_step1_ready.png` }).catch(() => { });

        // Điền form đăng nhập
        console.log('\n[3/3] ✍️ Đang tự động điền tài khoản & mật khẩu vào Form...');
        let formReady = false;
        for (let i = 1; i <= 15; i++) {
            formReady = await page.evaluate((): boolean => {
                const loginInput =
                    document.querySelector('#ctrl_pageLogin_login') ||
                    document.querySelector('input[name="login"]');
                const passwordInput =
                    document.querySelector('#ctrl_pageLogin_password') ||
                    document.querySelector('input[name="password"]');
                return !!(loginInput && passwordInput);
            }).catch(() => false);
            if (formReady) break;
            await sleep(1000);
        }

        if (formReady) {
            console.log('✓ Đã tìm thấy các trường đăng nhập trên trang!');

            // 1. Đảm bảo chọn radio "Yes, my password is:" (id="ctrl_pageLogin_registered", value="0")
            await page.evaluate(() => {
                const regYes = document.querySelector('#ctrl_pageLogin_registered') as HTMLInputElement | null;
                if (regYes) regYes.checked = true;

                const remBox = document.querySelector('#ctrl_pageLogin_remember') as HTMLInputElement | null;
                if (remBox) remBox.checked = true;
            });

            // 2. Điền username & password bằng page.type trực tiếp vào #pageLogin
            console.log(`⌨️ Đang gõ tài khoản: "${TEST_ACCOUNT.username}"...`);
            await page.click('#pageLogin #ctrl_pageLogin_login');
            await page.type('#pageLogin #ctrl_pageLogin_login', TEST_ACCOUNT.username, { delay: 20 });

            console.log(`⌨️ Đang gõ mật khẩu: ******...`);
            await page.click('#pageLogin #ctrl_pageLogin_password');
            await page.type('#pageLogin #ctrl_pageLogin_password', TEST_ACCOUNT.password, { delay: 20 });

            console.log(`✓ Đã điền xong tài khoản & mật khẩu vào form!`);
            await page.screenshot({ path: `${ARTIFACT_DIR}/spigot_step2_filled.png` }).catch(() => { });
        }

        console.log('\n====================================================');
        console.log('👉 Form đăng nhập đã được điền sẵn: fluid46@gmail.com');
        console.log('👉 Đang nhấn nút [Log in]...');
        console.log('====================================================');

        await sleep(1500);

        console.log('🖱️ Đang nhấn nút "Log in"...');
        await page.click('#pageLogin input.button.primary').catch(async () => {
            await page.evaluate(() => {
                const btn = document.querySelector('#pageLogin input[type="submit"]') as HTMLElement | null;
                if (btn) btn.click();
            });
        });
        console.log('✓ Đã nhấn nút [Log in] thành công!');

        // Đợi chuyển trang hoặc Turnstile hậu submit
        await sleep(3000);
        await solveTurnstileIfPresent(page, 'Hỗ trợ vượt Turnstile hậu Submit');
        await sleep(4000);

        const finalUrl = page.url();
        const finalTitle = await page.title().catch(() => '');
        console.log(`\n📌 [KẾT QUẢ ĐĂNG NHẬP]`);
        console.log(`* URL cuối cùng: "${finalUrl}"`);
        console.log(`* Tiêu đề trang: "${finalTitle}"`);

        // Chụp ảnh kết quả cuối cùng
        await page.screenshot({ path: `${ARTIFACT_DIR}/spigot_step3_result.png` }).catch(() => { });
        console.log('📸 Đã lưu toàn bộ ảnh chụp màn hình vào thư mục artifacts!');

        // Kiểm tra cookie đăng nhập xf_user
        const cookies = await page.cookies();
        const xfUser = cookies.find((c: any) => c.name === 'xf_user');
        if (xfUser) {
            console.log(`\n🎉🎉🎉 ĐĂNG NHẬP THÀNH CÔNG RỰC RỠ!`);
            console.log(`🔑 Cookie xf_user: ${xfUser.value.substring(0, 20)}...`);
        } else {
            console.log('\n⚠️ Chưa tìm thấy cookie xf_user (có thể sai mật khẩu hoặc cần xác thực thêm).');
        }

        await new Promise<void>((resolve) => {
            browser.on('disconnected', () => {
                clearInterval(monitorInterval);
                console.log('\n🚪 Bạn đã đóng cửa sổ trình duyệt.');
                resolve();
            });

            process.on('SIGINT', async () => {
                clearInterval(monitorInterval);
                console.log('\n🛑 Đã nhận lệnh Ctrl+C từ terminal. Đang tắt trình duyệt...');
                await browser.close().catch(() => { });
                resolve();
            });
        });
    } catch (err: unknown) {
        console.error('❌ Gặp lỗi:', err);
    }

    console.log('🔒 Tiến trình kết thúc an toàn.');
})();
