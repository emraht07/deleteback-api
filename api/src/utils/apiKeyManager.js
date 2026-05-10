import 'dotenv/config';
import pb from './pocketbaseClient.js';
import logger from './logger.js';

// In-memory rate limiter: { apiKey: { requestCount: number, resetTime: number } }
const rateLimitMap = new Map();

// In-memory queue system: { activeCount: number, queue: [] }
const queueManager = {
  activeCount: 0,
  queue: [],
  maxConcurrent: 20,
};

/**
 * Validate API key from X-API-Key header
 * @param {string} apiKey - The API key to validate
 * @returns {Promise<Object>} User record with api_plan, api_requests_used, api_monthly_limit
 * @throws {Error} If API key is invalid
 */
export async function validateApiKey(apiKey) {
  if (!apiKey) {
    throw new Error('Missing API key');
  }

  try {
    // Query users collection for matching API key
    const records = await pb.collection('users').getFullList({
      filter: `api_key = "${apiKey}"`,
    });

    if (records.length === 0) {
      throw new Error('Invalid API key');
    }

    const user = records[0];

    // Validate required fields
    if (!user.api_plan || user.api_requests_used === undefined || user.api_monthly_limit === undefined) {
      logger.warn(`User ${user.id} missing API quota fields`);
      throw new Error('Invalid API key');
    }

    return user;
  } catch (error) {
    if (error.message === 'Invalid API key' || error.message === 'Missing API key') {
      throw error;
    }
    logger.error('API key validation error:', error);
    throw new Error('Invalid API key');
  }
}

/**
 * Check if user has exceeded monthly limit
 * @param {Object} user - User record
 * @throws {Error} If monthly limit exceeded
 */
export function checkMonthlyLimit(user) {
  if (user.api_requests_used >= user.api_monthly_limit) {
    const error = new Error('Monthly limit exceeded');
    error.statusCode = 429;
    error.details = {
      used: user.api_requests_used,
      limit: user.api_monthly_limit,
    };
    throw error;
  }
}

/**
 * Check rate limit: max 5 requests per second per API key
 * @param {string} apiKey - The API key
 * @throws {Error} If rate limit exceeded
 */
export function checkRateLimit(apiKey) {
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
    const error = new Error('Rate limit exceeded');
    error.statusCode = 429;
    throw error;
  }

  currentWindow.requestCount += 1;
}

/**
 * Acquire a slot in the processing queue
 * @returns {Promise<Function>} Release function to call when done
 */
export async function acquireQueueSlot() {
  return new Promise((resolve) => {
    if (queueManager.activeCount < queueManager.maxConcurrent) {
      queueManager.activeCount += 1;
      resolve(() => {
        queueManager.activeCount -= 1;
        processQueue();
      });
    } else {
      // Queue the request
      queueManager.queue.push(() => {
        queueManager.activeCount += 1;
        resolve(() => {
          queueManager.activeCount -= 1;
          processQueue();
        });
      });
    }
  });
}

/**
 * Process queued requests
 */
function processQueue() {
  if (queueManager.queue.length > 0 && queueManager.activeCount < queueManager.maxConcurrent) {
    const nextRequest = queueManager.queue.shift();
    nextRequest();
  }
}

/**
 * Increment API requests used for a user
 * @param {string} userId - The user ID
 */
export async function incrementApiRequests(userId) {
  try {
    const user = await pb.collection('users').getOne(userId);
    await pb.collection('users').update(userId, {
      api_requests_used: (user.api_requests_used || 0) + 1,
    });
    logger.info(`Incremented API requests for user ${userId}`);
  } catch (error) {
    logger.error(`Failed to increment API requests for user ${userId}:`, error);
    // Don't throw - this is a non-critical operation
  }
}
