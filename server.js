const express = require('express');
require('dotenv').config();

const prompts = require('./prompts');
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

function validateVerificationKey(userId, verificationKey) {
    const expectedKey = `${userId}abcde57`;
    return verificationKey === expectedKey;
}

function extractAllVariables(prompt) {
    const variableRegex = /\{\{P(\d+)\}\}/g;
    const variables = new Set();
    let match;
    
    while ((match = variableRegex.exec(prompt)) !== null) {
        variables.add(match[0]); // حفظ {{P1}}, {{P2}}, etc.
    }
    
    return Array.from(variables);
}

function replaceAllVariables(prompt, requestData) {
    let finalPrompt = prompt;
    const allVariables = extractAllVariables(prompt);
    
    allVariables.forEach(variable => {
        const variableKey = variable.replace(/\{\{|\}\}/g, ''); // تحويل {{P1}} إلى P1
        if (requestData.hasOwnProperty(variableKey)) {
            const value = requestData[variableKey] || 'لم يعلق المستخدم';
            finalPrompt = finalPrompt.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), value);
        } else {
            finalPrompt = finalPrompt.replace(new RegExp(variable.replace(/[{}]/g, '\\$&'), 'g'), 'لم يعلق المستخدم');
        }
    });
    
    return finalPrompt;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.post('/api/KIMO_DEV', async (req, res) => {
    try {
        const { userId, promptId, verificationKey, ...requestData } = req.body;

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

        console.log(`📝 البرومت ${promptId}:`);
        console.log(`🔍 المتغيرات في الطلب:`, Object.keys(requestData));
        
        const variablesInPrompt = extractAllVariables(promptTemplate);
        console.log(`🔍 المتغيرات المطلوبة في البرومت:`, variablesInPrompt);
        
        const finalPrompt = replaceAllVariables(promptTemplate, requestData);
        
        // التحقق من استبدال جميع المتغيرات
        const remainingVars = extractAllVariables(finalPrompt);
        if (remainingVars.length > 0) {
            console.warn(`⚠️ متغيرات لم تستبدل:`, remainingVars);
        } else {
            console.log(`✅ تم استبدال جميع المتغيرات`);
        }
        
        const result = await sendToGemini(finalPrompt, requestData.PDF_BASE64 || '');
        
        res.set('Content-Type', 'text/plain');
        res.send(result);

    } catch (error) {
        console.error('❌ Server Error:', error.message);
        
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

app.post('/api/analyze', (req, res) => {
    try {
        const { promptId } = req.body;
        const prompt = prompts[promptId];
        
        if (!prompt) {
            return res.status(400).json({ error: 'Prompt not found' });
        }
        
        const variables = extractAllVariables(prompt);
        const variableCount = variables.length;
        
        res.json({
            promptId,
            variables,
            variableCount,
            promptLength: prompt.length,
            sample: prompt.substring(0, 300) + '...'
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.use((req, res) => {
    res.status(404).send('ACCESS DENIED');
});

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Variable format: {{P1}}, {{P2}}, {{P3}}, etc.`);
    console.log(`✅ Available prompts: ${Object.keys(prompts).length}`);
});
