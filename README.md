# Kino Telegram Bot

## Commands
- `/save KOD | Kino nomi` — admin: keyin video yuboradi
- `/list` — admin: kinolar ro'yxati
- `/delete KOD` — admin: kino o'chirish
- `/addchannel @kanal` — admin: majburiy kanal qo'shish
- `/delchannel @kanal` — admin: kanal o'chirish
- `/channels` — admin: kanallar ro'yxati
- `/users` — admin: foydalanuvchilar soni
- `/stats` — admin: foydalanuvchilar soni
- `/reklama` — admin: keyingi xabarni barcha foydalanuvchilarga yuborish
- `/bekor` — admin: reklama rejimini bekor qilish

## Environment variable
`TELEGRAM_BOT_TOKEN` — Telegram bot tokeni.

## Storage
Database is stored at `/data/kino_db.json` so it survives FadeHost deploy/restart.
