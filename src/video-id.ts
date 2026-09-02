const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{2,}$/;

/**
 * Accepts a bare video ID or any common YouTube URL form
 * (watch?v=, youtu.be/, /embed/, /shorts/, /live/, /v/).
 */
export function parseVideoId(input: string): string {
  const raw = input.trim();
  if (VIDEO_ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Not a valid YouTube video ID or URL: "${input}"`);
  }

  const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    if (VIDEO_ID_RE.test(id)) return id;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID_RE.test(v)) return v;

    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }

  throw new Error(
    `Could not extract a video ID from "${input}". ` +
      `Expected an 11-character ID or a youtube.com/youtu.be URL.`,
  );
}

/** Accepts a bare playlist ID or a URL containing ?list=. */
export function parsePlaylistId(input: string): string {
  const raw = input.trim();

  if (/^https?:\/\//i.test(raw) || raw.includes('youtube.com')) {
    try {
      const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const list = url.searchParams.get('list');
      if (list) return list;
    } catch {
      // fall through to treating the input as a bare ID
    }
  }

  if (PLAYLIST_ID_RE.test(raw)) return raw;
  throw new Error(`Could not extract a playlist ID from "${input}".`);
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
