/**
 * Test script: kirim 1 broadcast notification ke semua user.
 * Jalankan dengan: npx ts-node src/scripts/test-broadcast.ts
 */

import dotenv from 'dotenv';
dotenv.config();

import { prisma } from '../lib/prisma';
import { createBroadcastNotification } from '../services/notification.service';

async function main() {
  console.log('=== Broadcast Notification Test ===\n');

  // Cek jumlah user dulu
  const userCount = await prisma.user.count();
  console.log(`Total user di DB: ${userCount}`);

  if (userCount === 0) {
    console.log('Tidak ada user di database. Test dibatalkan.');
    return;
  }

  // Kirim broadcast
  const notif = await createBroadcastNotification({
    category: 'announcement',
    type:     'test_broadcast',
    title:    '🎉 Test Broadcast Berhasil!',
    message:  'Ini adalah test notifikasi broadcast dari sistem. Kalau kamu lihat ini, berarti sistem notifikasi berjalan dengan baik!',
    link:     '/',
  });

  console.log('\n✅ Broadcast terkirim!');
  console.log(`   Notification ID : ${notif.id}`);
  console.log(`   Category        : ${notif.category}`);
  console.log(`   Type            : ${notif.type}`);
  console.log(`   Title           : ${notif.title}`);
  console.log(`   Message         : ${notif.message}`);
  console.log(`   Created at      : ${notif.createdAt.toISOString()}`);

  // Cek berapa recipient yang dibuat
  const recipientCount = await prisma.notificationRecipient.count({
    where: { notificationId: notif.id },
  });
  console.log(`\n   Recipients created : ${recipientCount} dari ${userCount} user`);

  if (recipientCount < userCount) {
    const skipped = userCount - recipientCount;
    console.log(`   Skipped (opt-out)  : ${skipped} user (preferensi announcement=false)`);
  }

  // Tampilkan sample recipients
  const samples = await prisma.notificationRecipient.findMany({
    where: { notificationId: notif.id },
    take: 5,
    include: { user: { select: { id: true, username: true, email: true } } },
  });

  console.log('\n   Sample recipients:');
  for (const r of samples) {
    const label = r.user ? `@${r.user.username} (id=${r.user.id})` : `userId=null (guest)`;
    console.log(`    - ${label} isRead=${r.isRead}`);
  }
}

main()
  .catch((err) => {
    console.error('\n❌ Error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
