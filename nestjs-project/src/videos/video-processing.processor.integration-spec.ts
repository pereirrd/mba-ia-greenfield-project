import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import redisConfig from '../config/redis.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESS_JOB } from './video-processing.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';
import { Job } from 'bullmq';

const execFileAsync = promisify(execFile);

describe('VideoProcessingProcessor (integration)', () => {
  let dataSource: DataSource;
  let videoRepo: Repository<Video>;
  let storage: StorageService;
  let processor: VideoProcessingProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
    videoRepo = dataSource.getRepository(Video);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig, redisConfig],
        }),
        StorageModule,
      ],
      providers: [
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepo,
        },
        {
          provide: getRepositoryToken(Channel),
          useValue: dataSource.getRepository(Channel),
        },
        {
          provide: VideosService,
          useFactory: (storageService: StorageService) => {
            const queue = { enqueueProcess: jest.fn() };
            return new VideosService(
              videoRepo,
              dataSource.getRepository(Channel),
              storageService,
              queue as any,
              {
                maxSizeBytes: 10 * 1024 * 1024,
                partSizeBytes: 5 * 1024 * 1024,
                uploadUrlExpiresSeconds: 3600,
                processingQueue: 'video-processing',
              } as any,
            );
          },
          inject: [StorageService],
        },
        VideoProcessingProcessor,
      ],
    }).compile();

    storage = moduleRef.get(StorageService);
    processor = moduleRef.get(VideoProcessingProcessor);
    await storage.ensureBucket();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('processes a real mp4 fixture with ffmpeg and marks ready', async () => {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `proc-${Date.now()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    const channel = await dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'ch',
        nickname: `nick_${Date.now()}`,
        user_id: user.id,
      }),
    );

    const work = await mkdtemp(join(tmpdir(), 'fixture-'));
    const fixturePath = join(work, 'sample.mp4');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
    const bytes = await readFile(fixturePath);

    const videoId = crypto.randomUUID();
    const storageKey = `videos/${channel.id}/${videoId}/source`;
    await storage.putObject(storageKey, bytes, 'video/mp4');

    await videoRepo.save(
      videoRepo.create({
        id: videoId,
        public_id: `p${Date.now()}`.slice(0, 11),
        channel_id: channel.id,
        title: 'Fixture',
        status: VideoStatus.Processing,
        storage_key: storageKey,
        content_type: 'video/mp4',
        size_bytes: String(bytes.length),
      }),
    );

    await processor.process({
      name: VIDEO_PROCESS_JOB,
      data: { videoId },
      opts: { attempts: 1 },
      attemptsMade: 0,
    } as Job);

    const updated = await videoRepo.findOneByOrFail({ id: videoId });
    expect(updated.status).toBe(VideoStatus.Ready);
    expect(updated.duration_seconds).toBeGreaterThan(0);
    expect(updated.thumbnail_key).toBeTruthy();

    const thumbHead = await storage.headObject(updated.thumbnail_key!);
    expect(thumbHead.contentLength).toBeGreaterThan(0);

    await rm(work, { recursive: true, force: true });
    await storage.deleteObject(storageKey);
    await storage.deleteObject(updated.thumbnail_key!);
  }, 30000);
});
