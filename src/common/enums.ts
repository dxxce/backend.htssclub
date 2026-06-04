export enum AccountStatus {
  ACTIVE = 'ACTIVE',
  BANNED = 'BANNED',
  SUSPENDED = 'SUSPENDED',
  PENDING = 'PENDING',
}

export enum PresenceStatus {
  ONLINE = 'ONLINE',
  IDLE = 'IDLE',
  DND = 'DND',
  OFFLINE = 'OFFLINE',
}

export enum ChannelType {
  TEXT = 'TEXT',
  VOICE = 'VOICE',
}

export enum MemberRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
}

export enum FriendState {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  BLOCKED = 'BLOCKED',
}

export enum TxType {
  TOPUP = 'TOPUP',
  SPEND = 'SPEND',
  REWARD = 'REWARD',
  REFUND = 'REFUND',
  TRANSFER = 'TRANSFER',
}

export enum AttachmentCategory {
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  FILE = 'FILE',
}

export enum DmMessageType {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}
