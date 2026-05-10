import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import pb from '../utils/pocketbaseClient.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Verify Lemon Squeezy webhook signature
 * @param {string} payload - Raw request body as string
 * @param {string} signature - X-Signature header value
 * @throws {Error} If signature is invalid
 */
function verifyWebhookSignature(payload, signature) {
  const secret = process.env.LEMON_SQUEEZY_SIGNING_SECRET;

  if (!secret) {
    logger.warn('LEMON_SQUEEZY_SIGNING_SECRET not configured');
    throw new Error('Webhook signature verification not configured');
  }

  if (!signature) {
    throw new Error('Missing X-Signature header');
  }

  // Compute HMAC-SHA256 of the payload
  const computed = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  // Use timingSafeEqual to prevent timing attacks
  const signatureBuffer = Buffer.from(signature, 'hex');
  const computedBuffer = Buffer.from(computed, 'hex');

  if (signatureBuffer.length !== computedBuffer.length) {
    throw new Error('Invalid webhook signature');
  }

  if (!crypto.timingSafeEqual(signatureBuffer, computedBuffer)) {
    throw new Error('Invalid webhook signature');
  }
}

/**
 * Generate a random password for new users
 * @returns {string} Random password
 */
function generateRandomPassword() {
  return crypto.randomBytes(16).toString('hex');
}
/**
 * POST /api/webhooks/lemon-squeezy
 * Handle Lemon Squeezy webhook events
 * Verifies signature, extracts customer email, and creates/updates user
 */
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  // Get raw body and signature
  const rawBody = req.body.toString('utf-8');
  const signature = req.headers['x-signature'];

  // Verify webhook signature
  try {
    verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    logger.error('Webhook signature verification failed:', error.message);
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  // Parse JSON payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    logger.error('Failed to parse webhook payload:', error.message);
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  const { meta, data } = payload;

  // Validate event type
  if (!meta || !meta.event_name) {
    logger.info('Ignoring webhook: missing event_name');
    return res.json({ status: 'ok' });
  }

  const eventName = meta.event_name;

  // Only process subscription_created and subscription_payment_success events
  if (eventName !== 'subscription_created' && eventName !== 'subscription_payment_success') {
    logger.info(`Ignoring non-subscription event: ${eventName}`);
    return res.json({ status: 'ok' });
  }

  logger.info(`Received Lemon Squeezy webhook event: ${eventName}`);

  // Extract customer email
  const customerEmail = data?.attributes?.user_email || data?.attributes?.customer_email;
  if (!customerEmail) {
    logger.error('Missing customer_email/user_email in webhook payload');
    return res.status(400).json({ error: 'Missing customer_email' });
  }

  logger.info(`Processing webhook for customer: ${customerEmail}`);

  try {
    // Query PocketBase for existing user by email
    let user;
    try {
      user = await pb.collection('users').getFirstListItem(`email="${customerEmail}"`);
      logger.info(`Found existing user ${user.id} with email: ${customerEmail}`);
    } catch (error) {
      // User does not exist
      user = null;
    }

    if (user) {
      // User exists: update plan and credits
      logger.info(`Updating existing user ${user.id} with Pro plan`);

      await pb.collection('users').update(user.id, {
        api_plan: 'Pro',
        credits: 5000,
        api_monthly_limit: 5000,
        api_requests_used: 0,
      });

      logger.info(`Successfully updated user ${user.id}`);
      return res.json({ status: 'ok', user_email: customerEmail });
    }

    // User does NOT exist: create new user
    logger.info(`Creating new user with email: ${customerEmail}`);

    const newPassword = generateRandomPassword();

    const newUser = await pb.collection('users').create({
      email: customerEmail,
      password: newPassword,
      passwordConfirm: newPassword,
      api_plan: 'Pro',
      credits: 5000,
      api_monthly_limit: 5000,
      api_requests_used: 0,
    });

    logger.info(`Created new user ${newUser.id} with email: ${customerEmail}`);

    res.json({ status: 'ok', user_email: customerEmail });
  } catch (error) {
    logger.error(`Failed to process Lemon Squeezy webhook for ${customerEmail}:`, error);
    return res.status(500).json({ error: 'Failed to process webhook' });
  }
});

export default router;