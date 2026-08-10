# Loyihani Google Compute Engine (GCE) da ishga tushirish bo'yicha qo'llanma

Bu loyihani Google Compute Engine (GCE) virtual mashinasida (VPS) qanday qilib uzluksiz ishga tushirish bo'yicha bosqichma-bosqich qo'llanma. Eng maqbul variant sifatida **Ubuntu** operatsion tizimidan foydalanishni tavsiya qilamiz.

## 1. GCE da Virtual Mashina yaratish
1. Google Cloud Console ga kiring.
2. **Compute Engine -> VM instances** bo'limiga o'ting.
3. **Create Instance** tugmasini bosing.
4. O'zingizga qulay mintaqani (Region) tanlang.
5. Mashina turini loyihangiz talabiga qarab tanlang (masalan, `e2-micro` yoki `e2-medium`).
6. **Boot disk** bo'limida "Change" tugmasini bosib, Operatsion tizimni **Ubuntu** (masalan, Ubuntu 22.04 LTS yoki 24.04 LTS) qilib tanlang.
7. **Firewall** bo'limida loyihangiz ishlashi uchun kerak bo'ladigan portlarga ruxsat bering: HTTP (80) yoki HTTPS (443).
8. **Create** tugmasini bosing.

## 2. Serverga ulanish va kerakli dasturlarni o'rnatish
VM yaratilgandan so'ng, SSH tugmasini bosib brauzer orqali yoki o'zingizning kompyuteringiz terminalidan ulaning.

Serverga ulanganingizdan so'ng, tizimni yangilang va kerakli dasturlarni o'rnating:

```bash
# Tizimni yangilash
sudo apt update && sudo apt upgrade -y

# Git, curl va boshqa kerakli paketlarni o'rnatish
sudo apt install git curl build-essential -y

# Node.js o'rnatish (Node.js 20.x misolida)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Pnpm paket menejerini o'rnatish
sudo npm install -g pnpm

# PM2 ni o'rnatish (Loyihani fonda uzluksiz ishlatish uchun)
sudo npm install -g pm2
```

## 3. Loyihani serverga yuklash
Agar loyihangiz GitHub/GitLab da bo'lsa, uni serverga klonlashingiz mumkin:

```bash
git clone <LOYIHA_GIT_URL>
cd <loyiha_papkasi>
```
*(Yoki SFTP yordamida loyiha fayllarini serverga nusxalashingiz mumkin)*

## 4. Muhit o'zgaruvchilarini (.env) sozlash
Loyiha ishlashi uchun kerakli bo'lgan o'zgaruvchilarni yaratishingiz kerak. Loyiha papkasida `.env` faylini yarating:

```bash
nano .env
```
Va ichiga quyidagi ma'lumotlarni kiriting (o'zingizning ma'lumotlaringizni qo'ying):

```env
PORT=3000
BASE_PATH="/"
BOT_TOKEN="sizning_telegram_bot_tokeningiz"
SUPER_ADMIN_ID="sizning_telegram_id_raqamingiz"
```
Saqlash uchun `Ctrl + O`, `Enter` ni, chiqish uchun `Ctrl + X` ni bosing.

## 5. Loyihani build qilish va ishga tushirish
Endi loyihaning qaramliklarini (dependencies) o'rnatamiz va uni kompile (build) qilamiz.
Loyiha pnpm workspace asosida qurilganligi sababli, `.env`dagi o'zgaruvchilarni ko'rsatgan holda build qilamiz:

```bash
# Barcha qaramliklarni o'rnatish
pnpm install

# Loyihani build qilish (PORT va BASE_PATH kerak bo'lishi mumkin)
PORT=3000 BASE_PATH="/" pnpm run build
```

Loyihani uzluksiz ishlashi uchun `pm2` yordamida ishga tushiramiz. Api serverni ishga tushirish:

```bash
# Api server joylashgan papkaga o'tamiz (agar ishga tushiruvchi skript o'sha yerda bo'lsa)
# Yoki to'g'ridan to'g'ri package.json dagi skript orqali:
cd artifacts/api-server
pm2 start pnpm --name "api-server" -- run start
```

Agar PM2 to'g'ri ishga tushganini tekshirmoqchi bo'lsangiz:
```bash
pm2 status
pm2 logs api-server
```

Server qayta yonganda (restart) ham dastur avtomatik ishga tushishi uchun:
```bash
pm2 startup
pm2 save
```

## Xulosa
Endi sizning loyihangiz GCE da ishlamoqda. Telegram botingiz va API serveringiz muammosiz ishlashi kerak. Agar serveringiz API si tashqaridan ulanishi uchun kerak bo'lsa, GCE firewall sozlamalaridan port (masalan 3000) ga ruxsat berishni unutmang.