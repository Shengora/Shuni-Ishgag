# Google Compute Engine (GCE) Server Yo'riqnomasi

Ushbu hujjat botning serverda (Google Compute Engine) xotirasi to'lib qolishi (sda1 disk to'lishi) va server o'chib-yonganda PM2 avtomatik ishga tushmaslik muammolarini hal qilish uchun mo'ljallangan.

## 1. Disk (sda1) xotirasini tozalash

Serverga SSH orqali kirganingizdan so'ng, PM2 yaratgan va diskni to'ldirib yuborgan log (xotira) fayllarini o'chirish uchun quyidagi buyruqlarni bajaring:

```bash
# PM2 ning barcha joriy loglarini tozalash
pm2 flush

# Agar bu yetarli bo'lmasa, PM2 ning loglar papkasini to'liq tozalash
rm -rf ~/.pm2/logs/*
```

Shundan so'ng disk bo'shaganini tekshiring:
```bash
df -h
```
`sda1` (yoki `/`) qismi 100% dan tushgan bo'lishi kerak.

## 2. Kelajakda disk to'lishining oldini olish (Logrotate)

PM2 loglari yana ko'payib diskni to'ldirib yubormasligi uchun `pm2-logrotate` modulini o'rnating. U kunlik yoki hajmi kattalashgan loglarni avtomatik o'chirib/arxivlab turadi:

```bash
# pm2-logrotate ni o'rnatish
pm2 install pm2-logrotate

# Log fayl maksimal hajmini 50MB qilib belgilash (50MB ga yetganda yangisiga o'tadi)
pm2 set pm2-logrotate:max_size 50M

# Saqlanadigan eski loglar sonini cheklash (masalan, faqat oxirgi 10 tasini saqlash)
pm2 set pm2-logrotate:retain 10

# Eski loglarni avtomatik siqish (joyni tejash uchun)
pm2 set pm2-logrotate:compress true
```

## 3. Botni xavfsiz va to'g'ri ishga tushirish

Loyiha ichiga `ecosystem.config.js` fayli qo'shildi. Bu fayl botni xavfsiz ishga tushirish, xotira limitini o'rnatish va loglarni alohida `logs` papkaga saqlash uchun xizmat qiladi.

Botni ishga tushirish uchun loyiha papkasiga kiring (masalan, sizning proyektingiz turgan papkaga) va quyidagini yozing:

```bash
# Eskidan qolib ketgan, ishlamayotgan processlarni tozalash (ixtiyoriy)
pm2 delete all

# Loyihani sozlamalar bilan yangitdan ishga tushirish
pm2 start ecosystem.config.js
```

Bot to'g'ri ishlayotganini tekshirish uchun:
```bash
pm2 status
```

## 4. Server o'chib yonsa avtomatik ishga tushishini sozlash (Startup)

Server restart bo'lganda (o'chib-yonganda) PM2 avtomatik tarzda botni ko'tarishi uchun uni operatsion tizim startapiga qo'shish kerak. Quyidagi ikki buyruqni bajaring:

```bash
# 1. Startap skriptini generatsiya qilish.
# Bu buyruqni kiritganingizda, PM2 sizga terminalda uzun bir buyruq chiqarib beradi
# (masalan: sudo env PATH=$PATH:/usr/bin ...).
# O'sha terminalda chiqqan uzun buyruqni to'liq nusxalab, qaytadan enter qilib ishga tushirishingiz kerak!
pm2 startup

# 2. Hozirgi ishlab turgan botlar ro'yxatini saqlab qo'yish
pm2 save
```

Shu ishlarni to'liq bajarganingizdan so'ng, server o'zidan o'zi o'chib yonsa ham, botlaringiz avtomatik tarzda ishlab ketaveradi va xotira (disk) muammosi ham boshqa bezovta qilmaydi.