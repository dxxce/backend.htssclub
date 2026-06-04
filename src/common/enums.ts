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
  // Games: stake placed into a room pot, winnings paid out, stake refunded.
  GAME_STAKE = 'GAME_STAKE',
  GAME_PAYOUT = 'GAME_PAYOUT',
  GAME_REFUND = 'GAME_REFUND',
}

export enum GameType {
  CARO = 'CARO',
  TIENLEN = 'TIENLEN',
}

export enum GameMode {
  RANKED = 'RANKED', // affects rankPoints (RP), no coins
  WAGER = 'WAGER', // coin bet, winner takes the pot, no RP
  CASUAL = 'CASUAL', // no RP, no coins
}

export enum RoomStatus {
  WAITING = 'WAITING', // open lobby, accepting players
  STARTING = 'STARTING', // host pressed start, creating the game
  IN_PROGRESS = 'IN_PROGRESS', // game launched
  CLOSED = 'CLOSED', // finished or cancelled
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
