import { describe, it, expect, vi } from "vitest";
import { tryClickTurnstile } from "../src/services/upstream/download-via-browser.js";

describe("Cloudflare Turnstile Click Emulator", () => {
  it("trả về false và không crash khi không tìm thấy iframe Turnstile hoặc widget", async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue(null),
      mouse: {
        move: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const clicked = await tryClickTurnstile(mockPage);
    expect(clicked).toBe(false);
    expect(mockPage.mouse.click).not.toHaveBeenCalled();
  });

  it("tìm thấy tọa độ widget Turnstile và thực hiện di chuyển chuột & click thành công", async () => {
    const mockPage = {
      evaluate: vi.fn().mockResolvedValue({ x: 150, y: 320 }),
      mouse: {
        move: vi.fn().mockResolvedValue(undefined),
        click: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const clicked = await tryClickTurnstile(mockPage);
    expect(clicked).toBe(true);
    expect(mockPage.mouse.move).toHaveBeenCalled();
    expect(mockPage.mouse.click).toHaveBeenCalledWith(150, 320);
  });
});
