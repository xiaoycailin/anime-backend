const QUALITY_NAME_RANK: Record<string, number> = {
  mobile: 0,
  lowest: 1,
  low: 2,
  sd: 3,
  "360": 3,
  "360p": 3,
  hd: 4,
  "720": 4,
  "720p": 4,
  full: 5,
  fhd: 5,
  "1080": 5,
  "1080p": 5,
  uhd: 6,
  "4k": 6,
};

type VariantBlock = {
  streamInfo: string;
  uri: string;
  rank: number;
  index: number;
};

function attrValue(line: string, name: string) {
  const match = line.match(new RegExp(`${name}=("[^"]+"|[^,]+)`, "i"));
  return match?.[1]?.replace(/^"|"$/g, "") ?? "";
}

function resolutionRank(value: string) {
  const height = Number(value.match(/x(\d+)/i)?.[1] ?? 0);
  if (!height) return Number.POSITIVE_INFINITY;
  return height;
}

function qualityNameRank(value: string) {
  const normalized = value.trim().toLowerCase();
  return QUALITY_NAME_RANK[normalized] ?? Number.POSITIVE_INFINITY;
}

function streamRank(line: string) {
  const name = attrValue(line, "NAME");
  const resolution = attrValue(line, "RESOLUTION");
  const bandwidth = Number(attrValue(line, "BANDWIDTH")) || Number.POSITIVE_INFINITY;
  const named = qualityNameRank(name);
  if (Number.isFinite(named)) return named;
  const byResolution = resolutionRank(resolution);
  if (Number.isFinite(byResolution)) return byResolution;
  return bandwidth;
}

export function orderHlsVariantsForFastStart(content: string) {
  const lines = content.split(/\r?\n/);
  const staticLines: string[] = [];
  const variants: VariantBlock[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("#EXT-X-STREAM-INF")) {
      staticLines.push(line);
      continue;
    }

    const uri = lines[i + 1] ?? "";
    if (!uri.trim() || uri.trim().startsWith("#")) {
      staticLines.push(line);
      continue;
    }

    variants.push({
      streamInfo: line,
      uri,
      rank: streamRank(line),
      index: variants.length,
    });
    i++;
  }

  if (variants.length < 2) return content;

  variants.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return [
    ...staticLines,
    ...variants.flatMap((variant) => [variant.streamInfo, variant.uri]),
  ].join("\n");
}
