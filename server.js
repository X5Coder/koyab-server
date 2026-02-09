const express = require('express');
require('dotenv').config();

const { sendToGemini } = require('./gemini.service');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

function validateVerificationKey(id, pass) {
    const expectedKey = `${id}abcde57`;
    return pass === expectedKey;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.post('/api/KIMO_DEV', async (req, res) => {
    try {
        const { id, pass, data } = req.body;

        if (!id || !pass || !data) {
            return res.status(403).send('ACCESS DENIED');
        }

        if (!validateVerificationKey(id, pass)) {
            return res.status(403).send('ACCESS DENIED');
        }

        const result = await sendToGemini(data, '');
        
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

app.use((req, res) => {
    res.status(404).send('ACCESS DENIED');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
