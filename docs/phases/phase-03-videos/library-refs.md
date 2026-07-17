---
libs:
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/nest"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "BullModule.forRoot / registerQueue; @InjectQueue; @Processor extends WorkerHost"
  bullmq:
    version: "^5.34.0"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "Queue.add job payload; WorkerHost.process(job); attempts + exponential backoff"
  ioredis:
    version: "^5.4.2"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "connection host/port for BullMQ; Compose service name redis"
  "@aws-sdk/client-s3":
    version: "^3.758.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "S3Client; CreateMultipartUpload; UploadPart; CompleteMultipartUpload; GetObject Range; PutObject"
  "@aws-sdk/s3-request-presigner":
    version: "^3.758.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "getSignedUrl for UploadPartCommand / PutObjectCommand"
  nanoid:
    version: "n/a (not installed)"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "Decision revised to Node crypto.randomBytes with nanoid-compatible alphabet (generatePublicId) to avoid ESM-only nanoid@5 under Jest"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-17T13:46:00+00:00"
    notes: "ffprobe metadata; screenshots/thumbnail generation; requires system ffmpeg"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T13:45:00+00:00"
---

# Library Refs — phase-03-videos

Context7 MCP was unavailable in this agent environment; versions and APIs were cross-checked against NestJS queues docs (`@nestjs/bullmq`), AWS SDK v3 S3 client docs, BullMQ docs, nanoid docs, and fluent-ffmpeg docs via primary sources (WebSearch / official doc pages) matching the versions pinned below.

## @nestjs/bullmq + bullmq

- Register once: `BullModule.forRoot({ connection: { host, port } })`.
- Per-queue: `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 2000 } } })`.
- Producer: `@InjectQueue('video-processing') private readonly queue: Queue` then `queue.add('process', { videoId })`.
- Consumer (worker only): `@Processor('video-processing') class X extends WorkerHost { async process(job: Job) { ... } }`.

## @aws-sdk/client-s3 + s3-request-presigner

- `S3Client` with `endpoint`, `forcePathStyle: true`, `region`, credentials for MinIO.
- Multipart: `CreateMultipartUploadCommand` → per-part `UploadPartCommand` signed via `getSignedUrl` → `CompleteMultipartUploadCommand` with `{ ETag, PartNumber }[]`.
- Read path: `GetObjectCommand` with optional `Range: bytes=start-end`; body is a Readable stream.
- Thumbnails: `PutObjectCommand` with `ContentType: image/jpeg`.

## nanoid / public id

- Implementation uses `generatePublicId()` (`src/videos/public-id.util.ts`) with Node `crypto.randomBytes` and the nanoid URL-safe alphabet — same uniqueness strategy without the ESM-only `nanoid@5` package under Jest.

## fluent-ffmpeg

- Requires `ffmpeg` / `ffprobe` binaries on PATH (worker image).
- `ffprobe(path)` → format.duration + streams metadata.
- `ffmpeg(path).screenshots({ count: 1, timemarks: ['10%'], filename })` for thumbnail frame.
