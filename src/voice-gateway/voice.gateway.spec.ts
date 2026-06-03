import { VoiceGateway } from './voice.gateway';

/**
 * Unit tests for the parts of VoiceGateway that don't need a live socket:
 * mode resolution and the multi-socket leave behavior.
 */
describe('VoiceGateway logic', () => {
  let gateway: VoiceGateway;
  let presence: any;
  let sfu: any;
  let emitted: { room: string; event: string; payload: any }[];

  beforeEach(() => {
    emitted = [];
    presence = {
      removeSocket: jest.fn(),
      count: jest.fn(),
    };
    sfu = {
      isEnabled: jest.fn().mockReturnValue(true),
      threshold: 8,
    };
    const realtime = { setVoiceServer: jest.fn() };
    gateway = new VoiceGateway(
      {} as any, // auth
      {} as any, // channels
      presence,
      {} as any, // users
      sfu,
      realtime as any,
    );
    // Fake socket.io server capturing emits.
    gateway.server = {
      to: (room: string) => ({
        emit: (event: string, payload: any) =>
          emitted.push({ room, event, payload }),
      }),
    } as any;
  });

  describe('resolveMode', () => {
    it('uses mesh below the threshold', () => {
      expect((gateway as any).resolveMode(3)).toBe('mesh');
    });

    it('switches to sfu at/above the threshold', () => {
      expect((gateway as any).resolveMode(8)).toBe('sfu');
      expect((gateway as any).resolveMode(20)).toBe('sfu');
    });

    it('stays mesh when SFU is disabled even above threshold', () => {
      sfu.isEnabled.mockReturnValue(false);
      expect((gateway as any).resolveMode(50)).toBe('mesh');
    });
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
      presence.count.mockResolvedValue(2);

      await (gateway as any).handleSocketLeave('chan1', 'user1', 'sockB');

      const left = emitted.filter((e) => e.event === 'voice:user-left');
      expect(left).toHaveLength(1);
      expect(left[0].payload).toEqual({ channelId: 'chan1', userId: 'user1' });
    });
  });
});
