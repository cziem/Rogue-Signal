import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import type { YouTubeService } from '../src/youtube/service.js';
import { UserFacingError } from '../src/errors.js';

const status = {
  videoId: 'vid00000001',
  privacyStatus: 'private',
  publishAt: '2026-11-01T00:00:00.000Z',
  studioUrl: 'https://studio.youtube.com/video/vid00000001/edit',
  watchUrl: 'https://www.youtube.com/watch?v=vid00000001',
  notes: [],
};

function mockService() {
  return {
    uploadVideo: vi.fn(() =>
      Promise.resolve({
        videoId: 'vid00000001',
        privacyStatus: 'private',
        studioUrl: status.studioUrl,
        watchUrl: status.watchUrl,
        uploadStatus: 'uploaded',
        processingStatus: 'processing',
        bytesUploaded: 10,
        playlistItemId: undefined,
        thumbnailSet: false,
        warnings: [],
      }),
    ),
    schedulePublish: vi.fn(() => Promise.resolve(status)),
    makePublic: vi.fn(() =>
      Promise.resolve({ ...status, privacyStatus: 'public', publishAt: undefined }),
    ),
    updateMetadata: vi.fn(() =>
      Promise.resolve({
        videoId: 'vid00000001',
        snippet: { title: 'T', description: 'D', tags: [] },
        studioUrl: status.studioUrl,
      }),
    ),
    setThumbnail: vi.fn(),
    createPlaylist: vi.fn(),
    listPlaylists: vi.fn(() =>
      Promise.resolve({ items: [], nextPageToken: undefined, totalResults: 0 }),
    ),
    addToPlaylist: vi.fn(),
    listVideos: vi.fn(() => Promise.reject(new UserFacingError('quota gone', 'quota_exceeded'))),
    getVideoStatus: vi.fn(() => Promise.resolve(status)),
  };
}

describe('MCP server tools', () => {
  let client: Client;
  let service: ReturnType<typeof mockService>;

  beforeEach(async () => {
    service = mockService();
    const server = createMcpServer(() => Promise.resolve(service as unknown as YouTubeService));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });
  afterEach(async () => {
    await client.close();
  });

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }) as Promise<CallToolResult>;

  it('exposes every tool with annotations and output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_to_playlist',
        'create_playlist',
        'get_video_status',
        'list_playlists',
        'list_videos',
        'make_public',
        'schedule_publish',
        'set_thumbnail',
        'update_metadata',
        'upload_video',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toBeDefined();
    }
    const upload = tools.find((t) => t.name === 'upload_video');
    expect(upload?.description).toMatch(/ALWAYS uploads as private/);
    expect(JSON.stringify(upload?.inputSchema)).not.toContain('privacyStatus');
    const schedule = tools.find((t) => t.name === 'schedule_publish');
    expect(schedule?.description).toMatch(/ONLY call this after the human has explicitly/);
    expect(tools.find((t) => t.name === 'make_public')?.annotations?.destructiveHint).toBe(true);
  });

  it('upload_video applies defaults and returns structured output', async () => {
    const result = await call('upload_video', {
      source: { url: 'https://cdn.example.com/a.mp4' },
      title: 'Kill Switch Ep 3',
    });
    expect(result.isError).toBeFalsy();
    expect(service.uploadVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        madeForKids: false,
        containsSyntheticMedia: true,
        categoryId: '24',
        tags: [],
        description: '',
      }),
      undefined,
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      videoId: 'vid00000001',
      privacyStatus: 'private',
    });
    expect((result.structuredContent as { nextStep: string }).nextStep).toMatch(/PRIVATE/);
  });

  it('upload_video ignores attempts to pass a privacyStatus', async () => {
    await call('upload_video', {
      source: { url: 'https://cdn.example.com/a.mp4' },
      title: 'x',
      privacyStatus: 'public',
    });
    const [firstArg] = service.uploadVideo.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(firstArg).not.toHaveProperty('privacyStatus');
  });

  it('schedule_publish and make_public require confirm: true', async () => {
    for (const args of [{}, { confirm: false }, { confirm: 'true' }]) {
      const r1 = await call('schedule_publish', {
        videoId: 'vid00000001',
        publishAt: '2026-11-01T00:00:00Z',
        ...args,
      });
      expect(r1.isError).toBe(true);
      const r2 = await call('make_public', { videoId: 'vid00000001', ...args });
      expect(r2.isError).toBe(true);
    }
    expect(service.schedulePublish).not.toHaveBeenCalled();
    expect(service.makePublic).not.toHaveBeenCalled();

    const ok = await call('schedule_publish', {
      videoId: 'vid00000001',
      publishAt: '2026-11-01T00:00:00Z',
      confirm: true,
    });
    expect(ok.isError).toBeFalsy();
    expect(service.schedulePublish).toHaveBeenCalledWith('vid00000001', '2026-11-01T00:00:00Z');
    const pub = await call('make_public', { videoId: 'vid00000001', confirm: true });
    expect(pub.structuredContent).toMatchObject({ privacyStatus: 'public' });
  });

  it('schedule_publish rejects timestamps without timezone', async () => {
    const result = await call('schedule_publish', {
      videoId: 'vid00000001',
      publishAt: '2026-11-01 10:00',
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(service.schedulePublish).not.toHaveBeenCalled();
  });

  it('update_metadata parses chapter timestamps', async () => {
    await call('update_metadata', {
      videoId: 'vid00000001',
      chapters: [
        { start: '0:00', title: 'A' },
        { start: '1:30', title: 'B' },
        { start: 300, title: 'C' },
      ],
    });
    expect(service.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        chapters: [
          { startSeconds: 0, title: 'A' },
          { startSeconds: 90, title: 'B' },
          { startSeconds: 300, title: 'C' },
        ],
      }),
    );
  });

  it('returns user-facing errors as isError results', async () => {
    const result = await call('list_videos', {});
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'quota gone' }]);
  });

  it('validates inputs', async () => {
    const result = await call('get_video_status', { videoId: 'bad id!' });
    expect(result.isError).toBe(true);
    expect(service.getVideoStatus).not.toHaveBeenCalled();
  });
});
