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

async function callOpenAI(apiKey, messages) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: "gpt-4o", // O'zgartirishingiz mumkin, masalan: gpt-3.5-turbo yoki claude-3-5-sonnet (agar URLni o'zgartirsangiz)
      messages: messages,
      temperature: 0.2
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
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

async function getApiKey() {
  let apiKey = '';
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^AI_API_KEY=(.*)$/m);
    if (match && match[1].trim()) {
      apiKey = match[1].trim();
    }
  }

  if (!apiKey) {
    console.log('\n[Jules Agent] AI API kaliti topilmadi (masalan, OpenAI API Key).');
    apiKey = await question('Iltimos, API kalitingizni kiriting: ');

    if (!apiKey) {
      console.log('API kaliti kiritilmadi. Dastur to\'xtatildi.');
      process.exit(1);
    }

    const saveIt = await question('Ushbu kalitni kelajakda foydalanish uchun .env fayliga saqlab qo\'yaymi? (y/n): ');
    if (saveIt.toLowerCase() === 'y') {
      let currentEnv = '';
      if (fs.existsSync(envPath)) {
        currentEnv = fs.readFileSync(envPath, 'utf8');
      }
      const newEnv = currentEnv ? `${currentEnv}\nAI_API_KEY=${apiKey}\n` : `AI_API_KEY=${apiKey}\n`;
      fs.writeFileSync(envPath, newEnv, 'utf8');
      console.log('[Jules Agent] API kaliti .env fayliga muvaffaqiyatli saqlandi!\n');
    }
  }

  return apiKey;
}

async function startAgent() {
  console.log('\n=========================================');
  console.log('   🤖 JULES AVTONOM AGENTIGA XUSH KELIBSIZ');
  console.log('=========================================');

  const apiKey = await getApiKey();
  console.log('[Jules Agent] API kaliti qabul qilindi. Chat tizimi ishga tushmoqda...\n');

  chatHistory.push({ role: 'system', content: SYSTEM_PROMPT });

  chatLoop(apiKey);
}

function chatLoop(apiKey) {
  rl.question('\nSiz: ', async (userInput) => {
    if (userInput.toLowerCase() === 'exit' || userInput.toLowerCase() === 'quit') {
      console.log('[Jules Agent] Xayr! Dastur to\'xtatildi.');
      rl.close();
      return;
    }

    if (!userInput.trim()) {
      chatLoop(apiKey);
      return;
    }

    chatHistory.push({ role: 'user', content: userInput });

    await processAiResponse(apiKey);
  });
}

async function processAiResponse(apiKey) {
  try {
    process.stdout.write('\nAgent o\'ylamoqda...');
    const response = await callOpenAI(apiKey, chatHistory);
    process.stdout.write('\r\x1b[K'); // clear the "thinking" line

    console.log('\nJules:', response.replace(/\`\`\`json\n[\s\S]*?\n\`\`\`/g, '[JSON Action yashirildi]'));

    chatHistory.push({ role: 'assistant', content: response });

    const action = parseAction(response);
    if (action) {
      const actionResult = await executeAction(action);
      console.log(`[Natija]: ${actionResult.substring(0, 500)}${actionResult.length > 500 ? '...' : ''}`);

      // Feed the result back to AI
      chatHistory.push({ role: 'user', content: `Harakat natijasi:\n\n${actionResult}\n\nNatijani tahlil qiling va agar kerak bo'lsa navbatdagi qadamni bajaring.` });
      await processAiResponse(apiKey); // Recursive call for autonomous multi-step execution
    } else {
      // No more actions, back to user input
      chatLoop(apiKey);
    }

  } catch (error) {
    process.stdout.write('\r\x1b[K');
    console.error('\n[Xatolik] API so\'rovida xatolik yuz berdi:', error.message);
    chatHistory.pop(); // Remove the failed user prompt so they can try again
    chatLoop(apiKey);
  }
}

startAgent().catch(err => {
  console.error('[XATOLIK]', err);
  rl.close();
});
