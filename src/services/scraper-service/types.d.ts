export interface AnimeServer {
  value: string | undefined;
  label: string;
}

export interface AnimeEpisode {
  number: string;
  title: string;
  href: string | null;
  sub: string;
  date: string;
  servers?: AnimeServer[]; // opsional, hanya ada setelah getDetailEpisode
}

export interface AnimeMetadata {
  status?: string;
  network?: string;
  studio?: string;
  released?: string;
  duration?: string;
  season?: string;
  country?: string;
  type?: string;
  episodes?: string;
  fansub?: string;
  [key: string]: string | undefined;
}

export interface AnimeTag {
  label: string;
  href: string | null;
}

export interface AnimeDetail {
  title: string;
  thumbnail: string | null;
  bigCover: string | null;
  rating: string | null;
  alternativeTitles: string | null;
  synopsis: string;
  metadata: AnimeMetadata;
  genres: string[];
  episodes: AnimeEpisode[];
  followed: string | null;
  tags: AnimeTag[];
}

export interface ListType {
  title: string | null;
  href: string | null;
  thumbnail: string | null;
  type: string | null;
  status: string | null;
  sub: string | null;
}
