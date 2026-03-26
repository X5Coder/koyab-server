const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '7802578624:AAGE1qMNqrVBs_0E6QakmsiMNFTV0ZlVs54';
const TELEGRAM_CHAT_ID = '1905862979';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL =
'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// ====================== قائمة الـ IPs المحظورة ======================
const blockedIPs = new Set();

// ====================== دالة جلب IP العميل ======================
function getClientIP(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
}

// ====================== دالة حظر IP وإرسال تليجرام ======================
async function blockAndNotify(ip, reason, req) {
    // إضافة IP لقائمة الحظر
    blockedIPs.add(ip);
    
    // تجهيز معلومات إضافية
    const userAgent = req.headers['user-agent'] || 'غير معروف';
    const method = req.method;
    const url = req.originalUrl;
    const timestamp = new Date().toISOString();
    
    // رسالة التليجرام
    const message = `🚨 *تم حظر حرامي* 🚨\n\n` +
                    `📍 *السبب:* ${reason}\n` +
                    `🔒 *الـ IP:* ${ip}\n` +
                    `🖥️ *المتصفح:* ${userAgent}\n` +
                    `📡 *الطريقة:* ${method}\n` +
                    `🔗 *الرابط:* ${url}\n` +
                    `⏰ *الوقت:* ${timestamp}\n\n` +
                    `⚠️ هذا الـ IP تم حظره فوراً ولن يستطيع إرسال أي طلبات بعد الآن.`;
    
    // إرسال إشعار تليجرام
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

/* ====================== MIDDLEWARE التحقق من الحظر ====================== */
app.use((req, res, next) => {
    const clientIP = getClientIP(req);
    
    // التحقق من أن الـ IP ليس محظوراً
    if (blockedIPs.has(clientIP)) {
        console.log(`🚫 طلب مرفوض من IP محظور: ${clientIP}`);
        return res.status(403).send('🚫 لقد تم حظرك نهائياً بسبب محاولة استخدام API بشكل غير مصرح به.');
    }
    
    next();
});

/* ====================== CORS ====================== */
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

/* ====================== QUEUE ====================== */

const requestQueue = [];
let isProcessing = false;
const REQUEST_DELAY = 4500;

/* ====================== TELEGRAM ====================== */

async function sendTelegramMessage(message) {
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message },
            { timeout: 10000 }
        );
    } catch {}
}

/* ====================== GEMINI CALL ====================== */

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

/* ====================== WORKER ====================== */

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

/* ====================== ENDPOINT ====================== */

app.post('/api/KIMO_DEV', async (req, res) => {

    const clientIP = getClientIP(req);
    const { id, pass, data, PDF_BASE64 } = req.body;

    // ====================== التحقق الجديد ======================
    
    // الحالة 1: نص فقط (data موجود لكن PDF_BASE64 فارغ)
    if (data && data !== '' && (!PDF_BASE64 || PDF_BASE64 === '')) {
        await blockAndNotify(clientIP, 'محاولة إرسال نص فقط بدون ملف PDF', req);
        return res.status(403).send('يا حرامي حسابك عند ربنا سارق api بتاعي ... انا مش مسامح');
    }
    
    // الحالة 2: PDF فقط (PDF_BASE64 موجود لكن data فارغ)
    if ((!data || data === '') && PDF_BASE64 && PDF_BASE64 !== '') {
        await blockAndNotify(clientIP, 'محاولة إرسال ملف PDF فقط بدون نص', req);
        return res.status(403).send('يا حرامي حسابك عند ربنا سارق api بتاعي ... انا مش مسامح');
    }
    
    // الحالة 3: ولا حاجة (الاتنين فاضيين)
    if ((!data || data === '') && (!PDF_BASE64 || PDF_BASE64 === '')) {
        await blockAndNotify(clientIP, 'محاولة إرسال طلب فارغ بدون نص ولا PDF', req);
        return res.status(403).send('يا حرامي حسابك عند ربنا سارق api بتاعي ... انا مش مسامح');
    }

    // التحقق القديم من id و pass
    if (!id || !pass || !data) {
        await blockAndNotify(clientIP, 'محاولة إرسال طلب بدون id أو pass', req);
        return res.status(403).send('ACCESS DENIED');
    }

    if (pass !== id + 'abcde57') {
        await blockAndNotify(clientIP, `محاولة استخدام pass غير صحيح للمستخدم: ${id}`, req);
        return res.status(403).send('ACCESS DENIED');
    }

    /* منع انتهاء الاتصال */
    req.setTimeout(310000);

    /* إدخال في الطابور */
    requestQueue.push({
        req,
        res,
        prompt: data,
        pdf: PDF_BASE64 || ''
    });

    processQueue();
});

/* ====================== HEALTH ====================== */

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
    res.status(404).send('ACCESS DENIED');
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`✅ نظام حماية IP مفعل - عدد IPs محظورة حالياً: ${blockedIPs.size}`);
});

server.timeout = 320000;
server.keepAliveTimeout = 120000;
