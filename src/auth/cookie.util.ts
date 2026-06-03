import { ConfigService } from '@nestjs/config';
import { CookieOptions, Response } from 'express';

export function setRefreshCookie(
  res: Response,
  config: ConfigService,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(cookieName(config), token, buildOptions(config, expiresAt));
}

export function clearRefreshCookie(
  res: Response,
  config: ConfigService,
): void {
  const opts = buildOptions(config);
  delete opts.maxAge;
  delete opts.expires;
  res.clearCookie(cookieName(config), opts);
}

export function cookieName(config: ConfigService): string {
  return config.get<string>('cookie.refreshName') || 'refresh_token';
}

function buildOptions(
  config: ConfigService,
  expiresAt?: Date,
): CookieOptions {
  const secure = config.get<boolean>('cookie.secure') ?? false;
  const domain = config.get<string>('cookie.domain') || undefined;
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    domain,
    path: '/',
    expires: expiresAt,
  };
}
