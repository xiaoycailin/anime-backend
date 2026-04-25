import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DECORATIONS = [
  { name: "Border 1", asset: "border1.png", requiredLevel: 20, sortOrder: 1 },
  { name: "Border 2", asset: "border2.gif", requiredLevel: 30, sortOrder: 2 },
  { name: "Border 3", asset: "border3.gif", requiredLevel: 50, sortOrder: 3 },
  { name: "Border 4", asset: "border4.webp", requiredLevel: 55, sortOrder: 4 },
  { name: "Border 6", asset: "border6.png", requiredLevel: 60, sortOrder: 5 },
  { name: "Border 5", asset: "border5.gif", requiredLevel: 90, sortOrder: 6 },
  { name: "Border 7", asset: "border7.png", requiredLevel: 100, sortOrder: 7 },
  { name: "Border 8", asset: "border8.webp", requiredLevel: 55, sortOrder: 8 },
  { name: "Border 9", asset: "border9.gif", requiredLevel: 50, sortOrder: 9 },
  {
    name: "Border 10",
    asset: "border10.gif",
    requiredLevel: 80,
    sortOrder: 10,
  },
];

const NAMETAGS = [
  { name: "{player_name}", style: "aura", requiredLevel: 20, sortOrder: 101 },
  { name: "{player_name}", style: "glitch", requiredLevel: 50, sortOrder: 102 },
  { name: "{player_name}", style: "cosmic", requiredLevel: 70, sortOrder: 103 },
  {
    name: "{player_name}",
    style: "glitch-glasses",
    requiredLevel: 80,
    sortOrder: 104,
  },
  {
    name: "Immortal Blood God Aura",
    style: "blood-god",
    requiredLevel: 100,
    sortOrder: 105,
  },
  { name: "Royal Crest", style: "royal", requiredLevel: 110, sortOrder: 106 },
];

async function main() {
  for (const item of DECORATIONS) {
    await prisma.decoration.upsert({
      where: { asset: item.asset },
      update: {
        name: item.name,
        requiredLevel: item.requiredLevel,
        sortOrder: item.sortOrder,
        type: "frame",
        config: {},
        isActive: true,
      },
      create: {
        name: item.name,
        type: "frame",
        asset: item.asset,
        config: {},
        requiredLevel: item.requiredLevel,
        sortOrder: item.sortOrder,
      },
    });
  }

  for (const item of NAMETAGS) {
    await prisma.decoration.upsert({
      where: { asset: `nametag-${item.style}` },
      update: {
        name: item.name,
        type: "nametag",
        config: { style: item.style },
        requiredLevel: item.requiredLevel,
        sortOrder: item.sortOrder,
        isActive: true,
      },
      create: {
        name: item.name,
        type: "nametag",
        asset: `nametag-${item.style}`,
        config: { style: item.style },
        requiredLevel: item.requiredLevel,
        sortOrder: item.sortOrder,
      },
    });
  }

  console.log(
    `Seeded ${DECORATIONS.length} frame decorations and ${NAMETAGS.length} nametags.`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
