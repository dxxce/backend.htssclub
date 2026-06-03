import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

export interface StoredFile {
  url: string;
  type: string;
  name: string;
  size: number;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly config: ConfigService) {}

  async saveAvatar(file: Express.Multer.File): Promise<StoredFile> {
    if (!file) throw new BadRequestException('No file uploaded');
    const max = this.config.get<number>('upload.avatarMaxBytes')!;
    if (file.size > max) {
      throw new BadRequestException('Avatar exceeds size limit');
    }
    if (!IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException('Avatar must be an image');
    }
    return this.store(file, 'avatars');
  }

  async saveAttachment(file: Express.Multer.File): Promise<StoredFile> {
    if (!file) throw new BadRequestException('No file uploaded');
    const max = this.config.get<number>('upload.attachmentMaxBytes')!;
    if (file.size > max) {
      throw new BadRequestException('Attachment exceeds size limit');
    }
    return this.store(file, 'attachments');
  }

  private async store(
    file: Express.Multer.File,
    folder: string,
  ): Promise<StoredFile> {
    const driver = this.config.get<string>('upload.driver');
    const safeExt = extname(file.originalname).slice(0, 12);
    const filename = `${randomUUID()}${safeExt}`;

    if (driver === 's3') {
      // Placeholder for S3/MinIO integration. Wire up @aws-sdk/client-s3
      // here; for now we fall through to local storage to stay runnable.
      this.logger.warn('S3 driver not configured; storing locally');
    }

    const baseDir = this.config.get<string>('upload.localDir')!;
    const dir = join(baseDir, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, filename), file.buffer);

    const publicBase = this.config.get<string>('upload.publicBaseUrl');
    const url = `${publicBase}/${folder}/${filename}`;
    return {
      url,
      type: file.mimetype,
      name: file.originalname,
      size: file.size,
    };
  }
}
