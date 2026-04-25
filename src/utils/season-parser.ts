const SEASON_PATTERNS = [/\bseason\s*0*(\d+)\b/i, /\bs\s*0*(\d+)\b/i];

const SEASON_INDICATOR = /\b(?:season|series)\s*0*\d+\b|\bs\s*0*\d+\b/i;

const SEASON_INDICATOR_GLOBAL =
  /\b(?:season|series)\s*0*\d+\b|\bs\s*0*\d+\b/gi;

const EPISODE_TAIL =
  /\b(?:episode|episodes|eps|ep)\s*0*\d+.*$/i;

const NOISE_WORDS = new Set([
  "subtitle",
  "sub",
  "indo",
  "indonesia",
  "batch",
  "the",
  "of",
  "a",
  "an",
  "episode",
  "episodes",
  "eps",
  "ep",
]);

export function normalizeTitle(title: string) {
  return title
    .replace(EPISODE_TAIL, "")
    .replace(SEASON_INDICATOR_GLOBAL, "")
    .replace(/\s*[-:|]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableTitle(title: string) {
  return normalizeTitle(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function extractSeason(title: string) {
  for (const pattern of SEASON_PATTERNS) {
    const match = title.match(pattern);
    if (!match) continue;

    const season = Number(match[1]);
    if (Number.isInteger(season) && season > 0) {
      return season;
    }
  }

  return 1;
}

export function extractSeasonNumber(title: string) {
  return extractSeason(title);
}

export function extractBaseTitle(title: string) {
  const withoutEpisodeTail = title.replace(EPISODE_TAIL, "").trim();
  const seasonMatch = withoutEpisodeTail.match(SEASON_INDICATOR);

  if (seasonMatch?.index && seasonMatch.index > 0) {
    return normalizeTitle(withoutEpisodeTail.slice(0, seasonMatch.index));
  }

  return normalizeTitle(withoutEpisodeTail.replace(SEASON_INDICATOR, ""));
}

function titleTokens(title: string) {
  return normalizeComparableTitle(title)
    .split(" ")
    .filter((token) => token.length > 1 && !NOISE_WORDS.has(token));
}

export function isSameAnime(a: string, b: string) {
  const leftTitle = normalizeComparableTitle(a);
  const rightTitle = normalizeComparableTitle(b);

  if (!leftTitle || !rightTitle) return false;
  if (leftTitle === rightTitle) return true;

  const left = new Set(titleTokens(a));
  const right = new Set(titleTokens(b));

  if (left.size === 0 || right.size === 0) return false;

  let matches = 0;
  for (const token of left) {
    if (right.has(token)) matches += 1;
  }

  const strictCoverage = matches / Math.max(left.size, right.size);
  const shorterCoverage = matches / Math.min(left.size, right.size);

  return strictCoverage >= 0.85 && shorterCoverage >= 0.95;
}
