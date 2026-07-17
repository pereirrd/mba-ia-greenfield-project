/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument */
import { Job } from 'bullmq';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VIDEO_PROCESS_JOB } from './video-processing.constants';
import { VideoStatus } from './video-status.enum';

jest.mock('fluent-ffmpeg', () => {
  const ffprobe = jest.fn(
    (_path: string, cb: (err: Error | null, data: unknown) => void) => {
      cb(null, {
        format: { duration: 12.5, format_name: 'mp4' },
        streams: [
          { codec_type: 'video', codec_name: 'h264', width: 640, height: 360 },
        ],
      });
    },
  );
  const screenshots = jest.fn().mockReturnThis();
  const on = jest.fn(function (
    this: { on: unknown; screenshots: unknown },
    event: string,
    handler: () => void,
  ) {
    if (event === 'end') {
      setImmediate(handler);
    }
    return this;
  });
  const ffmpegFn: any = jest.fn(() => ({ on, screenshots }));
  ffmpegFn.ffprobe = ffprobe;
  return ffmpegFn;
});

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  mkdtemp: jest.fn().mockResolvedValue('/tmp/streamtube-video-test'),
  readFile: jest.fn().mockResolvedValue(Buffer.from('thumb')),
  rm: jest.fn().mockResolvedValue(undefined),
}));

describe('VideoProcessingProcessor', () => {
  const videosService = {
    findById: jest.fn(),
    markReady: jest.fn(),
    markFailed: jest.fn(),
  };
  const storageService = {
    getObjectToFile: jest.fn().mockResolvedValue(undefined),
    putObject: jest.fn().mockResolvedValue(undefined),
  };

  const processor = new VideoProcessingProcessor(
    videosService as any,
    storageService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks video ready after successful processing', async () => {
    videosService.findById.mockResolvedValue({
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.Processing,
      storage_key: 'videos/c/v/source',
    });

    await processor.process({
      name: VIDEO_PROCESS_JOB,
      data: { videoId: 'video-1' },
      opts: { attempts: 3 },
      attemptsMade: 0,
    } as Job);

    expect(videosService.markReady).toHaveBeenCalledWith(
      'video-1',
      expect.objectContaining({
        durationSeconds: 12.5,
        thumbnailKey: 'thumbnails/channel-1/video-1/thumb.jpg',
      }),
    );
  });

  it('marks failed on final attempt', async () => {
    videosService.findById.mockResolvedValue({
      id: 'video-1',
      channel_id: 'channel-1',
      status: VideoStatus.Processing,
      storage_key: 'videos/c/v/source',
    });
    storageService.getObjectToFile.mockRejectedValue(new Error('boom'));

    await expect(
      processor.process({
        name: VIDEO_PROCESS_JOB,
        data: { videoId: 'video-1' },
        opts: { attempts: 1 },
        attemptsMade: 0,
      } as Job),
    ).rejects.toThrow('boom');

    expect(videosService.markFailed).toHaveBeenCalledWith('video-1', 'boom');
  });
});
