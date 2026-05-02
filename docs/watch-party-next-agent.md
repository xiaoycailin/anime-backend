# Watch Party Next Agent Prompt

Lanjutkan fitur room nonton bareng Weebin dari fondasi yang sudah ada.

Kondisi saat ini:
- Backend sudah punya model Prisma `WatchPartyRoom` dan `WatchPartyParticipant`.
- Backend sudah punya service `src/services/watch-party.service.ts`.
- Backend sudah punya route tersembunyi `src/routes/watch-party/watch-party.route.ts`.
- Route create/list/detail dikunci oleh env `WATCH_PARTY_ENABLED=true`.
- Frontend sudah punya typed API helper `src/lib/watch-party.ts`.
- Belum ada UI publik, belum ada WebSocket sync player, belum ada migrasi/db push.

Target lanjutan:
1. Jalankan database sync saat siap:
   - `npm.cmd run prisma:push` di `backend-api`
   - generate Prisma normal kalau query engine tidak terkunci.
2. Tambahkan UI tersembunyi dulu:
   - tombol host room di watch page, hanya muncul kalau `WATCH_PARTY_ENABLED` aktif dari `/api/watch-party/feature`.
   - route `/watch-party/[code]` atau drawer di watch page.
3. Implement sync ringan:
   - mulai dari polling 3-5 detik untuk state playback.
   - WebSocket bisa menyusul kalau polling sudah stabil.
4. Endpoint tambahan yang dibutuhkan:
   - join/leave room
   - update playback state hanya host
   - participant heartbeat
   - end room hanya host/admin
5. Safety:
   - jangan expose token, IP, atau video source mentah.
   - room code unlisted, TTL pendek, cleanup expired room.
   - non-host tidak boleh force seek/play semua user.
6. Premium hook opsional:
   - host watch party bisa dibuat premium-only nanti.
   - viewer tetap ikut aturan kualitas masing-masing user.

Acceptance awal:
- Feature off: UI tidak muncul dan create room return not found.
- Feature on: host bisa buat room dari episode, share code, dan lihat metadata anime/episode.
- Build backend dan frontend pass.
