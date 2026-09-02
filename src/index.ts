import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { parseVideoId, parsePlaylistId, formatTimestamp } from './video-id.js';
import { fetchPlayerInfo } from './innertube.js';
import {
  fetchTranscript,
  formatTranscript,
  describeResult,
  type TranscriptFormat,
} from './transcript.js';
import { hasStoredCredentials, tokenPath } from './auth.js';
import {
  searchVideos,
  getVideoDetails,
  listMySubscriptions,
  listMyPlaylists,
  listPlaylistItems,
  listMyUploads,
  listOwnCaptions,
  downloadOwnCaption,
  getMyChannel,
} from './youtube-api.js';

const DEFAULT_MAX_CHARS = 100_000;

const server = new Server(
  { name: 'youtube-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_transcript',
      description:
        'Fetch the transcript/subtitles of a YouTube video for reading, summarizing or quoting. ' +
        'Works for any public video without sign-in. Accepts a video ID or any YouTube URL. ' +
        'Long transcripts are truncated at max_chars — request a later start_seconds to continue.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Video ID or URL (watch, youtu.be, shorts, embed)' },
          lang: {
            type: 'string',
            description: 'Preferred caption language code, e.g. de or en. Defaults to the video\'s default track.',
          },
          translate_to: {
            type: 'string',
            description: 'Machine-translate the track into this language code, e.g. de. Only for translatable tracks.',
          },
          format: {
            type: 'string',
            enum: ['text', 'timestamped', 'srt', 'vtt', 'json'],
            default: 'text',
            description: 'text = plain prose (cheapest, best for summarizing); timestamped = [mm:ss] lines for citing moments',
          },
          prefer_manual: {
            type: 'boolean',
            default: true,
            description: 'Prefer human-written captions over auto-generated ones when both exist',
          },
          start_seconds: { type: 'number', description: 'Only include cues at or after this timestamp' },
          end_seconds: { type: 'number', description: 'Only include cues at or before this timestamp' },
          max_chars: {
            type: 'number',
            default: DEFAULT_MAX_CHARS,
            description: 'Character budget for the transcript body. Set 0 for no limit.',
          },
          include_metadata: {
            type: 'boolean',
            default: true,
            description: 'Prefix the output with title, channel, duration and track info',
          },
        },
        required: ['video'],
      },
    },
    {
      name: 'list_transcript_languages',
      description:
        'List the caption tracks available for a video (language, human-written vs auto-generated, translatable) ' +
        'plus the languages YouTube can machine-translate into. Use before get_transcript when unsure.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Video ID or URL' },
        },
        required: ['video'],
      },
    },
    {
      name: 'get_video_info',
      description:
        'Get metadata for a video: title, channel, duration, description, view count and whether captions exist. ' +
        'Needs no sign-in and no API quota.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Video ID or URL' },
          full_description: {
            type: 'boolean',
            default: false,
            description: 'Return the whole description instead of the first 1000 characters',
          },
        },
        required: ['video'],
      },
    },
    {
      name: 'search_videos',
      description:
        'Search YouTube for videos. Requires sign-in or YOUTUBE_API_KEY and consumes YouTube Data API quota.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms' },
          max_results: { type: 'number', default: 10, description: '1-50' },
          channel_id: { type: 'string', description: 'Restrict results to this channel' },
          published_after: { type: 'string', description: 'ISO 8601 datetime, e.g. 2026-01-01T00:00:00Z' },
          order: {
            type: 'string',
            enum: ['relevance', 'date', 'viewCount', 'rating', 'title'],
            default: 'relevance',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_auth_status',
      description: 'Report whether the server is signed in to a Google account and which capabilities are available.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'list_my_subscriptions',
      description: 'List the channels the signed-in account is subscribed to. Requires sign-in.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', default: 50, description: '1-50' },
          page_token: { type: 'string', description: 'nextPageToken from a previous call' },
        },
      },
    },
    {
      name: 'list_my_playlists',
      description: 'List the signed-in account\'s own playlists. Requires sign-in.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', default: 50, description: '1-50' },
          page_token: { type: 'string' },
        },
      },
    },
    {
      name: 'get_playlist_items',
      description:
        'List the videos in a playlist. Public playlists work with an API key; private ones need sign-in. ' +
        'Combine with get_transcript to summarize a whole playlist.',
      inputSchema: {
        type: 'object',
        properties: {
          playlist: { type: 'string', description: 'Playlist ID or a URL containing ?list=' },
          max_results: { type: 'number', default: 50, description: '1-50' },
          page_token: { type: 'string' },
        },
        required: ['playlist'],
      },
    },
    {
      name: 'list_my_uploads',
      description: 'List videos uploaded by the signed-in account, newest first. Requires sign-in.',
      inputSchema: {
        type: 'object',
        properties: {
          max_results: { type: 'number', default: 50, description: '1-50' },
          page_token: { type: 'string' },
        },
      },
    },
    {
      name: 'list_my_video_captions',
      description:
        'List the official caption tracks of a video owned by the signed-in account, including drafts ' +
        'that are not publicly served. Requires sign-in and video ownership.',
      inputSchema: {
        type: 'object',
        properties: {
          video: { type: 'string', description: 'Video ID or URL of a video you own' },
        },
        required: ['video'],
      },
    },
    {
      name: 'download_my_caption',
      description:
        'Download an official caption track as SRT or VTT. Only works for videos owned by the signed-in account — ' +
        'use get_transcript for anything else.',
      inputSchema: {
        type: 'object',
        properties: {
          caption_id: { type: 'string', description: 'Caption ID from list_my_video_captions' },
          format: { type: 'string', enum: ['srt', 'vtt'], default: 'srt' },
        },
        required: ['caption_id'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_transcript': {
        const videoId = parseVideoId(args!.video as string);
        const maxChars = args!.max_chars as number | undefined;

        const result = await fetchTranscript(videoId, {
          lang: args!.lang as string | undefined,
          translateTo: args!.translate_to as string | undefined,
          preferManual: (args!.prefer_manual as boolean) ?? true,
          startSeconds: args!.start_seconds as number | undefined,
          endSeconds: args!.end_seconds as number | undefined,
          maxChars: maxChars === 0 ? undefined : (maxChars ?? DEFAULT_MAX_CHARS),
        });

        const format = ((args!.format as string) ?? 'text') as TranscriptFormat;
        const body = formatTranscript(result, format);
        const includeMetadata = (args!.include_metadata as boolean) ?? true;

        const text = includeMetadata ? `${describeResult(result)}\n\n---\n\n${body}` : body;
        return { content: [{ type: 'text', text }] };
      }

      case 'list_transcript_languages': {
        const videoId = parseVideoId(args!.video as string);
        const info = await fetchPlayerInfo(videoId);

        if (info.captionTracks.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: `"${info.title}" has no caption tracks. Live streams and some uploads never get them.`,
              },
            ],
          };
        }

        const tracks = info.captionTracks.map((t) => ({
          languageCode: t.languageCode,
          languageName: t.languageName,
          type: t.kind === 'asr' ? 'auto-generated' : 'human-written',
          translatable: t.isTranslatable,
        }));

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  title: info.title,
                  channel: info.author,
                  tracks,
                  translationLanguageCount: info.translationLanguages.length,
                  translationLanguages: info.translationLanguages.map((l) => l.code),
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case 'get_video_info': {
        const videoId = parseVideoId(args!.video as string);
        const info = await fetchPlayerInfo(videoId);
        const full = (args!.full_description as boolean) ?? false;

        const payload = {
          videoId: info.videoId,
          title: info.title,
          channel: info.author,
          channelId: info.channelId,
          duration: formatTimestamp(info.lengthSeconds),
          durationSeconds: info.lengthSeconds,
          viewCount: info.viewCount,
          isLiveContent: info.isLiveContent,
          keywords: info.keywords.slice(0, 25),
          url: `https://www.youtube.com/watch?v=${info.videoId}`,
          captionTracks: info.captionTracks.map((t) => `${t.languageCode} (${t.kind})`),
          description: full ? info.shortDescription : info.shortDescription.slice(0, 1000),
          descriptionTruncated: !full && info.shortDescription.length > 1000,
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      }

      case 'search_videos': {
        const results = await searchVideos(
          args!.query as string,
          (args!.max_results as number) ?? 10,
          args!.channel_id as string | undefined,
          args!.published_after as string | undefined,
          (args!.order as string) ?? 'relevance',
        );
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      }

      case 'get_auth_status': {
        const signedIn = hasStoredCredentials();
        const hasApiKey = Boolean(process.env.YOUTUBE_API_KEY);

        const lines = [
          `Signed in: ${signedIn ? 'yes' : 'no'}`,
          `Token file: ${tokenPath()}`,
          `API key configured: ${hasApiKey ? 'yes' : 'no'}`,
          '',
          'Available without sign-in: get_transcript, list_transcript_languages, get_video_info',
          `Available now with quota: ${signedIn || hasApiKey ? 'search_videos, get_playlist_items' : 'none'}`,
          `Account tools (subscriptions, playlists, uploads, own captions): ${signedIn ? 'available' : 'run "npm run auth" to enable'}`,
        ];

        if (signedIn) {
          try {
            const channel = await getMyChannel();
            lines.push('', `Channel: ${channel.title} (${channel.channelId})`);
          } catch (err: any) {
            lines.push('', `Channel lookup failed: ${err.message}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'list_my_subscriptions': {
        const result = await listMySubscriptions(
          (args!.max_results as number) ?? 50,
          args!.page_token as string | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_my_playlists': {
        const result = await listMyPlaylists(
          (args!.max_results as number) ?? 50,
          args!.page_token as string | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_playlist_items': {
        const playlistId = parsePlaylistId(args!.playlist as string);
        const result = await listPlaylistItems(
          playlistId,
          (args!.max_results as number) ?? 50,
          args!.page_token as string | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_my_uploads': {
        const result = await listMyUploads(
          (args!.max_results as number) ?? 50,
          args!.page_token as string | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_my_video_captions': {
        const videoId = parseVideoId(args!.video as string);
        const result = await listOwnCaptions(videoId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'download_my_caption': {
        const body = await downloadOwnCaption(
          args!.caption_id as string,
          ((args!.format as string) ?? 'srt') as 'srt' | 'vtt',
        );
        return { content: [{ type: 'text', text: body }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
