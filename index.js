(function () {
    'use strict';

    const SpotifyImporter = {
        name: 'Spotify Universal Importer',
        api: null,

        isOpen: false,
        isConverting: false,
        stopConversion: false,
        abortController: null,
        importedPlaylistData: null,
        singleTrackData: null,
        detectedType: null, // 'playlist' | 'track' | 'album'

        PLAYLIST_API: 'https://spotify-api-henna.vercel.app/api/playlist',
        trackCache: new Map(),
        cachedPlaylists: [],

        async init(api) {
            console.log('[SpotifyImporter] Initializing...');
            this.api = api;
            this.injectStyles();
            this.createModal();
            this.createMenuButton();
            console.log('[SpotifyImporter] Ready.');
        },

        // ── Fetch helpers ────────────────────────────────────────────────────

        /**
         * Fetch a Spotify embed page and extract __NEXT_DATA__ JSON.
         * Works for: track, album, playlist embed pages.
         */
        async fetchEmbedData(type, id) {
            const url = `https://open.spotify.com/embed/${type}/${id}`;
            const res = await this.api.fetch(url, {
                headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0' }
            });
            if (!res.ok) throw new Error(`Embed page returned ${res.status}`);
            const html = await res.text();

            const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (!match) throw new Error('__NEXT_DATA__ not found in embed page');

            const nextData = JSON.parse(match[1]);
            const entity = nextData?.props?.pageProps?.state?.data?.entity;
            if (!entity) throw new Error('entity not found in __NEXT_DATA__');

            // Extract the live session access token (useful for playlist pagination)
            const token = nextData?.props?.pageProps?.state?.session?.accessToken || null;
            return { entity, token };
        },

        /**
         * Fetch basic metadata via oEmbed (no auth needed).
         * Returns: { title, thumbnail_url }
         */
        async fetchOEmbed(type, id) {
            const url = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`;
            const res = await this.api.fetch(url);
            if (!res.ok) throw new Error(`oEmbed returned ${res.status}`);
            return await res.json();
        },

        // ── Smart Multi-Stage Source Search ─────────────────────────────────
        async searchAllSources(spotifyTrack, signal) {
            // Stage 1: Exact search
            let results = await this.querySearch(
                { title: spotifyTrack.title, artist: spotifyTrack.artist, isrc: spotifyTrack.isrc, duration_ms: spotifyTrack.duration_ms },
                signal
            );
            if (results.some(r => r.status === 'success')) return results;

            // Stage 2: Clean title & artist
            const cleanTitle = this.cleanSongTitle(spotifyTrack.title);
            const cleanArtist = this.cleanArtistName(spotifyTrack.artist);

            if (cleanTitle !== spotifyTrack.title || cleanArtist !== spotifyTrack.artist) {
                results = await this.querySearch(
                    { title: cleanTitle, artist: cleanArtist, duration_ms: spotifyTrack.duration_ms },
                    signal
                );
                if (results.some(r => r.status === 'success')) return results;
            }

            // Stage 3: Combined string
            results = await this.querySearch(
                { title: `${cleanTitle} ${cleanArtist}`.trim() },
                signal
            );
            if (results.some(r => r.status === 'success')) return results;

            // Stage 4: Title only
            if (cleanTitle.length > 2) {
                results = await this.querySearch({ title: cleanTitle }, signal);
            }

            return results;
        },

        querySearch(queryObj, signal) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                const results = [];
                if (!this.api?.search?.query) { resolve([]); return; }

                this.api.search.query(
                    queryObj,
                    (result) => {
                        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                        results.push(result);
                    },
                    () => {
                        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
                        resolve(results);
                    }
                );
            });
        },

        cleanSongTitle(title) {
            if (!title) return '';
            return title
                .replace(/\s*[\(\[\{](?:female|male|duet|slowed|reverb|official|video|lyric|audio|from|feat|ft)[\s\S]*?[\)\]\}]/gi, '')
                .replace(/\s*-\s*(?:female|male|duet|slowed|reverb|from|feat|ft)[\s\S]*$/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
        },

        cleanArtistName(artist) {
            if (!artist) return '';
            return artist.split(/[,&/]|feat\.|ft\./i)[0].trim();
        },

        pickBestResult(results) {
            const SOURCE_PRIORITY = ['qobuz', 'jiosaavn', 'universal', 'tidal'];
            const successes = results.filter(r => r.status === 'success');
            if (successes.length === 0) return null;
            for (const sourceId of SOURCE_PRIORITY) {
                const fromSource = successes.filter(r => r.sourceId === sourceId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                if (fromSource.length > 0) return fromSource[0];
            }
            return successes[0];
        },

        normalizeString(str) {
            if (!str) return '';
            return str.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
        },

        async getLibraryIndex() {
            const map = new Map();
            if (this.api?.library?.getTracks) {
                try {
                    const tracks = await this.api.library.getTracks();
                    if (Array.isArray(tracks)) {
                        tracks.forEach(t => {
                            if (t.source_type && t.external_id) map.set(`${t.source_type}:${t.external_id}`, t.id);
                        });
                    }
                } catch (e) { console.error(e); }
            }
            return map;
        },

        async addTrackToLibrary(result) {
            return await this.api.library.addExternalTrack({
                title: result.title,
                artist: result.artist,
                album: result.album || null,
                duration: result.duration || null,
                cover_url: result.cover_url || null,
                source_type: result.source_type,
                external_id: result.external_id,
                format: result.format || null,
                bitrate: result.bitrate || null,
                track_number: result.track_number || null,
                disc_number: result.disc_number || null,
                musicbrainz_recording_id: result.musicbrainz_recording_id || null,
                metadata_json: result.metadata_json || null,
            });
        },

        // ── Styles ───────────────────────────────────────────────────────────
        injectStyles() {
            if (document.getElementById('spi-styles')) return;
            const s = document.createElement('style');
            s.id = 'spi-styles';
            s.textContent = `
                #spi-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,0.75);
                    backdrop-filter: blur(8px);
                    z-index: 10000; opacity: 0; visibility: hidden;
                    transition: opacity 0.2s;
                }
                #spi-overlay.open { opacity: 1; visibility: visible; }

                #spi-modal {
                    position: fixed; top: 50%; left: 50%;
                    transform: translate(-50%, -50%) scale(0.96);
                    width: 720px; max-width: 96vw; max-height: 90vh;
                    background: #0d0d0d;
                    border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 24px;
                    z-index: 10001;
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    opacity: 0; visibility: hidden;
                    transition: all 0.3s cubic-bezier(0.16,1,0.3,1);
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }
                #spi-modal.open {
                    opacity: 1; visibility: visible;
                    transform: translate(-50%, -50%) scale(1);
                }

                .spi-topbar {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 13px 18px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07);
                    background: #0d0d0d; flex-shrink: 0;
                }
                .spi-topbar-left { display: flex; align-items: center; gap: 10px; }
                .spi-logo { color: #1DB954; display: flex; }
                .spi-title { font-size: 14px; font-weight: 500; color: #fff; letter-spacing: -0.2px; }
                .spi-dot { width: 3px; height: 3px; border-radius: 50%; background: #444; }
                .spi-sub { font-size: 12px; color: #777; }
                .spi-chip {
                    font-size: 10px; font-weight: 500; color: #1DB954;
                    background: rgba(29,185,84,0.10); border: 0.5px solid rgba(29,185,84,0.22);
                    padding: 3px 9px; border-radius: 20px; letter-spacing: 0.3px;
                }
                .spi-icon-btn {
                    width: 30px; height: 30px; border-radius: 50%;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #777; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 14px; transition: background .15s, color .15s;
                }
                .spi-icon-btn:hover { background: #222; color: #fff; }

                .spi-two-col {
                    display: grid; grid-template-columns: 1.15fr 1fr;
                    flex: 1; min-height: 0; overflow: hidden;
                }

                .spi-left {
                    border-right: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; flex-direction: column;
                    padding: 16px; gap: 12px;
                    overflow-y: auto; background: #0d0d0d;
                }
                .spi-left::-webkit-scrollbar { width: 3px; }
                .spi-left::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .spi-plabel {
                    font-size: 10px; font-weight: 500; letter-spacing: 0.7px;
                    text-transform: uppercase; color: #555; margin-bottom: 8px;
                    display: flex; align-items: center; gap: 5px;
                }

                .spi-url-card {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                }
                .spi-field-wrap { position: relative; margin-bottom: 10px; }
                .spi-field {
                    width: 100%; height: 40px;
                    background: #1e1e1e; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #fff; padding: 0 38px 0 12px;
                    border-radius: 10px; font-size: 13px;
                    outline: none; transition: border-color .15s; box-sizing: border-box;
                }
                .spi-field::placeholder { color: #555; }
                .spi-field:focus { border-color: #1DB954; background: #222; }
                .spi-field:disabled { opacity: 0.4; pointer-events: none; }
                .spi-field-x {
                    position: absolute; right: 10px; top: 50%;
                    transform: translateY(-50%);
                    width: 20px; height: 20px; border-radius: 50%;
                    background: #2a2a2a; border: none; color: #aaa;
                    font-size: 11px; cursor: pointer;
                    display: none; align-items: center; justify-content: center;
                }
                .spi-field-x:hover { background: #444; }

                .spi-notice {
                    background: rgba(29,185,84,0.06);
                    border: 0.5px solid rgba(29,185,84,0.18);
                    border-radius: 10px; padding: 10px 12px;
                    font-size: 12px; color: #a0a0a0; line-height: 1.5;
                }
                .spi-notice strong { color: #1DB954; font-weight: 500; }

                .spi-preview {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                    display: none; align-items: center; gap: 12px;
                }
                .spi-prev-art {
                    width: 54px; height: 54px; border-radius: 10px;
                    background: #1e1e1e; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    color: #444; font-size: 20px; overflow: hidden;
                }
                .spi-prev-art img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; }
                .spi-prev-info { flex: 1; overflow: hidden; }
                .spi-prev-name {
                    font-size: 14px; font-weight: 500; color: #fff;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;
                }
                .spi-prev-sub {
                    font-size: 11px; color: #777;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;
                }
                .spi-prev-badge {
                    font-size: 10px; font-weight: 600; padding: 3px 7px; border-radius: 4px;
                    background: rgba(29,185,84,0.12); color: #1DB954; border: 0.5px solid rgba(29,185,84,0.25);
                    white-space: nowrap;
                }

                /* Single Track Destination Card */
                .spi-dest-card {
                    display: none; background: #141414; border: 0.5px solid rgba(29,185,84,0.25);
                    border-radius: 14px; padding: 12px 14px; flex-direction: column; gap: 8px;
                }
                .spi-dest-card.open { display: flex; }
                .spi-dest-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #1DB954; letter-spacing: 0.5px; }
                .spi-radio-row {
                    display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ccc; cursor: pointer;
                }
                .spi-dest-select, .spi-dest-input {
                    margin-left: 20px; width: calc(100% - 20px); height: 32px;
                    background: #1c1c1c; border: 0.5px solid #333; border-radius: 6px;
                    color: #fff; padding: 0 8px; font-size: 12px; box-sizing: border-box;
                }

                .spi-actions { margin-top: auto; display: flex; gap: 8px; padding-top: 8px; }
                .spi-btn-stop {
                    height: 40px; padding: 0 16px; border-radius: 10px;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.11);
                    color: #888; font-size: 13px; font-weight: 500; cursor: pointer;
                    display: flex; align-items: center; gap: 6px; transition: all .15s;
                }
                .spi-btn-stop:hover:not(:disabled) { background: #1e1e1e; color: #fff; }
                .spi-btn-stop:disabled { opacity: 0.3; cursor: not-allowed; }
                .spi-btn-convert {
                    flex: 1; height: 40px; border-radius: 10px;
                    background: #1DB954; border: none; color: #000;
                    font-size: 13px; font-weight: 600; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; gap: 7px;
                    transition: filter .15s, transform .1s; letter-spacing: -0.1px;
                }
                .spi-btn-convert:hover:not(:disabled) { filter: brightness(1.10); }
                .spi-btn-convert:active:not(:disabled) { transform: scale(0.98); }
                .spi-btn-convert:disabled { opacity: 0.4; cursor: not-allowed; }

                /* Right panel */
                .spi-right {
                    display: flex; flex-direction: column; background: #0d0d0d; overflow: hidden;
                }
                .spi-right-hdr {
                    padding: 14px 16px 10px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07); flex-shrink: 0;
                }
                .spi-prog-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
                .spi-prog-track {
                    flex: 1; height: 3px; background: rgba(255,255,255,0.07);
                    border-radius: 2px; overflow: hidden;
                }
                .spi-prog-fill {
                    height: 100%; width: 0%; background: #1DB954;
                    border-radius: 2px; transition: width .25s ease;
                }
                .spi-prog-pct {
                    font-size: 11px; color: #666; min-width: 32px;
                    text-align: right; font-variant-numeric: tabular-nums;
                }

                .spi-stats {
                    display: grid; grid-template-columns: repeat(3, 1fr);
                    gap: 8px; padding: 12px 16px 0; flex-shrink: 0;
                }
                .spi-stat {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.07);
                    border-radius: 10px; padding: 10px 12px; text-align: center;
                }
                .spi-stat-val {
                    font-size: 20px; font-weight: 500; line-height: 1;
                    color: #fff; font-variant-numeric: tabular-nums;
                }
                .spi-stat-val.green { color: #1DB954; }
                .spi-stat-val.amber { color: #f59e0b; }
                .spi-stat-val.red { color: #e85555; }
                .spi-stat-lbl {
                    font-size: 10px; color: #555; margin-top: 4px;
                    text-transform: uppercase; letter-spacing: 0.5px;
                }

                .spi-log-wrap {
                    flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 0;
                }
                .spi-log-wrap::-webkit-scrollbar { width: 3px; }
                .spi-log-wrap::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .spi-log-line {
                    display: flex; align-items: baseline; gap: 7px;
                    padding: 2px 0; font-size: 11.5px; line-height: 1.6;
                    font-family: 'Courier New', monospace;
                }
                .spi-log-arrow { color: #444; flex-shrink: 0; font-size: 10px; }
                .spi-log-msg { color: #777; }
                .spi-log-line.success .spi-log-msg { color: #1DB954; }
                .spi-log-line.error   .spi-log-msg { color: #e85555; }
                .spi-log-line.warn    .spi-log-msg { color: #f59e0b; }
                .spi-log-line.info    .spi-log-msg { color: #bbb; }
                .spi-log-line.divider .spi-log-msg { color: #2a2a2a; letter-spacing: 1px; }

                .spi-status-bar {
                    padding: 10px 16px 14px;
                    border-top: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
                }
                .spi-status-dot {
                    width: 6px; height: 6px; border-radius: 50%;
                    background: #333; flex-shrink: 0; transition: background .3s;
                }
                .spi-status-dot.active { background: #1DB954; animation: spi-pulse 1s infinite; }
                .spi-status-dot.done   { background: #1DB954; }
                .spi-status-dot.err    { background: #e85555; }
                @keyframes spi-pulse {
                    0%, 100% { opacity: 1; } 50% { opacity: 0.4; }
                }
                .spi-status-txt { font-size: 11px; color: #555; flex: 1; }
            `;
            document.head.appendChild(s);
        },

        // ── Modal Creation ───────────────────────────────────────────────────
        createModal() {
            const overlay = document.createElement('div');
            overlay.id = 'spi-overlay';
            overlay.onclick = () => { if (!this.isConverting) this.close(); };
            document.body.appendChild(overlay);

            const modal = document.createElement('div');
            modal.id = 'spi-modal';
            modal.innerHTML = `
                <div class="spi-topbar">
                    <div class="spi-topbar-left">
                        <span class="spi-logo" aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/></svg>
                        </span>
                        <span class="spi-title">Spotify to Audion</span>
                        <span class="spi-dot" aria-hidden="true"></span>
                        <span class="spi-sub">Universal Importer</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="spi-chip">v2.0</span>
                        <button class="spi-icon-btn" id="spi-close" aria-label="Close">✕</button>
                    </div>
                </div>

                <div class="spi-two-col">
                    <div class="spi-left">
                        <div>
                            <div class="spi-plabel">Spotify URL</div>
                            <div class="spi-url-card">
                                <div class="spi-field-wrap">
                                    <input type="text" id="spi-url" class="spi-field"
                                        placeholder="Paste playlist, album, or song URL…" autocomplete="off">
                                    <button class="spi-field-x" id="spi-field-x" aria-label="Clear">✕</button>
                                </div>
                            </div>
                        </div>

                        <div class="spi-notice">
                            Paste any Spotify link:<br>
                            <strong>🎵 Single song</strong> — choose where to save it<br>
                            <strong>💿 Album</strong> — imports all tracks as a playlist<br>
                            <strong>📋 Playlist</strong> — full import, no 500-song limit
                        </div>

                        <!-- Preview Card -->
                        <div class="spi-preview" id="spi-preview">
                            <div class="spi-prev-art" id="spi-prev-art"></div>
                            <div class="spi-prev-info">
                                <div class="spi-prev-name" id="spi-prev-name">—</div>
                                <div class="spi-prev-sub" id="spi-prev-sub"></div>
                                <div class="spi-prev-sub" id="spi-prev-count" style="color:#555"></div>
                            </div>
                            <div class="spi-prev-badge" id="spi-prev-badge">TRACK</div>
                        </div>

                        <!-- Single Track Destination Selector (only shown for tracks) -->
                        <div class="spi-dest-card" id="spi-dest-card">
                            <div class="spi-dest-title">Where to save this song?</div>
                            <label class="spi-radio-row">
                                <input type="radio" name="spi-dest" value="library" checked>
                                <span>Save to Main Library</span>
                            </label>
                            <label class="spi-radio-row">
                                <input type="radio" name="spi-dest" value="existing_playlist">
                                <span>Add to existing playlist:</span>
                            </label>
                            <select id="spi-dest-select" class="spi-dest-select"></select>
                            <label class="spi-radio-row">
                                <input type="radio" name="spi-dest" value="new_playlist">
                                <span>Create new playlist:</span>
                            </label>
                            <input type="text" id="spi-dest-new-name" class="spi-dest-input" placeholder="Playlist name…">
                        </div>

                        <div class="spi-actions">
                            <button class="spi-btn-stop" id="spi-stop" disabled>Stop</button>
                            <button class="spi-btn-convert" id="spi-convert" disabled>Paste a URL first</button>
                        </div>
                    </div>

                    <div class="spi-right">
                        <div class="spi-right-hdr">
                            <div class="spi-plabel" style="margin-bottom:0">Activity log</div>
                            <div class="spi-prog-row">
                                <div class="spi-prog-track">
                                    <div class="spi-prog-fill" id="spi-prog-fill"></div>
                                </div>
                                <span class="spi-prog-pct" id="spi-prog-pct">0%</span>
                            </div>
                        </div>

                        <div class="spi-stats">
                            <div class="spi-stat">
                                <div class="spi-stat-val green" id="spi-stat-new">—</div>
                                <div class="spi-stat-lbl">Added</div>
                            </div>
                            <div class="spi-stat">
                                <div class="spi-stat-val amber" id="spi-stat-lib">—</div>
                                <div class="spi-stat-lbl">Library</div>
                            </div>
                            <div class="spi-stat">
                                <div class="spi-stat-val red" id="spi-stat-miss">—</div>
                                <div class="spi-stat-lbl">Not found</div>
                            </div>
                        </div>

                        <div class="spi-log-wrap" id="spi-log">
                            <div class="spi-log-line info">
                                <span class="spi-log-arrow">›</span>
                                <span class="spi-log-msg">Ready. Paste a Spotify playlist, album, or track URL.</span>
                            </div>
                        </div>

                        <div class="spi-status-bar">
                            <div class="spi-status-dot" id="spi-status-dot"></div>
                            <span class="spi-status-txt" id="spi-status-txt">Idle</span>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelector('#spi-close').onclick = () => this.close();
            modal.querySelector('#spi-convert').onclick = () => this.startImportProcess();
            modal.querySelector('#spi-stop').onclick = () => this.stopConversionProcess();

            // Clear button
            modal.querySelector('#spi-field-x').addEventListener('click', () => {
                this.resetInput();
            });

            // Auto-detect on paste
            const urlInput = modal.querySelector('#spi-url');
            urlInput.addEventListener('input', () => {
                const v = urlInput.value.trim();
                modal.querySelector('#spi-field-x').style.display = v ? 'flex' : 'none';
                if (v.includes('spotify.com/') || v.startsWith('spotify:')) {
                    this.onUrlEntered(v);
                }
            });
            urlInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const v = urlInput.value.trim();
                    if (v) this.onUrlEntered(v);
                }
            });
        },

        createMenuButton() {
            const btn = document.createElement('button');
            btn.className = 'plugin-menu-btn';
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/>
                </svg>
                <span>Spotify Importer</span>
            `;
            btn.onclick = () => this.open();
            this.api.ui.registerSlot('playerbar:menu', btn);
        },

        resetInput() {
            const modal = document.getElementById('spi-modal');
            if (!modal) return;
            modal.querySelector('#spi-url').value = '';
            modal.querySelector('#spi-field-x').style.display = 'none';
            modal.querySelector('#spi-preview').style.display = 'none';
            modal.querySelector('#spi-dest-card').classList.remove('open');
            modal.querySelector('#spi-convert').disabled = true;
            modal.querySelector('#spi-convert').textContent = 'Paste a URL first';
            this.singleTrackData = null;
            this.importedPlaylistData = null;
            this.detectedType = null;
            modal.querySelector('#spi-url').focus();
        },

        async open() {
            this.isOpen = true;
            document.getElementById('spi-overlay')?.classList.add('open');
            document.getElementById('spi-modal')?.classList.add('open');
            try {
                this.cachedPlaylists = (await this.api.library.getPlaylists()) || [];
            } catch (e) {
                this.cachedPlaylists = [];
            }
        },

        close() {
            if (this.isConverting) return;
            this.isOpen = false;
            document.getElementById('spi-overlay')?.classList.remove('open');
            document.getElementById('spi-modal')?.classList.remove('open');
        },

        // ── URL Detection & Preview ──────────────────────────────────────────
        async onUrlEntered(rawUrl) {
            const str = rawUrl.trim();
            const trackMatch = str.match(/(?:track\/|track:)([a-zA-Z0-9]+)/);
            const playlistMatch = str.match(/(?:playlist\/|playlist:)([a-zA-Z0-9]+)/);
            const albumMatch = str.match(/(?:album\/|album:)([a-zA-Z0-9]+)/);

            if (trackMatch) {
                this.detectedType = 'track';
                document.getElementById('spi-dest-card')?.classList.remove('open');
                document.getElementById('spi-convert').disabled = true;
                document.getElementById('spi-convert').textContent = 'Loading…';
                await this.fetchAndPreviewSingleTrack(trackMatch[1]);
            } else if (playlistMatch) {
                this.detectedType = 'playlist';
                document.getElementById('spi-dest-card')?.classList.remove('open');
                document.getElementById('spi-convert').disabled = true;
                document.getElementById('spi-convert').textContent = 'Loading…';
                await this.fetchAndPreviewPlaylist(playlistMatch[1]);
            } else if (albumMatch) {
                this.detectedType = 'album';
                document.getElementById('spi-dest-card')?.classList.remove('open');
                document.getElementById('spi-convert').disabled = true;
                document.getElementById('spi-convert').textContent = 'Loading…';
                await this.fetchAndPreviewAlbum(albumMatch[1]);
            }
        },

        // ── SINGLE TRACK ────────────────────────────────────────────────────
        async fetchAndPreviewSingleTrack(trackId) {
            this.log(`Fetching track (ID: ${trackId})…`, 'info');
            this.setStatus('Loading track…', 'active');

            try {
                let track = null;

                // Primary: parse Spotify embed page __NEXT_DATA__ (gives full artist info)
                try {
                    const { entity } = await this.fetchEmbedData('track', trackId);
                    if (entity && entity.name) {
                        const artists = (entity.artists || []).map(a => a.name).filter(Boolean);
                        track = {
                            title: entity.title || entity.name,
                            artist: artists.join(', ') || 'Unknown Artist',
                            album: entity.albumOfTrack?.name || '',
                            duration_ms: entity.duration || 180000,
                            cover_url: entity.visualIdentity?.image?.[0]?.url || null,
                            isrc: null
                        };
                        this.log(`Found: "${track.title}" by ${track.artist}`, 'success');
                    }
                } catch (e) {
                    this.log(`Embed parse failed, trying oEmbed…`, 'warn');
                    console.warn('[SpotifyImporter] Embed track error:', e);
                }

                // Fallback: oEmbed (title + thumbnail, no artist)
                if (!track) {
                    try {
                        const oembed = await this.fetchOEmbed('track', trackId);
                        track = {
                            title: oembed.title || 'Unknown Track',
                            artist: '',
                            album: '',
                            duration_ms: 180000,
                            cover_url: oembed.thumbnail_url || null,
                            isrc: null
                        };
                        this.log(`oEmbed: "${track.title}" (artist unknown, will search by title)`, 'warn');
                    } catch (e2) {
                        console.error('[SpotifyImporter] oEmbed track error:', e2);
                    }
                }

                if (!track) throw new Error('Could not fetch any track data from Spotify.');

                this.singleTrackData = track;

                // Show preview
                this.showPreview({
                    name: track.title,
                    sub: track.artist || 'Unknown Artist',
                    count: 'Single Track',
                    badge: 'TRACK',
                    image: track.cover_url
                });

                // Populate destination card
                const selectEl = document.getElementById('spi-dest-select');
                if (selectEl) {
                    selectEl.innerHTML = '';
                    if (this.cachedPlaylists.length === 0) {
                        selectEl.innerHTML = '<option value="">(No existing playlists)</option>';
                    } else {
                        this.cachedPlaylists.forEach(pl => {
                            const opt = document.createElement('option');
                            opt.value = pl.id;
                            opt.textContent = pl.name || pl.title || `Playlist #${pl.id}`;
                            selectEl.appendChild(opt);
                        });
                    }
                }
                document.getElementById('spi-dest-card').classList.add('open');
                document.getElementById('spi-convert').disabled = false;
                document.getElementById('spi-convert').textContent = 'Save track →';
                this.setStatus('Ready', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed to load track', 'err');
                document.getElementById('spi-convert').textContent = 'Paste a URL first';
            }
        },

        async saveSingleTrack() {
            const track = this.singleTrackData;
            if (!track) return;

            const convertBtn = document.getElementById('spi-convert');
            convertBtn.disabled = true;
            convertBtn.textContent = 'Searching…';
            this.setStatus('Searching audio stream…', 'active');
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
            this.log(`Searching: "${track.title}"${track.artist ? ' — ' + track.artist : ''}`, 'info');

            try {
                const results = await this.searchAllSources(track, null);
                const best = this.pickBestResult(results);

                if (!best) {
                    this.log(`No audio source found for "${track.title}".`, 'error');
                    this.updateStats(0, 0, 1);
                    this.setStatus('Not found', 'err');
                    convertBtn.disabled = false;
                    convertBtn.textContent = 'Save track →';
                    return;
                }

                if (!best.cover_url && track.cover_url) best.cover_url = track.cover_url;

                const libraryId = await this.addTrackToLibrary(best);
                this.log(`Added: "${best.title}" via ${best.source_type}`, 'success');

                const destVal = document.querySelector('input[name="spi-dest"]:checked')?.value || 'library';
                if (destVal === 'existing_playlist') {
                    const plId = document.getElementById('spi-dest-select')?.value;
                    if (plId) {
                        await this.api.library.addTrackToPlaylist(plId, libraryId);
                        this.log(`Added to playlist!`, 'success');
                    }
                } else if (destVal === 'new_playlist') {
                    const newName = document.getElementById('spi-dest-new-name')?.value?.trim() || `${track.title} Mix`;
                    const newPlId = await this.api.library.createPlaylist(newName, track.cover_url);
                    await this.api.library.addTrackToPlaylist(newPlId, libraryId);
                    this.log(`Created playlist "${newName}" and added track!`, 'success');
                } else {
                    this.log('Saved to Main Library.', 'success');
                }

                this.updateStats(1, 0, 0);
                this.updateProgress(100);
                this.setStatus('Saved!', 'done');
                convertBtn.textContent = '✓ Saved';
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
                convertBtn.disabled = false;
                convertBtn.textContent = 'Save track →';
            }
        },

        // ── ALBUM ────────────────────────────────────────────────────────────
        async fetchAndPreviewAlbum(albumId) {
            this.log(`Fetching album (ID: ${albumId})…`, 'info');
            this.setStatus('Loading album…', 'active');

            try {
                let albumData = null;

                // Primary: Spotify embed page __NEXT_DATA__
                try {
                    const { entity } = await this.fetchEmbedData('album', albumId);
                    if (entity && entity.name) {
                        // Album artist comes from entity.subtitle
                        const albumArtist = entity.subtitle || 'Unknown Artist';
                        const coverUrl = entity.visualIdentity?.image?.[0]?.url || null;

                        const tracks = (entity.trackList || []).map(t => {
                            // Individual track artists may be in t.artists array
                            const trackArtists = (t.artists || []).map(a => a.name).filter(Boolean);
                            return {
                                title: t.title || t.name || 'Unknown',
                                // Use track-level artists if present, otherwise fall back to album artist
                                artist: trackArtists.length > 0 ? trackArtists.join(', ') : albumArtist,
                                album: entity.name,
                                duration_ms: t.duration || 0,
                                cover_url: coverUrl,
                                isrc: null
                            };
                        });

                        albumData = {
                            title: entity.name,
                            image: coverUrl,
                            owner: albumArtist,
                            total: tracks.length,
                            tracks: tracks
                        };
                        this.log(`Album: "${albumData.title}" by ${albumArtist} — ${tracks.length} tracks`, 'success');
                    }
                } catch (e) {
                    this.log(`Embed parse failed: ${e.message}`, 'warn');
                    console.warn('[SpotifyImporter] Album embed error:', e);
                }

                // Fallback: oEmbed gives at least name + cover (no track list)
                if (!albumData) {
                    try {
                        const oembed = await this.fetchOEmbed('album', albumId);
                        albumData = {
                            title: oembed.title || 'Unknown Album',
                            image: oembed.thumbnail_url || null,
                            owner: null,
                            total: 0,
                            tracks: []
                        };
                        this.log(`oEmbed fallback: "${albumData.title}" — track list unavailable`, 'warn');
                    } catch (e2) {
                        console.error('[SpotifyImporter] Album oEmbed error:', e2);
                    }
                }

                if (!albumData) throw new Error('Could not fetch album data.');
                if (albumData.tracks.length === 0) {
                    this.log('Could not retrieve track list for this album.', 'error');
                    this.setStatus('Album load failed', 'err');
                    document.getElementById('spi-convert').textContent = 'Paste a URL first';
                    return;
                }

                this.importedPlaylistData = albumData;
                this.showPreview({
                    name: albumData.title,
                    sub: albumData.owner || '',
                    count: `${albumData.total} tracks`,
                    badge: 'ALBUM',
                    image: albumData.image
                });
                document.getElementById('spi-convert').disabled = false;
                document.getElementById('spi-convert').textContent = 'Import album →';
                this.setStatus('Ready to import', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Album error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
                document.getElementById('spi-convert').textContent = 'Paste a URL first';
            }
        },

        // ── PLAYLIST ─────────────────────────────────────────────────────────
        async fetchAndPreviewPlaylist(playlistId) {
            this.log(`Fetching playlist (ID: ${playlistId})…`, 'info');
            this.setStatus('Loading playlist…', 'active');

            try {
                let playlistData = null;
                let token = null;

                // Try to get a live session token from embed page (enables unlimited pagination)
                try {
                    const { entity, token: t } = await this.fetchEmbedData('playlist', playlistId);
                    token = t;
                    if (entity && entity.name) {
                        this.log(`Loaded playlist info: "${entity.name}"`, 'info');
                    }
                } catch (e) {
                    console.warn('[SpotifyImporter] Playlist embed error:', e);
                }

                // If we have a token, use official Spotify API (no limit!)
                if (token) {
                    this.log('Session token found — using unlimited pagination…', 'info');
                    try {
                        const metaRes = await this.api.fetch(
                            `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description,images,owner,tracks.total`,
                            { headers: { 'Authorization': `Bearer ${token}` } }
                        );
                        if (metaRes.ok) {
                            const meta = await metaRes.json();
                            const total = meta.tracks?.total || 0;
                            let allTracks = [];
                            let offset = 0;
                            const limit = 100;

                            while (offset < total) {
                                const pageRes = await this.api.fetch(
                                    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=items(track(name,artists(name),album(name,images),duration_ms,external_ids))`,
                                    { headers: { 'Authorization': `Bearer ${token}` } }
                                );
                                if (!pageRes.ok) break;
                                const pageJson = await pageRes.json();
                                const items = pageJson.items || [];
                                if (items.length === 0) break;

                                for (const item of items) {
                                    const t = item.track;
                                    if (!t || !t.name) continue;
                                    allTracks.push({
                                        title: t.name,
                                        artist: (t.artists || []).map(a => a.name).join(', ') || 'Unknown',
                                        album: t.album?.name || '',
                                        duration_ms: t.duration_ms || 0,
                                        cover_url: t.album?.images?.[0]?.url || null,
                                        isrc: t.external_ids?.isrc || null
                                    });
                                }

                                offset += limit;
                                this.log(`Loaded ${allTracks.length}/${total} tracks…`, 'info');
                            }

                            playlistData = {
                                title: meta.name || 'Spotify Import',
                                image: meta.images?.[0]?.url || null,
                                owner: meta.owner?.display_name || null,
                                total: allTracks.length,
                                tracks: allTracks
                            };
                        }
                    } catch (e) {
                        console.warn('[SpotifyImporter] Spotify API pagination error:', e);
                    }
                }

                // Fallback: public proxy (may cap at 499)
                if (!playlistData) {
                    playlistData = await this.fetchPlaylistFromPublicAPI(playlistId);
                }

                this.importedPlaylistData = playlistData;
                this.showPreview({
                    name: playlistData.title,
                    sub: playlistData.owner || '',
                    count: `${playlistData.tracks.length} tracks`,
                    badge: 'PLAYLIST',
                    image: playlistData.image
                });
                document.getElementById('spi-convert').disabled = false;
                document.getElementById('spi-convert').textContent = 'Import playlist →';
                this.setStatus('Ready to import', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
                document.getElementById('spi-convert').textContent = 'Paste a URL first';
            }
        },

        async fetchPlaylistFromPublicAPI(playlistId) {
            this.log('Using public proxy (may have 499-track limit)…', 'warn');
            const limit = 100;
            let offset = 0, allTracks = [], playlistMeta = null, total = 0, page = 1;

            while (true) {
                const url = `${this.PLAYLIST_API}/${playlistId}?limit=${limit}&offset=${offset}`;
                const response = await this.api.fetch(url);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const json = await response.json();
                if (!json.success || !json.data) throw new Error('Invalid API response');
                const data = json.data;

                if (!playlistMeta) {
                    playlistMeta = {
                        title: data.name || 'Spotify Import',
                        image: data.image || null,
                        owner: data.owner || null
                    };
                    total = data.total || 0;
                }

                const pageTracks = (data.tracks || []).map(t => ({
                    title: t.name,
                    artist: Array.isArray(t.artists) ? t.artists.join(', ') : (t.artist || 'Unknown'),
                    album: t.album,
                    duration_ms: t.duration_ms,
                    cover_url: t.image || null,
                    isrc: null
                }));

                allTracks = allTracks.concat(pageTracks);
                this.log(`Page ${page}: ${pageTracks.length} tracks (${allTracks.length}/${total})`, 'info');

                if (!data.next || pageTracks.length === 0 || allTracks.length >= total) break;
                offset += limit;
                page++;
            }

            return { ...playlistMeta, total: allTracks.length, tracks: allTracks };
        },

        // ── Preview helper ───────────────────────────────────────────────────
        showPreview({ name, sub, count, badge, image }) {
            const art = document.getElementById('spi-prev-art');
            if (image) {
                art.innerHTML = `<img src="${image}" alt="">`;
            } else {
                const icons = { TRACK: '🎵', ALBUM: '💿', PLAYLIST: '📋' };
                art.innerHTML = `<span style="font-size:22px">${icons[badge] || '🎵'}</span>`;
            }
            document.getElementById('spi-prev-name').textContent = name || '—';
            document.getElementById('spi-prev-sub').textContent = sub || '';
            document.getElementById('spi-prev-count').textContent = count || '';
            document.getElementById('spi-prev-badge').textContent = badge || 'TRACK';
            document.getElementById('spi-preview').style.display = 'flex';
        },

        // ── Conversion Execution ─────────────────────────────────────────────
        async startImportProcess() {
            if (this.detectedType === 'track') {
                return this.saveSingleTrack();
            }
            // Playlist or Album
            await this.runPlaylistImport();
        },

        async runPlaylistImport() {
            const convertBtn = document.getElementById('spi-convert');
            const stopBtn = document.getElementById('spi-stop');
            const urlEl = document.getElementById('spi-url');

            const playlistData = this.importedPlaylistData;
            if (!playlistData || playlistData.tracks.length === 0) {
                this.log('No tracks to import.', 'error');
                return;
            }

            this.isConverting = true;
            this.stopConversion = false;
            this.abortController = new AbortController();
            convertBtn.disabled = true;
            stopBtn.disabled = false;
            urlEl.disabled = true;
            this.updateProgress(0);
            this.updateStats('—', '—', '—');
            this.setStatus('Importing…', 'active');

            document.getElementById('spi-log').innerHTML = '';
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
            this.log(`Importing: ${playlistData.title}`, 'info');
            this.log(`${playlistData.tracks.length} tracks to process`, 'info');
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');

            try {
                const existingTracks = await this.getLibraryIndex();
                this.log(`${existingTracks.size} tracks already in library`, 'info');

                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title, playlistData.image);
                this.log('Playlist created in Audion ✓', 'success');

                const total = playlistData.tracks.length;
                let processed = 0, successes = 0, fromLibrary = 0, notFound = 0;
                const concurrency = 5;
                const queue = playlistData.tracks.map((track, idx) => ({ track, idx }));
                const inFlight = new Map();

                const searchWorker = async () => {
                    while (queue.length > 0 && !this.stopConversion) {
                        const item = queue.shift();
                        if (!item) break;
                        const { track } = item;
                        const key = `${this.normalizeString(track.title)}|${this.normalizeString(track.artist)}`;

                        let trackId = null;
                        if (this.trackCache.has(key)) {
                            trackId = this.trackCache.get(key);
                            fromLibrary++;
                        } else if (inFlight.has(key)) {
                            try {
                                trackId = await inFlight.get(key);
                                if (trackId) successes++; else notFound++;
                            } catch (e) { notFound++; }
                        } else {
                            const searchPromise = (async () => {
                                try {
                                    const allResults = await this.searchAllSources(track, this.abortController.signal);
                                    const best = this.pickBestResult(allResults);
                                    if (best) {
                                        if (!best.cover_url && track.cover_url) best.cover_url = track.cover_url;
                                        const libraryKey = `${best.source_type}:${best.external_id}`;
                                        let resolvedId;
                                        if (existingTracks.has(libraryKey)) {
                                            resolvedId = existingTracks.get(libraryKey);
                                        } else {
                                            resolvedId = await this.addTrackToLibrary(best);
                                            existingTracks.set(libraryKey, resolvedId);
                                        }
                                        this.trackCache.set(key, resolvedId);
                                        return resolvedId;
                                    }
                                    return null;
                                } catch (err) {
                                    if (err.name === 'AbortError') throw err;
                                    return null;
                                }
                            })();

                            inFlight.set(key, searchPromise);
                            try {
                                trackId = await searchPromise;
                                if (trackId) successes++; else notFound++;
                            } catch (err) {
                                if (err.name === 'AbortError') break;
                                notFound++;
                            } finally {
                                inFlight.delete(key);
                            }
                        }

                        if (trackId && audionPlaylistId) {
                            try {
                                await this.api.library.addTrackToPlaylist(audionPlaylistId, trackId);
                            } catch (e) { }
                        }

                        processed++;
                        this.updateProgress((processed / total) * 100);
                        this.updateStats(successes, fromLibrary, notFound);
                        if (trackId) {
                            this.log(`✓ ${track.title}`, 'success');
                        } else {
                            this.log(`✗ ${track.title}`, 'error');
                        }
                    }
                };

                const workers = Array.from({ length: concurrency }, () => searchWorker());
                await Promise.all(workers);

                if (this.stopConversion) {
                    this.log('Stopped by user.', 'warn');
                    this.setStatus('Stopped', 'idle');
                } else {
                    this.log(`━━━━━━━━━━━━━━━━━━━━━━━`, 'divider');
                    this.log(`Done! ${successes + fromLibrary}/${total} tracks imported to "${playlistData.title}".`, 'success');
                    this.setStatus('Done!', 'done');
                }
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            } finally {
                this.isConverting = false;
                convertBtn.disabled = false;
                convertBtn.textContent = 'Import again';
                stopBtn.disabled = true;
                urlEl.disabled = false;
            }
        },

        stopConversionProcess() {
            this.stopConversion = true;
            if (this.abortController) this.abortController.abort();
        },

        // ── Log & Stats ──────────────────────────────────────────────────────
        log(msg, type = 'info') {
            const log = document.getElementById('spi-log');
            if (!log) return;
            const line = document.createElement('div');
            line.className = `spi-log-line ${type}`;
            line.innerHTML = `<span class="spi-log-arrow">›</span><span class="spi-log-msg">${msg}</span>`;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
        },

        updateProgress(percent) {
            const p = Math.round(percent);
            const fill = document.getElementById('spi-prog-fill');
            const pct = document.getElementById('spi-prog-pct');
            if (fill) fill.style.width = `${p}%`;
            if (pct) pct.textContent = `${p}%`;
        },

        updateStats(n, l, m) {
            const sN = document.getElementById('spi-stat-new');
            const sL = document.getElementById('spi-stat-lib');
            const sM = document.getElementById('spi-stat-miss');
            if (sN) sN.textContent = n;
            if (sL) sL.textContent = l;
            if (sM) sM.textContent = m;
        },

        setStatus(text, state = 'idle') {
            const txt = document.getElementById('spi-status-txt');
            const dot = document.getElementById('spi-status-dot');
            if (txt) txt.textContent = text;
            if (dot) {
                dot.className = 'spi-status-dot';
                if (state !== 'idle') dot.classList.add(state);
            }
        }
    };

    if (typeof window !== 'undefined' && window.Audion && typeof window.Audion.register === 'function') {
        window.Audion.register(SpotifyImporter);
    } else if (typeof Audion !== 'undefined' && typeof Audion.register === 'function') {
        Audion.register(SpotifyImporter);
    } else {
        window.SpotifyUniversalImporter = SpotifyImporter;
    }
})();
