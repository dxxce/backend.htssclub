import { ConfigService } from '@nestjs/config';
import { SfuService } from './sfu.service';

describe('SfuService', () => {
  function build(values: Record<string, any>): SfuService {
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService;
    return new SfuService(config);
  }

  it('is disabled when LiveKit is not configured', () => {
    const sfu = build({ 'voice.sfuThreshold': 8 });
    expect(sfu.isEnabled()).toBe(false);
  });

  it('is enabled when url/key/secret are present', () => {
    const sfu = build({
      'voice.livekit.url': 'ws://localhost:7880',
      'voice.livekit.apiKey': 'devkey',
      'voice.livekit.apiSecret': 'secret',
    });
    expect(sfu.isEnabled()).toBe(true);
  });

  it('returns null token when disabled', async () => {
    const sfu = build({});
    await expect(sfu.createToken('chan1', 'user1')).resolves.toBeNull();
  });

  it('mints a token when enabled', async () => {
    const sfu = build({
      'voice.livekit.url': 'ws://localhost:7880',
      'voice.livekit.apiKey': 'devkey',
      'voice.livekit.apiSecret': 'secret',
    });
    const creds = await sfu.createToken('chan1', 'user1', 'Alice');
    expect(creds).not.toBeNull();
    expect(creds!.room).toBe('voice_chan1');
    expect(creds!.url).toBe('ws://localhost:7880');
    expect(creds!.identity).toBe('user1');
    expect(typeof creds!.token).toBe('string');
    expect(creds!.token.length).toBeGreaterThan(0);
  });
});
