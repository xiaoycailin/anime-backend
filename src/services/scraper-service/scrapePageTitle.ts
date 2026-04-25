import * as cheerio from "cheerio";

export default async function scrapePageTitle(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch target URL: ${response.status}`);
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  const title = $("title").text().trim();

  return {
    url,
    title,
  };
}
