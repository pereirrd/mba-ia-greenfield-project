import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { StorageService } from '../src/storage/storage.service';
import { VideosService } from '../src/videos/videos.service';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videosService: VideosService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storageService = moduleFixture.get(StorageService);
    videosService = moduleFixture.get(VideosService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  it('rejects unauthenticated initiate upload', async () => {
    await request(app.getHttpServer())
      .post('/videos/uploads')
      .send({
        filename: 'a.mp4',
        contentType: 'video/mp4',
        size: 100,
      })
      .expect(401);
  });

  it('rejects invalid initiate body with VALIDATION_ERROR', async () => {
    const token = await registerConfirmAndLogin('upload-val@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'a.mp4' })
      .expect(400);
    expect(res.body.error).toBe('VALIDATION_ERROR');
  });

  it('initiates multipart upload as draft without proxying file bytes', async () => {
    const token = await registerConfirmAndLogin('uploader@example.com');
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'vacation.mp4',
        contentType: 'video/mp4',
        size: 1024,
        title: 'Vacation',
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.publicId).toBeDefined();
    expect(res.body.uploadId).toBeDefined();
    expect(res.body.partSize).toBeGreaterThan(0);

    const video = await videoRepository.findOneByOrFail({ id: res.body.id });
    expect(video.status).toBe(VideoStatus.Draft);
    expect(video.title).toBe('Vacation');
  });

  it('completes multipart upload, enqueues processing, streams and downloads when ready', async () => {
    const token = await registerConfirmAndLogin('stream@example.com');
    const initiate = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: 256,
      })
      .expect(201);

    const partsRes = await request(app.getHttpServer())
      .post(`/videos/${initiate.body.id}/uploads/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ partNumbers: [1] })
      .expect(200);

    const partUrl = partsRes.body.parts[0].url as string;
    const payload = Buffer.from('fake-video-bytes-for-e2e-test-payload');
    const putRes = await fetch(partUrl, { method: 'PUT', body: payload });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const complete = await request(app.getHttpServer())
      .post(`/videos/${initiate.body.id}/uploads/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(200);

    expect(complete.body.status).toBe(VideoStatus.Processing);

    // Simulate worker success for stream/download contract (worker covered in unit/integration)
    const video = await videoRepository.findOneByOrFail({
      id: initiate.body.id,
    });
    await storageService.putObject(
      `thumbnails/${video.channel_id}/${video.id}/thumb.jpg`,
      Buffer.from('thumb'),
      'image/jpeg',
    );
    await videosService.markReady(video.id, {
      durationSeconds: 1.5,
      metadata: { format: { duration: 1.5 } },
      thumbnailKey: `thumbnails/${video.channel_id}/${video.id}/thumb.jpg`,
    });

    const meta = await request(app.getHttpServer())
      .get(`/videos/${initiate.body.publicId}`)
      .expect(200);
    expect(meta.body.status).toBe(VideoStatus.Ready);
    expect(meta.body.durationSeconds).toBe(1.5);

    const ranged = await request(app.getHttpServer())
      .get(`/videos/${initiate.body.publicId}/stream`)
      .set('Range', 'bytes=0-9')
      .expect(206);
    expect(ranged.headers['content-range']).toMatch(/^bytes 0-9\//);
    expect(ranged.headers['accept-ranges']).toBe('bytes');
    expect(Buffer.from(ranged.body).length).toBe(10);

    const download = await request(app.getHttpServer())
      .get(`/videos/${initiate.body.publicId}/download`)
      .expect(200);
    expect(download.headers['content-disposition']).toMatch(/attachment/);
  });

  it('returns VIDEO_NOT_READY when streaming a draft video', async () => {
    const token = await registerConfirmAndLogin('notready@example.com');
    const initiate = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        contentType: 'video/mp4',
        size: 100,
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/videos/${initiate.body.publicId}/stream`)
      .expect(409);
    expect(res.body.error).toBe('VIDEO_NOT_READY');
  });
});
