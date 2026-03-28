const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const blockedIPs = new Set();
let rateLimitBlockUntil = 0;
const MAX_CONCURRENT = 3;
let activeRequests = 0;
const requestQueue = [];

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || req.ip || 'unknown';
}

async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message },
            { timeout: 5000 }
        );
        console.log(`📨 تم إرسال إشعار`);
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
    
    const message = `🚨 حظر IP 🚨\nالسبب: ${reason}\nIP: ${ip}\nالمتصفح: ${userAgent}\nالوقت: ${timestamp}${requestDetails}`;
    
    sendTelegramNotification(message);
    console.log(`🚫 تم حظر ${ip} - ${reason}`);
}

app.use((req, res, next) => {
    const clientIP = getClientIP(req);
    if (blockedIPs.has(clientIP)) {
        console.log(`🚫 مرفوض من IP محظور: ${clientIP}`);
        return res.status(403).json({ error: 'IP blocked' });
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
            inline_data: {
                mime_type: "application/pdf",
                data: pdfBase64
            }
        });
    }

    const requestBody = {
        contents: [{ parts }],
        generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4000
        }
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
            `⚠️ خطأ في Gemini\nالمعرف: ${requestId}\nالحالة: ${statusCode}\nالمحاولة: ${attempt}\nالخطأ: ${errorMessage}`
        );
        
        if (statusCode === 429 && attempt <= 5) {
            let backoff = 0;
            const match = errorMessage.match(/(\d+)s/);
            if (match) backoff = parseInt(match[1]) * 1000;
            if (backoff === 0) backoff = Math.min(60000, 5000 * Math.pow(2, attempt));
            
            const waitTime = backoff + 2000;
            rateLimitBlockUntil = Date.now() + waitTime;
            
            await sendTelegramNotification(`⚠️ Rate Limit ${waitTime/1000} ثانية`);
            await new Promise(r => setTimeout(r, waitTime));
            return sendToGemini(prompt, pdfBase64, attempt + 1, requestId);
        }
        
        throw new Error(`AI_REQUEST_FAILED: ${errorMessage}`);
    }
}

async function processQueue() {
    if (activeRequests >= MAX_CONCURRENT) return;
    if (requestQueue.length === 0) return;
    
    const now = Date.now();
    if (rateLimitBlockUntil > now) {
        setTimeout(processQueue, rateLimitBlockUntil - now);
        return;
    }
    
    while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT) {
        const job = requestQueue.shift();
        activeRequests++;
        
        (async () => {
            try {
                const result = await sendToGemini(job.prompt, job.pdf, 1, job.requestId);
                if (!job.res.headersSent) {
                    job.res.set('Content-Type', 'text/plain; charset=utf-8');
                    job.res.send(result);
                }
            } catch (error) {
                if (!job.res.headersSent) {
                    job.res.status(500).json({ error: error.message || 'AI request failed' });
                }
            } finally {
                activeRequests--;
                processQueue();
            }
        })();
    }
}

app.post('/api/KIMO_DEV', (req, res) => {
    const clientIP = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const now = Date.now();
    if (rateLimitBlockUntil > now) {
        const waitSeconds = Math.ceil((rateLimitBlockUntil - now) / 1000);
        return res.status(429).json({ error: `Rate limit active, wait ${waitSeconds}s`, retryAfter: waitSeconds });
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
    console.log(`📥 طلب ${requestId} دخل الطابور - الطابور: ${requestQueue.length} | نشط: ${activeRequests}/${MAX_CONCURRENT}`);
    
    processQueue();
});

app.get('/', (req, res) => {
    res.status(200).send('Server is running');
});

app.get('/api/health', (req, res) => {
    const now = Date.now();
    res.json({
        status: 'online',
        queue_length: requestQueue.length,
        active_requests: activeRequests,
        max_concurrent: MAX_CONCURRENT,
        blocked_ips_count: blockedIPs.size,
        rate_limit_active: rateLimitBlockUntil > now,
        rate_limit_remaining_seconds: rateLimitBlockUntil > now ? Math.ceil((rateLimitBlockUntil - now) / 1000) : 0,
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🛡️ IP Blocking Active`);
    console.log(`⚡ Concurrent: ${MAX_CONCURRENT}`);
    console.log(`🤖 Telegram Notifications Active`);
});

server.timeout = 320000;
server.keepAliveTimeout = 120000;
