export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  mongoUri: string;
  redisUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
    resetPasswordTtl: string;
  };
  cookie: {
    refreshName: string;
    secure: boolean;
    domain?: string;
  };
  upload: {
    driver: 'local' | 's3';
    localDir: string;
    publicBaseUrl: string;
    avatarMaxBytes: number;
    attachmentMaxBytes: number;
    videoMaxBytes: number;
    s3: {
      endpoint?: string;
      region: string;
      bucket?: string;
      accessKey?: string;
      secretKey?: string;
      publicBaseUrl?: string;
    };
  };
  voice: {
    sfuThreshold: number;
    livekit: {
      url?: string;
      apiKey?: string;
      apiSecret?: string;
    };
  };
  defaultServer: {
    id?: string;
    ownerId?: string;
  };
  dm: {
    encryptionKey: string;
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiPrefix: process.env.API_PREFIX || 'api',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  mongoUri:
    process.env.MONGO_URI ||
    'mongodb://127.0.0.1:27017/htss_club?replicaSet=rs0',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    resetPasswordTtl: process.env.RESET_PASSWORD_TTL || '30m',
  },
  cookie: {
    refreshName: process.env.REFRESH_COOKIE_NAME || 'refresh_token',
    secure: (process.env.COOKIE_SECURE || 'false') === 'true',
    domain: process.env.COOKIE_DOMAIN || undefined,
  },
  upload: {
    driver: (process.env.UPLOAD_DRIVER as 'local' | 's3') || 'local',
    localDir: process.env.UPLOAD_LOCAL_DIR || './uploads-store',
    publicBaseUrl:
      process.env.UPLOAD_PUBLIC_BASE_URL || 'http://localhost:3000/static',
    avatarMaxBytes: parseInt(process.env.AVATAR_MAX_BYTES || '5242880', 10),
    attachmentMaxBytes: parseInt(
      process.env.ATTACHMENT_MAX_BYTES || '26214400',
      10,
    ),
    videoMaxBytes: parseInt(
      process.env.VIDEO_MAX_BYTES || '209715200',
      10,
    ),
    s3: {
      endpoint: process.env.S3_ENDPOINT || undefined,
      region: process.env.S3_REGION || 'us-east-1',
      bucket: process.env.S3_BUCKET || undefined,
      accessKey: process.env.S3_ACCESS_KEY || undefined,
      secretKey: process.env.S3_SECRET_KEY || undefined,
      publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || undefined,
    },
  },
  voice: {
    // When a voice channel reaches this many participants, the gateway
    // switches that channel from mesh P2P to SFU (LiveKit) mode.
    sfuThreshold: parseInt(process.env.VOICE_SFU_THRESHOLD || '8', 10),
    livekit: {
      url: process.env.LIVEKIT_URL || undefined,
      apiKey: process.env.LIVEKIT_API_KEY || undefined,
      apiSecret: process.env.LIVEKIT_API_SECRET || undefined,
    },
  },
  defaultServer: {
    // New users are auto-joined to this server and cannot leave it.
    id: process.env.DEFAULT_SERVER_ID || undefined,
    // Used when bootstrapping the default server if it does not exist yet.
    ownerId: process.env.DEFAULT_SERVER_OWNER_ID || undefined,
  },
  dm: {
    // At-rest encryption key for direct messages (Discord-style: server can
    // read content; encrypted on disk). Use a 32-byte key (base64 or hex).
    encryptionKey:
      process.env.DM_ENCRYPTION_KEY || 'dev_dm_encryption_key_change_me_32b',
  },
});
