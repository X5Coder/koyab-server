const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🌐 ENV
const GEMINI_API_KEY = process.env.API;
const TELEGRAM_CHAT_ID = process.env.ID;
const TELEGRAM_BOT_TOKEN = process.env.TOKEN;

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// 🧪 DEBUG ENV (مهم)
function mask(str) {
    if (!str) return '❌ NOT FOUND';
    return str.substring(0, 5) + '*****' + str.substring(str.length - 5);
}

console.log("🔍 ENV CHECK:");
console.log("API:", mask(GEMINI_API_KEY));
console.log("ID:", TELEGRAM_CHAT_ID || '❌ NOT FOUND');
console.log("TOKEN:", mask(TELEGRAM_BOT_TOKEN));

// 🚫 حماية
const blockedIPs = new Set();
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const requestQueue = [];

app.use(express.json({ limit: '20mb' }));

// 🧠 IP
function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

// 📩 Telegram (FIXED + DEBUG)
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("⚠️ Telegram ENV missing");
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

        console.log("📤 Sending Telegram to:", TELEGRAM_CHAT_ID);

        const res = await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });

        console.log("✅ Telegram sent:", res.data.ok);

    } catch (err) {
        console.error("❌ Telegram Error:");
        console.error("Status:", err.response?.status);
        console.error("Data:", err.response?.data);
        console.error("Message:", err.message);
    }
}

// 🚫 Block
function blockAndNotify(ip, reason, req) {
    if (blockedIPs.has(ip)) return;

    blockedIPs.add(ip);

    const message = `🚫 حظر IP
IP: ${ip}
السبب: ${reason}
Agent: ${req.headers['user-agent']}`;

    sendTelegramNotification(message);
}

// 🔒 Middleware
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

    console.log(`📥 طلب ${job.id} بدأ التنفيذ`);

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

    console.log(`📥 طلب ${requestId} دخل الطابور`);

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

// 🚀 Start
const server = app.listen(PORT, () => {
    console.log(`✅ Server running on ${PORT}`);
    console.log("🤖 Telegram Notifications Active");
    console.log("🛡️ IP Blocking Active");
});

server.timeout = 300000;
server.keepAliveTimeout = 120000;
