export interface JwtAccessPayload {
  sub: string; // user id
  username: string;
  role?: string;
  type: 'access';
}

export interface JwtRefreshPayload {
  sub: string; // user id
  sid: string; // session id
  type: 'refresh';
}

export interface AuthUser {
  id: string;
  username: string;
  role?: string;
}
