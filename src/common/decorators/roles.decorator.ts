import { SetMetadata } from '@nestjs/common';
import { MemberRole } from '../enums';

export const SERVER_ROLES_KEY = 'serverRoles';

/**
 * Marks the minimum server role(s) allowed for a route. Used together
 * with ServerRolesGuard which resolves the caller's role in the server
 * identified by the `:id` / `:serverId` route param.
 */
export const ServerRoles = (...roles: MemberRole[]) =>
  SetMetadata(SERVER_ROLES_KEY, roles);
