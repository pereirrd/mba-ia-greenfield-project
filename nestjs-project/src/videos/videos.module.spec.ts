import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import databaseConfig from '../config/database.config';
import mailConfig from '../config/mail.config';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { Video } from './entities/video.entity';
import { VideoQueueService } from './video-queue.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VideosModule } from './videos.module';

describe('VideosModule', () => {
  it('compiles with mocked TypeORM repositories and real queue/storage config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            appConfig,
            authConfig,
            databaseConfig,
            mailConfig,
            storageConfig,
            redisConfig,
            videoConfig,
          ],
        }),
        StorageModule,
        QueueModule,
      ],
      controllers: [VideosController],
      providers: [
        VideosService,
        VideoQueueService,
        { provide: getRepositoryToken(Video), useValue: {} },
        { provide: getRepositoryToken(Channel), useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(VideosService)).toBeDefined();
    expect(moduleRef.get(VideoQueueService)).toBeDefined();
    await moduleRef.close();
  });

  it('exports VideosModule symbol', () => {
    expect(VideosModule).toBeDefined();
  });
});
