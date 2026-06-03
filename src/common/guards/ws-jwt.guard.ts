import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { AuthService } from '../../auth/auth.service';
import { AuthUser } from '../types/jwt-payload';

/**
 * Authenticates a Socket.IO client using the access token supplied in
 * `socket.handshake.auth.token` (or `Authorization` header). On success
 * attaches `socket.data.user`.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient<Socket>();
    // Already authenticated during connection handshake.
    if (client.data?.user) return true;
    const user = await WsJwtGuard.authenticate(client, this.auth);
    if (!user) {
      throw new WsException('Unauthorized');
    }
    client.data.user = user;
    return true;
  }

  static extractToken(client: Socket): string | undefined {
    const auth = client.handshake?.auth as Record<string, any> | undefined;
    if (auth?.token) return String(auth.token).replace(/^Bearer\s+/i, '');
    const header =
      client.handshake?.headers?.authorization ||
      (client.handshake?.query?.token as string | undefined);
    if (header) return String(header).replace(/^Bearer\s+/i, '');
    return undefined;
  }

  static async authenticate(
    client: Socket,
    auth: AuthService,
  ): Promise<AuthUser | null> {
    const token = WsJwtGuard.extractToken(client);
    if (!token) return null;
    try {
      const payload = await auth.verifyAccessToken(token);
      return {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
      };
    } catch {
      return null;
    }
  }
}
