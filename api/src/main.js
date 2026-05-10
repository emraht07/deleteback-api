import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cron from 'node-cron';

import routes from './routes/index.js';
import lemonSqueezyRouter from './routes/lemonSqueezy.js';
import { errorMiddleware } from './middleware/error.js';
import { globalRateLimit } from './middleware/global-rate-limit.js';
import logger from './utils/logger.js';
import { BodyLimit } from './constants/common.js';
import pb from './utils/pocketbaseClient.js';

const app = express();

app.set('trust proxy', true);

process.on('uncaughtException', (error) => {
	logger.error('Uncaught exception:', error);
});
  
process.on('unhandledRejection', (reason, promise) => {
	logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});

process.on('SIGINT', async () => {
	logger.info('Interrupted');
	process.exit(0);
});

process.on('SIGTERM', async () => {
	logger.info('SIGTERM signal received');

	await new Promise(resolve => setTimeout(resolve, 3000));

	logger.info('Exiting');
	process.exit();
});

app.use(helmet());

// Register Lemon Squeezy webhook BEFORE express.json() middleware
// This allows express.raw() to handle the raw body for signature verification
app.use('/api/webhooks/lemon-squeezy', lemonSqueezyRouter);

app.use(cors({
	origin: process.env.CORS_ORIGIN,
	credentials: true,
}));
app.use(morgan('combined'));
app.use(globalRateLimit);
app.use(express.json({
	limit: BodyLimit,
}));
app.use(express.urlencoded({ 
	extended: true,
	limit: BodyLimit,
}));

app.use('/', routes());

app.use(errorMiddleware);

app.use((req, res) => {
	res.status(404).json({ error: 'Route not found' });
});

// Schedule monthly reset: 1st of each month at 00:00 UTC
// Cron pattern: '0 0 1 * *' = minute hour day month dayOfWeek
cron.schedule('0 0 1 * *', async () => {
	logger.info('Running scheduled monthly API requests reset');

	try {
		// Get all users from the users collection
		const users = await pb.collection('users').getFullList();

		if (users.length === 0) {
			logger.info('No users found to reset');
			return;
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

		logger.info(`Scheduled reset completed: ${resetCount} users reset`);
	} catch (error) {
		logger.error('Scheduled monthly reset failed:', error);
	}
}, {
	timezone: 'UTC',
});

const port = process.env.PORT || 3001;

app.listen(port, () => {
	logger.info(`🚀 API Server running on http://localhost:${port}`);
});

export default app;