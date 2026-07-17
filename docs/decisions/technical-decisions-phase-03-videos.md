---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-17
scope_description: "Backend upload and processing pipeline for videos: object storage usage, queue technology, large-file upload strategy, worker/FFmpeg processing, unique public URLs, streaming/download, and video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API module for video draft/upload/complete/stream/download, MinIO/S3 storage client, BullMQ producer, Compose services (MinIO, Redis, video-worker), and FFmpeg-based worker process.
- `next-frontend/` — Frontend video UI is out of scope for this phase (challenge is backend-only). No open decision in this document.

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the message queue as TBD. Phase 03 needs durable background jobs so FFmpeg work never blocks the API. The choice must integrate cleanly with NestJS 11 and Docker Compose.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue with NestJS-first DI (`BullModule`, `@InjectQueue`, `@Processor` / `WorkerHost`). Jobs persist across restarts; retries and backoff are built in.
- **Pros:** Official NestJS technique docs; TypeScript-native; concurrency controls; easy separate worker process sharing the same Redis; large Nest ecosystem.
- **Cons:** Adds Redis as new infrastructure. Redis is in-memory (AOF/RDB optional) — not a full broker with multi-protocol support.

### Option B: RabbitMQ + `@nestjs/microservices` / amqplib
- Classic AMQP broker. API publishes messages; worker consumes via Nest microservice transport or raw amqplib.
- **Pros:** Strong routing, acknowledgements, dead-letter exchanges. Language-agnostic consumers.
- **Cons:** Heavier ops footprint than Redis for a single job type. Nest microservice patterns are oriented to RPC/events more than job retries/backoff. More boilerplate for idempotent video jobs.

### Option C: PostgreSQL SKIP LOCKED job table (no broker)
- Jobs stored in a `jobs` table; worker polls with `FOR UPDATE SKIP LOCKED`.
- **Pros:** Zero new infrastructure — reuses PostgreSQL already in Compose.
- **Cons:** Polling latency; reinvent retries/visibility timeouts; poor fit for long FFmpeg jobs; diverges from the architecture diagram’s dedicated queue container.

**Recommendation:** Option A (BullMQ + Redis) — NestJS-native integration, proven for video pipelines, and Redis is a small Compose addition that matches the “Message Queue” container without over-engineering.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`)

**Libraries:** `@nestjs/bullmq@^11`, `bullmq@^5`, `ioredis@^5`

---

## TD-02: Large File Upload Strategy (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Passing a 10GB body through Nest/Express would exhaust memory and tie up the API. Object storage is already fixed as S3-compatible (MinIO locally). The open choice is the client↔storage handshake.

**Options:**

### Option A: Presigned multipart upload to MinIO/S3
- API creates a draft video row, starts `CreateMultipartUpload`, returns part-sized presigned `UploadPart` URLs (and/or an endpoint that mints them). Client uploads parts directly to storage. API `CompleteMultipartUpload` then enqueues processing.
- **Pros:** API never touches file bytes; supports >5GB (S3 single-PUT limit); resumable by part; fits MinIO/S3 APIs.
- **Cons:** More endpoints (initiate / parts / complete). Client must track ETags.

### Option B: Single presigned PUT
- API returns one presigned PUT URL; client uploads the whole object in one request to MinIO.
- **Pros:** Simplest handshake.
- **Cons:** S3 single-object PUT max is 5GB — cannot meet the 10GB requirement on real S3. No part-level resume.

### Option C: Proxy multipart through the API (tus / busboy streaming)
- Client streams chunks to Nest; Nest streams to MinIO.
- **Pros:** Full server-side validation of every byte.
- **Cons:** API remains on the hot path for 10GB — violates “sem travar o sistema” and the challenge’s auto-fail rule.

**Recommendation:** Option A — only strategy that keeps the API off the data path and supports 10GB on S3-compatible storage.

**Decision:** A (Presigned multipart upload to MinIO/S3)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-03: Object Storage Layout and Client

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage product is given (S3 API / MinIO in Compose). Remaining choice: bucket/key layout and SDK.

**Options:**

### Option A: One bucket + AWS SDK v3, keys namespaced by channel/video
- Bucket `streamtube` (configurable). Keys: `videos/{channelId}/{videoId}/source` and `thumbnails/{channelId}/{videoId}/thumb.jpg`. MinIO in Compose; same client against AWS S3 in production via endpoint/credentials env.
- **Pros:** Matches architecture; portable; clear ownership in keys; single SDK.
- **Cons:** Must manage bucket bootstrap (create-on-startup in dev).

### Option B: Separate buckets for videos vs thumbnails
- Two buckets with independent policies.
- **Pros:** Cleaner IAM policies in production.
- **Cons:** Extra Compose/config surface for little gain in Phase 03.

**Recommendation:** Option A — one bucket, namespaced keys, AWS SDK v3 pointing at MinIO service hostname `minio`.

**Decision:** A (Single bucket + AWS SDK v3 + namespaced keys)

**Libraries:** `@aws-sdk/client-s3@^3`, `@aws-sdk/s3-request-presigner@^3`

---

## TD-04: Video Worker Process and FFmpeg Processing

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Heavy FFmpeg work must run outside the API process. Need a worker packaging model and how metadata/thumbnail are extracted.

**Options:**

### Option A: Separate NestJS worker entry in the same repo + FFmpeg CLI in worker image
- Second Compose service `video-worker` builds from the same Nest project with a Dockerfile that installs `ffmpeg`. Entry: `node dist/worker.main.js` booting a Nest application context that registers the BullMQ processor only. Processor downloads source from MinIO to temp, runs `ffprobe` (duration/format) and `ffmpeg` (thumbnail frame), uploads thumbnail, updates DB status.
- **Pros:** Shares entities/config/DI with the API; clear process isolation; matches C4 “Video Worker” container.
- **Cons:** Two Node processes to operate; need shared env for DB/Redis/MinIO.

### Option B: In-process BullMQ processor inside the API container
- Same Nest app consumes jobs.
- **Pros:** One deployable.
- **Cons:** FFmpeg CPU/IO starves HTTP; contradicts architecture’s separate worker.

### Option C: Sidecar shell consumer (non-Nest) calling ffmpeg
- Custom Node/bash script outside Nest DI.
- **Pros:** Tiny runtime.
- **Cons:** Duplicates DB/storage wiring; drifts from project Nest conventions.

**Recommendation:** Option A — separate worker container with FFmpeg, Nest DI, BullMQ `WorkerHost` processor.

**Decision:** A (Separate NestJS worker + FFmpeg/ffprobe CLI)

**Libraries:** `fluent-ffmpeg@^2` (optional wrapper) or child_process around system `ffmpeg`/`ffprobe`

---

## TD-05: Unique Public Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a stable public identifier for watch/stream/download URLs that never collides.

**Options:**

### Option A: Nanoid `publicId` column (unique, URL-safe)
- On draft creation, generate `nanoid(11)` (or similar), store in `videos.public_id` with UNIQUE constraint. Routes use `/videos/:publicId/...`. Internal UUID `id` remains PK for FKs/storage keys.
- **Pros:** Short, opaque, collision-resistant; DB unique constraint is source of truth; retry on rare collision.
- **Cons:** Extra dependency (`nanoid`).

### Option B: Use UUID primary key in URLs
- Expose `id` directly.
- **Pros:** No extra column.
- **Cons:** Longer URLs; couples public links to internal PK (harder to rotate later).

### Option C: Sequential numeric id / YouTube-like base64
- Auto-increment or custom encoding.
- **Pros:** Very short.
- **Cons:** Enumerable; leakage of upload volume; more custom code.

**Recommendation:** Option A — `public_id` via URL-safe random id (nanoid alphabet / crypto) with UNIQUE index; UUID stays internal.

**Decision:** A (`public_id` URL-safe random + unique constraint)

**Libraries:** — (Node `crypto.randomBytes`; nanoid alphabet, no extra dependency to keep Jest/CJS compatible)

---

## TD-06: Streaming and Download Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Clients must play without downloading the full file, and also download when requested. Architecture notes frontend may stream from object storage; Phase 03 delivery is API-side.

**Options:**

### Option A: API Range proxy (206 Partial Content) + dedicated download endpoint
- `GET /videos/:publicId/stream` reads `Range` header, fetches the corresponding byte range from MinIO via SDK `GetObject` with `Range`, returns `206` with `Content-Range` / `Accept-Ranges`. `GET /videos/:publicId/download` streams the full object with `Content-Disposition: attachment`.
- **Pros:** AuthZ stays in the API; works for anonymous watch later; no CORS to MinIO required for players hitting the API; satisfies HTTP range semantics.
- **Cons:** API bandwidth for media (acceptable for Phase 03; CDN/presigned can come later).

### Option B: Redirect to short-lived presigned GET URLs
- API returns 302 to MinIO/S3 presigned URL; browser/player talks to storage.
- **Pros:** Offloads bytes from API (matches C4 “Frontend streams from Object Storage”).
- **Cons:** Harder to enforce fine-grained access in Phase 03; CORS/MinIO public URL setup required for local players.

### Option C: HLS/DASH packaging in the worker
- Worker transcodes to adaptive streaming manifests.
- **Pros:** Production-grade playback.
- **Cons:** Far beyond Phase 03 scope (plan only asks duration/metadata + thumbnail + progressive stream/download).

**Recommendation:** Option A — Range-aware stream endpoint + download endpoint via API, sourcing bytes from MinIO. Presigned direct streaming can be revisited when the frontend lands.

**Decision:** A (API Range/206 stream + attachment download)

**Libraries:** `@aws-sdk/client-s3@^3` (GetObject with Range)

---

## TD-07: Video Status Lifecycle and Processing Failure

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Need an explicit state machine for draft → processing → terminal states, including worker failures.

**Options:**

### Option A: `draft` → `processing` → `ready` | `failed`
- Initiate upload creates row in `draft` (title optional/default, storage keys reserved). Completing multipart sets `processing` and enqueues job. Worker success → `ready` (duration, metadata JSON, thumbnail key). Exhausted retries / fatal error → `failed` with `failure_reason`. Stream/download only for `ready`.
- **Pros:** Clear; maps to plan wording (rascunho → processando → pronto/erro); easy to query.
- **Cons:** No intermediate “uploaded but not queued” state (complete endpoint transitions atomically).

### Option B: Fine-grained states (`uploading`, `uploaded`, `probing`, `thumbnailing`, …)
- **Pros:** Observability.
- **Cons:** Over-modeled for Phase 03; more edge cases without product UI.

**Recommendation:** Option A — four statuses with atomic draft→processing on complete and ready/failed from the worker; BullMQ attempts (e.g. 3) before `failed`.

**Decision:** A (`draft` → `processing` → `ready` | `failed`)

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background job queue | BullMQ + Redis | A |
| TD-02 | Backend | Large upload strategy | Presigned multipart to MinIO/S3 | A |
| TD-03 | Backend | Storage layout/client | Single bucket + AWS SDK v3 | A |
| TD-04 | Backend | Worker + FFmpeg | Separate Nest worker container | A |
| TD-05 | Backend | Unique public URL | crypto public_id (nanoid alphabet) | A |
| TD-06 | Backend | Streaming/download | API Range 206 + download | A |
| TD-07 | Backend | Status lifecycle | draft→processing→ready\|failed | A |
