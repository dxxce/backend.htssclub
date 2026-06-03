import { VoiceGateway } from './voice.gateway';

/**
 * Unit tests for VoiceGateway parts that don't need a live socket:
 * multi-socket leave behavior (LiveKit-only voice).
 */
describe('VoiceGateway logic', () => {
  let gateway: VoiceGateway;
  let presence: any;
  let sfu: any;
  let channels: any;
  let realtime: any;
  let emitted: { room: string; event: string; payload: any }[];

  beforeEach(() => {
    emitted = [];
    presence = {
      removeSocket: jest.fn(),
      count: jest.fn(),
      // No active stream by default.
      getState: jest.fn().mockResolvedValue({
        muted: false,
        deafened: false,
        speaking: false,
        streaming: false,
      }),
      setState: jest.fn().mockResolvedValue(undefined),
    };
    sfu = { isEnabled: jest.fn().mockReturnValue(true) };
    channels = {
      getServerIdOfChannel: jest.fn().mockResolvedValue(null),
    };
    realtime = { setVoiceServer: jest.fn(), emitToServer: jest.fn() };
    gateway = new VoiceGateway(
      {} as any, // auth
      channels,
      presence,
      {} as any, // users
      sfu,
      realtime as any,
    );
    gateway.server = {
      to: (room: string) => ({
        emit: (event: string, payload: any) =>
          emitted.push({ room, event, payload }),
      }),
    } as any;
  });

  describe('handleSocketLeave (multi-socket)', () => {
    it('does NOT broadcast user-left while other sockets remain', async () => {
      presence.removeSocket.mockResolvedValue({
        removedMember: false,
        remainingSockets: 1,
      });

      await (gateway as any).handleSocketLeave('chan1', 'user1', 'sockA');

      const left = emitted.filter((e) => e.event === 'voice:user-left');
      expect(left).toHaveLength(0);
    });

    it('broadcasts user-left only when the last socket leaves', async () => {
      presence.removeSocket.mockResolvedValue({
        removedMember: true,
        remainingSockets: 0,
      });

      await (gateway as any).handleSocketLeave('chan1', 'user1', 'sockB');

      const left = emitted.filter((e) => e.event === 'voice:user-left');
      expect(left).toHaveLength(1);
      expect(left[0].payload).toEqual({ channelId: 'chan1', userId: 'user1' });
    });
  });

  describe('stopStreaming', () => {
    it('does nothing when the user is not streaming', async () => {
      presence.getState.mockResolvedValue({ streaming: false });
      await (gateway as any).stopStreaming('chan1', 'user1');
      expect(presence.setState).not.toHaveBeenCalled();
      expect(emitted.filter((e) => e.event === 'stream:stopped')).toHaveLength(0);
    });

    it('broadcasts stream:stopped when the user was streaming', async () => {
      presence.getState.mockResolvedValue({
        muted: false, deafened: false, speaking: false, streaming: true,
      });
      await (gateway as any).stopStreaming('chan1', 'user1');
      expect(presence.setState).toHaveBeenCalled();
      const stopped = emitted.filter((e) => e.event === 'stream:stopped');
      expect(stopped).toHaveLength(1);
      expect(stopped[0].payload).toEqual({ channelId: 'chan1', userId: 'user1' });
    });
  });
});
