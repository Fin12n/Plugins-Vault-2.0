import { describe, it, expect, vi } from "vitest";
import { syncRolesForMember } from "../src/services/roles/role-sync.js";

describe("Role Sync Service (Discord Roles from Purchases)", () => {
  it("trả về thông báo lỗi khi không tìm thấy Guild", async () => {
    const mockClient = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(null),
      },
    } as any;

    const mockNeonDb = {} as any;
    const res = await syncRolesForMember(
      mockClient,
      "guild-123",
      "user-456",
      mockNeonDb
    );

    expect(res.success).toBe(false);
    expect(res.message).toBe("Không tìm thấy Discord Server");
  });

  it("gán role Khách Hàng khi người dùng có đơn hàng thành công", async () => {
    const mockBuyerRole = { id: "role-buyer", name: "Khách Hàng" };
    const mockMember = {
      id: "user-456",
      roles: {
        cache: new Map(),
        add: vi.fn().mockResolvedValue(undefined),
      },
    };

    const mockGuild = {
      id: "guild-123",
      members: {
        fetch: vi.fn().mockResolvedValue(mockMember),
      },
      roles: {
        cache: [mockBuyerRole],
      },
    };

    const mockClient = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(mockGuild),
      },
    } as any;

    // Giả lập Neon DB trả về 1 đơn hàng đã thanh toán 50.000 VNĐ
    const mockNeonDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 1, amount: 50000 }]),
        }),
      }),
    } as any;

    const res = await syncRolesForMember(
      mockClient,
      "guild-123",
      "user-456",
      mockNeonDb
    );

    expect(res.success).toBe(true);
    expect(res.assignedRoles).toContain("Khách Hàng");
    expect(mockMember.roles.add).toHaveBeenCalledWith(mockBuyerRole);
  });

  it("gán cả role VIP/Gold khi người dùng chi tiêu trên 200.000 VNĐ", async () => {
    const mockBuyerRole = { id: "role-buyer", name: "Khách Hàng" };
    const mockVipRole = { id: "role-vip", name: "VIP Member" };
    const mockMember = {
      id: "user-456",
      roles: {
        cache: new Map(),
        add: vi.fn().mockResolvedValue(undefined),
      },
    };

    const mockGuild = {
      id: "guild-123",
      members: {
        fetch: vi.fn().mockResolvedValue(mockMember),
      },
      roles: {
        cache: [mockBuyerRole, mockVipRole],
      },
    };

    const mockClient = {
      guilds: {
        fetch: vi.fn().mockResolvedValue(mockGuild),
      },
    } as any;

    // Giả lập Neon DB trả về 2 đơn hàng với tổng chi tiêu = 250.000 VNĐ
    const mockNeonDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: 1, amount: 150000 },
            { id: 2, amount: 100000 },
          ]),
        }),
      }),
    } as any;

    const res = await syncRolesForMember(
      mockClient,
      "guild-123",
      "user-456",
      mockNeonDb
    );

    expect(res.success).toBe(true);
    expect(res.assignedRoles).toContain("Khách Hàng");
    expect(res.assignedRoles).toContain("VIP Member");
    expect(mockMember.roles.add).toHaveBeenCalledTimes(2);
  });
});
