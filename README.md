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
| `list_channel_uploads` | API key or sign-in | Recent uploads of any channel (ID, `@handle` or URL) — 1 quota unit |
| `get_subscription_feed` | yes | Merged newest-first feed across all your subscriptions |
| `search_videos` | API key or sign-in | Full-text search — 100 quota units |
| `get_playlist_items` | public: API key | Videos in a playlist |
| `get_auth_status` | no | What the server can currently do |
| `list_my_subscriptions` | yes | Channels you follow |
| `list_my_playlists` | yes | Your own playlists |
| `list_my_uploads` | yes | Videos you uploaded |
| `list_my_video_captions` | yes | Official caption tracks of your own videos, incl. drafts |
| `download_my_caption` | yes | Download an official caption track you own |

Transcripts do **not** consume YouTube Data API quota — they come from the caption endpoint the
player itself uses. Only the tools marked as using quota do.

## Quota

The daily budget is 10 000 units, and `search.list` costs 100 of them per call — 100 calls a day.
Listing a channel's videos does not need search at all: every channel has an auto-maintained
uploads playlist whose ID is the channel ID with `UC` swapped for `UU`, and `playlistItems.list`
on it costs **1 unit** while returning uploads completely rather than best-effort.

`get_subscription_feed` uses that: a feed over 120 subscriptions costs roughly 123 units instead of
the 12 000 the search route would need — which would not fit in a day at all. Results are cached on
disk (subscriptions 24 h, uploads 12 min), so a repeated feed call usually costs nothing, and dead
channels are cached as failures so they are not re-requested on every call.

`search_videos` stays for genuine full-text search. Calling it with `channel_id` but no `query` is
routed to the cheap path automatically.

## Setup

### 1. Install and build

```bash
cd ~/Repos/youtube-mcp
npm install
npm run build
```

At this point transcripts already work. Sign-in is only needed for the account tools.

### 2. Google Cloud credentials (for account access)

The old "OAuth consent screen" page is gone — Google replaced it with the **Google Auth Platform**
section. German console labels are given in parentheses.

1. Open the [Google Cloud Console](https://console.cloud.google.com) and create a project.
2. **APIs & Services → Library (Bibliothek) →** enable **YouTube Data API v3**.
3. **Google Auth Platform → Get started (Erste Schritte).** The wizard asks for an app name, your
   support email, the audience — choose **External (Extern)** — and a contact email.
4. **Google Auth Platform → Audience (Zielgruppe) → Test users (Testnutzer):** add your own Google
   address. Without this, sign-in fails with `access_denied`.
5. **Google Auth Platform → Data access (Datenzugriff) → Add or remove scopes:** add
   `.../auth/youtube.readonly` and `.../auth/youtube.force-ssl`, then save.
6. **Google Auth Platform → Clients → Create client (Client erstellen) →** application type
   **Desktop app (Desktop-App)**.
7. Copy the client ID and secret into `.env`:

```bash
cp .env.example .env
```

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Optionally add `YOUTUBE_API_KEY` so search works without signing in.

Two things to expect, both normal for a personal project:

- The consent screen warns that the app is **not verified**. Click *Advanced (Erweitert)* →
  *Go to … (unsafe)*. Verification only matters for apps offered to other people.
- While the app's publishing status is **Testing**, the refresh token expires after **7 days**, so
  you have to re-run `npm run auth` weekly. Setting the status to **In production (In Produktion)**
  under *Google Auth Platform → Audience* removes that limit; the unverified warning stays.

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
