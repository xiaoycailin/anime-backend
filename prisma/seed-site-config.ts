import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const configs = [
  {
    key: "site.name",
    value: "AniStream",
    type: "string",
    group: "general",
  },
  {
    key: "site.tagline",
    value: "Nonton Anime Sub Indo Gratis, Kualitas Terbaik",
    type: "string",
    group: "general",
  },
  {
    key: "site.description",
    value:
      "Situs nonton anime subtitle Indonesia terlengkap dan terbaru. Streaming anime HD gratis tanpa iklan berlebihan.",
    type: "string",
    group: "general",
  },
  {
    key: "site.url",
    value: "https://anistream.id",
    type: "string",
    group: "general",
  },
  {
    key: "site.logo",
    value: "/icon.png",
    type: "image",
    group: "general",
  },
  {
    key: "site.favicon",
    value: "/icon.png",
    type: "image",
    group: "general",
  },
  {
    key: "site.language",
    value: "id",
    type: "string",
    group: "general",
  },
  {
    key: "site.timezone",
    value: "Asia/Jakarta",
    type: "string",
    group: "general",
  },
  {
    key: "site.maintenanceMode",
    value: "false",
    type: "boolean",
    group: "general",
  },
  {
    key: "site.maintenanceMessage",
    value: "Sedang dalam pemeliharaan. Kembali lagi sebentar ya!",
    type: "string",
    group: "general",
  },
  {
    key: "seo.titleTemplate",
    value: "%s - AniStream",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.defaultTitle",
    value: "AniStream - Nonton Anime Sub Indo Gratis",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.defaultDescription",
    value:
      "Streaming anime subtitle Indonesia terlengkap. Update cepat, kualitas HD, gratis.",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.keywords",
    value:
      "nonton anime, anime sub indo, streaming anime, anime indonesia, anime gratis, anime terbaru",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.ogImage",
    value: "/icon.png",
    type: "image",
    group: "seo",
  },
  {
    key: "seo.twitterCard",
    value: "summary_large_image",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.twitterSite",
    value: "@anistream_id",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.robotsTxt",
    value:
      "User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /profile/\nSitemap: https://anistream.id/sitemap.xml",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.canonicalUrl",
    value: "https://anistream.id",
    type: "string",
    group: "seo",
  },
  {
    key: "seo.structuredData",
    value: JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "AniStream",
      url: "https://anistream.id",
      description: "Situs nonton anime subtitle Indonesia terlengkap",
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://anistream.id/search?q={search_term_string}",
        },
        "query-input": "required name=search_term_string",
      },
    }),
    type: "json",
    group: "seo",
  },
  {
    key: "analytics.googleTagId",
    value: "G-XXXXXXXXXX",
    type: "string",
    group: "analytics",
  },
  {
    key: "analytics.googleTagManagerId",
    value: "GTM-XXXXXXX",
    type: "string",
    group: "analytics",
  },
  {
    key: "analytics.googleSearchConsoleVerification",
    value: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    type: "string",
    group: "analytics",
  },
  {
    key: "analytics.clarityProjectId",
    value: "xxxxxxxxxx",
    type: "string",
    group: "analytics",
  },
  {
    key: "analytics.enabled",
    value: "true",
    type: "boolean",
    group: "analytics",
  },
  {
    key: "social.facebook",
    value: "https://facebook.com/anistream.id",
    type: "string",
    group: "social",
  },
  {
    key: "social.twitter",
    value: "https://twitter.com/anistream_id",
    type: "string",
    group: "social",
  },
  {
    key: "social.instagram",
    value: "https://instagram.com/anistream.id",
    type: "string",
    group: "social",
  },
  {
    key: "social.discord",
    value: "https://discord.gg/anistream",
    type: "string",
    group: "social",
  },
  {
    key: "social.telegram",
    value: "https://t.me/anistream_id",
    type: "string",
    group: "social",
  },
  {
    key: "appearance.primaryColor",
    value: "#7c3aed",
    type: "string",
    group: "appearance",
  },
  {
    key: "appearance.defaultTheme",
    value: "dark",
    type: "string",
    group: "appearance",
  },
  {
    key: "appearance.footerText",
    value: "(c) 2026 AniStream. Semua konten hanya untuk keperluan edukasi.",
    type: "string",
    group: "appearance",
  },
  {
    key: "appearance.announcementBar",
    value: "",
    type: "string",
    group: "appearance",
  },
  {
    key: "player.defaultQuality",
    value: "auto",
    type: "string",
    group: "player",
  },
  {
    key: "player.autoPlay",
    value: "false",
    type: "boolean",
    group: "player",
  },
  {
    key: "player.autoNextEpisode",
    value: "true",
    type: "boolean",
    group: "player",
  },
  {
    key: "player.skipIntroSeconds",
    value: "85",
    type: "number",
    group: "player",
  },
];

async function main() {
  console.log("Seeding site config...");

  for (const config of configs) {
    await prisma.siteConfig.upsert({
      where: { key: config.key },
      update: {
        value: config.value,
        type: config.type,
        group: config.group,
      },
      create: config,
    });
  }

  console.log(`${configs.length} site config records seeded.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
