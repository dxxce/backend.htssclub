import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../types/jwt-payload';

/**
 * Extracts the authenticated user attached by JwtAuthGuard (req.user)
 * or WsJwtGuard (socket.data.user).
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | any => {
    let user: AuthUser | undefined;
    if (ctx.getType() === 'ws') {
      user = ctx.switchToWs().getClient().data?.user;
    } else {
      user = ctx.switchToHttp().getRequest().user;
    }
    return data && user ? user[data] : user;
  },
);
