import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import logger from '../utils/logger.js';
import pb from '../utils/pocketbaseClient.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Allowed image MIME types
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const PROCESSING_TIMEOUT = 8000; // 8 seconds

// In-memory rate limiter: { apiKey: { requestCount: number, resetTime: number } }
const rateLimitMap = new Map();

/**
 * Check rate limit: max 5 requests per second per API key
 * @param {string} apiKey - The API key
 * @throws {Error} If rate limit exceeded
 */
function checkRateLimit(apiKey) {
  const now = Date.now();
  const currentWindow = rateLimitMap.get(apiKey);

  if (!currentWindow) {
    // First request in this second
    rateLimitMap.set(apiKey, { requestCount: 1, resetTime: now + 1000 });
    return;
  }

  if (now >= currentWindow.resetTime) {
    // Window expired, reset
    rateLimitMap.set(apiKey, { requestCount: 1, resetTime: now + 1000 });
    return;
  }

  // Still in same window
  if (currentWindow.requestCount >= 5) {
    throw new Error('Rate limit exceeded (5 requests/second)');
  }

  currentWindow.requestCount += 1;
}

/**
 * POST /api/v1/remove - Remove background from image
 * Requires X-API-Key header or api_key query parameter
 */
router.post('/api/v1/remove', upload.single('image'), async (req, res) => {
  // 1. Extract API key from Authorization header (Bearer token) or api_key query param
  let apiKey = req.headers['x-api-key'];
  if (!apiKey && req.headers.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7);
    }
  }
  if (!apiKey) {
    apiKey = req.query.api_key;
  }

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  // 2. Find user in PocketBase by api_key field
  let user;
  try {
    const users = await pb.collection('users').getFullList({
      filter: `api_key = "${apiKey}"`,
    });

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    user = users[0];
  } catch (error) {
    logger.error('Failed to validate API key:', error);
    return res.status(401).json({ error: 'Invalid API key' });
  }

  // 3. Check if api_requests_used >= api_monthly_limit
  if (user.api_requests_used >= user.api_monthly_limit) {
    throw new Error('Monthly limit exceeded');
  }

  // 4. Check rate limit (5 requests/second per API key)
  checkRateLimit(apiKey);

  // 5. Validate image file
  if (!req.file) {
    return res.status(400).json({ error: 'Invalid image format' });
  }

  if (!ALLOWED_MIME_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Invalid image format' });
  }

  if (req.file.size > MAX_FILE_SIZE) {
    return res.status(400).json({ error: 'Invalid image format' });
  }

  // 6. Extract optional mode parameter
  const pixelPerfect = req.query.mode === 'pixel_perfect';

  try {
    // 7. Process image with timeout
    const pngBuffer = await Promise.race([
      processImageRemoveBackground(req.file.buffer, pixelPerfect),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Processing timeout')), PROCESSING_TIMEOUT)
      ),
    ]);

    // 8. Return PNG binary on success
    res.type('image/png').send(pngBuffer);

    // 9. Increment api_requests_used by 1 in PocketBase user record (async, don't wait)
    pb.collection('users')
      .update(user.id, {
        api_requests_used: (user.api_requests_used || 0) + 1,
      })
      .catch((error) => {
        logger.error(`Failed to increment API requests for user ${user.id}:`, error);
      });

    logger.info(`Successfully processed image for user ${user.id}`);
  } catch (error) {
    if (error.message === 'Processing timeout') {
      return res.status(504).json({ error: 'Processing timeout' });
    }
    throw error;
  }
});

/**
 * Process image and remove background
 * @param {Buffer} imageBuffer - Image file buffer
 * @param {boolean} pixelPerfect - Use pixel perfect mode
 * @returns {Promise<Buffer>} PNG buffer
 */
async function processImageRemoveBackground(imageBuffer, pixelPerfect) {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image format or corrupted image');
  }

  // Convert to RGBA for alpha channel manipulation
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels; // Should be 4 (RGBA)

  if (channels !== 4) {
    throw new Error('Failed to convert image to RGBA format');
  }

  // Calculate threshold based on mode
  // Pixel perfect mode uses stricter threshold (75 precision)
  const precision = pixelPerfect ? 75 : 50;
  const threshold = Math.max(10, 255 - precision * 2.55);

  // Detect background color from corners
  const cornerPixels = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  let bgR = 0,
    bgG = 0,
    bgB = 0;
  cornerPixels.forEach(({ x, y }) => {
    const idx = (y * width + x) * 4;
    bgR += data[idx];
    bgG += data[idx + 1];
    bgB += data[idx + 2];
  });

  bgR = Math.round(bgR / cornerPixels.length);
  bgG = Math.round(bgG / cornerPixels.length);
  bgB = Math.round(bgB / cornerPixels.length);

  logger.debug(
    `Processing image: ${width}x${height}, mode: ${pixelPerfect ? 'pixel_perfect' : 'standard'}, threshold: ${threshold}`
  );

  // Apply color-based background removal
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Calculate color distance from background
    const distance = Math.sqrt(
      Math.pow(r - bgR, 2) + Math.pow(g - bgG, 2) + Math.pow(b - bgB, 2)
    );

    // If color is similar to background, make it transparent
    if (distance < threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Convert back to PNG with alpha channel
  const pngBuffer = await sharp(data, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  return pngBuffer;
}

router.post('/', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Image file is required' });
  }

  const precision = parseInt(req.body.precision, 10);
  if (isNaN(precision) || precision < 0 || precision > 100) {
    return res.status(400).json({ error: 'Precision must be a number between 0 and 100' });
  }

  logger.info(`Processing image with precision: ${precision}`);

  // Load image and get metadata
  const image = sharp(req.file.buffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image format or corrupted image');
  }

  // Convert to RGBA for alpha channel manipulation
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels; // Should be 4 (RGBA)

  if (channels !== 4) {
    throw new Error('Failed to convert image to RGBA format');
  }

  // Calculate threshold based on precision (0-100)
  // Higher precision = stricter threshold (less background removed)
  // Lower precision = looser threshold (more background removed)
  const threshold = Math.max(10, 255 - precision * 2.55);

  // Detect background color from corners (average of corner pixels)
  const cornerPixels = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  let bgR = 0,
    bgG = 0,
    bgB = 0;
  cornerPixels.forEach(({ x, y }) => {
    const idx = (y * width + x) * 4;
    bgR += data[idx];
    bgG += data[idx + 1];
    bgB += data[idx + 2];
  });

  bgR = Math.round(bgR / cornerPixels.length);
  bgG = Math.round(bgG / cornerPixels.length);
  bgB = Math.round(bgB / cornerPixels.length);

  logger.debug(`Detected background color: RGB(${bgR}, ${bgG}, ${bgB}), threshold: ${threshold}`);

  // Apply color-based background removal
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Calculate color distance from background
    const distance = Math.sqrt(
      Math.pow(r - bgR, 2) + Math.pow(g - bgG, 2) + Math.pow(b - bgB, 2)
    );

    // If color is similar to background, make it transparent
    if (distance < threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Convert back to PNG with alpha channel
  const pngBuffer = await sharp(data, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();

  res.type('image/png').send(pngBuffer);
});

router.get('/download-hd', async (req, res) => {
  const { imageData } = req.query;

  if (!imageData) {
    return res.status(400).json({ error: 'imageData parameter is required' });
  }

  logger.info('Processing HD quality image download');

  // Decode base64 image data
  let imageBuffer;
  if (imageData.startsWith('data:image')) {
    // Handle data URI format
    const base64Data = imageData.split(',')[1];
    imageBuffer = Buffer.from(base64Data, 'base64');
  } else {
    // Handle raw base64
    imageBuffer = Buffer.from(imageData, 'base64');
  }

  // Validate image buffer
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error('Invalid or empty image data');
  }

  // Load and process image with HD quality settings
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error('Invalid image format or corrupted image');
  }

  logger.debug(`Processing image: ${metadata.width}x${metadata.height}, format: ${metadata.format}`);

  // Convert to RGBA and process
  const { data, info } = await image
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  if (channels !== 4) {
    throw new Error('Failed to convert image to RGBA format');
  }

  // Detect background color from corners
  const cornerPixels = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  let bgR = 0,
    bgG = 0,
    bgB = 0;
  cornerPixels.forEach(({ x, y }) => {
    const idx = (y * width + x) * 4;
    bgR += data[idx];
    bgG += data[idx + 1];
    bgB += data[idx + 2];
  });

  bgR = Math.round(bgR / cornerPixels.length);
  bgG = Math.round(bgG / cornerPixels.length);
  bgB = Math.round(bgB / cornerPixels.length);

  logger.debug(`Detected background color: RGB(${bgR}, ${bgG}, ${bgB})`);

  // Apply background removal with default precision (75)
  const threshold = Math.max(10, 255 - 75 * 2.55);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const distance = Math.sqrt(
      Math.pow(r - bgR, 2) + Math.pow(g - bgG, 2) + Math.pow(b - bgB, 2)
    );

    if (distance < threshold) {
      data[i + 3] = 0;
    }
  }

  // Generate HD quality PNG with maximum color depth and optimized compression
  const hdPngBuffer = await sharp(data, {
    raw: {
      width,
      height,
      channels: 4,
    },
  })
    .png({
      compressionLevel: 9, // Maximum compression (0-9)
      adaptiveFiltering: true, // Optimize filtering for better compression
      palette: false, // Use full color depth, not palette mode
    })
    .toBuffer();

  logger.info(`Generated HD PNG: ${hdPngBuffer.length} bytes`);

  // Set response headers for downloadable file
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'attachment; filename=image-hd.png');
  res.setHeader('Content-Length', hdPngBuffer.length);

  res.send(hdPngBuffer);
});

export default router;
