const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const TELEGRAM_TOKEN = '7802578624:AAGE1qMNqrVBs_0E6QakmsiMNFTV0ZlVs54';
const TELEGRAM_CHAT_ID = '1905862979';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '500mb' }));

async function sendTelegramMessage(message) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        }, { timeout: 10000 });
    } catch {}
}

async function sendToGemini(prompt, pdfBase64) {
    try {
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

        const response = await axios.post(
            `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
            requestBody,
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 300000
            }
        );

        if (response.data && response.data.candidates && response.data.candidates[0]) {
            return response.data.candidates[0].content.parts[0].text;
        }
        
        throw new Error('Invalid response from Gemini API');

    } catch (error) {
        await sendTelegramMessage(`Gemini API Failed: ${error.message}`);
        throw new Error('AI REQUEST ENDED❤️‍🩹');
    }
}

app.post('/api/KIMO_DEV', async (req, res) => {
    try {
        const { id, pass, data, PDF_BASE64 } = req.body;

        if (!id || !pass || !data) {
            return res.status(403).send('ACCESS DENIED');
        }

        if (pass !== id + 'abcde57') {
            return res.status(403).send('ACCESS DENIED');
        }

        const result = await sendToGemini(data, PDF_BASE64 || '');
        res.set('Content-Type', 'text/plain');
        res.send(result);

    } catch (error) {
        if (error.message === 'AI REQUEST ENDED❤️‍🩹') {
            return res.status(500).send('AI REQUEST ENDED❤️‍🩹');
        }
        res.status(500).send(error.message);
    }
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

app.use('*', (req, res) => {
    res.status(404).send('ACCESS DENIED');
});

const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

server.timeout = 300000;
server.keepAliveTimeout = 120000;
