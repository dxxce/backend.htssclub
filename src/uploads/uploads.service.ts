import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';
import { AttachmentCategory } from '../common/enums';

const IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml',
]);

export interface StoredFile {
  url: string;
  type: string; // MIME type
  name: string;
  size: number;
  category: AttachmentCategory;
}

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(private readonly config: ConfigService) {}

  /** Classifies a file into a broad attachment category from its MIME type. */
  categorize(mime: string): AttachmentCategory {
    if (mime.startsWith('image/')) return AttachmentCategory.IMAGE;
    if (mime.startsWith('video/')) return AttachmentCategory.VIDEO;
    if (mime.startsWith('audio/')) return AttachmentCategory.AUDIO;
    return AttachmentCategory.FILE;
  }

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

  /**
   * Stores any message attachment: image, video, audio or generic file.
   * Applies a higher size limit to videos than to other files.
   */
  async saveAttachment(file: Express.Multer.File): Promise<StoredFile> {
    if (!file) throw new BadRequestException('No file uploaded');
    const category = this.categorize(file.mimetype);
    const max =
      category === AttachmentCategory.VIDEO
        ? this.config.get<number>('upload.videoMaxBytes')!
        : this.config.get<number>('upload.attachmentMaxBytes')!;
    if (file.size > max) {
      const mb = Math.round(max / (1024 * 1024));
      throw new BadRequestException(
        `${category} attachment exceeds size limit (${mb}MB)`,
      );
    }
    const folder = `attachments/${category.toLowerCase()}`;
    return this.store(file, folder);
  }

  private async store(
    file: Express.Multer.File,
    folder: string,
  ): Promise<StoredFile> {
    const driver = this.config.get<string>('upload.driver');
    const safeExt = this.safeExtension(file.originalname);
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
      category: this.categorize(file.mimetype),
    };
  }

  /** Sanitizes the file extension to avoid path tricks. */
  private safeExtension(originalName: string): string {
    const ext = extname(originalName || '').toLowerCase();
    if (!ext || !/^\.[a-z0-9]{1,12}$/.test(ext)) return '';
    return ext;
  }
}
