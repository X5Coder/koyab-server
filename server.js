<!DOCTYPE html>
<html>
<body>
    <h3>اختبار النظام الجديد {{VARIABLE_NAME}}</h3>
    
    <button onclick="analyzePrompt()">تحليل البرومت</button>
    <button onclick="sendTest()">إرسال طلب تجريبي</button>
    
    <div id="result" style="margin-top:20px; padding:10px; background:#f0f0f0; display:none;">
        <pre id="resultText"></pre>
    </div>

    <script>
        const SERVER = 'https://wet-aidan-kimon-66eadaf6.koyeb.app';
        
        async function analyzePrompt() {
            try {
                const res = await fetch(SERVER + '/api/debug', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ promptId: "1" })
                });
                
                const data = await res.json();
                showResult(`📋 تحليل البرومت:\nالمتغيرات: ${data.variables.join(', ')}\n\n${JSON.stringify(data, null, 2)}`);
            } catch(e) {
                showResult('❌ خطأ: ' + e.message);
            }
        }
        
        async function sendTest() {
            const data = {
                userId: "12345",
                promptId: "1",
                verificationKey: "12345abcde57",
                PDF_BASE64: "",
                PAGES_COUNT: "3",
                SUMMARY_STYLE: "تفصيلي",
                EXPLAINER_PERSONALITY: "خبير أكاديمي",
                USER_COMMENT: "اختبار"
            };
            
            try {
                const res = await fetch(SERVER + '/api/KIMO_DEV', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(data)
                });
                
                const text = await res.text();
                showResult(`📊 النتيجة:\nكود: ${res.status}\n\n${text}`);
            } catch(e) {
                showResult('❌ خطأ: ' + e.message);
            }
        }
        
        function showResult(text) {
            document.getElementById('resultText').textContent = text;
            document.getElementById('result').style.display = 'block';
        }
        
        setTimeout(analyzePrompt, 1000);
    </script>
</body>
</html>
