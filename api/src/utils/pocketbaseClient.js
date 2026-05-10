import dotenv from 'dotenv';
dotenv.config();
import Pocketbase from 'pocketbase';
import logger from './logger.js';
import { Agent } from 'undici';

const POCKETBASE_HOST = `https://${process.env.WEBSITE_DOMAIN}/hcgi/platform`;

const insecureDispatcher = new Agent({
    connect: { rejectUnauthorized: false }
});

async function waitForHealth({ retries = 10, delayMs = 2000 } = {}) {
    for (let i = 1; i <= retries; i++) {
        try {
            const response = await fetch(`${POCKETBASE_HOST}/api/health`, {
                method: 'HEAD',
                dispatcher: insecureDispatcher,
            });
            if (response.ok) return;
        } catch (err) {
            logger.warn(`PocketBase health check attempt ${i}/${retries} failed: ${err.message}`);
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`PocketBase health check failed after ${retries} retries`);
}

const pocketbaseClient = new Pocketbase(POCKETBASE_HOST);
pocketbaseClient.autoCancellation(false);
let authPromise = null;

pocketbaseClient.beforeSend = async function (url, options) {
    if (url.includes('/api/collections/_superusers/auth-with-password')) {
        return { url, options };
    }
    if (!pocketbaseClient.authStore.isValid && !authPromise) {
        authPromise = pocketbaseClient.collection('_superusers').authWithPassword(
            process.env.PB_SUPERUSER_EMAIL,
            process.env.PB_SUPERUSER_PASSWORD,
        ).finally(() => { authPromise = null; });
    }
    if (authPromise) await authPromise;
    if (pocketbaseClient.authStore.isValid && pocketbaseClient.authStore.token) {
        options.headers = options.headers || {};
        options.headers['Authorization'] = pocketbaseClient.authStore.token;
    }
    return { url, options };
};

(async () => {
    try {
        await waitForHealth();
        if (!pocketbaseClient.authStore.isValid && !authPromise) {
            authPromise = pocketbaseClient.collection('_superusers').authWithPassword(
                process.env.PB_SUPERUSER_EMAIL,
                process.env.PB_SUPERUSER_PASSWORD,
            ).finally(() => { authPromise = null; });
        }
        if (authPromise) await authPromise;
        logger.info('PocketBase client initialized successfully');
    } catch (err) {
        logger.error('Failed to initialize PocketBase client:', err);
        process.exit(1);
    }
})();

export default pocketbaseClient;
export { pocketbaseClient };
