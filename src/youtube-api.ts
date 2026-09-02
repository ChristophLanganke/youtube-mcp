/**
 * Thin wrapper around YouTube Data API v3.
 *
 * Endpoints that read personal data require OAuth; public reads fall back to an
 * API key when one is configured, so search works before the user signs in.
 */
import { getAccessToken, hasStoredCredentials } from './auth.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

type AuthMode = 'oauth' | 'any';

async function apiRequest(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  mode: AuthMode,
): Promise<any> {
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

  const res = await fetch(url.toString(), { headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason;
    const message = data?.error?.message ?? `HTTP ${res.status}`;
    if (reason === 'quotaExceeded') {
      throw new Error('YouTube Data API quota exceeded for today. Transcript tools still work without quota.');
    }
    throw new Error(`YouTube API error (${res.status}): ${message}`);
  }

  return data;
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

export async function searchVideos(
  query: string,
  maxResults = 10,
  channelId?: string,
  publishedAfter?: string,
  order = 'relevance',
): Promise<VideoSummary[]> {
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
