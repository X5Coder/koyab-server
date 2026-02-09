const express = require('express');
require('dotenv').config();

const prompts = require('./prompts');
const { sendToGemini } = require('./gemini.service');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔥 أضف CORS middleware هنا في البداية
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

function validateVerificationKey(userId, verificationKey) {
    const expectedKey = `${userId}abcde57`;
    return verificationKey === expectedKey;
}

function extractVariablesFromPrompt(prompt) {
    const variableRegex = /\*\[([A-Z_][A-Z0-9_]*)\]\*/g;
    const variables = new Set();
    let match;
    
    while ((match = variableRegex.exec(prompt)) !== null) {
        variables.add(match[1]);
    }
    
    return Array.from(variables);
}

function replacePromptVariables(prompt, data) {
    let processedPrompt = prompt;
    const variables = extractVariablesFromPrompt(prompt);
    
    variables.forEach(variable => {
        const value = data[variable] || 'لم يعلق المستخدم';
        processedPrompt = processedPrompt.replace(new RegExp(`\\*\\[${variable}\\]\\*`, 'g'), value);
    });
    
    return processedPrompt;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.post('/api/KIMO_DEV', async (req, res) => {
    try {
        const { userId, promptId, verificationKey, PDF_BASE64, ...variables } = req.body;

        if (!userId || !promptId || !verificationKey) {
            return res.status(403).send('ACCESS DENIED');
        }

        if (!validateVerificationKey(userId, verificationKey)) {
            return res.status(403).send('ACCESS DENIED');
        }

        const promptTemplate = prompts[promptId];
        if (!promptTemplate) {
            return res.status(400).send('Invalid promptId');
        }

        const finalPrompt = replacePromptVariables(promptTemplate, { PDF_BASE64, ...variables });

        const result = await sendToGemini(finalPrompt, PDF_BASE64 || '');
        
        res.set('Content-Type', 'text/plain');
        res.send(result);

    } catch (error) {
        console.error('Server Error:', error.message);
        
        if (error.message === 'AI REQUEST ENDED❤️‍🩹') {
            return res.status(500).send('AI REQUEST ENDED❤️‍🩹');
        }
        
        res.status(500).send(error.message);
    }
});

// 🔥 أضف endpoint للاختبار والصحة
app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        message: 'Gemini Proxy Server is running',
        timestamp: new Date().toISOString()
    });
});

// 🔥 أضف endpoint لاختبار التحقق
app.post('/api/test', (req, res) => {
    const { userId, verificationKey } = req.body;
    
    if (!userId || !verificationKey) {
        return res.status(400).json({ error: 'Missing userId or verificationKey' });
    }
    
    const isValid = validateVerificationKey(userId, verificationKey);
    
    res.json({
        userId,
        verificationKey,
        expectedKey: `${userId}abcde57`,
        isValid,
        message: isValid ? 'Verification successful' : 'Verification failed'
    });
});

app.use((req, res) => {
    res.status(404).send('ACCESS DENIED');
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ CORS enabled - Accepting requests from all origins`);
    console.log(`✅ Endpoints:`);
    console.log(`   POST /api/KIMO_DEV`);
    console.log(`   GET  /api/health`);
    console.log(`   POST /api/test`);
});
