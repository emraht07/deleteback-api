import { Router } from 'express';
import healthCheck from './health-check.js';
import removeBackgroundRouter from './removeBackground.js';
import webhooksRouter from './webhooks.js';
import lemonSqueezyRouter from './lemonSqueezy.js';
import pb from '../utils/pocketbaseClient.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /admin/reset-monthly-usage
 * Manual endpoint for testing monthly reset
 * Resets api_requests_used to 0 for all users
 */
router.get('/admin/reset-monthly-usage', async (req, res) => {
  logger.info('Manual monthly usage reset triggered');

  try {
    // Fetch all users from PocketBase
    const users = await pb.collection('users').getFullList();

    if (users.length === 0) {
      logger.info('No users found to reset');
      return res.json({ status: 'ok', updated: 0 });
    }

    let updateCount = 0;

    // Update each user record setting api_requests_used=0
    for (const user of users) {
      try {
        await pb.collection('users').update(user.id, {
          api_requests_used: 0,
        });
        updateCount += 1;
      } catch (error) {
        logger.error(`Failed to reset user ${user.id}:`, error);
        // Continue with next user even if one fails
      }
    }

    logger.info(`Successfully reset ${updateCount} users`);
    res.json({ status: 'ok', updated: updateCount });
  } catch (error) {
    logger.error('Manual reset failed:', error);
    throw error;
  }
});

export default () => {
  router.get('/health', healthCheck);
  router.use('/remove-background', removeBackgroundRouter);
  router.use('/webhooks/lemon-squeezy', lemonSqueezyRouter);
  router.use('/webhooks', webhooksRouter);

  return router;
};