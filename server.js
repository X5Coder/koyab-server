const express = require('express');
const axios = require('axios');
const geoip = require('geoip-lite');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '8270884971:AAHoFrlytzmQ5XtqFeYG8CZUdcCiPGqgozw';
const TELEGRAM_CHAT_ID = '1905862979';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

const blockedIPs = new Set();

function getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.socket.remoteAddress || req.ip || 'unknown';
}

async function blockAndNotify(ip, reason, req, requestBody = null) {
    blockedIPs.add(ip);
    
    const userAgent = req.headers['user-agent'] || 'غير معروف';
    const method = req.method;
    const url = req.originalUrl;
    const timestamp = new Date().toISOString();
    
    let locationInfo = 'غير متاح';
    const geo = geoip.lookup(ip);
    if (geo) {
        locationInfo = `${geo.country} (${geo.city || 'غير معروف'}) - ${geo.ll ? geo.ll.join(', ') : 'غير متاح'}`;
    }
    
    let requestDetails = '';
    if (requestBody) {
        requestDetails = `\n\n📦 *بيانات الطلب:*\n`;
        if (requestBody.data) {
            const promptPreview = requestBody.data.length > 200 ? requestBody.data.substring(0, 200) + '...' : requestBody.data;
            requestDetails += `📝 *النص المرسل:*\n\`\`\`\n${promptPreview}\n\`\`\`\n`;
        }
        if (requestBody.PDF_BASE64) {
            const pdfSize = Math.round(requestBody.PDF_BASE64.length * 0.75 / 1024);
            requestDetails += `📄 *ملف PDF:* موجود (${pdfSize} KB)\n`;
        }
    }
    
    const message = `🚨 *تم حظر حرامي* 🚨\n\n` +
                    `📍 *السبب:* ${reason}\n` +
                    `🔒 *الـ IP:* ${ip}\n` +
                    `🌍 *الدولة/الموقع:* ${locationInfo}\n` +
                    `🖥️ *المتصفح:* ${userAgent}\n` +
                    `📡 *الطريقة:* ${method}\n` +
                    `🔗 *الرابط:* ${url}\n` +
                    `⏰ *الوقت:* ${timestamp}\n` +
                    `${requestDetails}\n\n` +
                    `⚠️ هذا الـ IP تم حظره فوراً ولن يستطيع إرسال أي طلبات بعد الآن.`;
    
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { 
                chat_id: TELEGRAM_CHAT_ID, 
                text: message,
                parse_mode: 'Markdown'
            },
            { timeout: 10000 }
        );
        console.log(`✅ تم إبلاغ تليجرام عن IP: ${ip}`);
    } catch (telegramError) {
        console.error('❌ فشل إرسال إشعار تليجرام:', telegramError.message);
    }
}

app.use((req, res, next) => {
    const clientIP = getClientIP(req);
    
    if (blockedIPs.has(clientIP)) {
        console.log(`🚫 طلب مرفوض من IP محظور: ${clientIP}`);
        res.status(403).end();
        return;
    }
    
    next();
});

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS');

    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

const requestQueue = [];
let isProcessing = false;
const REQUEST_DELAY = 4500;

async function sendTelegramMessage(message) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message },
            { timeout: 10000 }
        );
    } catch {}
}

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

        if (
            response.data &&
            response.data.candidates &&
            response.data.candidates[0]
        ) {
            return response.data.candidates[0].content.parts[0].text;
        }

        throw new Error('INVALID_GEMINI_RESPONSE');

    } catch (error) {

        if (error.response && error.response.status === 429 && attempt <= 5) {

            const backoff = Math.min(60000, 5000 * Math.pow(2, attempt));

            await sendTelegramMessage(
                `429 Rate Limit → Retry in ${backoff/1000}s (Attempt ${attempt})`
            );

            await new Promise(r => setTimeout(r, backoff));

            return sendToGemini(prompt, pdfBase64, attempt + 1);
        }

        await sendTelegramMessage(`Gemini API Failed: ${error.message}`);
        throw new Error('AI_REQUEST_FAILED');
    }
}

async function processQueue() {

    if (isProcessing) return;
    isProcessing = true;

    while (requestQueue.length > 0) {

        const job = requestQueue.shift();
        const { req, res, prompt, pdf } = job;

        try {

            const result = await sendToGemini(prompt, pdf);

            if (!res.headersSent) {
                res.set('Content-Type', 'text/plain; charset=utf-8');
                res.send(result);
            }

        } catch (error) {

            if (!res.headersSent) {
                res.status(500).send('AI REQUEST FAILED');
            }
        }

        await new Promise(r => setTimeout(r, REQUEST_DELAY));
    }

    isProcessing = false;
}

app.post('/api/KIMO_DEV', async (req, res) => {

    const clientIP = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;

    if (data && data !== '' && (!PDF_BASE64 || PDF_BASE64 === '')) {
        await blockAndNotify(clientIP, 'محاولة إرسال نص فقط بدون ملف PDF', req, { data, PDF_BASE64 });
        res.status(403).end();
        return;
    }
    
    if ((!data || data === '') && PDF_BASE64 && PDF_BASE64 !== '') {
        await blockAndNotify(clientIP, 'محاولة إرسال ملف PDF فقط بدون نص', req, { data, PDF_BASE64 });
        res.status(403).end();
        return;
    }
    
    if ((!data || data === '') && (!PDF_BASE64 || PDF_BASE64 === '')) {
        await blockAndNotify(clientIP, 'محاولة إرسال طلب فارغ بدون نص ولا PDF', req, { data, PDF_BASE64 });
        res.status(403).end();
        return;
    }

    if (!id || !pass || !data) {
        await blockAndNotify(clientIP, 'محاولة إرسال طلب بدون id أو pass', req, { data, PDF_BASE64 });
        res.status(403).end();
        return;
    }

    if (pass !== id + 'abcde57') {
        await blockAndNotify(clientIP, `محاولة استخدام pass غير صحيح للمستخدم: ${id}`, req, { data, PDF_BASE64 });
        res.status(403).end();
        return;
    }

    req.setTimeout(310000);

    requestQueue.push({
        req,
        res,
        prompt: data,
        pdf: PDF_BASE64 || ''
    });

    processQueue();
});

app.get('/', (req, res) => {
    res.status(200).send('Server is running');
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        queue_length: requestQueue.length,
        processing: isProcessing,
        blocked_ips_count: blockedIPs.size,
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    res.status(404).end();
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`✅ نظام حماية IP مفعل - عدد IPs محظورة حالياً: ${blockedIPs.size}`);
});

server.timeout = 320000;
server.keepAliveTimeout = 120000;
