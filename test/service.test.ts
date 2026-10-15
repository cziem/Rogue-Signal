import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubeService } from '../src/youtube/service.js';
import { data, fakeYouTube, googleError, type FakeYouTube } from './helpers.js';

const NOW = new Date('2026-10-15T12:00:00Z');

function uploadFetch(onInit?: (body: unknown) => void) {
  return vi.fn((input: URL | string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cdn.example.com/')) {
      return Promise.resolve(
        new Response('episode-bytes', {
          headers: { 'content-type': 'video/mp4', 'content-length': '13' },
        }),
      );
    }
    if (init?.method === 'POST') {
      onInit?.(JSON.parse(init.body as string));
      return Promise.resolve(
        new Response(null, { status: 200, headers: { location: 'https://upload.example/s' } }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: 'vid00000001',
          status: { privacyStatus: 'private', uploadStatus: 'uploaded' },
        }),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;
}

describe('YouTubeService', () => {
  let fake: FakeYouTube;
  let service: YouTubeService;
  let initBody: unknown;

  beforeEach(() => {
    const yt = fakeYouTube();
    fake = yt.fake;
    initBody = undefined;
    service = new YouTubeService({
      youtube: yt.youtube,
      getAccessToken: () => Promise.resolve('tok'),
      sourceOptions: {
        allowLocalPaths: false,
        resolveHost: () => Promise.resolve(['93.184.216.34']),
        fetch: uploadFetch(),
      },
      fetch: uploadFetch((b) => (initBody = b)),
      now: () => NOW,
    });
  });

  describe('uploadVideo', () => {
    it('always uploads private with synthetic-media disclosure', async () => {
      const result = await service.uploadVideo({
        source: { url: 'https://cdn.example.com/ep1.mp4' },
        title: 'Agent Wars Ep 1',
        description: 'Pilot',
        tags: ['#AgentWars', 'AI'],
        categoryId: '24',
        madeForKids: false,
        containsSyntheticMedia: true,
        defaultLanguage: 'en',
      });
      expect(initBody).toMatchObject({
        snippet: {
          title: 'Agent Wars Ep 1',
          tags: ['AgentWars', 'AI'],
          categoryId: '24',
          defaultLanguage: 'en',
        },
        status: {
          privacyStatus: 'private',
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: true,
        },
      });
      expect(result).toMatchObject({
        videoId: 'vid00000001',
        privacyStatus: 'private',
        studioUrl: 'https://studio.youtube.com/video/vid00000001/edit',
        bytesUploaded: 13,
        thumbnailSet: false,
        warnings: [],
      });
    });

    it('adds to a playlist and reports partial failures as warnings', async () => {
      fake.playlistItems.insert.mockRejectedValueOnce(googleError(404, 'playlistNotFound'));
      const result = await service.uploadVideo({
        source: { url: 'https://cdn.example.com/ep1.mp4' },
        title: 't',
        description: '',
        tags: [],
        categoryId: '24',
        madeForKids: false,
        containsSyntheticMedia: true,
        playlistId: 'PLmissing000',
      });
      expect(result.videoId).toBe('vid00000001');
      expect(result.warnings[0]).toMatch(/playlist failed.*list_playlists/);
    });
  });

  describe('schedulePublish', () => {
    it('rejects past or invalid timestamps before calling the API', async () => {
      await expect(
        service.schedulePublish('vid00000001', '2026-10-15T11:00:00Z'),
      ).rejects.toMatchObject({ code: 'invalid_publish_at' });
      await expect(service.schedulePublish('vid00000001', 'tomorrow')).rejects.toMatchObject({
        code: 'invalid_publish_at',
      });
      expect(fake.videos.update).not.toHaveBeenCalled();
    });

    it('keeps the video private, sets publishAt and preserves other status fields', async () => {
      fake.videos.list.mockResolvedValue(
        data({
          items: [
            {
              id: 'vid00000001',
              status: {
                privacyStatus: 'private',
                selfDeclaredMadeForKids: false,
                containsSyntheticMedia: true,
                license: 'youtube',
              },
            },
          ],
        }),
      );
      fake.videos.update.mockResolvedValue(data({}));
      await service.schedulePublish('vid00000001', '2026-11-01T17:00:00+01:00');
      expect(fake.videos.update).toHaveBeenCalledWith({
        part: ['status'],
        requestBody: {
          id: 'vid00000001',
          status: {
            privacyStatus: 'private',
            publishAt: '2026-11-01T16:00:00.000Z',
            selfDeclaredMadeForKids: false,
            containsSyntheticMedia: true,
            license: 'youtube',
          },
        },
      });
    });

    it('refuses to schedule an already-public video', async () => {
      fake.videos.list.mockResolvedValue(
        data({ items: [{ id: 'vid00000001', status: { privacyStatus: 'public' } }] }),
      );
      await expect(service.schedulePublish('vid00000001', '2026-11-01T00:00:00Z')).rejects.toThrow(
        /already public/,
      );
    });

    it('maps invalidPublishAt from the API', async () => {
      fake.videos.list.mockResolvedValue(
        data({ items: [{ id: 'vid00000001', status: { privacyStatus: 'private' } }] }),
      );
      fake.videos.update.mockRejectedValue(googleError(400, 'invalidPublishAt'));
      await expect(
        service.schedulePublish('vid00000001', '2026-11-01T00:00:00Z'),
      ).rejects.toMatchObject({ code: 'invalid_publish_at' });
    });
  });

  describe('makePublic', () => {
    it('sets public and clears publishAt', async () => {
      fake.videos.list
        .mockResolvedValueOnce(
          data({
            items: [
              {
                id: 'v',
                status: {
                  privacyStatus: 'private',
                  publishAt: '2026-11-01T00:00:00Z',
                  embeddable: true,
                },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(data({ items: [{ id: 'v', status: { privacyStatus: 'public' } }] }));
      fake.videos.update.mockResolvedValue(data({}));
      const status = await service.makePublic('vid00000001');
      expect(fake.videos.update).toHaveBeenCalledWith({
        part: ['status'],
        requestBody: { id: 'vid00000001', status: { privacyStatus: 'public', embeddable: true } },
      });
      expect(status.privacyStatus).toBe('public');
      expect(status.notes).toEqual([]);
    });

    it('explains the unaudited-project private lock', async () => {
      fake.videos.list.mockResolvedValue(
        data({ items: [{ id: 'v', status: { privacyStatus: 'private' } }] }),
      );
      fake.videos.update.mockResolvedValue(data({}));
      const status = await service.makePublic('vid00000001');
      expect(status.notes.join(' ')).toMatch(/Unaudited/);
    });
  });

  describe('updateMetadata', () => {
    it('merges with existing snippet and renders chapters', async () => {
      fake.videos.list.mockResolvedValue(
        data({
          items: [
            {
              id: 'v',
              snippet: {
                title: 'Old',
                description: 'Story so far.',
                categoryId: '1',
                tags: ['a'],
                defaultAudioLanguage: 'en',
              },
            },
          ],
        }),
      );
      fake.videos.update.mockImplementation((params: { requestBody: { snippet: unknown } }) =>
        Promise.resolve(data({ snippet: params.requestBody.snippet })),
      );
      const result = await service.updateMetadata({
        videoId: 'vid00000001',
        title: 'New title',
        chapters: [
          { startSeconds: 0, title: 'Intro' },
          { startSeconds: 60, title: 'Middle' },
          { startSeconds: 120, title: 'End' },
        ],
      });
      expect(result.snippet).toEqual({
        title: 'New title',
        description: 'Story so far.\n\nChapters:\n0:00 Intro\n1:00 Middle\n2:00 End',
        categoryId: '1',
        tags: ['a'],
        defaultAudioLanguage: 'en',
      });
    });

    it('reports missing videos clearly', async () => {
      fake.videos.list.mockResolvedValue(data({ items: [] }));
      await expect(service.updateMetadata({ videoId: 'nope0000000' })).rejects.toMatchObject({
        code: 'not_found',
      });
    });
  });

  describe('listVideos', () => {
    it('reads the uploads playlist and hydrates video details in order', async () => {
      fake.channels.list.mockResolvedValue(
        data({
          items: [
            {
              id: 'UC1',
              snippet: { title: 'Rogue Signal' },
              contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
            },
          ],
        }),
      );
      fake.playlistItems.list.mockResolvedValue(
        data({
          items: [{ contentDetails: { videoId: 'b' } }, { contentDetails: { videoId: 'a' } }],
          nextPageToken: 'NEXT',
          pageInfo: { totalResults: 7 },
        }),
      );
      fake.videos.list.mockResolvedValue(
        data({
          items: [
            { id: 'a', snippet: { title: 'A' }, status: { privacyStatus: 'private' } },
            { id: 'b', snippet: { title: 'B' }, status: { privacyStatus: 'public' } },
          ],
        }),
      );
      const page = await service.listVideos(undefined, 2);
      expect(page.items.map((v) => v.title)).toEqual(['B', 'A']);
      expect(page.nextPageToken).toBe('NEXT');
      expect(page.totalResults).toBe(7);
      expect(fake.playlistItems.list).toHaveBeenCalledWith({
        part: ['contentDetails'],
        playlistId: 'UU1',
        maxResults: 2,
      });
    });

    it('maps quota errors', async () => {
      fake.channels.list.mockRejectedValue(googleError(403, 'quotaExceeded'));
      await expect(service.listVideos()).rejects.toMatchObject({ code: 'quota_exceeded' });
    });
  });

  describe('getVideoStatus', () => {
    it('surfaces processing, rejection and schedule details', async () => {
      fake.videos.list.mockResolvedValue(
        data({
          items: [
            {
              id: 'v',
              snippet: { title: 'Ep' },
              status: {
                privacyStatus: 'private',
                publishAt: '2026-11-01T00:00:00Z',
                uploadStatus: 'rejected',
                rejectionReason: 'duplicate',
                containsSyntheticMedia: true,
              },
              processingDetails: {
                processingStatus: 'processing',
                processingProgress: { partsTotal: '10', partsProcessed: '4', timeLeftMs: '5000' },
              },
              contentDetails: { duration: 'PT10M' },
            },
          ],
        }),
      );
      const status = await service.getVideoStatus('vid00000001');
      expect(status).toMatchObject({
        privacyStatus: 'private',
        publishAt: '2026-11-01T00:00:00Z',
        rejectionReason: 'duplicate',
        processingStatus: 'processing',
        processingProgress: { partsTotal: 10, partsProcessed: 4, timeLeftMs: 5000 },
        containsSyntheticMedia: true,
        duration: 'PT10M',
      });
      expect(status.notes).toEqual([
        'Rejected by YouTube: duplicate.',
        'Scheduled to go public at 2026-11-01T00:00:00Z.',
      ]);
    });
  });

  describe('playlists', () => {
    it('creates, lists and adds', async () => {
      fake.playlists.insert.mockResolvedValue(
        data({
          id: 'PL123456789',
          snippet: { title: 'Agent Wars S1' },
          status: { privacyStatus: 'private' },
        }),
      );
      const created = await service.createPlaylist({
        title: 'Agent Wars S1',
        privacyStatus: 'private',
      });
      expect(created).toMatchObject({
        playlistId: 'PL123456789',
        url: 'https://www.youtube.com/playlist?list=PL123456789',
      });

      fake.playlists.list.mockResolvedValue(
        data({ items: [{ id: 'PL123456789', contentDetails: { itemCount: 3 } }] }),
      );
      expect((await service.listPlaylists()).items[0]?.itemCount).toBe(3);

      fake.playlistItems.insert.mockResolvedValue(data({ id: 'PLI1', snippet: { position: 0 } }));
      expect(await service.addToPlaylist('PL123456789', 'vid00000001', 0)).toEqual({
        playlistItemId: 'PLI1',
        playlistId: 'PL123456789',
        videoId: 'vid00000001',
        position: 0,
      });
      expect(fake.playlistItems.insert).toHaveBeenCalledWith({
        part: ['snippet'],
        requestBody: {
          snippet: {
            playlistId: 'PL123456789',
            resourceId: { kind: 'youtube#video', videoId: 'vid00000001' },
            position: 0,
          },
        },
      });
    });
  });

  describe('setThumbnail', () => {
    it('rejects non-image content types', async () => {
      const svc = new YouTubeService({
        youtube: fakeYouTube().youtube,
        getAccessToken: () => Promise.resolve('t'),
        sourceOptions: {
          allowLocalPaths: false,
          resolveHost: () => Promise.resolve(['93.184.216.34']),
          fetch: vi.fn(() =>
            Promise.resolve(new Response('x', { headers: { 'content-type': 'image/gif' } })),
          ),
        },
      });
      await expect(
        svc.setThumbnail('vid00000001', { url: 'https://cdn.example.com/t.gif' }),
      ).rejects.toThrow(/JPEG or PNG/);
    });

    it('uploads JPEG/PNG thumbnails', async () => {
      const { fake: f, youtube } = fakeYouTube();
      f.thumbnails.set.mockResolvedValue(
        data({ items: [{ high: { url: 'https://i.ytimg.com/x.jpg' } }] }),
      );
      const svc = new YouTubeService({
        youtube,
        getAccessToken: () => Promise.resolve('t'),
        sourceOptions: {
          allowLocalPaths: false,
          resolveHost: () => Promise.resolve(['93.184.216.34']),
          fetch: vi.fn(() =>
            Promise.resolve(new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } })),
          ),
        },
      });
      const result = await svc.setThumbnail('vid00000001', {
        url: 'https://cdn.example.com/t.jpg',
      });
      expect(result.thumbnailUrl).toBe('https://i.ytimg.com/x.jpg');
      expect(f.thumbnails.set).toHaveBeenCalledWith(
        expect.objectContaining({
          videoId: 'vid00000001',
          media: expect.objectContaining({ mimeType: 'image/jpeg' }) as unknown,
        }),
      );
    });
  });
});
