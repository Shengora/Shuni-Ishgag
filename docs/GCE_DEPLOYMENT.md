# Google Compute Engine (GCE) - Tezkor O'rnatish Qo'llanmasi

Ushbu qo'llanma orqali siz loyihani Google Cloud (yoki istalgan Ubuntu/Debian) serverlarida **bitta buyruq bilan** o'rnatib, ishga tushirishingiz mumkin.

## 1. Tayyorgarlik

Serverga o'rnatishdan oldin sizda quyidagi ma'lumotlar tayyor bo'lishi kerak:
1. **`BOT_TOKEN`**: BotFather'dan olingan bot tokeni.
2. **`SUPER_ADMIN_ID`**: O'zingizning Telegram raqamli ID'ingiz (masalan 123456789).
3. **`DATABASE_URL`**: Supabase (yoki Neon.tech kabi boshqa PostgreSQL) ma'lumotlar bazasi URL'si.
   - Format: `postgresql://user:password@host:port/dbname`

## 2. Serverga kirish

Google Cloud konsoliga kiring va Compute Engine bo'limidan o'z virtual mashinangizni toping.
**"SSH"** tugmasini bosib, serverning terminaliga (qora oyna) kiring.

## 3. Loyihani yuklab olish va Skriptni ishga tushirish

Server terminalida quyidagi amallarni bajaring:

### A) Loyihani serverga tushirish (Git orqali)
Agar loyihangiz Git'da (Github/Gitlab) bo'lsa, avval uni serverga yuklab oling:
```bash
git clone <sizning_git_repo_havolangiz>
cd <loyihangiz_papkasi>
```
*(Agar kodni boshqa usulda serverga tashlagan bo'lsangiz, o'sha papkaga `cd` orqali kiring).*

### B) Avtomatik o'rnatish skriptini ishga tushirish
Loyiha papkasiga kirganingizdan so'ng, men tayyorlab bergan `setup-gce.sh` skriptini ishga tushiring:

```bash
bash scripts/setup-gce.sh
```

**Bu skript o'zi nima qiladi?**
- Node.js (20.x) va Pnpm'ni o'rnatadi.
- PM2'ni logrotate (xotira to'lmasligi uchun) xususiyati bilan o'rnatadi.
- Playwright (avtomatlashtirilgan brauzer) ishlashi uchun kerakli tizim kutubxonalarini o'rnatadi.
- Sizdan kerakli `.env` (Maxfiy) ma'lumotlarni kiritishni so'raydi. (Siz shunchaki so'raganida kiritib enter bosasiz).
- Barcha npm modullarini yuklaydi, dasturni yig'adi (build).
- PM2 orqali `ecosystem.config.js` yordamida dasturni uzluksiz ishga tushiradi.

## 4. Yakunlovchi ish (Muhim!)

Skript o'z ishini tugatgandan so'ng dastur ishga tushgan bo'ladi. Lekin, kelajakda server tasodifan o'chib qolsa yoki restart bo'lsa, bot ham avtomatik yonishi uchun **Startup** qo'shishingiz kerak.

Buning uchun terminalda:
```bash
pm2 startup
```
deb yozing. U sizga ekranda uzun bir buyruq chiqarib beradi (masalan, `sudo env PATH=$PATH:/usr/bin ...`). O'sha chiqqan uzun buyruqni **nusxalab, yana terminalga tashlang va Enter bosing**.

So'ngra, sozlamalarni saqlash uchun:
```bash
pm2 save
```
deb yozing.

**Tabriklayman! Bot endi serveringizda 24/7 rejimida xavfsiz va barqaror ishlaydi.**

## Yordamchi buyruqlar:
- Bot holatini ko'rish: `pm2 status`
- Bot qanday ishlayotganini (loglarni) kuzatish: `pm2 logs api-server`
- Botni to'xtatish: `pm2 stop api-server`
- Botni qayta ishga tushirish (restart): `pm2 restart api-server`
