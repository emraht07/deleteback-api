import dotenv from 'dotenv';
dotenv.config();
import Pocketbase from 'pocketbase';
import logger from './logger.js';
import https from 'https';
import http from 'http';

const POCKETBASE_HOST = `https://${process.env.WEBSITE_DOMAIN}/hcgi/platform`;

// Override global fetch to ignore SSL errors
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => {
    return originalFetch(url, {
        ...options,
    });
};

const pocketbaseClient = new Pocketbase(POCKETBASE_HOST);
pocketbaseClient.autoCancellation(false);

// Ignore SSL for pocketbase
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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
        // Skip health check, directly try to authenticate
        await new Promise((r) => setTimeout(r, 2000));
        
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
