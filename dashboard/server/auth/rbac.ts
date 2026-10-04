import type { FastifyRequest, FastifyReply } from 'fastify';
import type { SessionRole } from './session.js';

/**
 * Pre-handler kiểm tra vai trò người dùng (RBAC)
 * - 'owner' luôn có toàn quyền trên mọi endpoint
 * - Người dùng chỉ được phép truy cập nếu vai trò thuộc danh sách allowedRoles
 */
export function requireRole(allowedRoles: SessionRole[]) {
  return async function rbacPreHandler(request: FastifyRequest, reply: FastifyReply) {
    const user = request.sessionUser;
    if (!user) {
      return reply.code(401).send({ error: 'Chưa đăng nhập' });
    }

    const userRole = user.role;
    const isAuthorized = userRole === 'owner' || allowedRoles.includes(userRole);
    if (!isAuthorized) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Bạn không có quyền thực hiện thao tác này',
        requiredRoles: allowedRoles,
      });
    }
  };
}
