import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const password = await hash("admin123!", 12);

  await prisma.user.upsert({
    where: { email: "admin@anistream.id" },
    update: { role: "admin" },
    create: {
      email: "admin@anistream.id",
      username: "admin",
      password,
      role: "admin",
      preference: { create: {} },
    },
  });

  console.log("Admin user ready: admin@anistream.id / admin123!");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
