/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { VideosService } from './videos.service';
import { VideoStatus } from './video-status.enum';
import { VideoTooLargeException } from '../common/exceptions/domain.exception';

describe('VideosService', () => {
  const videoRepository = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn((value: unknown) => Promise.resolve(value)),
    findOne: jest.fn(),
    findOneByOrFail: jest.fn(),
    update: jest.fn(),
  };
  const channelRepository = {
    findOne: jest.fn(),
  };
  const storageService = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn().mockResolvedValue('https://minio/part'),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
  const videoQueueService = {
    enqueueProcess: jest.fn().mockResolvedValue(undefined),
  };
  const videoCfg = {
    maxSizeBytes: 1024,
    partSizeBytes: 100,
    uploadUrlExpiresSeconds: 60,
    processingQueue: 'video-processing',
  };

  const service = new VideosService(
    videoRepository as any,
    channelRepository as any,
    storageService as any,
    videoQueueService as any,
    videoCfg as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects initiate when size exceeds max', async () => {
    await expect(
      service.initiateUpload('user-1', {
        filename: 'big.mp4',
        contentType: 'video/mp4',
        size: 2048,
      }),
    ).rejects.toBeInstanceOf(VideoTooLargeException);
  });

  it('creates a draft and returns multipart session', async () => {
    channelRepository.findOne.mockResolvedValue({
      id: 'channel-1',
      user_id: 'user-1',
    });
    videoRepository.findOne.mockResolvedValue(null);

    const result = await service.initiateUpload('user-1', {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      size: 512,
      title: 'Clip',
    });

    expect(result.uploadId).toBe('upload-1');
    expect(result.publicId).toBeTruthy();
    expect(storageService.createMultipartUpload).toHaveBeenCalled();
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: VideoStatus.Draft,
        channel_id: 'channel-1',
        title: 'Clip',
      }),
    );
  });

  it('completes upload, sets processing and enqueues job', async () => {
    videoRepository.findOne.mockResolvedValue({
      id: 'video-1',
      status: VideoStatus.Draft,
      multipart_upload_id: 'upload-1',
      storage_key: 'videos/c/v/source',
      public_id: 'pub1',
      channel: { user_id: 'user-1' },
    });

    const result = await service.completeUpload('user-1', 'video-1', {
      parts: [{ partNumber: 1, etag: 'abc' }],
    });

    expect(storageService.completeMultipartUpload).toHaveBeenCalled();
    expect(videoQueueService.enqueueProcess).toHaveBeenCalledWith('video-1');
    expect(result.status).toBe(VideoStatus.Processing);
  });
});
