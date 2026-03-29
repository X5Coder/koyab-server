const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ENV
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_API_URL =
'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// حماية
const blockedIPs = new Set();
let rateLimitBlockUntil = 0;

const MAX_CONCURRENT = 3;
let activeRequests = 0;
const requestQueue = [];

// مهم: قلل الحجم
app.use(express.json({ limit: '20mb' }));

// 🧠 IP
function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

// 📩 Telegram
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message },
            { timeout: 5000 }
        );
    } catch (err) {
        console.error('❌ Telegram Error:', err.message);
    }
}

// 🚫 Block
function blockAndNotify(ip, reason, req, body = {}) {
    if (blockedIPs.has(ip)) return;

    blockedIPs.add(ip);

    const message = `🚫 حظر IP
IP: ${ip}
السبب: ${reason}
Agent: ${req.headers['user-agent']}`;

    sendTelegramNotification(message);
}

// 🔒 IP Middleware
app.use((req, res, next) => {
    const ip = getClientIP(req);
    if (blockedIPs.has(ip)) {
        return res.status(403).json({ error: 'IP blocked' });
    }
    next();
});

// 🌐 CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    res.header('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 🤖 Gemini
async function sendToGemini(prompt, pdfBase64, requestId) {
    try {
        const parts = [{ text: prompt }];

        if (pdfBase64) {
            parts.push({
                inline_data: {
                    mime_type: "application/pdf",
                    data: pdfBase64
                }
            });
        }

        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            {
                contents: [{ parts }],
                generationConfig: {
                    temperature: 0.1,
                    maxOutputTokens: 2000
                }
            },
            { timeout: 120000 }
        );

        return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';

    } catch (err) {
        const msg = err.response?.data?.error?.message || err.message;

        await sendTelegramNotification(`❌ Gemini Error\nID: ${requestId}\n${msg}`);

        throw new Error(msg);
    }
}

// 🧵 Queue
function processQueue() {
    if (activeRequests >= MAX_CONCURRENT) return;
    if (!requestQueue.length) return;

    const job = requestQueue.shift();
    activeRequests++;

    (async () => {
        try {
            const result = await sendToGemini(job.prompt, job.pdf, job.id);
            if (!job.res.headersSent) {
                job.res.send(result);
            }
        } catch (e) {
            if (!job.res.headersSent) {
                job.res.status(500).json({ error: e.message });
            }
        } finally {
            activeRequests--;
            processQueue();
        }
    })();
}

// 🚀 API
app.post('/api/KIMO_DEV', (req, res) => {
    const ip = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;

    const hasText = !!data;
    const hasPdf = !!PDF_BASE64;

    if (!hasText && !hasPdf) {
        blockAndNotify(ip, 'طلب فارغ', req);
        return res.status(400).json({ error: 'طلب فارغ' });
    }

    if (!id || !pass) {
        blockAndNotify(ip, 'بدون id/pass', req);
        return res.status(403).json({ error: 'بيانات ناقصة' });
    }

    if (pass !== id + 'abcde57') {
        blockAndNotify(ip, 'pass خطأ', req);
        return res.status(403).json({ error: 'بيانات غلط' });
    }

    const requestId = Date.now().toString();

    requestQueue.push({
        res,
        prompt: data || '',
        pdf: PDF_BASE64 || null,
        id: requestId
    });

    processQueue();
});

// 🧪 Health
app.get('/api/health', (req, res) => {
    res.json({
        queue: requestQueue.length,
        active: activeRequests,
        blocked: blockedIPs.size
    });
});

// 🏠 Root
app.get('/', (req, res) => {
    res.send('Server running');
});

// ❌ 404
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// 🛡️ GLOBAL PROTECTION
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
    console.error('🔥 Unhandled Rejection:', err);
});

// 🚀 Start
const server = app.listen(PORT, () => {
    console.log(`✅ Server running on ${PORT}`);
});

server.timeout = 300000;
server.keepAliveTimeout = 120000;
