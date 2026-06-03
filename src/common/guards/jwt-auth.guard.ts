import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Protects REST routes. Validates the `Authorization: Bearer <token>`
 * access token via the 'jwt' passport strategy.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
