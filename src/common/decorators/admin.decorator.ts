import { SetMetadata } from '@nestjs/common';

export const IS_ADMIN_KEY = 'isAdminRoute';

/**
 * Marks a route as requiring a platform admin user.
 * Enforced by AdminGuard.
 */
export const AdminOnly = () => SetMetadata(IS_ADMIN_KEY, true);
