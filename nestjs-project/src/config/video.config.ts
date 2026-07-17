import { registerAs } from '@nestjs/config';

const TEN_GB = 10 * 1024 * 1024 * 1024;
const HUNDRED_MB = 100 * 1024 * 1024;

export default registerAs('video', () => ({
  maxSizeBytes: Number(process.env.VIDEO_MAX_SIZE_BYTES ?? TEN_GB),
  partSizeBytes: Number(process.env.VIDEO_PART_SIZE_BYTES ?? HUNDRED_MB),
  uploadUrlExpiresSeconds: Number(
    process.env.VIDEO_UPLOAD_URL_EXPIRES_SECONDS ?? 3600,
  ),
  processingQueue: process.env.VIDEO_PROCESSING_QUEUE ?? 'video-processing',
}));
