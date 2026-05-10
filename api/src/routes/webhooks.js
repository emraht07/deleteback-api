import 'dotenv/config';
import express from 'express';
import pb from '../utils/pocketbaseClient.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * POST /webhooks/monthly-reset
 * Resets api_requests_used to 0 for all users
 * Should be called via external cron service on the 1st of every month at 00:00 UTC
 */
router.post('/monthly-reset', async (req, res) => {
  logger.info('Starting monthly API requests reset');

  try {
    // Get all users from the users collection
    const users = await pb.collection('users').getFullList();

    if (users.length === 0) {
      logger.info('No users found to reset');
      return res.json({ success: true, usersReset: 0 });
    }

    let resetCount = 0;

    // Reset api_requests_used for each user
    for (const user of users) {
      try {
        await pb.collection('users').update(user.id, {
          api_requests_used: 0,
        });
        resetCount += 1;
      } catch (error) {
        logger.error(`Failed to reset user ${user.id}:`, error);
        // Continue with next user even if one fails
      }
    }

    logger.info(`Successfully reset ${resetCount} users`);
    res.json({ success: true, usersReset: resetCount });
  } catch (error) {
    logger.error('Monthly reset failed:', error);
    throw error;
  }
});

/**
 * POST /webhooks/lemon
 * Handle Lemon Squeezy webhook events
 * Events: subscription_created, subscription_payment_success, subscription_cancelled, subscription_expired
 */
router.post('/lemon', async (req, res) => {
  const { meta, data } = req.body;

  if (!meta || !meta.event_name) {
    logger.warn('Invalid Lemon Squeezy webhook payload: missing event_name');
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  const eventName = meta.event_name;
  logger.info(`Received Lemon Squeezy webhook event: ${eventName}`);

  // Extract customer email from payload
  const customerEmail = data?.attributes?.customer_email;
  if (!customerEmail) {
    logger.warn(`Webhook event ${eventName}: missing customer_email`);
    return res.status(400).json({ error: 'Missing customer email' });
  }

  try {
    // Find user by email
    const users = await pb.collection('users').getFullList({
      filter: `email = "${customerEmail}"`,
    });

    if (users.length === 0) {
      logger.warn(`No user found with email: ${customerEmail}`);
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];
    const updateData = {};

    // Handle subscription events
    if (eventName === 'subscription_created' || eventName === 'subscription_payment_success') {
      // Extract plan information from payload
      const productName = data?.attributes?.product_name || '';
      const variantName = data?.attributes?.variant_name || '';
      const planInfo = `${productName} ${variantName}`.toLowerCase();

      // Determine plan based on product/variant name
      if (planInfo.includes('business')) {
        updateData.api_plan = 'business';
        updateData.api_monthly_limit = 100000;
      } else if (planInfo.includes('pro')) {
        updateData.api_plan = 'pro';
        updateData.api_monthly_limit = 5000;
      } else {
        // Default to pro if plan name doesn't match
        updateData.api_plan = 'pro';
        updateData.api_monthly_limit = 5000;
      }

      updateData.api_requests_used = 0;
      logger.info(`Setting user ${user.id} to plan: ${updateData.api_plan}`);
    } else if (eventName === 'subscription_cancelled' || eventName === 'subscription_expired') {
      // Downgrade to free plan
      updateData.api_plan = 'free';
      updateData.api_monthly_limit = 100;
      // Keep api_requests_used unchanged
      logger.info(`Downgrading user ${user.id} to free plan`);
    } else {
      logger.warn(`Unhandled webhook event: ${eventName}`);
      return res.status(200).json({ status: 'ok' });
    }

    // Update user record in PocketBase
    await pb.collection('users').update(user.id, updateData);
    logger.info(`Successfully updated user ${user.id} for event ${eventName}`);

    res.json({ status: 'ok' });
  } catch (error) {
    logger.error(`Failed to process Lemon Squeezy webhook for ${customerEmail}:`, error);
    throw error;
  }
});

export default router;
