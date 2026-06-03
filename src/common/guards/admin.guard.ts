import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { AuthUser } from '../types/jwt-payload';

/**
 * Allows access only to platform admins. Must be used after JwtAuthGuard
 * so that `req.user` is populated. Verifies the `isAdmin` flag in the DB.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authUser = req.user as AuthUser | undefined;
    if (!authUser) throw new ForbiddenException('Unauthorized');
    const user = await this.users.findById(authUser.id);
    if (!user || !user.isAdmin) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
