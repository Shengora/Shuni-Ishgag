#!/bin/bash
# Dasturni yangilash skripti (update-prod.sh)
# Ushbu skript serverdagi kodni avtomatik yangilash uchun mo'ljallangan.

set -e

# Jurnal yozish
log() {
    echo -e "\033[1;36m[UPDATE-PROD]\033[0m $1"
}

cd "$(dirname "$0")/.."
PROJECT_ROOT=$(pwd)
log "Loyiha papkasiga o'tildi: $PROJECT_ROOT"

log "GitHub-dan so'nggi o'zgarishlar yuklanmoqda (git pull)..."
git pull

# .env faylni xavfsiz o'qish va kiritish
if [ -f .env ]; then
    log ".env fayli topildi, muhit o'zgaruvchilari kiritilmoqda..."
    # agar .env da BASE_PATH yo'q bo'lsa, xatolikni oldini olish uchun shunchaki default ulab qo'yamiz
    if ! grep -q "^BASE_PATH=" .env; then
        log "BASE_PATH topilmadi, vaqtincha qiymat ulanmoqda..."
        echo "BASE_PATH=/" >> .env
    fi
else
    log "\033[1;31mXATO: .env fayli topilmadi. Iltimos oldin setup qiling.\033[0m"
    exit 1
fi

log "Yangi modullar o'rnatilmoqda (pnpm install)..."
pnpm install

log "Dastur qayta build qilinmoqda (pnpm build)..."
# set -a barcha e'lon qilingan o'zgaruvchilarni export qiladi
set -a
source .env
set +a
pnpm build

log "Ma'lumotlar bazasi sxemalari yangilanmoqda (drizzle push)..."
set -a
source .env
set +a
if pnpm --filter "@workspace/db" run push; then
    log "Jadvallar muvaffaqiyatli bazaga yuklandi."
else
    log "\033[1;33mDIQQAT: Bazaga jadvallarni yuklashda qandaydir muammo yuzaga kelgan bo'lishi mumkin.\033[0m"
fi

log "PM2 orqali xizmatlar qayta ishga tushirilmoqda..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart all
    pm2 save
    log "\033[1;32mMuvaffaqiyatli yangilandi va ishga tushirildi!\033[0m"
else
    log "\033[1;31mXATO: PM2 o'rnatilmagan yoki topilmadi.\033[0m"
fi
