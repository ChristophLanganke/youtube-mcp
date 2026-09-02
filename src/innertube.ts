/**
 * Minimal InnerTube (youtubei/v1/player) client.
 *
 * The WEB client no longer returns caption tracks for unauthenticated callers,
 * so we try the mobile clients first and fall back to scraping the watch page.
 */

const PLAYER_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';

interface InnertubeClient {
  label: string;
  key: string;
  userAgent: string;
  client: Record<string, unknown>;
}

const CLIENTS: InnertubeClient[] = [
  {
    label: 'ANDROID',
    key: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    client: {
      clientName: 'ANDROID',
      clientVersion: '20.10.38',
      androidSdkVersion: 34,
      hl: 'en',
      gl: 'US',
    },
  },
  {
    label: 'IOS',
    key: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)',
    client: {
      clientName: 'IOS',
      clientVersion: '20.10.4',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      hl: 'en',
      gl: 'US',
    },
  },
];

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface CaptionTrack {
  languageCode: string;
  languageName: string;
  kind: 'manual' | 'asr';
  baseUrl: string;
  vssId: string;
  isTranslatable: boolean;
}

export interface TranslationLanguage {
  code: string;
  name: string;
}

export interface PlayerInfo {
  videoId: string;
  title: string;
  author: string;
  channelId: string;
  lengthSeconds: number;
  viewCount: number | null;
  shortDescription: string;
  isLiveContent: boolean;
  keywords: string[];
  captionTracks: CaptionTrack[];
  translationLanguages: TranslationLanguage[];
  source: string;
}

function runsToText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r: any) => r.text ?? '').join('');
  return '';
}

function mapTracks(playerResponse: any): CaptionTrack[] {
  const list = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(list)) return [];

  return list.map((t: any) => ({
    languageCode: t.languageCode ?? '',
    languageName: runsToText(t.name) || t.languageCode || 'unknown',
    kind: t.kind === 'asr' ? ('asr' as const) : ('manual' as const),
    baseUrl: t.baseUrl ?? '',
    vssId: t.vssId ?? '',
    isTranslatable: Boolean(t.isTranslatable),
  }));
}

function mapTranslationLanguages(playerResponse: any): TranslationLanguage[] {
  const list = playerResponse?.captions?.playerCaptionsTracklistRenderer?.translationLanguages;
  if (!Array.isArray(list)) return [];
  return list.map((l: any) => ({
    code: l.languageCode ?? '',
    name: runsToText(l.languageName),
  }));
}

function toPlayerInfo(videoId: string, pr: any, source: string): PlayerInfo {
  const details = pr?.videoDetails ?? {};
  return {
    videoId,
    title: details.title ?? '',
    author: details.author ?? '',
    channelId: details.channelId ?? '',
    lengthSeconds: Number(details.lengthSeconds ?? 0),
    viewCount: details.viewCount != null ? Number(details.viewCount) : null,
    shortDescription: details.shortDescription ?? '',
    isLiveContent: Boolean(details.isLiveContent),
    keywords: Array.isArray(details.keywords) ? details.keywords : [],
    captionTracks: mapTracks(pr),
    translationLanguages: mapTranslationLanguages(pr),
    source,
  };
}

async function fetchViaClient(videoId: string, c: InnertubeClient): Promise<any | null> {
  const res = await fetch(`${PLAYER_ENDPOINT}?key=${c.key}&prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': c.userAgent,
      Origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      videoId,
      context: { client: c.client },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });

  if (!res.ok) return null;
  const pr = await res.json();
  const status = pr?.playabilityStatus?.status;
  if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') return null;
  return pr;
}

/** Extracts the first balanced JSON object appearing after `marker`. */
function extractJsonObject(html: string, marker: string): any | null {
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) return null;

  const start = html.indexOf('{', markerIdx);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

async function fetchViaWatchPage(videoId: string): Promise<any | null> {
  const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) return null;
  const html = await res.text();
  return extractJsonObject(html, 'ytInitialPlayerResponse');
}

/**
 * Resolves video metadata and caption tracks, trying each transport in turn.
 * A transport that responds but exposes no caption tracks is still accepted if
 * no later transport does better — some videos genuinely have no captions.
 */
export async function fetchPlayerInfo(videoId: string): Promise<PlayerInfo> {
  let best: PlayerInfo | null = null;
  const errors: string[] = [];

  const attempts: Array<[string, () => Promise<any | null>]> = [
    ...CLIENTS.map((c) => [c.label, () => fetchViaClient(videoId, c)] as [string, () => Promise<any | null>]),
    ['WATCH_PAGE', () => fetchViaWatchPage(videoId)],
  ];

  for (const [label, run] of attempts) {
    try {
      const pr = await run();
      if (!pr) {
        errors.push(`${label}: no usable response`);
        continue;
      }
      const info = toPlayerInfo(videoId, pr, label);
      if (info.captionTracks.length > 0) return info;
      if (!best) best = info;
    } catch (err: any) {
      errors.push(`${label}: ${err.message}`);
    }
  }

  if (best) return best;

  throw new Error(
    `Could not load video ${videoId}. It may be private, age-restricted, region-blocked or removed. ` +
      `Attempts: ${errors.join('; ')}`,
  );
}
