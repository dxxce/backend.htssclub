import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * Normalises ALL exceptions thrown from WebSocket handlers into a clean,
 * client-friendly payload: `{ success: false, error: { code, message } }`.
 *
 * - Delivers the error to the client's ack callback (if the event used one)
 *   AND emits an `exception` event so listeners catch it either way.
 * - Maps HttpException (NotFoundException/BadRequestException/etc.) to a
 *   sensible `code` so the frontend can show a localised message.
 * - Expected client errors (4xx / WsException) are logged at debug level so
 *   they don't spam the error log (fixes noisy "Room not found" ERRORs).
 */
@Catch()
export class WsExceptionsFilter extends BaseWsExceptionFilter {
  private readonly logger = new Logger(WsExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const data = host.switchToWs().getData();
    const callback = this.findAckCallback(host);

    const { code, message, isServerError } = this.describe(exception);
    const payload = { success: false, error: { code, message } };

    if (isServerError) {
      this.logger.error(
        `WS error: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.debug(`WS rejected: ${code} ${message}`);
    }

    // 1) Return the error via the ack callback if the client provided one.
    if (typeof callback === 'function') {
      try {
        callback(payload);
      } catch {
        // ignore callback failures
      }
    }
    // 2) Always emit an `exception` event so global listeners catch it too.
    if (client && typeof client.emit === 'function') {
      client.emit('exception', { code, message, data: this.safeData(data) });
    }
  }

  /**
   * Finds the ack callback among the handler args. NestJS's WsProxy invokes
   * the handler as `(data, ack, targetPattern)`, so the ack is NOT the last
   * arg (the pattern string is). Scan for the first function.
   */
  private findAckCallback(host: ArgumentsHost): unknown {
    const args = host.getArgs?.();
    if (Array.isArray(args)) {
      for (const a of args) {
        if (typeof a === 'function') return a;
      }
    }
    return undefined;
  }

  private safeData(data: unknown): unknown {
    try {
      // Avoid echoing huge / circular payloads back.
      if (data && typeof data === 'object') return data;
      return undefined;
    } catch {
      return undefined;
    }
  }

  private describe(exception: unknown): {
    code: string;
    message: string;
    isServerError: boolean;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      let message = exception.message;
      let code = this.statusToCode(status);
      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const r = res as Record<string, any>;
        message = Array.isArray(r.message)
          ? r.message.join(', ')
          : r.message || message;
        code = r.code || code;
      }
      return { code, message, isServerError: status >= 500 };
    }
    if (exception instanceof WsException) {
      const err = exception.getError();
      const message =
        typeof err === 'string' ? err : (err as any)?.message || 'Error';
      const code = (err as any)?.code || 'WS_ERROR';
      return { code, message, isServerError: false };
    }
    if (exception instanceof Error) {
      return {
        code: 'INTERNAL_ERROR',
        message: exception.message || 'Internal server error',
        isServerError: true,
      };
    }
    return {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      isServerError: true,
    };
  }

  private statusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMITED';
      default:
        return 'ERROR';
    }
  }
}
