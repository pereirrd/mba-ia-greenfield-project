---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-17T13:36:02+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-17T13:45:00+00:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-07-17T13:36:02+00:00"
  docs/phases/phase-02-auth/context.md: "2026-07-17T13:36:02+00:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-17T13:36:02+00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Frontend video UI; video edit/publish/visibility (Fase 04); watch page player (Fase 05); social features (Fase 06).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — video screens not in this phase.

**Sequencing notes:** Depends on Fase 01 (base) and Fase 02 (auth + channel 1:1). Videos belong to the user's channel.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — auth, users, channels delivered.
- **Phase 04:** Gerenciamento de Vídeos e Canal — edit/publish/visibility after upload pipeline exists.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11, bullmq@^5, ioredis@^5 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Large File Upload Strategy | decided | A (Presigned multipart) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Layout and Client | decided | A (Single bucket + AWS SDK v3) | @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3 |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker Process and FFmpeg | decided | A (Separate NestJS worker + FFmpeg) | fluent-ffmpeg@^2 |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Unique Public Video URL Identifier | decided | A (nanoid public_id) | nanoid@^5 |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Streaming and Download Strategy | decided | A (API Range 206 + download) | @aws-sdk/client-s3@^3 |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (draft→processing→ready\|failed) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — NestJS-native integration, proven for video pipelines, and Redis is a small Compose addition that matches the “Message Queue” container without over-engineering.

**Libraries:** @nestjs/bullmq@^11, bullmq@^5, ioredis@^5

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart upload to MinIO/S3 — only strategy that keeps the API off the data path and supports 10GB on S3-compatible storage.

**Libraries:** @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3

### phase-03-videos/TD-03

**Recommendation:** One bucket, namespaced keys, AWS SDK v3 pointing at MinIO service hostname `minio`.

**Libraries:** @aws-sdk/client-s3@^3, @aws-sdk/s3-request-presigner@^3

### phase-03-videos/TD-04

**Recommendation:** Separate worker container with FFmpeg, Nest DI, BullMQ WorkerHost processor.

**Libraries:** fluent-ffmpeg@^2

### phase-03-videos/TD-05

**Recommendation:** `public_id` via nanoid with UNIQUE index; UUID stays internal.

**Libraries:** nanoid@^5

### phase-03-videos/TD-06

**Recommendation:** Range-aware stream endpoint + download endpoint via API, sourcing bytes from MinIO.

**Libraries:** @aws-sdk/client-s3@^3

### phase-03-videos/TD-07

**Recommendation:** Four statuses with atomic draft→processing on complete and ready/failed from the worker; BullMQ attempts before `failed`.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Custom guards with @nestjs/jwt — JWT access guard is global; use `@Public()` for anonymous stream/download of ready videos.

**Libraries:** @nestjs/jwt@^11.0.0

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — `{ statusCode, error, message }` error envelope for all new video domain exceptions.

**Libraries:** —

### phase-01-configuracao-base/TD — TypeORM + migrations

**Recommendation:** TypeORM Data Mapper with versioned migrations; `synchronize: false`; Docker service hostname `db`.

**Libraries:** typeorm, @nestjs/typeorm, pg

## Inherited Conventions

- Global JWT guard with `@Public()` opt-out _(from phase 02)_
- Domain exceptions + `DomainExceptionFilter` error envelope _(from phase 02)_
- Config via `registerAs` namespaces + Joi `env.validation.ts` _(from phase 01)_
- Docker Compose service names as hosts — never localhost inside containers _(from phase 01)_
- Test suffixes: `*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`; integration/e2e `--runInBand` _(from phase 02)_
- Each user has exactly one channel (1:1) created at registration — videos belong to channel _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| Frontend video upload/player UI | deferred | Challenge scope is backend-only; `next-frontend/` video screens belong to later phases | — |

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity | Integration (constraints, defaults, relations) |
| Service with branching + DB | Unit (mock boundaries) + Integration (DB contract) |
| Service with storage/queue side-effect | Integration against real MinIO/Redis when available |
| Module with configured imports | Unit compilation |
| Controller | E2E only |
| Domain exception | Unit filter mapping + E2E |
| Worker processor | Unit (mocked ffmpeg/storage) + Integration (queue + DB) where feasible |
