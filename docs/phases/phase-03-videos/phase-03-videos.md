---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-17T13:36:02+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T13:45:00+00:00"
  docs/phases/phase-03-videos/context.md: "2026-07-17T13:46:00+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-17T13:46:00+00:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the video upload and processing pipeline on the NestJS backend: MinIO object storage, Redis/BullMQ job queue, a separate FFmpeg worker, draft-on-initiate multipart upload (up to 10GB without proxying bytes through the API), unique public URLs, Range-based streaming, and download — with status lifecycle `draft → processing → ready | failed`.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Compose Infra

**Description:** Install Phase 03 libraries; add `storage` and `redis`/`queue` config namespaces; extend Joi validation and `.env.example`; add MinIO, Redis, and `video-worker` services to `compose.yaml`.

**Technical actions:**

- Install in `nestjs-project`: `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`, `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`, `nanoid@^5`, `fluent-ffmpeg@^2`, `@types/fluent-ffmpeg` (dev)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)`: `S3_ENDPOINT` (default `http://minio:9000`), `S3_REGION` (default `us-east-1`), `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` (default `streamtube`), `S3_FORCE_PATH_STYLE` (default `true`)
- Create `src/config/redis.config.ts` — `registerAs('redis', ...)`: `REDIS_HOST` (default `redis`), `REDIS_PORT` (default `6379`)
- Create `src/config/video.config.ts` — `registerAs('video', ...)`: `VIDEO_MAX_SIZE_BYTES` (default `10737418240` = 10GB), `VIDEO_PART_SIZE_BYTES` (default `104857600` = 100MB), `VIDEO_UPLOAD_URL_EXPIRES_SECONDS` (default `3600`), `VIDEO_PROCESSING_QUEUE` (default `video-processing`)
- Extend `env.validation.ts` + `.env.example` with all new keys (Compose service hostnames, never localhost defaults for in-container use)
- Update `compose.yaml`:
  - `minio` — `minio/minio server /data`, ports 9000/9001, root user/password env, volume
  - `minio-init` — one-shot `mc` create bucket `streamtube` (or document API bootstrap)
  - `redis` — `redis:7-alpine`, port 6379
  - `video-worker` — build from `Dockerfile.worker` (Node + ffmpeg), command `node dist/worker.main.js`, depends on `db`, `redis`, `minio`
  - `nestjs-api` depends_on: `db`, `mailpit`, `redis`, `minio`
- Add `Dockerfile.worker` based on Node 22 + `ffmpeg` package

**Dependencies:** None

**Acceptance criteria:**

- App boots when new env vars are set; Joi fails boot without required S3/Redis secrets when marked required
- `docker compose config` lists `minio`, `redis`, `video-worker` alongside existing services
- Hostnames in defaults are Compose service names (`minio`, `redis`, `db`)

---

### SI-03.2 — Storage Module (S3/MinIO Client)

**Description:** Encapsulate S3 client and operations used by videos API and worker: ensure bucket, multipart initiate/presign/complete, get object (optional Range), put thumbnail, head object for size.

**Technical actions:**

- Create `src/storage/storage.module.ts` (global or exported) and `src/storage/storage.service.ts`
- Methods: `ensureBucket()`, `createMultipartUpload(key, contentType)`, `presignUploadPart(key, uploadId, partNumber)`, `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(...)`, `getObjectStream(key, range?)`, `headObject(key)`, `putObject(key, body, contentType)`, `getObjectToFile(key, destPath)`
- Wire `S3Client` from `storageConfig` with `forcePathStyle: true` for MinIO
- Call `ensureBucket()` on module init (dev-friendly)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Put/get/head against real MinIO; multipart initiate+complete with small payload |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Integration test uploads and reads a small object from MinIO bucket
- Multipart complete produces a readable object

---

### SI-03.3 — Video Entity, Enums, and Migration

**Description:** Create `Video` entity linked to `Channel`, with status enum, storage keys, public_id, duration/metadata, failure_reason; generate migration; extend test cleanup helpers.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — columns per Data Model below; `@ManyToOne(() => Channel)`; unique on `public_id`; indexes on `(channel_id, status)`
- Create `src/videos/video-status.enum.ts` — `draft | processing | ready | failed`
- Migration `CreateVideos`
- Update `cleanAllTables` to delete `videos` first (FK order)
- Extend `Channel` with `@OneToMany` optional relation if needed for cascades (prefer explicit FK without cascade delete in Phase 03)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique public_id, FK to channel, status default `draft`, nullable duration/thumbnail |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `migration:run` creates `videos` table with constraints
- Duplicate `public_id` fails uniquely

---

### SI-03.4 — Queue Module and Job Contract

**Description:** Register BullMQ root + `video-processing` queue in a shared module usable by API (producer) and worker (consumer). Define job payload type.

**Technical actions:**

- `src/queue/queue.module.ts` — `BullModule.forRootAsync` from `redisConfig`; `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`
- `src/videos/video-processing.job.ts` — type `{ videoId: string }`
- `src/videos/video-queue.service.ts` — `enqueueProcess(videoId: string)`
- Export queue service from Videos/Queue modules for API use
- Do **not** register `@Processor` in the API app module

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-queue.service.integration-spec.ts` | Integration | Job appears in Redis/BullMQ wait list when enqueued |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with redis config mocks or test redis |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Enqueue writes a job consumable by a BullMQ worker connected to the same Redis

---

### SI-03.5 — Domain Exceptions for Videos

**Description:** Add video-domain exceptions mapped by existing `DomainExceptionFilter`.

**Technical actions:**

- Add to `domain.exception.ts`: `VideoNotFoundException`, `VideoNotReadyException`, `VideoNotOwnedException`, `VideoInvalidStatusException`, `VideoUploadNotFoundException`, `VideoTooLargeException`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/common/filters/domain-exception.filter.spec.ts` | Unit | New exceptions map to correct statusCode/error codes (extend existing suite) |

**Dependencies:** None (uses Phase 02 filter)

**Acceptance criteria:**

- Each new exception returns documented error code from Error Catalog

---

### SI-03.6 — Videos Service: Initiate Multipart Upload (Draft)

**Description:** Authenticated initiate creates draft video for the user’s channel, generates `public_id`, starts multipart upload in MinIO, returns upload session info.

**Technical actions:**

- `VideosService.initiateUpload(userId, dto)` — load channel by user; generate `public_id` (nanoid, retry on unique violation); persist `Video` status=`draft` with `storage_key`, `content_type`, `title`; `createMultipartUpload`; return `{ id, publicId, uploadId, key, partSize, maxSize }`
- DTOs: `InitiateUploadDto` — `filename`, `contentType` (video/*), optional `title`, required `size` (≤ 10GB)
- Reject size > `VIDEO_MAX_SIZE_BYTES` with `VideoTooLargeException`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Draft creation, size rejection, ownership channel resolution |
| `src/videos/videos.service.integration-spec.ts` | Integration | Row persisted as draft with unique public_id; multipart id stored |

**Dependencies:** SI-03.2, SI-03.3, SI-03.5

**Acceptance criteria:**

- Initiate creates DB draft without accepting file body on the API
- Size > 10GB rejected

---

### SI-03.7 — Presign Parts and Complete Upload → Enqueue

**Description:** Endpoints to mint part URLs and complete multipart; on complete, transition to `processing` and enqueue job.

**Technical actions:**

- `presignParts(userId, videoId, partNumbers[])` — ownership check; status must be `draft`; return `{ parts: [{ partNumber, url }] }`
- `completeUpload(userId, videoId, parts[{partNumber,etag}])` — ownership; complete multipart in S3; set status `processing`; clear upload_id; `enqueueProcess(videoId)`; return video summary
- Persist `multipart_upload_id` on video during draft

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Status guards; enqueue called on complete |
| `src/videos/videos.service.integration-spec.ts` | Integration | Complete marks processing and job enqueued |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- Complete does not stream file through Nest; status becomes `processing`; job enqueued

---

### SI-03.8 — Videos Controller HTTP API (Upload + Get)

**Description:** REST controller for upload flow and get-by-publicId; JWT required except public get of ready metadata if desired (Phase 03: get metadata public for ready).

**Technical actions:**

- `VideosController` prefix `videos`
- `POST /videos/uploads` — initiate (auth)
- `POST /videos/:id/uploads/parts` — presign (auth)
- `POST /videos/:id/uploads/complete` — complete (auth)
- `GET /videos/:publicId` — `@Public()` — returns metadata if `ready` (or owner can see draft/processing of own video when authenticated — keep Phase 03 simple: public only `ready`; owner endpoints optional `GET /videos/me/:id`)
- Swagger decorators consistent with Phase 02

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | Initiate 201; unauthorized 401; validation 400; complete happy path with MinIO parts |

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- E2E covers auth + validation wiring for upload endpoints

---

### SI-03.9 — Stream (Range/206) and Download

**Description:** Public stream and download for `ready` videos using StorageService getObject with Range.

**Technical actions:**

- `GET /videos/:publicId/stream` — `@Public()`; require `ready`; parse `Range`; return 206 or 200 full; set `Accept-Ranges`, `Content-Type`, `Content-Length` / `Content-Range`
- `GET /videos/:publicId/download` — `@Public()`; `Content-Disposition: attachment; filename="..."`
- Use `@Res({ passthrough: false })` / Node stream pipe; handle abort

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | Range request returns 206 with Content-Range; download has attachment disposition; non-ready → 409/404 per catalog |

**Dependencies:** SI-03.2, SI-03.3, SI-03.8

**Acceptance criteria:**

- Partial content works without transferring entire object when Range is sent

---

### SI-03.10 — Video Worker: FFmpeg Processor

**Description:** Worker entrypoint + processor: download source, ffprobe duration/metadata, generate thumbnail, upload thumbnail, set `ready` or `failed`.

**Technical actions:**

- `src/worker.main.ts` + `src/worker.module.ts` — Config + TypeORM + Storage + Queue + Videos entities + `VideoProcessingProcessor` only (no HTTP)
- Processor: set failure on throw after attempts; write `duration_seconds`, `metadata` jsonb, `thumbnail_key`, status `ready`
- Temp dir cleanup in `finally`
- `package.json` script `start:worker`
- Compose `video-worker` uses built dist

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processing.processor.spec.ts` | Unit | Success path updates ready; failure sets failed; ffmpeg mocked |
| `src/videos/video-processing.processor.integration-spec.ts` | Integration | Tiny sample video through real ffmpeg + MinIO + DB (fixture mp4) |

**Dependencies:** SI-03.4, SI-03.7

**Acceptance criteria:**

- Processing a small fixture video yields `ready` with duration > 0 and thumbnail object present

---

### SI-03.11 — VideosModule Wiring, AppModule, CLAUDE.md

**Description:** Register modules in API `AppModule`; update root and nestjs `CLAUDE.md` with videos section; update architecture queue TBD note in root CLAUDE if needed.

**Technical actions:**

- Import `VideosModule`, `StorageModule`, `QueueModule` in `AppModule`
- Document endpoints, env vars, Compose services, worker command
- Update C4 mention: Message Queue = Redis/BullMQ

**Dependencies:** SI-03.8, SI-03.9, SI-03.10

**Acceptance criteria:**

- CLAUDE.md describes only behaviors that exist in code

---

### SI-03.12 — Definition of Done Gate

**Description:** Full suite, `tsc --noEmit`, `lint` green; progress.md finalized.

**Technical actions:**

- Fix any regressions in auth/migrations tests (cleanup order)
- Ensure e2e uses Compose hostnames when inside containers / localhost overrides in local `.env` for agent host runs documented in progress observations only

**Dependencies:** All prior SIs

**Acceptance criteria:**

- `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint` all exit 0

---

## Technical Specifications

### Data Model

**Entity: `videos`**

| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | generated |
| public_id | varchar(21) UNIQUE NOT NULL | nanoid |
| channel_id | uuid FK → channels.id NOT NULL | owner |
| title | varchar(200) NOT NULL | default from filename stem |
| status | enum draft/processing/ready/failed NOT NULL | default draft |
| storage_key | varchar NOT NULL | object key for source |
| thumbnail_key | varchar NULL | set by worker |
| content_type | varchar NOT NULL | e.g. video/mp4 |
| size_bytes | bigint NOT NULL | declared at initiate |
| duration_seconds | double precision NULL | from ffprobe |
| metadata | jsonb NULL | ffprobe summary |
| multipart_upload_id | varchar NULL | set while draft |
| failure_reason | text NULL | on failed |
| created_at / updated_at | timestamptz | |

Relation: Video N:1 Channel.

### API Contracts

| Method | Path | Auth | Request | Response | Status |
|--------|------|------|---------|----------|--------|
| POST | /videos/uploads | JWT | `{ filename, contentType, size, title? }` | `{ id, publicId, uploadId, key, partSize, maxSize }` | 201 |
| POST | /videos/:id/uploads/parts | JWT | `{ partNumbers: number[] }` | `{ parts: [{ partNumber, url }] }` | 200 |
| POST | /videos/:id/uploads/complete | JWT | `{ parts: [{ partNumber, etag }] }` | `{ id, publicId, status: processing }` | 200 |
| GET | /videos/:publicId | Public | — | `{ publicId, title, status, durationSeconds, thumbnailUrl?, channelId }` | 200 (ready only for anon) |
| GET | /videos/:publicId/stream | Public | Header `Range` optional | video bytes | 200 / 206 |
| GET | /videos/:publicId/download | Public | — | video bytes + attachment | 200 |

### Authorization Matrix

| Action | Anonymous | Authenticated owner | Authenticated other |
|--------|-----------|---------------------|---------------------|
| Initiate / parts / complete | ❌ 401 | ✅ own channel | ❌ 403 |
| GET metadata ready | ✅ | ✅ | ✅ |
| GET metadata non-ready | ❌ | ✅ owner only (optional; else 404) | ❌ |
| Stream/download ready | ✅ | ✅ | ✅ |
| Stream/download non-ready | ❌ | ❌ | ❌ |

### Error Catalog

| error | HTTP | When |
|-------|------|------|
| VIDEO_NOT_FOUND | 404 | Unknown id/publicId |
| VIDEO_NOT_OWNED | 403 | Mutating another channel’s video |
| VIDEO_INVALID_STATUS | 409 | Wrong status for operation |
| VIDEO_NOT_READY | 409 | Stream/download while not ready |
| VIDEO_TOO_LARGE | 400 | size > 10GB |
| VIDEO_UPLOAD_NOT_FOUND | 404 | multipart session missing |
| VALIDATION_ERROR | 400 | DTO validation |

### Events / Messages

**Queue:** `video-processing` (BullMQ / Redis)

**Job name:** `process`

**Payload:**

```json
{ "videoId": "<uuid>" }
```

**Options:** `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 50`

**Consumer:** `video-worker` process only. On final failure → status `failed`, `failure_reason` set.

---

## Dependency Map

```
SI-03.1 ─┬─► SI-03.2 ─┬─► SI-03.6 ─┬─► SI-03.7 ─► SI-03.8 ─► SI-03.9
         │            │            │
         ├─► SI-03.3 ─┘            │
         │                         │
         ├─► SI-03.4 ──────────────┴─► SI-03.10
         │
         └─► SI-03.5 ─► (used by 03.6+)

SI-03.8 + SI-03.9 + SI-03.10 ─► SI-03.11 ─► SI-03.12
```

---

## Deliverables

- [ ] MinIO + Redis + video-worker in `compose.yaml`
- [ ] `videos` table migration + entity linked to channel
- [ ] Multipart presigned upload up to 10GB without API proxying file bytes
- [ ] Automatic processing (duration/metadata + thumbnail) via BullMQ worker + FFmpeg
- [ ] Unique `public_id` URLs
- [ ] Streaming with Range/206 and download endpoint
- [ ] Status lifecycle draft → processing → ready | failed
- [ ] Tests (unit + integration + e2e) green; tsc + lint green
- [ ] CLAUDE.md updated with videos section
- [ ] Phase artifacts: decisions, context, validation (clean), library-refs, plan, progress
