#!/bin/bash
# Google Compute Engine (Debian/Ubuntu) uchun to'liq o'rnatish skripti.
# Ushbu skript Node.js, pnpm, pm2 va kerakli kutubxonalarni avtomatik o'rnatib,
# dasturni ishlab chiqarish (production) muhitida ishga tushiradi.

set -e

# Rivojlanish jurnali funksiyasi
log() {
    echo -e "\033[1;32m[GCE-SETUP]\033[0m $1"
}

log "Tizimni yangilash va kerakli yordamchi paketlarni o'rnatish boshlandi..."
sudo apt-get update
sudo apt-get install -y curl wget git unzip bash-completion build-essential

# Node.js 20.x versiyasini o'rnatish
log "Node.js 20.x o'rnatilmoqda..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    log "Node.js allaqachon o'rnatilgan."
fi

# Pnpm o'rnatish
log "Pnpm 9-versiyasi o'rnatilmoqda (Node 20 uchun stabil versiya)..."
# Agar avval pnpm 10 o'rnatilgan bo'lsa (node:sqlite xatosi), uni o'chirib tashlaymiz
sudo npm uninstall -g pnpm || true
# To'g'ridan to'g'ri pnpm 9 ni o'rnatamiz
sudo npm install -g pnpm@9

# PM2 o'rnatish (agar yo'q bo'lsa)
log "PM2 va uning logrotate moduli o'rnatilmoqda..."
if ! command -v pm2 >/dev/null 2>&1; then
    sudo npm install -g pm2
    pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 50M
    pm2 set pm2-logrotate:retain 10
    pm2 set pm2-logrotate:compress true
else
    log "PM2 allaqachon o'rnatilgan."
fi

# Playwright uchun kerakli tizim paketlarini o'rnatish
log "Playwright uchun kerakli tizim paketlari o'rnatilmoqda..."
sudo npx -y playwright install-deps

log "Kodni o'rnatish jildiga o'tilmoqda..."
# Agar foydalanuvchi bu skriptni loyiha papkasidan tashqarida ishlatsa xato bo'lmasligi uchun:
cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)
log "Loyiha root papkasi: $PROJECT_ROOT"

# Agar .env fayl bo'lmasa yaratishni so'rash
if [ ! -f .env ]; then
    log "\033[1;31mDIQQAT: .env fayli topilmadi!\033[0m"
    echo "Iltimos, .env faylini yaratish uchun quyidagi ma'lumotlarni kiriting."

    read -p "PORT (masalan, 3000): " PORT_VAL
    read -p "BOT_TOKEN (Telegram bot tokeni): " BOT_TOKEN_VAL
    read -p "SUPER_ADMIN_ID (Telegram admin id): " ADMIN_VAL
    read -p "DATABASE_URL (PostgreSQL yoki Supabase url): " DB_VAL

    PORT_VAL=${PORT_VAL:-3000}

    cat <<EOF > .env
PORT=$PORT_VAL
BOT_TOKEN=$BOT_TOKEN_VAL
SUPER_ADMIN_ID=$ADMIN_VAL
DATABASE_URL=$DB_VAL
EOF
    log ".env fayli muvaffaqiyatli yaratildi."
fi

# Loyiha modullarini yuklash
log "Pnpm orqali modullar yuklanmoqda..."
pnpm install

# Build qilish
log "Loyiha build qilinmoqda..."
pnpm build

# Ma'lumotlar bazasi jadvallarini yangilash (Drizzle ORM)
log "Ma'lumotlar bazasiga jadvallar kiritilmoqda..."
if pnpm --filter "./lib/db" run push; then
    log "Jadvallar muvaffaqiyatli bazaga yuklandi."
else
    log "\033[1;33mDIQQAT: Bazaga jadvallarni yuklashda qandaydir muammo yuzaga kelgan bo'lishi mumkin.\033[0m"
fi

# PM2 yordamida ishga tushirish
log "Dasturni PM2 yordamida ishga tushirish boshlandi..."
pm2 start ecosystem.config.js
pm2 save

# PM2 ni startup (tizim yonganda avtomatik yonish) ga qo'shish yo'riqnomasi
log "\033[1;33mDastur muvaffaqiyatli ishga tushirildi!\033[0m"
log "Tizim o'chib yonganda bot o'z-o'zidan ishlashi uchun, terminalingizda quyidagi buyruqni alohida ishga tushiring:"
echo ""
echo "    pm2 startup"
echo ""
log "Va ekranda chiqqan (sudo env PATH=...) qatorini ko'chirib bosib yuboring, so'ngra 'pm2 save' ni bosing."

log "Barcha jarayonlar tugadi."
