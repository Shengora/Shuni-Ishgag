import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

// System prompt to instruct AI on how to behave and format its output
const SYSTEM_PROMPT = `Sen (Jules) avtonom dasturchi agentisan. Sening vazifang foydalanuvchining loyihasidagi muammolarni hal qilish, kodlarni tahrirlash va terminal buyruqlarini bajarish.
Sen bevosita Node.js muhitida ishlayapsan. Muloqot vaqtida quyidagi qoidalarga qat'iy rioya qil:

1. Agar sen faylni o'zgartirmoqchi bo'lsang, matningda quyidagi maxsus JSON formatni ishlatsang, u avtomatik tarzda muhitda bajariladi:
\`\`\`json
{
  "action": "write_file",
  "filepath": "relative/path/to/file.ext",
  "content": "faylning to'liq yangi matni"
}
\`\`\`

2. Agar sen terminalda biron buyruq (masalan, loyihani build qilish, pm2 ni restart qilish, fayllarni izlash) bajarmoqchi bo'lsang, quyidagi JSON formatdan foydalan:
\`\`\`json
{
  "action": "run_command",
  "command": "buyruq matni (masalan: pm2 restart all)"
}
\`\`\`

3. Agar sen fayl matnini o'qimoqchi bo'lsang (masalan, loglarni yoki kodni):
\`\`\`json
{
  "action": "read_file",
  "filepath": "relative/path/to/file.ext"
}
\`\`\`

Javobingda xohlagancha oddiy matn orqali tushuntirish berishing mumkin. Ammo biror amal bajarish kerak bo'lsa, albatta bitta JSON blok yubor. Muhit faqat oxirgi JSON blokni tutib, o'sha amalni bajaradi va senga natijani qaytaradi (keyingi siklda).
`;

let chatHistory = [];

async function fetchSources(apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'jules.googleapis.com',
      port: 443,
      path: '/v1alpha/sources',
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) reject(new Error("401_UNAUTHORIZED"));
        else if (res.statusCode >= 200 && res.statusCode < 300) {
           resolve(JSON.parse(data));
        } else reject(new Error(`Fetch Sources xatosi: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function createSession(apiKey, sourceName, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      prompt: prompt,
      sourceContext: { source: sourceName }
    });
    const options = {
      hostname: 'jules.googleapis.com',
      port: 443,
      path: '/v1alpha/sessions',
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) reject(new Error("401_UNAUTHORIZED"));
        else if (res.statusCode >= 200 && res.statusCode < 300) {
           resolve(JSON.parse(data));
        } else reject(new Error(`Create Session xatosi: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getActivities(apiKey, sessionId) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'jules.googleapis.com',
      port: 443,
      path: `/v1alpha/${sessionId}/activities?pageSize=50`,
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
           resolve(JSON.parse(data));
        } else reject(new Error(`Get Activities xatosi: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function sendMessage(apiKey, sessionId, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ prompt: prompt });
    const options = {
      hostname: 'jules.googleapis.com',
      port: 443,
      path: `/v1alpha/${sessionId}:sendMessage`,
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) reject(new Error("401_UNAUTHORIZED"));
        else if (res.statusCode >= 200 && res.statusCode < 300) {
           resolve();
        } else reject(new Error(`Send Message xatosi: ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollForAgentResponse(apiKey, sessionId, knownActivityIds = new Set()) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let foundNewTexts = [];
    const interval = setInterval(async () => {
      try {
        attempts++;
        const resp = await getActivities(apiKey, sessionId);
        const activities = resp.activities || [];

        let hasNewActivity = false;
        let isCompleted = false;

        for (const act of activities) {
          if (!knownActivityIds.has(act.id)) {
             knownActivityIds.add(act.id);
             hasNewActivity = true;
             if (act.originator === 'agent' && act.progressUpdated) {
                let msg = act.progressUpdated.title || "";
                if (act.progressUpdated.description) msg += "\n" + act.progressUpdated.description;
                foundNewTexts.push(msg);
             } else if (act.originator === 'agent' && act.sessionCompleted) {
                foundNewTexts.push("Session completed by agent.");
                isCompleted = true;
             } else if (act.originator === 'agent' && act.planGenerated) {
                const planSteps = act.planGenerated.plan.steps.map(s => s.title).join('\n');
                foundNewTexts.push(`Plan generated:\n${planSteps}\n\`\`\`json\n{"action": "run_command", "command": "echo Plan approved"}\n\`\`\``);
             } else if (act.originator === 'agent' && act.artifacts && act.artifacts.length > 0) {
                 const bash = act.artifacts.find(a => a.bashOutput);
                 if (bash) foundNewTexts.push(`Bash output: ${bash.bashOutput.output}`);
             }
          }
        }

        // Only resolve if session is completed OR we hit timeout,
        // Otherwise keep polling to aggregate everything
        if (isCompleted) {
          clearInterval(interval);
          resolve(foundNewTexts.join('\n\n'));
        } else if (attempts > 60) {
          clearInterval(interval);
          if (foundNewTexts.length > 0) {
             resolve(foundNewTexts.join('\n\n'));
          } else {
             resolve("Agent javob bermadi (timeout).");
          }
        } else if (hasNewActivity) {
           // We got some activities, but session is not complete.
           // Reset attempts so we can wait longer if needed
           attempts = 0;
        }
      } catch (err) {
         clearInterval(interval);
         reject(err);
      }
    }, 2000);
  });
}

async function callOpenAI(apiKey, messages, endpoint = 'https://api.openai.com/v1/chat/completions', model = 'gpt-4o') {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const data = JSON.stringify({
      model: model,
      messages: messages,
      temperature: 0.2
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = (url.protocol === 'http:' ? require('http') : https).request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(responseData);
            resolve(parsed.choices[0].message.content);
          } catch (e) {
            reject(new Error("JSON parsing error: " + e.message));
          }
        } else if (res.statusCode === 401) {
          reject(new Error("401_UNAUTHORIZED"));
        } else {
          reject(new Error(`API xatosi: ${res.statusCode} - ${responseData}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(data);
    req.end();
  });
}

// Global state for Jules integration
let currentJulesSessionId = null;
let knownActivityIds = new Set();

function parseAction(aiResponse) {
  const jsonRegex = /\`\`\`json\n([\s\S]*?)\n\`\`\`/g;
  let match;
  let lastJson = null;

  while ((match = jsonRegex.exec(aiResponse)) !== null) {
    lastJson = match[1];
  }

  if (lastJson) {
    try {
      return JSON.parse(lastJson);
    } catch (e) {
      console.log("[Jules Agent] JSON o'qishda xatolik:", e.message);
      return null;
    }
  }
  return null;
}

async function executeAction(action) {
  if (action.action === 'write_file') {
    const fullPath = path.join(rootDir, action.filepath);
    console.log(`\n[AVTOMATIK] Fayl yozilmoqda: ${action.filepath}`);
    fs.writeFileSync(fullPath, action.content, 'utf8');
    return `Fayl muvaffaqiyatli saqlandi: ${action.filepath}`;
  }

  if (action.action === 'read_file') {
    const fullPath = path.join(rootDir, action.filepath);
    console.log(`\n[AVTOMATIK] Fayl o'qilmoqda: ${action.filepath}`);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      return `Fayl matni (${action.filepath}):\n\n${content}`;
    } else {
      return `Fayl topilmadi: ${action.filepath}`;
    }
  }

  if (action.action === 'run_command') {
    console.log(`\n[JULES] Ushbu buyruqni bajarmoqchi:\n> ${action.command}`);

    // Safety check filter for dangerous operations
    const dangerousPatterns = [
      /rm\s+-rf/i,
      /sudo\s/i,
      /drop\s+(database|table)/i,
      /mkfs/i,
      /chmod\s+-R\s+777/i,
      /chown\s+-R/i,
      />\s*\/dev\/sd/i
    ];

    const isDangerous = dangerousPatterns.some(pattern => pattern.test(action.command));

    if (isDangerous) {
      console.log("\n[DIQQAT XAVF!] Agent xavfli buyruqni ishga tushirmoqchi.");
      const allowed = await question(`Buyruq: ${action.command}\nRuxsat berasizmi? (y/n): `);
      if (allowed.toLowerCase() !== 'y') {
        return "Xavfli buyruq foydalanuvchi tomonidan bekor qilindi.";
      }
    } else {
      console.log("[AVTOMATIK] Xavfsiz buyruq, ruxsatsiz bajarilmoqda...");
    }

    return new Promise((resolve) => {
      exec(action.command, { cwd: rootDir }, (error, stdout, stderr) => {
        let result = `Command executed: ${action.command}\n`;
        if (stdout) result += `STDOUT:\n${stdout}\n`;
        if (stderr) result += `STDERR:\n${stderr}\n`;
        if (error) result += `ERROR:\n${error.message}\n`;
        resolve(result);
      });
    });
  }

  return "Noma'lum harakat (action) kiritildi.";
}

async function getApiKeyAndConfig() {
  let apiKey = '';
  let endpoint = 'https://api.openai.com/v1/chat/completions';
  let model = 'gpt-4o';

  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');

    const keyMatch = envContent.match(/^AI_API_KEY=(.*)$/m);
    if (keyMatch && keyMatch[1].trim()) apiKey = keyMatch[1].trim();

    const endpointMatch = envContent.match(/^AI_API_ENDPOINT=(.*)$/m);
    if (endpointMatch && endpointMatch[1].trim()) endpoint = endpointMatch[1].trim();

    const modelMatch = envContent.match(/^AI_API_MODEL=(.*)$/m);
    if (modelMatch && modelMatch[1].trim()) model = modelMatch[1].trim();
  }

  while (!apiKey) {
    console.log('\n[Jules Agent] AI API kaliti topilmadi.');
    apiKey = await question('Iltimos, API kalitingizni kiriting: ');

    if (!apiKey) {
      console.log('API kaliti kiritilmadi. Qayta urinib ko\'ring.');
    }
  }

  // Auto-detect if it's a Jules API key
  if (apiKey.startsWith('AQ.')) {
     endpoint = 'https://jules.googleapis.com';
     model = 'jules';
  }

  let currentEnv = '';
  if (fs.existsSync(envPath)) {
    currentEnv = fs.readFileSync(envPath, 'utf8');
    // update or add keys
    currentEnv = currentEnv.replace(/^AI_API_KEY=.*$/m, `AI_API_KEY=${apiKey}`);
    if (!currentEnv.includes(`AI_API_KEY=${apiKey}`)) {
      currentEnv += `\nAI_API_KEY=${apiKey}`;
    }

    currentEnv = currentEnv.replace(/^AI_API_ENDPOINT=.*$/m, `AI_API_ENDPOINT=${endpoint}`);
    if (!currentEnv.includes(`AI_API_ENDPOINT=${endpoint}`)) {
       currentEnv += `\nAI_API_ENDPOINT=${endpoint}`;
    }

    currentEnv = currentEnv.replace(/^AI_API_MODEL=.*$/m, `AI_API_MODEL=${model}`);
    if (!currentEnv.includes(`AI_API_MODEL=${model}`)) {
       currentEnv += `\nAI_API_MODEL=${model}`;
    }
  } else {
    currentEnv = `AI_API_KEY=${apiKey}\nAI_API_ENDPOINT=${endpoint}\nAI_API_MODEL=${model}\n`;
  }

  fs.writeFileSync(envPath, currentEnv, 'utf8');
  return { apiKey, endpoint, model };
}

async function initJulesSession(config) {
   let retry = true;
   while(retry) {
      console.log('[Jules Agent] Jules API manbai aniqlanmoqda...');
      try {
        const sourcesResp = await fetchSources(config.apiKey);
        if (sourcesResp.sources && sourcesResp.sources.length > 0) {
           const sourceName = sourcesResp.sources[0].name;
           console.log(`[Jules Agent] Manba topildi: ${sourceName}. Yangi sessiya yaratilmoqda...`);
           const sessionResp = await createSession(config.apiKey, sourceName, SYSTEM_PROMPT);
           currentJulesSessionId = sessionResp.name;
           console.log(`[Jules Agent] Sessiya muvaffaqiyatli yaratildi: ${currentJulesSessionId}\n`);

           const actResp = await getActivities(config.apiKey, currentJulesSessionId);
           if (actResp.activities) {
             actResp.activities.forEach(a => knownActivityIds.add(a.id));
           }
           retry = false;
        } else {
           console.log('[Jules Agent] Diqqat: Hech qanday source topilmadi. Avval Jules web panelidan Github ni ulang.');
           process.exit(1);
        }
      } catch (err) {
        if (err.message === "401_UNAUTHORIZED") {
           console.error('\n[Xatolik] API kaliti yaroqsiz (401 Unauthorized). U .env faylidan o\'chirilmoqda.');
           if (fs.existsSync(envPath)) {
             let envContent = fs.readFileSync(envPath, 'utf8');
             envContent = envContent.replace(/^AI_API_KEY=.*$/m, '');
             fs.writeFileSync(envPath, envContent, 'utf8');
           }
           config = await getApiKeyAndConfig(); // Qayta so'rash
        } else {
           console.error('[Jules Agent] Sessiya yaratishda xatolik:', err.message);
           process.exit(1);
        }
      }
   }
   return config;
}

async function startAgent() {
  console.log('\n=========================================');
  console.log('   🤖 JULES AVTONOM AGENTIGA XUSH KELIBSIZ');
  console.log('=========================================');

  let config = await getApiKeyAndConfig();
  console.log('[Jules Agent] API kaliti qabul qilindi. Chat tizimi ishga tushmoqda...\n');

  if (config.endpoint.includes('jules.googleapis.com')) {
     config = await initJulesSession(config);
  } else {
     chatHistory.push({ role: 'system', content: SYSTEM_PROMPT });
  }

  chatLoop(config);
}

function chatLoop(config) {
  rl.question('\nSiz: ', async (userInput) => {
    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      console.log('[Jules Agent] Xayr! Dastur to\'xtatildi.');
      rl.close();
      return;
    }

    if (!userInput.trim()) {
      chatLoop(config);
      return;
    }

    chatHistory.push({ role: 'user', content: userInput });

    await processAiResponse(config);
  });
}

async function processAiResponse(config) {
  try {
    process.stdout.write('\nAgent o\'ylamoqda...');

    let response;
    if (config.endpoint.includes('jules.googleapis.com')) {
       const lastUserMsg = chatHistory[chatHistory.length - 1].content;
       await sendMessage(config.apiKey, currentJulesSessionId, lastUserMsg);
       response = await pollForAgentResponse(config.apiKey, currentJulesSessionId, knownActivityIds);
    } else {
       response = await callOpenAI(config.apiKey, chatHistory, config.endpoint, config.model);
    }

    process.stdout.write('\r\x1b[K'); // clear the "thinking" line

    console.log('\nJules:', (response || "").replace(/\`\`\`json\n[\s\S]*?\n\`\`\`/g, '[JSON Action yashirildi]'));

    chatHistory.push({ role: 'assistant', content: response });

    const action = parseAction(response);
    if (action) {
      const actionResult = await executeAction(action);
      console.log(`[Natija]: ${actionResult.substring(0, 500)}${actionResult.length > 500 ? '...' : ''}`);

      // Feed the result back to AI
      chatHistory.push({ role: 'user', content: `Harakat natijasi:\n\n${actionResult}\n\nNatijani tahlil qiling va agar kerak bo'lsa navbatdagi qadamni bajaring.` });
      await processAiResponse(config); // Recursive call for autonomous multi-step execution
    } else {
      // No more actions, back to user input
      chatLoop(config);
    }

  } catch (error) {
    process.stdout.write('\r\x1b[K');
    if (error.message === "401_UNAUTHORIZED") {
      console.error('\n[Xatolik] API kaliti yaroqsiz (401 Unauthorized). U .env faylidan o\'chirilmoqda. Iltimos, dasturni qayta ishga tushiring va to\'g\'ri kalitni kiriting.');
      if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, 'utf8');
        envContent = envContent.replace(/^AI_API_KEY=.*$/m, '');
        fs.writeFileSync(envPath, envContent, 'utf8');
      }
      process.exit(1);
    } else {
      console.error('\n[Xatolik] API so\'rovida xatolik yuz berdi:', error.message);
      chatHistory.pop(); // Remove the failed user prompt so they can try again
      chatLoop(config);
    }
  }
}

startAgent().catch(err => {
  console.error('[XATOLIK]', err);
  rl.close();
});
