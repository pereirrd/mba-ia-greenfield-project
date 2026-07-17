import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import ffmpegImport from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from '../storage/storage.service';
import {
  VIDEO_PROCESS_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const ffmpeg = ffmpegImport as unknown as typeof ffmpegImport &
  ((path: string) => ffmpegImport.FfmpegCommand);

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    if (job.name !== VIDEO_PROCESS_JOB) {
      return;
    }

    const video = await this.videosService.findById(job.data.videoId);
    if (!video) {
      this.logger.warn(`Video ${job.data.videoId} not found — skipping`);
      return;
    }
    if (video.status === VideoStatus.Ready) {
      return;
    }

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
    const sourcePath = join(workDir, 'source');
    const thumbDir = join(workDir, 'thumbs');

    try {
      await mkdir(thumbDir, { recursive: true });
      await this.storageService.getObjectToFile(video.storage_key, sourcePath);

      const probe = await this.probe(sourcePath);
      const durationSeconds = Number(probe.format?.duration ?? 0);
      const thumbnailFile = 'thumb.jpg';
      await this.takeScreenshot(
        sourcePath,
        thumbDir,
        thumbnailFile,
        durationSeconds,
      );

      const thumbnailKey = `thumbnails/${video.channel_id}/${video.id}/thumb.jpg`;
      const thumbBytes = await readFile(join(thumbDir, thumbnailFile));
      await this.storageService.putObject(
        thumbnailKey,
        thumbBytes,
        'image/jpeg',
      );

      await this.videosService.markReady(video.id, {
        durationSeconds,
        metadata: {
          format: probe.format as unknown as Record<string, unknown>,
          streams: (probe.streams ?? []).map((stream) => ({
            codec_type: stream.codec_type,
            codec_name: stream.codec_name,
            width: stream.width,
            height: stream.height,
          })),
        },
        thumbnailKey,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Processing failed for ${video.id}: ${reason}`);
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        await this.videosService.markFailed(video.id, reason);
      }
      throw error;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private probe(path: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(path, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(data);
      });
    });
  }

  private takeScreenshot(
    sourcePath: string,
    folder: string,
    filename: string,
    durationSeconds: number,
  ): Promise<void> {
    const timemark =
      durationSeconds > 2 ? '00:00:01' : durationSeconds > 0 ? '0%' : '0%';

    return new Promise((resolve, reject) => {
      ffmpeg(sourcePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          count: 1,
          timemarks: [timemark],
          filename,
          folder,
          size: '640x?',
        });
    });
  }
}
