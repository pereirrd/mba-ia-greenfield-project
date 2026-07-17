import { DataSource } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { VideoStatus } from '../video-status.enum';
import { Video } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource([User, Channel, Video]);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function seedChannel(): Promise<Channel> {
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({
        email: `video-${Date.now()}@example.com`,
        password: 'hashed',
        is_confirmed: true,
      }),
    );
    return channelRepo.save(
      channelRepo.create({
        name: 'channel',
        nickname: `ch_${Date.now()}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a draft video linked to a channel', async () => {
    const channel = await seedChannel();
    const repo = dataSource.getRepository(Video);
    const video = await repo.save(
      repo.create({
        id: crypto.randomUUID(),
        public_id: 'abc123XYZ01',
        channel_id: channel.id,
        title: 'Demo',
        status: VideoStatus.Draft,
        storage_key: 'videos/x/y/source',
        content_type: 'video/mp4',
        size_bytes: '1024',
      }),
    );

    expect(video.status).toBe(VideoStatus.Draft);
    expect(video.duration_seconds).toBeNull();
    expect(video.thumbnail_key).toBeNull();
  });

  it('enforces unique public_id', async () => {
    const channel = await seedChannel();
    const repo = dataSource.getRepository(Video);
    await repo.save(
      repo.create({
        id: crypto.randomUUID(),
        public_id: 'samePublicId1',
        channel_id: channel.id,
        title: 'A',
        status: VideoStatus.Draft,
        storage_key: 'videos/a/source',
        content_type: 'video/mp4',
        size_bytes: '10',
      }),
    );

    await expect(
      repo.save(
        repo.create({
          id: crypto.randomUUID(),
          public_id: 'samePublicId1',
          channel_id: channel.id,
          title: 'B',
          status: VideoStatus.Draft,
          storage_key: 'videos/b/source',
          content_type: 'video/mp4',
          size_bytes: '10',
        }),
      ),
    ).rejects.toThrow();
  });
});
