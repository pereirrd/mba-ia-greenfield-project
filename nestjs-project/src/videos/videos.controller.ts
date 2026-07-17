import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  Headers,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { StorageService } from '../storage/storage.service';
import {
  CompleteUploadDto,
  InitiateUploadDto,
  PresignPartsDto,
} from './dto/upload.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
  ) {}

  @ApiBearerAuth()
  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ) {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @ApiBearerAuth()
  @Post(':id/uploads/parts')
  @HttpCode(HttpStatus.OK)
  async presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PresignPartsDto,
  ) {
    return this.videosService.presignParts(user.sub, id, dto);
  }

  @ApiBearerAuth()
  @Post(':id/uploads/complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Public()
  @Get(':publicId')
  async getByPublicId(
    @Param('publicId') publicId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    return this.videosService.getByPublicId(publicId, user?.sub);
  }

  @Public()
  @Get(':publicId/stream')
  async stream(
    @Param('publicId') publicId: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const video = await this.videosService.getReadyForMedia(publicId);
    const head = await this.storageService.headObject(video.storage_key);
    const total = head.contentLength;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        let end = match[2] ? Number(match[2]) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
          res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
          res.setHeader('Content-Range', `bytes */${total}`);
          return;
        }
        end = Math.min(end, total - 1);
        const chunkSize = end - start + 1;
        const ranged = await this.storageService.getObjectStream(
          video.storage_key,
          `bytes=${start}-${end}`,
        );
        res.status(HttpStatus.PARTIAL_CONTENT);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunkSize);
        res.setHeader('Content-Type', ranged.contentType ?? video.content_type);
        return new StreamableFile(ranged.body);
      }
    }

    const full = await this.storageService.getObjectStream(video.storage_key);
    res.status(HttpStatus.OK);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', total);
    res.setHeader('Content-Type', full.contentType ?? video.content_type);
    return new StreamableFile(full.body);
  }

  @Public()
  @Get(':publicId/download')
  async download(
    @Param('publicId') publicId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const video = await this.videosService.getReadyForMedia(publicId);
    const head = await this.storageService.headObject(video.storage_key);
    const object = await this.storageService.getObjectStream(video.storage_key);
    const safeName = `${video.title.replace(/[^\w.-]+/g, '_')}.mp4`;
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    res.setHeader('Content-Length', head.contentLength);
    res.setHeader('Content-Type', object.contentType ?? video.content_type);
    return new StreamableFile(object.body);
  }
}
