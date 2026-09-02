import { fetchPlayerInfo, type CaptionTrack, type PlayerInfo } from './innertube.js';
import { formatTimestamp } from './video-id.js';

export type TranscriptFormat = 'text' | 'timestamped' | 'srt' | 'vtt' | 'json';

export interface Cue {
  start: number;
  duration: number;
  text: string;
}

export interface TranscriptResult {
  video: PlayerInfo;
  track: CaptionTrack;
  translatedTo: string | null;
  cues: Cue[];
  totalCues: number;
  truncated: boolean;
}

export interface TranscriptOptions {
  lang?: string;
  translateTo?: string;
  preferManual?: boolean;
  startSeconds?: number;
  endSeconds?: number;
  maxChars?: number;
}

/**
 * Picks the caption track that best matches `lang`, preferring an exact match,
 * then a prefix match (de matches de-DE), then the default/first track.
 * Human-written tracks win over auto-generated ones at equal specificity.
 */
export function selectTrack(
  tracks: CaptionTrack[],
  lang?: string,
  preferManual = true,
): CaptionTrack {
  if (tracks.length === 0) throw new Error('This video has no caption tracks.');

  const rank = (t: CaptionTrack) => (preferManual && t.kind === 'manual' ? 0 : 1);
  const byRank = (a: CaptionTrack, b: CaptionTrack) => rank(a) - rank(b);

  if (lang) {
    const target = lang.toLowerCase();

    const exact = tracks.filter((t) => t.languageCode.toLowerCase() === target).sort(byRank);
    if (exact.length) return exact[0];

    const base = target.split('-')[0];
    const prefix = tracks
      .filter((t) => t.languageCode.toLowerCase().split('-')[0] === base)
      .sort(byRank);
    if (prefix.length) return prefix[0];

    const available = tracks.map((t) => t.languageCode).join(', ');
    throw new Error(
      `No caption track for language "${lang}". Available: ${available}. ` +
        `Use translate_to to machine-translate an existing track instead.`,
    );
  }

  return [...tracks].sort(byRank)[0];
}

function buildTrackUrl(track: CaptionTrack, translateTo?: string): string {
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');
  if (translateTo) url.searchParams.set('tlang', translateTo);
  return url.toString();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseJson3(body: string): Cue[] {
  const parsed = JSON.parse(body);
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const cues: Cue[] = [];

  for (const ev of events) {
    if (!Array.isArray(ev.segs)) continue;
    const text = normalizeText(ev.segs.map((s: any) => s.utf8 ?? '').join(''));
    if (!text) continue;
    cues.push({
      start: (ev.tStartMs ?? 0) / 1000,
      duration: (ev.dDurationMs ?? 0) / 1000,
      text,
    });
  }

  return cues;
}

async function downloadCues(track: CaptionTrack, translateTo?: string): Promise<Cue[]> {
  const res = await fetch(buildTrackUrl(track, translateTo), {
    headers: {
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 429) {
    throw new Error('YouTube rate-limited the transcript request (HTTP 429). Wait a moment and retry.');
  }
  if (!res.ok) {
    throw new Error(`Transcript download failed with HTTP ${res.status}.`);
  }

  const body = await res.text();
  if (!body.trim()) {
    throw new Error(
      translateTo
        ? `YouTube returned an empty transcript for translation to "${translateTo}". The track may not be translatable.`
        : 'YouTube returned an empty transcript for this track.',
    );
  }

  try {
    return parseJson3(body);
  } catch {
    throw new Error('Could not parse the transcript response as JSON3.');
  }
}

export async function fetchTranscript(
  videoId: string,
  options: TranscriptOptions = {},
): Promise<TranscriptResult> {
  const video = await fetchPlayerInfo(videoId);
  const track = selectTrack(video.captionTracks, options.lang, options.preferManual ?? true);

  if (options.translateTo && !track.isTranslatable) {
    throw new Error(`The "${track.languageName}" track cannot be machine-translated by YouTube.`);
  }

  let cues = await downloadCues(track, options.translateTo);
  const totalCues = cues.length;

  const from = options.startSeconds;
  const to = options.endSeconds;
  if (from != null || to != null) {
    cues = cues.filter((c) => {
      const end = c.start + c.duration;
      if (from != null && end < from) return false;
      if (to != null && c.start > to) return false;
      return true;
    });
  }

  let truncated = false;
  if (options.maxChars != null && options.maxChars > 0) {
    let used = 0;
    const kept: Cue[] = [];
    for (const c of cues) {
      if (used + c.text.length > options.maxChars) {
        truncated = true;
        break;
      }
      kept.push(c);
      used += c.text.length + 1;
    }
    cues = kept;
  }

  return {
    video,
    track,
    translatedTo: options.translateTo ?? null,
    cues,
    totalCues,
    truncated,
  };
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const f = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${f}`;
}

export function formatTranscript(result: TranscriptResult, format: TranscriptFormat): string {
  const { cues } = result;

  switch (format) {
    case 'text':
      return cues.map((c) => c.text).join(' ');

    case 'timestamped':
      return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');

    case 'srt':
      return cues
        .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.start + c.duration)}\n${c.text}\n`)
        .join('\n');

    case 'vtt':
      return (
        'WEBVTT\n\n' +
        cues
          .map(
            (c) =>
              `${srtTime(c.start).replace(',', '.')} --> ${srtTime(c.start + c.duration).replace(',', '.')}\n${c.text}\n`,
          )
          .join('\n')
      );

    case 'json':
      return JSON.stringify(cues, null, 2);

    default:
      throw new Error(`Unknown transcript format: ${format}`);
  }
}

export function describeResult(result: TranscriptResult): string {
  const { video, track, translatedTo, cues, totalCues, truncated } = result;
  const lines = [
    `Title: ${video.title}`,
    `Channel: ${video.author}`,
    `Duration: ${formatTimestamp(video.lengthSeconds)}`,
    `URL: https://www.youtube.com/watch?v=${video.videoId}`,
    `Caption track: ${track.languageName} (${track.languageCode}, ${track.kind === 'asr' ? 'auto-generated' : 'human-written'})`,
  ];
  if (translatedTo) lines.push(`Machine-translated to: ${translatedTo}`);
  lines.push(`Cues: ${cues.length}${cues.length !== totalCues ? ` of ${totalCues}` : ''}`);
  if (truncated) lines.push('NOTE: output was truncated by max_chars; request a later time range for the rest.');
  return lines.join('\n');
}
