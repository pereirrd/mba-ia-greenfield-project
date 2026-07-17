import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from './storage.service';

@Module({
  imports: [
    ConfigModule.forFeature(storageConfig),
    ConfigModule.forFeature(videoConfig),
  ],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
