import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        StorageModule,
      ],
    }).compile();

    storage = moduleRef.get(StorageService);
    await storage.ensureBucket();
  });

  it('puts and heads a small object', async () => {
    const key = `tests/${randomUUID()}.txt`;
    const body = Buffer.from('hello-streamtube');
    await storage.putObject(key, body, 'text/plain');

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(body.length);

    await storage.deleteObject(key);
  });

  it('completes a multipart upload for a small payload', async () => {
    const key = `tests/multipart-${randomUUID()}.bin`;
    const uploadId = await storage.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const partBody = Buffer.alloc(5 * 1024 * 1024, 1);
    const url = await storage.presignUploadPart(key, uploadId, 1);

    const uploadResponse = await fetch(url, {
      method: 'PUT',
      body: partBody,
    });
    expect(uploadResponse.ok).toBe(true);
    const etag = uploadResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag! },
    ]);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(partBody.length);
    await storage.deleteObject(key);
  });
});
