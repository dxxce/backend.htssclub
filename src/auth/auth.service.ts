import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import { Model, Types } from 'mongoose';
import { randomUUID, createHash } from 'crypto';
import { AccountStatus } from '../common/enums';
import {
  JwtAccessPayload,
  JwtRefreshPayload,
} from '../common/types/jwt-payload';
import { UsersService } from '../users/users.service';
import { UserDocument } from '../users/schemas/user.schema';
import { ServersService } from '../servers/servers.service';
import { Session, SessionDocument } from './schemas/session.schema';
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
} from './dto/auth.dto';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface AuthResult {
  user: UserDocument;
  tokens: IssuedTokens;
}

interface SessionContext {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly servers: ServersService,
    @InjectModel(Session.name)
    private readonly sessionModel: Model<SessionDocument>,
  ) {}

  // ── Public flows ──────────────────────────────────────────────
  async register(dto: RegisterDto, ctx: SessionContext): Promise<AuthResult> {
    const email = dto.email.toLowerCase();
    const existing = await this.users.model.findOne({
      $or: [{ email }, { username: dto.username }],
    });
    if (existing) {
      throw new ConflictException('Username or email already in use');
    }
    const passwordHash = await argon2.hash(dto.password);
    const user = await this.users.create({
      username: dto.username,
      email,
      passwordHash,
      displayName: dto.displayName || dto.username,
    });
    // Auto-join the platform default server (best-effort; never blocks
    // registration if the default server is unavailable).
    try {
      await this.servers.addUserToDefaultServer(user._id);
    } catch (err) {
      this.logger.warn(
        `Could not add new user to default server: ${(err as Error).message}`,
      );
    }
    const tokens = await this.issueTokensForUser(user, ctx);
    return { user, tokens };
  }

  async login(dto: LoginDto, ctx: SessionContext): Promise<AuthResult> {
    const user = await this.users.findByIdentifier(dto.identifier);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }
    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new UnauthorizedException('Invalid credentials');
    }
    this.assertLoginAllowed(user);
    const tokens = await this.issueTokensForUser(user, ctx);
    return { user, tokens };
  }

  async refresh(
    refreshToken: string | undefined,
    ctx: SessionContext,
  ): Promise<AuthResult> {
    if (!refreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }
    let payload: JwtRefreshPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtRefreshPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type');
    }

    const session = await this.sessionModel.findById(payload.sid);
    if (!session || session.userId.toString() !== payload.sub) {
      throw new UnauthorizedException('Session not found');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await session.deleteOne();
      throw new UnauthorizedException('Session expired');
    }
    const matches = session.refreshHash === this.hashToken(refreshToken);
    if (!matches) {
      // Token reuse / theft: revoke the session.
      await session.deleteOne();
      throw new UnauthorizedException('Refresh token mismatch');
    }

    const user = await this.users.findById(payload.sub);
    if (!user) throw new UnauthorizedException('User not found');
    this.assertLoginAllowed(user);

    // Rotate: issue new tokens and update the existing session in place.
    const tokens = await this.rotateSession(session, user, ctx);
    return { user, tokens };
  }

  async logout(sessionId: string): Promise<void> {
    if (!Types.ObjectId.isValid(sessionId)) return;
    await this.sessionModel.findByIdAndDelete(sessionId).exec();
  }

  async logoutByRefreshToken(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    try {
      const payload = await this.jwt.verifyAsync<JwtRefreshPayload>(
        refreshToken,
        { secret: this.config.get<string>('jwt.refreshSecret') },
      );
      await this.logout(payload.sid);
    } catch {
      // ignore invalid token on logout
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessionModel.deleteMany({ userId }).exec();
  }

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.users.findByIdOrThrow(userId);
    const valid = await argon2.verify(user.passwordHash, dto.oldPassword);
    if (!valid) {
      throw new UnauthorizedException('Old password is incorrect');
    }
    const passwordHash = await argon2.hash(dto.newPassword);
    await this.users.setPasswordHash(userId, passwordHash);
    // Revoke other sessions for safety.
    await this.logoutAll(userId);
  }

  /**
   * Issues a password reset token. In production this token would be
   * emailed. Here we return it so the flow is testable; the caller may
   * choose not to expose it.
   */
  async forgotPassword(email: string): Promise<string | null> {
    const user = await this.users.findByEmail(email);
    if (!user) {
      // Do not reveal whether the email exists.
      return null;
    }
    const token = await this.jwt.signAsync(
      { sub: user._id.toString(), type: 'reset' },
      {
        secret: this.resetSecret(),
        expiresIn: this.config.get<string>('jwt.resetPasswordTtl'),
      },
    );
    this.logger.log(`Password reset requested for ${email}`);
    return token;
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    let payload: { sub: string; type: string };
    try {
      payload = await this.jwt.verifyAsync(dto.token, {
        secret: this.resetSecret(),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
    if (payload.type !== 'reset') {
      throw new UnauthorizedException('Invalid token type');
    }
    const user = await this.users.findById(payload.sub);
    if (!user) throw new NotFoundException('User not found');
    const passwordHash = await argon2.hash(dto.newPassword);
    await this.users.setPasswordHash(user._id.toString(), passwordHash);
    await this.logoutAll(user._id.toString());
  }

  // ── Sessions listing ──────────────────────────────────────────
  async listSessions(userId: string): Promise<SessionDocument[]> {
    return this.sessionModel.find({ userId }).sort({ updatedAt: -1 }).exec();
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new NotFoundException('Session not found');
    }
    const session = await this.sessionModel.findById(sessionId);
    if (!session || session.userId.toString() !== userId) {
      throw new NotFoundException('Session not found');
    }
    await session.deleteOne();
  }

  // ── Token verification used by WsJwtGuard ─────────────────────
  async verifyAccessToken(token: string): Promise<JwtAccessPayload> {
    const payload = await this.jwt.verifyAsync<JwtAccessPayload>(token, {
      secret: this.config.get<string>('jwt.accessSecret'),
    });
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    return payload;
  }

  // ── Internals ─────────────────────────────────────────────────
  private assertLoginAllowed(user: UserDocument): void {
    if (user.status === AccountStatus.BANNED) {
      throw new ForbiddenException('Account is banned');
    }
    if (user.status === AccountStatus.SUSPENDED) {
      throw new ForbiddenException('Account is suspended');
    }
  }

  private async issueTokensForUser(
    user: UserDocument,
    ctx: SessionContext,
  ): Promise<IssuedTokens> {
    const sessionId = new Types.ObjectId();
    const { refreshToken, refreshExpiresAt } = await this.signRefresh(
      user._id.toString(),
      sessionId.toString(),
    );
    await this.sessionModel.create({
      _id: sessionId,
      userId: user._id,
      refreshHash: this.hashToken(refreshToken),
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      expiresAt: refreshExpiresAt,
    });
    const accessToken = await this.signAccess(user);
    return { accessToken, refreshToken, refreshExpiresAt };
  }

  private async rotateSession(
    session: SessionDocument,
    user: UserDocument,
    ctx: SessionContext,
  ): Promise<IssuedTokens> {
    const { refreshToken, refreshExpiresAt } = await this.signRefresh(
      user._id.toString(),
      session._id.toString(),
    );
    session.refreshHash = this.hashToken(refreshToken);
    session.expiresAt = refreshExpiresAt;
    if (ctx.userAgent) session.userAgent = ctx.userAgent;
    if (ctx.ip) session.ip = ctx.ip;
    await session.save();
    const accessToken = await this.signAccess(user);
    return { accessToken, refreshToken, refreshExpiresAt };
  }

  private async signAccess(user: UserDocument): Promise<string> {
    const payload: JwtAccessPayload = {
      sub: user._id.toString(),
      username: user.username,
      role: user.isAdmin ? 'ADMIN' : 'USER',
      type: 'access',
    };
    return this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.accessSecret'),
      expiresIn: this.config.get<string>('jwt.accessTtl'),
    });
  }

  private async signRefresh(
    userId: string,
    sessionId: string,
  ): Promise<{ refreshToken: string; refreshExpiresAt: Date }> {
    const payload: JwtRefreshPayload = {
      sub: userId,
      sid: sessionId,
      type: 'refresh',
    };
    const ttl = this.config.get<string>('jwt.refreshTtl') || '7d';
    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.config.get<string>('jwt.refreshSecret'),
      expiresIn: ttl,
      jwtid: randomUUID(),
    });
    const refreshExpiresAt = new Date(Date.now() + this.ttlToMs(ttl));
    return { refreshToken, refreshExpiresAt };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private resetSecret(): string {
    return (
      this.config.get<string>('jwt.accessSecret') +
      ':reset:' +
      this.config.get<string>('jwt.refreshSecret')
    );
  }

  private ttlToMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) return 7 * 24 * 60 * 60 * 1000;
    const value = parseInt(match[1], 10);
    const unit = match[2];
    const factor: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    return value * factor[unit];
  }
}
