const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8270884971:AAHoFrlytzmQ5XtqFeYG8CZUdcCiPGqgozw';
const TELEGRAM_CHAT_ID = '1905862979';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const blockedIPs = new Set();
let rateLimitBlockUntil = 0;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 3000;

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
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

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '500mb' }));

const requestQueue = [];
let isProcessing = false;

async function sendToGemini(prompt, pdfBase64, attempt = 1) {
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
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 300000
            }
        );

        if (response.data?.candidates?.[0]) {
            return response.data.candidates[0].content.parts[0].text;
        }
        throw new Error('INVALID_GEMINI_RESPONSE');

    } catch (error) {
        const errorMessage = error.response?.data?.error?.message || error.message;
        const statusCode = error.response?.status;
        
        if (statusCode === 429 && attempt <= 5) {
            let backoff = 0;
            if (errorMessage) {
                const match = errorMessage.match(/(\d+)s/);
                if (match) {
                    backoff = parseInt(match[1]) * 1000;
                }
            }
            if (backoff === 0) {
                backoff = Math.min(60000, 5000 * Math.pow(2, attempt));
            }
            
            const waitTime = backoff + 2000;
            rateLimitBlockUntil = Date.now() + waitTime;
            
            await sendTelegramNotification(
                `⚠️ Rate Limit 429 من Gemini\n` +
                `الانتظار: ${waitTime/1000} ثانية\n` +
                `المحاولة: ${attempt}/5\n` +
                `السبب: ${errorMessage}\n` +
                `سيتم إيقاف الطلبات حتى ${new Date(rateLimitBlockUntil).toLocaleTimeString()}`,
                true
            );
            
            await new Promise(r => setTimeout(r, waitTime));
            return sendToGemini(prompt, pdfBase64, attempt + 1);
        }
        
        if (statusCode !== 403 && statusCode !== 429) {
            await sendTelegramNotification(
                `⚠️ خطأ غير متوقع من Gemini\n` +
                `الحالة: ${statusCode || 'unknown'}\n` +
                `الخطأ: ${errorMessage}\n` +
                `المحاولة: ${attempt}`,
                true
            );
        }
        
        throw new Error(`AI_REQUEST_FAILED: ${errorMessage}`);
    }
}

async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;

    while (requestQueue.length > 0) {
        const job = requestQueue.shift();
        const { res, prompt, pdf } = job;

        const now = Date.now();
        if (rateLimitBlockUntil > now) {
            const waitTime = rateLimitBlockUntil - now;
            console.log(`⏳ انتظار ${waitTime/1000} ثانية بسبب Rate Limit...`);
            await new Promise(r => setTimeout(r, waitTime));
        }
        
        const timeSinceLastRequest = Date.now() - lastRequestTime;
        if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
            const waitTime = MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            console.log(`⏳ انتظار ${waitTime/1000} ثانية بين الطلبات...`);
            await new Promise(r => setTimeout(r, waitTime));
        }

        try {
            const result = await sendToGemini(prompt, pdf);
            lastRequestTime = Date.now();
            if (!res.headersSent) {
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(result);
            }
        } catch (error) {
            lastRequestTime = Date.now();
            if (!res.headersSent) {
                res.status(500).json({ error: error.message || 'AI request failed' });
            }
        }
    }
    isProcessing = false;
}

app.post('/api/KIMO_DEV', (req, res) => {
    const clientIP = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;

    const now = Date.now();
    if (rateLimitBlockUntil > now) {
        const waitSeconds = Math.ceil((rateLimitBlockUntil - now) / 1000);
        console.log(`⏸️ طلب مؤجل بسبب Rate Limit - انتظار ${waitSeconds} ثانية`);
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

    requestQueue.push({
        res,
        prompt: data,
        pdf: PDF_BASE64
    });

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
        processing: isProcessing,
        blocked_ips_count: blockedIPs.size,
        rate_limit_active: rateLimitBlockUntil > now,
        rate_limit_remaining_seconds: rateLimitBlockUntil > now ? Math.ceil((rateLimitBlockUntil - now) / 1000) : 0,
        last_request_ms_ago: lastRequestTime ? Date.now() - lastRequestTime : null,
        min_interval_ms: MIN_REQUEST_INTERVAL,
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

const server = app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`🛡️ نظام حماية IP مفعل - عدد IPs محظورة: ${blockedIPs.size}`);
    console.log(`⏱️ الفاصل الزمني بين الطلبات: ${MIN_REQUEST_INTERVAL/1000} ثانية`);
    console.log(`📊 نظام تنظيم الطلبات (Queue) مفعل`);
});

server.timeout = 320000;
server.keepAliveTimeout = 120000;
