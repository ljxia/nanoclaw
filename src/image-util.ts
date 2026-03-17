/**
 * Image utility for saving and resizing message attachments.
 * Ensures images fit within LLM vision limits before saving.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { ImageAttachment } from './types.js';

// Claude vision supports up to ~1568px on the long edge.
// Resize to fit within this box to avoid wasting tokens on excess pixels.
const MAX_DIMENSION = 1568;
// Skip images larger than 15MB raw (before resize)
const MAX_RAW_SIZE = 15 * 1024 * 1024;

/**
 * Save an image buffer to the group's media directory, resizing if needed.
 * Returns the ImageAttachment on success, null on failure.
 */
export async function saveImage(
  groupFolder: string,
  buffer: Buffer,
  mediaType: string,
  nameHint: string,
): Promise<ImageAttachment | null> {
  try {
    if (buffer.length > MAX_RAW_SIZE) {
      logger.warn(
        { size: buffer.length, nameHint },
        'Image too large, skipping',
      );
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const mediaDir = path.join(groupDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });

    // Determine output format — keep jpeg/png/webp, convert others to jpeg
    let ext = nameHint.split('.').pop()?.toLowerCase() || 'jpg';
    let outputFormat: 'jpeg' | 'png' | 'webp' = 'jpeg';
    if (ext === 'png') outputFormat = 'png';
    else if (ext === 'webp') outputFormat = 'webp';
    else ext = 'jpg';

    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const outputPath = path.join(mediaDir, filename);

    // Resize if either dimension exceeds MAX_DIMENSION
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;

    let pipeline = image;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      logger.debug(
        { width, height, maxDim: MAX_DIMENSION, nameHint },
        'Resizing image for vision',
      );
    }

    const outputBuffer = await pipeline.toFormat(outputFormat).toBuffer();
    fs.writeFileSync(outputPath, outputBuffer);

    const outMediaType =
      outputFormat === 'jpeg'
        ? 'image/jpeg'
        : outputFormat === 'png'
          ? 'image/png'
          : 'image/webp';

    logger.debug(
      {
        filename,
        originalSize: buffer.length,
        outputSize: outputBuffer.length,
        originalDims: `${width}x${height}`,
      },
      'Image saved for vision',
    );

    return { path: `media/${filename}`, mediaType: outMediaType };
  } catch (err) {
    logger.warn({ err, nameHint }, 'Failed to process image');
    return null;
  }
}
