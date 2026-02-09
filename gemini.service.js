const axios = require('axios');
require('dotenv').config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';

async function sendToGemini(prompt, pdfBase64) {
  try {
    const parts = [
      { text: prompt }
    ];

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
        temperature: 0.1
      }
    };

    const response = await axios.post(
      `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`,
      requestBody,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      return response.data.candidates[0].content.parts[0].text;
    }
    throw new Error('Invalid response from Gemini API');

  } catch (error) {
    if (error.response) {
      console.error('Gemini API Error:', error.response.data);
    } else {
      console.error('Gemini Request Error:', error.message);
    }
    
    const telegramToken = '7802578624:AAGE1qMNqrVBs_0E6QakmsiMNFTV0ZlVs54';
    const chatId = '1905862979';
    const message = `Gemini API Failed: ${error.message}`;
    
    try {
      await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        chat_id: chatId,
        text: message
      });
    } catch (telegramError) {
      console.error('Telegram notification failed:', telegramError.message);
    }
    
    throw new Error('AI REQUEST ENDED❤️‍🩹');
  }
}

module.exports = { sendToGemini };
