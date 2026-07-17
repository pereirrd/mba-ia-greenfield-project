import { Injectable, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ConfigType } from '@nestjs/config';
import { Channel } from '../channels/entities/channel.entity';
import {
  VideoInvalidStatusException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
  VideoTooLargeException,
  VideoUploadNotFoundException,
} from '../common/exceptions/domain.exception';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  CompleteUploadDto,
  InitiateUploadDto,
  PresignPartsDto,
} from './dto/upload.dto';
import { generatePublicId } from './public-id.util';
import { VideoStatus } from './video-status.enum';
import { VideoQueueService } from './video-queue.service';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    private readonly videoQueueService: VideoQueueService,
    @Inject(videoConfig.KEY)
    private readonly videoCfg: ConfigType<typeof videoConfig>,
  ) {}

  async initiateUpload(userId: string, dto: InitiateUploadDto) {
    if (dto.size > this.videoCfg.maxSizeBytes) {
      throw new VideoTooLargeException();
    }
    if (!dto.contentType.startsWith('video/')) {
      throw new VideoInvalidStatusException(
        'contentType must be a video/* MIME type',
      );
    }

    const channel = await this.channelRepository.findOne({
      where: { user_id: userId },
    });
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const title =
      dto.title?.trim() ||
      dto.filename.replace(/\.[^.]+$/, '').slice(0, 200) ||
      'Untitled';

    const publicId = await this.generateUniquePublicId();
    const videoId = crypto.randomUUID();
    const storageKey = `videos/${channel.id}/${videoId}/source`;

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.contentType,
    );

    const video = this.videoRepository.create({
      id: videoId,
      public_id: publicId,
      channel_id: channel.id,
      title,
      status: VideoStatus.Draft,
      storage_key: storageKey,
      thumbnail_key: null,
      content_type: dto.contentType,
      size_bytes: String(dto.size),
      multipart_upload_id: uploadId,
    });
    await this.videoRepository.save(video);

    return {
      id: video.id,
      publicId: video.public_id,
      uploadId,
      key: storageKey,
      partSize: this.videoCfg.partSizeBytes,
      maxSize: this.videoCfg.maxSizeBytes,
    };
  }

  async presignParts(userId: string, videoId: string, dto: PresignPartsDto) {
    const video = await this.requireOwnedDraft(userId, videoId);
    if (!video.multipart_upload_id) {
      throw new VideoUploadNotFoundException();
    }

    const uniqueParts = [...new Set(dto.partNumbers)].sort((a, b) => a - b);
    const parts = await Promise.all(
      uniqueParts.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.multipart_upload_id!,
          partNumber,
        ),
      })),
    );

    return { parts };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ) {
    const video = await this.requireOwnedDraft(userId, videoId);
    if (!video.multipart_upload_id) {
      throw new VideoUploadNotFoundException();
    }
    if (!dto.parts?.length) {
      throw new VideoInvalidStatusException('parts are required');
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.multipart_upload_id,
      dto.parts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
      })),
    );

    video.status = VideoStatus.Processing;
    video.multipart_upload_id = null;
    await this.videoRepository.save(video);
    await this.videoQueueService.enqueueProcess(video.id);

    return {
      id: video.id,
      publicId: video.public_id,
      status: video.status,
    };
  }

  async getByPublicId(publicId: string, userId?: string) {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner = Boolean(userId && video.channel?.user_id === userId);
    if (video.status !== VideoStatus.Ready && !isOwner) {
      throw new VideoNotFoundException();
    }

    return this.toPublicResponse(video);
  }

  async getReadyForMedia(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.Ready) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async markReady(
    videoId: string,
    data: {
      durationSeconds: number;
      metadata: Record<string, unknown>;
      thumbnailKey: string;
    },
  ): Promise<void> {
    const video = await this.videoRepository.findOneByOrFail({ id: videoId });
    video.status = VideoStatus.Ready;
    video.duration_seconds = data.durationSeconds;
    video.metadata = data.metadata;
    video.thumbnail_key = data.thumbnailKey;
    video.failure_reason = null;
    await this.videoRepository.save(video);
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepository.update(videoId, {
      status: VideoStatus.Failed,
      failure_reason: reason.slice(0, 2000),
    });
  }

  async findById(videoId: string): Promise<Video | null> {
    return this.videoRepository.findOne({ where: { id: videoId } });
  }

  private async requireOwnedDraft(userId: string, videoId: string) {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: { channel: true },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel?.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
    if (video.status !== VideoStatus.Draft) {
      throw new VideoInvalidStatusException(
        'Upload can only continue while video is in draft status',
      );
    }
    return video;
  }

  private async generateUniquePublicId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generatePublicId(11);
      const existing = await this.videoRepository.findOne({
        where: { public_id: candidate },
      });
      if (!existing) {
        return candidate;
      }
    }
    return generatePublicId(16);
  }

  private toPublicResponse(video: Video) {
    return {
      id: video.id,
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      contentType: video.content_type,
      channelId: video.channel_id,
      thumbnailKey: video.thumbnail_key,
      createdAt: video.created_at,
    };
  }
}
