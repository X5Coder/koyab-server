const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ENV
const GEMINI_API_KEY = process.env.API;
const TELEGRAM_CHAT_ID = process.env.ID;
const TELEGRAM_BOT_TOKEN = process.env.TOKEN;

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

// 🧪 DEBUG
function mask(str) {
    if (!str) return '❌';
    return str.slice(0, 4) + '*****';
}

console.log("ENV:");
console.log("API:", mask(GEMINI_API_KEY));
console.log("ID:", TELEGRAM_CHAT_ID);
console.log("TOKEN:", mask(TELEGRAM_BOT_TOKEN));

// ⚠️ KEEP ALIVE (مهم جدا لـ Koyeb)
setInterval(() => {
    console.log("❤️ Server Alive:", new Date().toISOString());
}, 25000);

// 🧠 JSON
app.use(express.json({ limit: '20mb' }));

// 📩 Telegram
async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: TELEGRAM_CHAT_ID,
                text: message
            },
            { timeout: 5000 }
        );

        console.log("📨 Telegram OK:", res.data.ok);

    } catch (err) {
        console.log("❌ Telegram Error:", err.response?.data || err.message);
    }
}

// 🤖 Gemini (محمي)
async function sendToGemini(prompt, pdfBase64) {
    const parts = [{ text: prompt }];

    if (pdfBase64) {
        parts.push({
            inline_data: {
                mime_type: "application/pdf",
                data: pdfBase64
            }
        });
    }

    const res = await axios.post(
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

    return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
}

// 🚀 API (بدون Queue = أكثر استقرار)
app.post('/api/KIMO_DEV', async (req, res) => {
    try {
        const { id, pass, data, PDF_BASE64 } = req.body;

        if (!data && !PDF_BASE64) {
            return res.status(400).json({ error: 'طلب فارغ' });
        }

        if (!id || !pass) {
            return res.status(403).json({ error: 'بيانات ناقصة' });
        }

        if (pass !== id + 'abcde57') {
            return res.status(403).json({ error: 'بيانات غلط' });
        }

        console.log("📥 Request received");

        const result = await sendToGemini(data || '', PDF_BASE64);

        res.send(result);

    } catch (err) {
        console.error("🔥 API Error:", err.message);

        sendTelegramNotification("🔥 Server Error:\n" + err.message);

        res.status(500).json({ error: err.message });
    }
});

// 🧪 Health
app.get('/api/health', (req, res) => {
    res.json({ status: "ok", time: Date.now() });
});

// 🏠 Root
app.get('/', (req, res) => {
    res.send('Server running');
});

// ❗ مهم: منع الخروج
process.on('SIGTERM', () => {
    console.log("⚠️ SIGTERM received - ignored");
});

process.on('uncaughtException', (err) => {
    console.log("🔥 Uncaught:", err);
});

process.on('unhandledRejection', (err) => {
    console.log("🔥 Rejection:", err);
});

// 🚀 Start
app.listen(PORT, () => {
    console.log(`✅ Server running on ${PORT}`);
});
