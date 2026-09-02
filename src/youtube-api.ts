/**
 * Thin wrapper around YouTube Data API v3.
 *
 * Endpoints that read personal data require OAuth; public reads fall back to an
 * API key when one is configured, so search works before the user signs in.
 */
import { getAccessToken, hasStoredCredentials } from './auth.js';
import { cacheGet, cacheGetStale, cacheSet, cacheTouch, TTL } from './cache.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

/** Requests per second, not quota — hitting it is retryable. */
const MAX_CONCURRENCY = 8;
const MAX_RETRIES = 4;

type AuthMode = 'oauth' | 'any';

/** Thrown on HTTP 404 so callers can fall back instead of failing. */
export class NotFoundError extends Error {}

interface RequestOptions {
  /** Enables TTL caching and ETag revalidation under this key. */
  cacheKey?: string;
  ttlMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiRequest(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  mode: AuthMode,
  opts: RequestOptions = {},
): Promise<any> {
  const { cacheKey, ttlMs } = opts;

  if (cacheKey && ttlMs) {
    const fresh = cacheGet<any>(cacheKey);
    if (fresh !== undefined) return fresh;
  }

  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (mode === 'oauth' || hasStoredCredentials()) {
    headers.Authorization = `Bearer ${await getAccessToken()}`;
  } else if (apiKey) {
    url.searchParams.set('key', apiKey);
  } else {
    throw new Error(
      'No credentials available. Run "npm run auth" to sign in, or set YOUTUBE_API_KEY in .env for public data.',
    );
  }

  // A stale entry can still be revalidated for free: a 304 costs no quota.
  const stale = cacheKey && ttlMs ? cacheGetStale<any>(cacheKey) : undefined;
  if (stale?.etag) headers['If-None-Match'] = stale.etag;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url.toString(), { headers });

    if (res.status === 304 && stale) {
      cacheTouch(cacheKey!, ttlMs!);
      return stale.value;
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (cacheKey && ttlMs) cacheSet(cacheKey, data, ttlMs, res.headers.get('etag') ?? undefined);
      return data;
    }

    const data = await res.json().catch(() => ({}));
    const reason = data?.error?.errors?.[0]?.reason;
    const message = data?.error?.message ?? `HTTP ${res.status}`;

    if (res.status === 404) {
      throw new NotFoundError(message);
    }

    if (reason === 'quotaExceeded') {
      throw new Error(
        'YouTube Data API quota exceeded for today. Transcript tools still work without quota.',
      );
    }

    // Requests-per-second limit or a transient server fault — back off and retry.
    const retryable = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      await sleep(2 ** attempt * 250 + Math.random() * 250);
      continue;
    }

    throw new Error(`YouTube API error (${res.status}): ${message}`);
  }
}

/** Runs tasks with a bounded number in flight, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

export interface VideoSummary {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  description: string;
  url: string;
}

function toVideoSummary(item: any): VideoSummary {
  const videoId = item.id?.videoId ?? item.snippet?.resourceId?.videoId ?? item.id ?? '';
  return {
    videoId,
    title: item.snippet?.title ?? '',
    channel: item.snippet?.channelTitle ?? '',
    publishedAt: item.snippet?.publishedAt ?? '',
    description: (item.snippet?.description ?? '').slice(0, 300),
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const UPLOADS_ID_RE = /^UU[A-Za-z0-9_-]{22}$/;

/**
 * Every channel has an auto-maintained uploads playlist whose ID is the channel
 * ID with the UC prefix swapped for UU. Undocumented but stable for years;
 * listChannelUploads falls back to channels.list if the derivation ever 404s.
 */
function uploadsPlaylistId(channelId: string): string {
  return `UU${channelId.slice(2)}`;
}

/** Accepts a channel ID, a UU uploads-playlist ID, an @handle or a channel URL. */
export async function resolveChannelId(channel: string): Promise<string> {
  const raw = channel.trim();

  if (CHANNEL_ID_RE.test(raw)) return raw;
  if (UPLOADS_ID_RE.test(raw)) return `UC${raw.slice(2)}`;

  let handle: string | undefined;
  let username: string | undefined;

  if (raw.startsWith('@')) {
    handle = raw;
  } else if (/^https?:\/\//i.test(raw) || raw.includes('youtube.com')) {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const segments = url.pathname.split('/').filter(Boolean);

    if (segments[0] === 'channel' && segments[1]) {
      if (CHANNEL_ID_RE.test(segments[1])) return segments[1];
      throw new Error(`"${segments[1]}" is not a valid channel ID.`);
    }
    if (segments[0]?.startsWith('@')) handle = segments[0];
    else if (segments[0] === 'user' && segments[1]) username = segments[1];
    else if (segments[0] === 'c' && segments[1]) handle = `@${segments[1]}`;
  } else {
    handle = `@${raw}`;
  }

  if (!handle && !username) {
    throw new Error(`Could not interpret "${channel}" as a channel ID, handle or URL.`);
  }

  const cacheKey = `channel:${handle ?? `user:${username}`}`;
  const data = await apiRequest(
    'channels',
    { part: 'id', forHandle: handle, forUsername: username },
    'any',
    { cacheKey, ttlMs: TTL.handle },
  );

  const id = data.items?.[0]?.id;
  if (id) return id;

  // A /c/ vanity URL is not always identical to the handle.
  if (handle) {
    const legacy = await apiRequest(
      'channels',
      { part: 'id', forUsername: handle.slice(1) },
      'any',
      { cacheKey: `channel:user:${handle.slice(1)}`, ttlMs: TTL.handle },
    );
    const legacyId = legacy.items?.[0]?.id;
    if (legacyId) return legacyId;
  }

  throw new Error(
    `No channel found for "${channel}". Open the channel on YouTube and use the UC... ID from its URL.`,
  );
}

function toUploadSummary(item: any): VideoSummary {
  const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId ?? '';
  return {
    videoId,
    title: item.snippet?.title ?? '',
    channel: item.snippet?.videoOwnerChannelTitle ?? item.snippet?.channelTitle ?? '',
    // snippet.publishedAt is when the video entered the playlist, which drifts
    // apart for videos flipped from private to public. The real upload date is
    // contentDetails.videoPublishedAt.
    publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? '',
    description: (item.snippet?.description ?? '').slice(0, 300),
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export interface ChannelUploads {
  channelId: string;
  channel: string;
  videos: VideoSummary[];
  nextPageToken: string | null;
}

/**
 * Lists a channel's uploads via its uploads playlist: 1 quota unit instead of
 * the 100 that search.list costs, and complete rather than best-effort.
 */
export async function listChannelUploads(
  channel: string,
  maxResults = 10,
  publishedAfter?: string,
  pageToken?: string,
): Promise<ChannelUploads> {
  const channelId = await resolveChannelId(channel);
  const limit = Math.min(Math.max(maxResults, 1), 50);

  const request = (playlistId: string) =>
    apiRequest(
      'playlistItems',
      { part: 'snippet,contentDetails', playlistId, maxResults: limit, pageToken },
      'any',
      { cacheKey: `uploads:${playlistId}:${limit}:${pageToken ?? ''}`, ttlMs: TTL.uploads },
    );

  // A channel that is gone stays gone. Without this, every feed call would
  // re-request the same 404 for each dead subscription.
  const failKey = `uploadsFail:${channelId}`;
  const knownFailure = cacheGet<string>(failKey);
  if (knownFailure) throw new Error(knownFailure);

  const giveUp = (message: string): never => {
    cacheSet(failKey, message, TTL.uploads);
    throw new Error(message);
  };

  let data: any;
  try {
    data = await request(uploadsPlaylistId(channelId));
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    // Derivation failed — ask for the real uploads playlist explicitly.
    let explicit: string | undefined;
    try {
      const meta = await apiRequest(
        'channels',
        { part: 'contentDetails', id: channelId },
        'any',
        { cacheKey: `uploadsPlaylist:${channelId}`, ttlMs: TTL.handle },
      );
      explicit = meta.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    } catch (metaErr) {
      if (!(metaErr instanceof NotFoundError)) throw metaErr;
    }

    if (!explicit) {
      giveUp(`Channel ${channelId} exposes no uploads playlist (deleted, suspended, or no public uploads).`);
    }

    try {
      data = await request(explicit!);
    } catch (err2) {
      if (!(err2 instanceof NotFoundError)) throw err2;
      giveUp(`Uploads playlist ${explicit} for channel ${channelId} is not available.`);
    }
  }

  let videos = (data.items ?? []).map(toUploadSummary);

  if (publishedAfter) {
    const cutoff = Date.parse(publishedAfter);
    if (Number.isNaN(cutoff)) throw new Error(`published_after is not a valid ISO 8601 datetime: "${publishedAfter}"`);
    videos = videos.filter((v: VideoSummary) => Date.parse(v.publishedAt) >= cutoff);
  }

  return {
    channelId,
    channel: videos[0]?.channel ?? '',
    videos,
    nextPageToken: data.nextPageToken ?? null,
  };
}

export async function searchVideos(
  query: string | undefined,
  maxResults = 10,
  channelId?: string,
  publishedAfter?: string,
  order = 'relevance',
): Promise<VideoSummary[]> {
  // Listing a channel without a search term is the uploads-playlist case:
  // 1 unit instead of 100, and it returns videos whose title lacks the term.
  if (!query && channelId) {
    const result = await listChannelUploads(channelId, maxResults, publishedAfter);
    return result.videos;
  }

  if (!query) {
    throw new Error(
      'Provide either query (full-text search) or channel_id (lists that channel\'s uploads).',
    );
  }

  const data = await apiRequest(
    'search',
    {
      part: 'snippet',
      q: query,
      type: 'video',
      maxResults: Math.min(Math.max(maxResults, 1), 50),
      channelId,
      publishedAfter,
      order,
    },
    'any',
  );
  return (data.items ?? []).map(toVideoSummary);
}

export async function getVideoDetails(videoIds: string[]): Promise<any[]> {
  const data = await apiRequest(
    'videos',
    { part: 'snippet,contentDetails,statistics', id: videoIds.join(',') },
    'any',
  );

  return (data.items ?? []).map((v: any) => ({
    videoId: v.id,
    title: v.snippet?.title,
    channel: v.snippet?.channelTitle,
    channelId: v.snippet?.channelId,
    publishedAt: v.snippet?.publishedAt,
    description: v.snippet?.description,
    tags: v.snippet?.tags ?? [],
    duration: v.contentDetails?.duration,
    viewCount: v.statistics?.viewCount,
    likeCount: v.statistics?.likeCount,
    commentCount: v.statistics?.commentCount,
    url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
}

export async function listMySubscriptions(maxResults = 50, pageToken?: string): Promise<any> {
  const data = await apiRequest(
    'subscriptions',
    { part: 'snippet', mine: 'true', maxResults: Math.min(Math.max(maxResults, 1), 50), order: 'alphabetical', pageToken },
    'oauth',
  );

  return {
    channels: (data.items ?? []).map((s: any) => ({
      channelId: s.snippet?.resourceId?.channelId,
      title: s.snippet?.title,
      description: (s.snippet?.description ?? '').slice(0, 200),
      url: `https://www.youtube.com/channel/${s.snippet?.resourceId?.channelId}`,
    })),
    nextPageToken: data.nextPageToken ?? null,
    total: data.pageInfo?.totalResults ?? null,
  };
}

export interface SubscribedChannel {
  channelId: string;
  title: string;
}

/** Pages through every subscription once and caches the assembled list. */
async function fetchAllSubscriptions(): Promise<SubscribedChannel[]> {
  const cacheKey = 'subs:all';
  const cached = cacheGet<SubscribedChannel[]>(cacheKey);
  if (cached) return cached;

  const all: SubscribedChannel[] = [];
  let pageToken: string | undefined;

  do {
    const data = await apiRequest(
      'subscriptions',
      { part: 'snippet', mine: 'true', maxResults: 50, order: 'alphabetical', pageToken },
      'oauth',
    );

    for (const item of data.items ?? []) {
      const channelId = item.snippet?.resourceId?.channelId;
      if (channelId) all.push({ channelId, title: item.snippet?.title ?? channelId });
    }

    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  cacheSet(cacheKey, all, TTL.subscriptions);
  return all;
}

export interface FeedError {
  channel: string;
  channelId: string;
  error: string;
}

export interface SubscriptionFeedResult {
  videos: VideoSummary[];
  channelCount: number;
  since: string | null;
  errors: FeedError[];
}

const publishedTime = (v: VideoSummary) => {
  const t = Date.parse(v.publishedAt);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Merged newest-first feed across all subscriptions.
 *
 * Costs roughly one quota unit per channel plus a few for the subscription
 * list, versus 100 per channel via search.list.
 */
export async function getSubscriptionFeed(
  options: {
    maxResults?: number;
    since?: string;
    perChannel?: number;
    channels?: string[];
  } = {},
): Promise<SubscriptionFeedResult> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 20, 1), 100);
  const perChannel = Math.min(Math.max(options.perChannel ?? 3, 1), 50);

  let cutoff = NaN;
  if (options.since) {
    cutoff = Date.parse(options.since);
    if (Number.isNaN(cutoff)) throw new Error(`since is not a valid ISO 8601 datetime: "${options.since}"`);
  }

  let channels = await fetchAllSubscriptions();

  if (options.channels?.length) {
    const resolved = await mapWithConcurrency(options.channels, MAX_CONCURRENCY, async (c) => {
      try {
        return await resolveChannelId(c);
      } catch {
        return null;
      }
    });

    const wanted = new Set(resolved.filter((id): id is string => id !== null));
    const known = new Map(channels.map((c) => [c.channelId, c]));
    channels = [...wanted].map((id) => known.get(id) ?? { channelId: id, title: id });
  }

  const videos: VideoSummary[] = [];
  const errors: FeedError[] = [];

  await mapWithConcurrency(channels, MAX_CONCURRENCY, async (sub) => {
    try {
      const result = await listChannelUploads(sub.channelId, perChannel);
      for (const video of result.videos) {
        if (!Number.isNaN(cutoff) && publishedTime(video) < cutoff) continue;
        videos.push({ ...video, channel: video.channel || sub.title });
      }
    } catch (err: any) {
      // One dead channel must not take the whole feed down with it.
      errors.push({ channel: sub.title, channelId: sub.channelId, error: err.message });
    }
  });

  videos.sort((a, b) => publishedTime(b) - publishedTime(a));

  return {
    videos: videos.slice(0, maxResults),
    channelCount: channels.length,
    since: options.since ?? null,
    errors,
  };
}

export async function listMyPlaylists(maxResults = 50, pageToken?: string): Promise<any> {
  const data = await apiRequest(
    'playlists',
    { part: 'snippet,contentDetails', mine: 'true', maxResults: Math.min(Math.max(maxResults, 1), 50), pageToken },
    'oauth',
  );

  return {
    playlists: (data.items ?? []).map((p: any) => ({
      playlistId: p.id,
      title: p.snippet?.title,
      description: (p.snippet?.description ?? '').slice(0, 200),
      itemCount: p.contentDetails?.itemCount,
      url: `https://www.youtube.com/playlist?list=${p.id}`,
    })),
    nextPageToken: data.nextPageToken ?? null,
  };
}

export async function listPlaylistItems(
  playlistId: string,
  maxResults = 50,
  pageToken?: string,
): Promise<any> {
  const data = await apiRequest(
    'playlistItems',
    { part: 'snippet', playlistId, maxResults: Math.min(Math.max(maxResults, 1), 50), pageToken },
    'any',
  );

  return {
    videos: (data.items ?? []).map(toVideoSummary),
    nextPageToken: data.nextPageToken ?? null,
    total: data.pageInfo?.totalResults ?? null,
  };
}

/** Resolves the signed-in user's "uploads" playlist and lists it. */
export async function listMyUploads(maxResults = 50, pageToken?: string): Promise<any> {
  const channels = await apiRequest('channels', { part: 'contentDetails,snippet', mine: 'true' }, 'oauth');
  const channel = channels.items?.[0];
  const uploads = channel?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploads) throw new Error('Could not resolve the uploads playlist for the signed-in account.');

  const result = await listPlaylistItems(uploads, maxResults, pageToken);
  return { channel: channel?.snippet?.title, ...result };
}

/**
 * Official caption tracks for a video the signed-in user owns.
 * Unlike the transcript tools this reflects what the API reports, including
 * drafts and tracks that are not publicly served.
 */
export async function listOwnCaptions(videoId: string): Promise<any[]> {
  const data = await apiRequest('captions', { part: 'snippet', videoId }, 'oauth');

  return (data.items ?? []).map((c: any) => ({
    captionId: c.id,
    language: c.snippet?.language,
    name: c.snippet?.name,
    trackKind: c.snippet?.trackKind,
    isDraft: c.snippet?.isDraft,
    isAutoSynced: c.snippet?.isAutoSynced,
    lastUpdated: c.snippet?.lastUpdated,
  }));
}

/** Downloads a caption track the signed-in user owns. Requires video ownership. */
export async function downloadOwnCaption(captionId: string, format: 'srt' | 'vtt' = 'srt'): Promise<string> {
  const url = new URL(`${API_BASE}/captions/${captionId}`);
  url.searchParams.set('tfmt', format);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        'Caption download refused (403). captions.download only works for videos owned by the signed-in account. ' +
          'For third-party videos use get_transcript instead.',
      );
    }
    throw new Error(`Caption download failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return res.text();
}

export async function getMyChannel(): Promise<any> {
  const data = await apiRequest('channels', { part: 'snippet,statistics', mine: 'true' }, 'oauth');
  const c = data.items?.[0];
  if (!c) throw new Error('No channel found for the signed-in account.');

  return {
    channelId: c.id,
    title: c.snippet?.title,
    description: c.snippet?.description,
    customUrl: c.snippet?.customUrl,
    subscriberCount: c.statistics?.subscriberCount,
    videoCount: c.statistics?.videoCount,
    viewCount: c.statistics?.viewCount,
  };
}
