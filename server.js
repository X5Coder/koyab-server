<!DOCTYPE html>
<html>
<head>
    <title>اختبار السيرفر الجديد</title>
    <style>
        body { font-family: Arial; padding: 20px; }
        input, button { padding: 10px; margin: 5px; }
        button { background: #28a745; color: white; border: none; cursor: pointer; }
        #result { background: #f8f9fa; padding: 15px; margin-top: 20px; display: none; }
    </style>
</head>
<body>
    <h3>اختبار السيرفر الجديد</h3>
    
    <button onclick="analyzePrompt()">تحليل البرومت</button>
    <button onclick="sendFullRequest()">إرسال طلب كامل</button>
    
    <div id="result">
        <pre id="resultText"></pre>
    </div>

    <script>
        const SERVER = 'https://wet-aidan-kimon-66eadaf6.koyeb.app';
        
        async function analyzePrompt() {
            try {
                const res = await fetch(SERVER + '/api/analyze', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ promptId: "1" })
                });
                
                const data = await res.json();
                showResult(`📋 تحليل البرومت:\n${JSON.stringify(data, null, 2)}`);
            } catch(e) {
                showResult('❌ خطأ: ' + e.message);
            }
        }
        
        async function sendFullRequest() {
            // إنشاء PDF تجريبي صغير (base64)
            const testPDF = "JVBERi0xLjQKMSAwIG9iaiA8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9Db3VudCAxCi9LaWRzIFszIDAgUl0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL01lZGlhQm94IFswIDAgMzAwIDE1MF0KL1BhcmVudCAyIDAgUgovQ29udGVudHMgNCAwIFIKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL0xlbmd0aCA1NQo+PgpzdHJlYW0KMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgMC4wMDAgY20KQlQKMTAgNzAgVEQKL0YxIDEwIFRmCihUZXN0IFBERiBEb2N1bWVudCkgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNQowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTkgMDAwMDAgbiAKMDAwMDAwMDA3NyAwMDAwMCBuIAowMDAwMDAwMTQzIDAwMDAwIG4gCjAwMDAwMDAyMjUgMDAwMDAgbiAKdHJhaWxlcgo8PAovU2l6ZSA1Ci9Sb290IDEgMCBSCj4+CnN0YXJ0eHJlZgoyNjQKJSVFT0YK";
            
            const requestData = {
                userId: "12345",
                promptId: "1",
                verificationKey: "12345abcde57",
                PDF_BASE64: testPDF,
                PAGES_COUNT: "3",
                SUMMARY_STYLE: "تفصيلي",
                EXPLAINER_PERSONALITY: "خبير أكاديمي",
                USER_COMMENT: "اختبار النظام الجديد",
                ANY_OTHER_VARIABLE: "هذا متغير إضافي"
            };
            
            console.log('📤 إرسال البيانات:', requestData);
            
            try {
                const res = await fetch(SERVER + '/api/KIMO_DEV', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(requestData)
                });
                
                const text = await res.text();
                showResult(`📊 الاستجابة:\nكود: ${res.status}\n\n${text}`);
            } catch(e) {
                showResult('❌ خطأ: ' + e.message);
            }
        }
        
        function showResult(text) {
            document.getElementById('resultText').textContent = text;
            document.getElementById('result').style.display = 'block';
        }
        
        // اختبار تلقائي
        setTimeout(analyzePrompt, 1000);
    </script>
</body>
</html>
