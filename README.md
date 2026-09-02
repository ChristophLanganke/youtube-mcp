# youtube-mcp

MCP server that gives Claude Desktop access to YouTube transcripts and your own YouTube account data.

Built for the case "let Claude read/summarize this video": `get_transcript` pulls the subtitle
track of any public video and hands it over as plain text, so Claude can summarize, translate or
quote it without you watching the video.

## Capabilities

| Tool | Needs sign-in | Purpose |
| --- | --- | --- |
| `get_transcript` | no | Transcript of any public video, as text / timestamps / SRT / VTT / JSON |
| `list_transcript_languages` | no | Which caption tracks exist, auto vs human, translatable |
| `get_video_info` | no | Title, channel, duration, description, view count |
| `search_videos` | API key or sign-in | Search YouTube (uses API quota) |
| `get_playlist_items` | public: API key | Videos in a playlist |
| `get_auth_status` | no | What the server can currently do |
| `list_my_subscriptions` | yes | Channels you follow |
| `list_my_playlists` | yes | Your own playlists |
| `list_my_uploads` | yes | Videos you uploaded |
| `list_my_video_captions` | yes | Official caption tracks of your own videos, incl. drafts |
| `download_my_caption` | yes | Download an official caption track you own |

Transcripts do **not** consume YouTube Data API quota — they come from the caption endpoint the
player itself uses. Only the tools marked as using quota do.

## Setup

### 1. Install and build

```bash
cd ~/Repos/youtube-mcp
npm install
npm run build
```

At this point transcripts already work. Sign-in is only needed for the account tools.

### 2. Google Cloud credentials (for account access)

1. Open the [Google Cloud Console](https://console.cloud.google.com) and create a project.
2. **APIs & Services → Library →** enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen →** External, add yourself under *Test users*.
   (A personal project stays in "Testing" mode; a test-user refresh token expires after 7 days.
   Publishing the app removes that limit.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Desktop app.**
5. Copy the client ID and secret into `.env`:

```bash
cp .env.example .env
```

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Optionally add `YOUTUBE_API_KEY` so search works without signing in.

### 3. Sign in once

```bash
npm run auth
```

This opens a browser, asks for consent, and stores the token at `~/.youtube-mcp/token.json`
(mode `0600`). The server refreshes it automatically afterwards.

Sign out again with:

```bash
npm run auth -- --logout
```

### 4. Register with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "youtube": {
      "command": "node",
      "args": ["/Users/christophlanganke/Repos/youtube-mcp/dist/index.js"]
    }
  }
}
```

Then restart Claude Desktop.

## Usage examples

> Fasse mir dieses Video zusammen: https://www.youtube.com/watch?v=...

> Welche Untertitelsprachen hat das Video? Hol das deutsche Transkript.

> Was wird zwischen Minute 12 und 18 gesagt? — uses `start_seconds` / `end_seconds`

> Zeig mir die letzten 10 Videos meiner Abos und fasse das neueste zusammen.

For long videos the transcript is capped at `max_chars` (default 100 000). The response says so
explicitly; ask for a later `start_seconds` to continue, or set `max_chars: 0` to lift the cap.

## Authentication design

Sign-in uses **Google OAuth 2.0 for installed apps** (loopback redirect + PKCE), not your YouTube
password. Reasons:

- Your password is never handled or stored — only a revocable token is.
- Revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Automating a password login would violate YouTube's Terms of Service and break on every
  login-flow change.

Scopes requested: `youtube.readonly` and `youtube.force-ssl` (the latter is required by
`captions.download`). The server never writes to your account — no tool uploads, edits or deletes.

## How transcripts are fetched

The YouTube `WEB` InnerTube client stopped returning caption tracks to unauthenticated callers, so
[`src/innertube.ts`](src/innertube.ts) tries the `ANDROID` client, then `IOS`, then falls back to
scraping `ytInitialPlayerResponse` from the watch page. The first transport that returns caption
tracks wins. Cues are requested in `json3` format and parsed in
[`src/transcript.ts`](src/transcript.ts).

If all three fail, the video is usually private, age-restricted, region-blocked or deleted.

## Limitations

- Videos without captions (many live streams, some uploads) yield nothing — there is no
  speech-to-text fallback.
- `captions.download` works only for videos owned by the signed-in account; that is a YouTube
  restriction. Use `get_transcript` for third-party videos.
- YouTube rate-limits the caption endpoint (HTTP 429) if hit rapidly in a loop.
- Search and playlist tools share the default 10 000 units/day API quota; a search costs 100.
