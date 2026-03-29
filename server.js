const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ جلب البيانات من Koyeb مباشرة
const TELEGRAM_TOKEN = process.env.TOKEN;
const TELEGRAM_CHAT_ID = process.env.ID;
const GEMINI_API_KEY = process.env.API;

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const blockedIPs = new Set();
let rateLimitBlockUntil = 0;

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

async function sendTelegramNotification(message, isError = true) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message },
            { timeout: 5000 }
        );
        console.log(`📨 تم إرسال إشعار: ${message.substring(0, 50)}...`);
    } catch (err) {
        console.error('❌ فشل إرسال إشعار:', err.message);
    }
}

function blockAndNotify(ip, reason, req, requestBody = null) {
    if (blockedIPs.has(ip)) return;
    blockedIPs.add(ip);
    const userAgent = req.headers['user-agent'] || 'غير معروف';
    const timestamp = new Date().toISOString();

    let requestDetails = '';
    if (requestBody) {
        if (requestBody.data) {
            const promptPreview = requestBody.data.length > 300 ? requestBody.data.substring(0, 300) + '...' : requestBody.data;
            requestDetails += `\n📝 النص: ${promptPreview}`;
        }
        if (requestBody.PDF_BASE64) {
            const pdfSize = Math.round(requestBody.PDF_BASE64.length * 0.75 / 1024);
            requestDetails += `\n📄 PDF: ${pdfSize} KB`;
        }
    }

    const message = `🚨 حظر IP 🚨\n` +
                    `السبب: ${reason}\n` +
                    `IP: ${ip}\n` +
                    `المتصفح: ${userAgent}\n` +
                    `الوقت: ${timestamp}${requestDetails}`;

    sendTelegramNotification(message, true);
    console.log(`🚫 تم حظر ${ip} - ${reason}`);
}

app.use((req, res, next) => {
    const clientIP = getClientIP(req);
    if (blockedIPs.has(clientIP)) {
        console.log(`🚫 مرفوض من IP محظور: ${clientIP}`);
        res.status(403).json({ error: 'IP blocked' });
        return;
    }
    next();
});

app.use((req, res, next) => {
    const origin = req.headers.origin;
    res.header('Access-Control-Allow-Origin', origin || '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

async function sendToGemini(prompt, pdfBase64, attempt = 1, requestId = null) {
    const parts = [{ text: prompt }];
    if (pdfBase64 && pdfBase64 !== '') {
        parts.push({
            inline_data: { mime_type: "application/pdf", data: pdfBase64 }
        });
    }

    const requestBody = {
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4000 }
    };

    try {
        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            requestBody,
            { headers: { 'Content-Type': 'application/json' }, timeout: 300000 }
        );

        if (response.data?.candidates?.[0]) {
            return response.data.candidates[0].content.parts[0].text;
        }
        throw new Error('INVALID_GEMINI_RESPONSE');
    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        const statusCode = error.response?.status;

        await sendTelegramNotification(
            `⚠️ خطأ في طلب Gemini\n` +
            `المعرف: ${requestId || 'غير معروف'}\n` +
            `الحالة: ${statusCode || 'unknown'}\n` +
            `المحاولة: ${attempt}\n` +
            `الخطأ: ${errorMessage}\n` +
            `الوقت: ${new Date().toISOString()}`,
            true
        );

        throw new Error(`AI_REQUEST_FAILED: ${errorMessage}`);
    }
}

// ================= Queue + Worker =================
const requestQueue = [];
let isWorkerBusy = false;

async function processNext() {
    if (isWorkerBusy) return;
    if (requestQueue.length === 0) return;

    const job = requestQueue.shift();
    const { res, prompt, pdf, requestId } = job;

    isWorkerBusy = true;

    try {
        const result = await sendToGemini(prompt, pdf, 1, requestId);
        if (!res.headersSent) {
            res.set('Content-Type', 'text/plain; charset=utf-8');
            res.send(result);
        }
        // بعد أي طلب ناجح، انتظر 2 ثانية قبل معالجة التالي
        setTimeout(() => {
            isWorkerBusy = false;
            processNext();
        }, 2000);
    } catch (err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message || 'AI request failed' });
        }
        // بعد أي فشل، انتظر 12 ثانية قبل معالجة التالي
        setTimeout(() => {
            isWorkerBusy = false;
            processNext();
        }, 12000);
    }
}

// ================= API Endpoint =================
app.post('/api/KIMO_DEV', (req, res) => {
    const clientIP = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(2,8)}`;

    const now = Date.now();
    if (rateLimitBlockUntil > now) {
        const waitSeconds = Math.ceil((rateLimitBlockUntil - now) / 1000);
        return res.status(429).json({
            error: `Rate limit active, please wait ${waitSeconds} seconds`,
            retryAfter: waitSeconds
        });
    }

    const hasText = data && data !== '';
    const hasPdf = PDF_BASE64 && PDF_BASE64 !== '';

    if (hasText && !hasPdf) {
        blockAndNotify(clientIP, 'نص فقط بدون PDF', req, { data, PDF_BASE64 });
        return res.status(403).json({ error: 'نص فقط بدون ملف PDF - تم حظرك' });
    }

    if (!hasText && hasPdf) {
        blockAndNotify(clientIP, 'PDF فقط بدون نص', req, { data, PDF_BASE64 });
        return res.status(403).json({ error: 'PDF فقط بدون نص - تم حظرك' });
    }

    if (!hasText && !hasPdf) {
        blockAndNotify(clientIP, 'طلب فارغ', req, { data, PDF_BASE64 });
        return res.status(403).json({ error: 'طلب فارغ - تم حظرك' });
    }

    if (!id || !pass) {
        blockAndNotify(clientIP, 'بدون id/pass', req, { data, PDF_BASE64 });
        return res.status(403).json({ error: 'بيانات غير صحيحة' });
    }

    if (pass !== id + 'abcde57') {
        blockAndNotify(clientIP, `pass غير صحيح للمستخدم: ${id}`, req, { data, PDF_BASE64 });
        return res.status(403).json({ error: 'بيانات غير صحيحة' });
    }

    req.setTimeout(310000);

    requestQueue.push({ res, prompt: data, pdf: PDF_BASE64, requestId });
    processNext();
});

app.get('/', (req, res) => res.status(200).send('Server is running'));

app.get('/api/health', (req, res) => {
    const now = Date.now();
    res.json({
        status: 'online',
        queue_length: requestQueue.length,
        worker_busy: isWorkerBusy,
        blocked_ips_count: blockedIPs.size,
        rate_limit_active: rateLimitBlockUntil > now,
        rate_limit_remaining_seconds: rateLimitBlockUntil > now ? Math.ceil((rateLimitBlockUntil - now)/1000) : 0,
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => res.status(404).json({ error: 'Not found' }));

const server = app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

server.timeout = 320000;
server.keepAliveTimeout = 120000;
