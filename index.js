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

        NEW_SPOTIFY_API_BASE: 'https://spotify-api-henna.vercel.app/api/playlist',
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

        // ── Smart Multi-Stage Source Search ─────────────────────────────────
        async searchAllSources(spotifyTrack, signal) {
            // Stage 1: Exact search
            let results = await this.querySearch(
                { title: spotifyTrack.title, artist: spotifyTrack.artist, isrc: spotifyTrack.isrc, duration_ms: spotifyTrack.duration_ms },
                signal
            );
            if (results.some(r => r.status === 'success')) return results;

            // Stage 2: Clean title & artist (remove "(Female Version)", "[Official]", "- From...", featured artists)
            const cleanTitle = this.cleanSongTitle(spotifyTrack.title);
            const cleanArtist = this.cleanArtistName(spotifyTrack.artist);

            if (cleanTitle !== spotifyTrack.title || cleanArtist !== spotifyTrack.artist) {
                results = await this.querySearch(
                    { title: cleanTitle, artist: cleanArtist, duration_ms: spotifyTrack.duration_ms },
                    signal
                );
                if (results.some(r => r.status === 'success')) return results;
            }

            // Stage 3: Combined string search query
            results = await this.querySearch(
                { title: `${cleanTitle} ${cleanArtist}`.trim() },
                signal
            );
            if (results.some(r => r.status === 'success')) return results;

            // Stage 4: Title only search
            if (cleanTitle.length > 2) {
                results = await this.querySearch(
                    { title: cleanTitle },
                    signal
                );
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
            // If multiple artists, take the primary one for search
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

        // ── Styles (Matching Spotify Converter) ─────────────────────────────
        injectStyles() {
            if (document.getElementById('sc2-styles')) return;
            const s = document.createElement('style');
            s.id = 'sc2-styles';
            s.textContent = `
                #sc2-overlay {
                    position: fixed; inset: 0;
                    background: rgba(0,0,0,0.75);
                    backdrop-filter: blur(8px);
                    z-index: 10000; opacity: 0; visibility: hidden;
                    transition: opacity 0.2s;
                }
                #sc2-overlay.open { opacity: 1; visibility: visible; }

                #sc2-modal {
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
                #sc2-modal.open {
                    opacity: 1; visibility: visible;
                    transform: translate(-50%, -50%) scale(1);
                }

                .sc2-topbar {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 13px 18px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07);
                    background: #0d0d0d; flex-shrink: 0;
                }
                .sc2-topbar-left { display: flex; align-items: center; gap: 10px; }
                .sc2-logo { color: #1DB954; display: flex; }
                .sc2-title { font-size: 14px; font-weight: 500; color: #fff; letter-spacing: -0.2px; }
                .sc2-dot { width: 3px; height: 3px; border-radius: 50%; background: #444; }
                .sc2-sub { font-size: 12px; color: #777; }
                .sc2-chip {
                    font-size: 10px; font-weight: 500; color: #1DB954;
                    background: rgba(29,185,84,0.10); border: 0.5px solid rgba(29,185,84,0.22);
                    padding: 3px 9px; border-radius: 20px; letter-spacing: 0.3px;
                }
                .sc2-icon-btn {
                    width: 30px; height: 30px; border-radius: 50%;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #777; cursor: pointer;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 14px; transition: background .15s, color .15s;
                }
                .sc2-icon-btn:hover { background: #222; color: #fff; }

                .sc2-two-col {
                    display: grid; grid-template-columns: 1.15fr 1fr;
                    flex: 1; min-height: 0; overflow: hidden;
                }

                /* Left panel */
                .sc2-left {
                    border-right: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; flex-direction: column;
                    padding: 16px; gap: 12px;
                    overflow-y: auto; background: #0d0d0d;
                }
                .sc2-left::-webkit-scrollbar { width: 3px; }
                .sc2-left::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .sc2-plabel {
                    font-size: 10px; font-weight: 500; letter-spacing: 0.7px;
                    text-transform: uppercase; color: #555; margin-bottom: 8px;
                    display: flex; align-items: center; gap: 5px;
                }

                .sc2-url-card {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                }
                .sc2-field-wrap { position: relative; margin-bottom: 10px; }
                .sc2-field {
                    width: 100%; height: 40px;
                    background: #1e1e1e; border: 0.5px solid rgba(255,255,255,0.10);
                    color: #fff; padding: 0 38px 0 12px;
                    border-radius: 10px; font-size: 13px;
                    outline: none; transition: border-color .15s; box-sizing: border-box;
                }
                .sc2-field::placeholder { color: #555; }
                .sc2-field:focus { border-color: #1DB954; background: #222; }
                .sc2-field:disabled { opacity: 0.4; pointer-events: none; }
                .sc2-field-x {
                    position: absolute; right: 10px; top: 50%;
                    transform: translateY(-50%);
                    width: 20px; height: 20px; border-radius: 50%;
                    background: #2a2a2a; border: none; color: #aaa;
                    font-size: 11px; cursor: pointer;
                    display: none; align-items: center; justify-content: center;
                }
                .sc2-field-x:hover { background: #444; }

                .sc2-sep { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
                .sc2-sep-line { flex: 1; height: 0.5px; background: rgba(255,255,255,0.06); }
                .sc2-sep-text { font-size: 11px; color: #444; }

                .sc2-json-btn {
                    width: 100%; height: 38px;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.11);
                    border-radius: 10px; color: #999; font-size: 13px; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; gap: 8px;
                    transition: border-color .15s, color .15s, background .15s;
                    box-sizing: border-box;
                }
                .sc2-json-btn:hover { border-color: rgba(29,185,84,0.45); color: #fff; background: rgba(29,185,84,0.08); }

                .sc2-file-pill {
                    display: none; align-items: center; gap: 8px;
                    background: rgba(29,185,84,0.09);
                    border: 0.5px solid rgba(29,185,84,0.22);
                    border-radius: 8px; padding: 8px 10px; margin-top: 8px;
                }
                .sc2-pill-text { font-size: 12px; color: #1DB954; flex: 1; }
                .sc2-pill-remove {
                    background: transparent; border: none;
                    color: rgba(29,185,84,0.5); cursor: pointer;
                    font-size: 14px; padding: 2px;
                }
                .sc2-pill-remove:hover { color: #e85555; }

                .sc2-notice {
                    background: rgba(29,185,84,0.06);
                    border: 0.5px solid rgba(29,185,84,0.18);
                    border-radius: 10px; padding: 10px 12px;
                    font-size: 12px; color: #a0a0a0; line-height: 1.5;
                }
                .sc2-notice strong { color: #1DB954; font-weight: 500; }

                .sc2-preview {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.08);
                    border-radius: 14px; padding: 13px;
                    display: none; align-items: center; gap: 12px;
                }
                .sc2-prev-art {
                    width: 54px; height: 54px; border-radius: 10px;
                    background: #1e1e1e; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    color: #444; font-size: 20px; overflow: hidden;
                }
                .sc2-prev-art img { width: 100%; height: 100%; object-fit: cover; border-radius: 9px; }
                .sc2-prev-info { flex: 1; overflow: hidden; }
                .sc2-prev-name {
                    font-size: 14px; font-weight: 500; color: #fff;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;
                }
                .sc2-prev-owner, .sc2-prev-count {
                    font-size: 11px; color: #777;
                    display: flex; align-items: center; gap: 4px; margin-bottom: 2px;
                }
                .sc2-prev-badge {
                    font-size: 10px; font-weight: 600; padding: 3px 7px; border-radius: 4px;
                    background: rgba(29,185,84,0.12); color: #1DB954; border: 0.5px solid rgba(29,185,84,0.25);
                }

                /* Single Track Destination Card */
                .sc2-dest-card {
                    display: none; background: #141414; border: 0.5px solid rgba(29,185,84,0.25);
                    border-radius: 14px; padding: 12px 14px; flex-direction: column; gap: 8px;
                }
                .sc2-dest-card.open { display: flex; }
                .sc2-dest-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #1DB954; letter-spacing: 0.5px; }
                .sc2-radio-row {
                    display: flex; align-items: center; gap: 8px; font-size: 12px; color: #ccc; cursor: pointer;
                }
                .sc2-dest-select, .sc2-dest-input {
                    margin-left: 20px; width: calc(100% - 20px); height: 32px;
                    background: #1c1c1c; border: 0.5px solid #333; border-radius: 6px;
                    color: #fff; padding: 0 8px; font-size: 12px; box-sizing: border-box;
                }

                .sc2-actions { margin-top: auto; display: flex; gap: 8px; padding-top: 8px; }
                .sc2-btn-stop {
                    height: 40px; padding: 0 16px; border-radius: 10px;
                    background: transparent; border: 0.5px solid rgba(255,255,255,0.11);
                    color: #888; font-size: 13px; font-weight: 500; cursor: pointer;
                    display: flex; align-items: center; gap: 6px; transition: all .15s;
                }
                .sc2-btn-stop:hover:not(:disabled) { background: #1e1e1e; color: #fff; }
                .sc2-btn-stop:disabled { opacity: 0.3; cursor: not-allowed; }
                .sc2-btn-convert {
                    flex: 1; height: 40px; border-radius: 10px;
                    background: #1DB954; border: none; color: #000;
                    font-size: 13px; font-weight: 600; cursor: pointer;
                    display: flex; align-items: center; justify-content: center; gap: 7px;
                    transition: filter .15s, transform .1s; letter-spacing: -0.1px;
                }
                .sc2-btn-convert:hover:not(:disabled) { filter: brightness(1.10); }
                .sc2-btn-convert:active:not(:disabled) { transform: scale(0.98); }
                .sc2-btn-convert:disabled { opacity: 0.4; cursor: not-allowed; }

                /* Right panel */
                .sc2-right {
                    display: flex; flex-direction: column; background: #0d0d0d; overflow: hidden;
                }
                .sc2-right-hdr {
                    padding: 14px 16px 10px;
                    border-bottom: 0.5px solid rgba(255,255,255,0.07); flex-shrink: 0;
                }
                .sc2-prog-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
                .sc2-prog-track {
                    flex: 1; height: 3px; background: rgba(255,255,255,0.07);
                    border-radius: 2px; overflow: hidden;
                }
                .sc2-prog-fill {
                    height: 100%; width: 0%; background: #1DB954;
                    border-radius: 2px; transition: width .25s ease;
                }
                .sc2-prog-pct {
                    font-size: 11px; color: #666; min-width: 32px;
                    text-align: right; font-variant-numeric: tabular-nums;
                }

                .sc2-stats {
                    display: grid; grid-template-columns: repeat(3, 1fr);
                    gap: 8px; padding: 12px 16px 0; flex-shrink: 0;
                }
                .sc2-stat {
                    background: #141414; border: 0.5px solid rgba(255,255,255,0.07);
                    border-radius: 10px; padding: 10px 12px; text-align: center;
                }
                .sc2-stat-val {
                    font-size: 20px; font-weight: 500; line-height: 1;
                    color: #fff; font-variant-numeric: tabular-nums;
                }
                .sc2-stat-val.green { color: #1DB954; }
                .sc2-stat-val.amber { color: #f59e0b; }
                .sc2-stat-val.red { color: #e85555; }
                .sc2-stat-lbl {
                    font-size: 10px; color: #555; margin-top: 4px;
                    text-transform: uppercase; letter-spacing: 0.5px;
                }

                .sc2-log-wrap {
                    flex: 1; overflow-y: auto; padding: 12px 16px; min-height: 0;
                }
                .sc2-log-wrap::-webkit-scrollbar { width: 3px; }
                .sc2-log-wrap::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }

                .sc2-log-line {
                    display: flex; align-items: baseline; gap: 7px;
                    padding: 2px 0; font-size: 11.5px; line-height: 1.6;
                    font-family: 'Courier New', monospace;
                }
                .sc2-log-arrow { color: #444; flex-shrink: 0; font-size: 10px; }
                .sc2-log-msg { color: #777; }
                .sc2-log-line.success .sc2-log-msg { color: #1DB954; }
                .sc2-log-line.error   .sc2-log-msg { color: #e85555; }
                .sc2-log-line.warn    .sc2-log-msg { color: #f59e0b; }
                .sc2-log-line.info    .sc2-log-msg { color: #bbb; }
                .sc2-log-line.divider .sc2-log-msg { color: #2a2a2a; letter-spacing: 1px; }

                .sc2-status-bar {
                    padding: 10px 16px 14px;
                    border-top: 0.5px solid rgba(255,255,255,0.07);
                    display: flex; align-items: center; gap: 8px; flex-shrink: 0;
                }
                .sc2-status-dot {
                    width: 6px; height: 6px; border-radius: 50%;
                    background: #333; flex-shrink: 0; transition: background .3s;
                }
                .sc2-status-dot.active { background: #1DB954; }
                .sc2-status-dot.done   { background: #1DB954; }
                .sc2-status-dot.err    { background: #e85555; }
                .sc2-status-txt { font-size: 11px; color: #555; flex: 1; }
            `;
            document.head.appendChild(s);
        },

        // ── Modal Creation ──────────────────────────────────────────────────
        createModal() {
            const overlay = document.createElement('div');
            overlay.id = 'sc2-overlay';
            overlay.onclick = () => { if (!this.isConverting) this.close(); };
            document.body.appendChild(overlay);

            const modal = document.createElement('div');
            modal.id = 'sc2-modal';
            modal.innerHTML = `
                <div class="sc2-topbar">
                    <div class="sc2-topbar-left">
                        <span class="sc2-logo" aria-hidden="true">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141 4.32-1.38 9.841-.719 13.44 1.56.42.3.6.84.3 1.26zm.12-3.36C14.939 8.46 8.641 8.28 5.1 9.421c-.6.18-1.26-.12-1.441-.72-.18-.6.12-1.26.72-1.44 4.08-1.26 11.04-1.02 15.361 1.56.6.358.779 1.14.421 1.74-.359.6-1.14.779-1.741.419z"/></svg>
                        </span>
                        <span class="sc2-title">Spotify to Audion</span>
                        <span class="sc2-dot" aria-hidden="true"></span>
                        <span class="sc2-sub">Universal Importer</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:8px">
                        <span class="sc2-chip">Unlimited</span>
                        <button class="sc2-icon-btn" id="sc2-close" aria-label="Close">✕</button>
                    </div>
                </div>

                <div class="sc2-two-col">
                    <div class="sc2-left">
                        <div>
                            <div class="sc2-plabel">Source</div>
                            <div class="sc2-url-card">
                                <div class="sc2-field-wrap">
                                    <input type="text" id="sc2-url" class="sc2-field" placeholder="Paste Spotify Playlist, Album, or Track URL..." autocomplete="off">
                                    <button class="sc2-field-x" id="sc2-field-x" aria-label="Clear">✕</button>
                                </div>
                                <div class="sc2-sep">
                                    <div class="sc2-sep-line"></div>
                                    <span class="sc2-sep-text">or</span>
                                    <div class="sc2-sep-line"></div>
                                </div>
                                <label for="sc2-file" class="sc2-json-btn" id="sc2-json-label">Upload JSON backup</label>
                                <input type="file" id="sc2-file" accept=".json" style="display:none">
                                <div class="sc2-file-pill" id="sc2-pill">
                                    <span class="sc2-pill-text" id="sc2-pill-text"></span>
                                    <button class="sc2-pill-remove" id="sc2-pill-remove" aria-label="Remove file">✕</button>
                                </div>
                            </div>
                        </div>

                        <div class="sc2-notice">
                            Supports <strong>entire playlists</strong> (500+ tracks), <strong>albums</strong>, and <strong>single songs</strong>. Matches via <strong>saavan-search</strong> or <strong>qobuz-player</strong>.
                        </div>

                        <!-- Preview Card -->
                        <div class="sc2-preview" id="sc2-preview">
                            <div class="sc2-prev-art" id="sc2-prev-art"></div>
                            <div class="sc2-prev-info">
                                <div class="sc2-prev-name" id="sc2-prev-name">—</div>
                                <div class="sc2-prev-owner" id="sc2-prev-owner" style="display:none">
                                    <span id="sc2-prev-owner-text"></span>
                                </div>
                                <div class="sc2-prev-count">
                                    <span id="sc2-prev-count"></span>
                                </div>
                            </div>
                            <div class="sc2-prev-badge" id="sc2-prev-badge">PLAYLIST</div>
                        </div>

                        <!-- Single Track Destination Selector -->
                        <div class="sc2-dest-card" id="sc2-dest-card">
                            <div class="sc2-dest-title">Where to save this song?</div>
                            <label class="sc2-radio-row">
                                <input type="radio" name="sc2-dest" value="library" checked>
                                <span>Save directly to Main Library</span>
                            </label>
                            <label class="sc2-radio-row">
                                <input type="radio" name="sc2-dest" value="existing_playlist">
                                <span>Add to Playlist:</span>
                            </label>
                            <select id="sc2-dest-select" class="sc2-dest-select"></select>

                            <label class="sc2-radio-row">
                                <input type="radio" name="sc2-dest" value="new_playlist">
                                <span>Create New Playlist:</span>
                            </label>
                            <input type="text" id="sc2-dest-new-name" class="sc2-dest-input" placeholder="e.g. My Favorites">
                        </div>

                        <div class="sc2-actions">
                            <button class="sc2-btn-stop" id="sc2-stop" disabled>Stop</button>
                            <button class="sc2-btn-convert" id="sc2-convert">Convert</button>
                        </div>
                    </div>

                    <div class="sc2-right">
                        <div class="sc2-right-hdr">
                            <div class="sc2-plabel" style="margin-bottom:0">Activity log</div>
                            <div class="sc2-prog-row">
                                <div class="sc2-prog-track">
                                    <div class="sc2-prog-fill" id="sc2-prog-fill"></div>
                                </div>
                                <span class="sc2-prog-pct" id="sc2-prog-pct">0%</span>
                            </div>
                        </div>

                        <div class="sc2-stats">
                            <div class="sc2-stat">
                                <div class="sc2-stat-val green" id="sc2-stat-new">—</div>
                                <div class="sc2-stat-lbl">Added</div>
                            </div>
                            <div class="sc2-stat">
                                <div class="sc2-stat-val amber" id="sc2-stat-lib">—</div>
                                <div class="sc2-stat-lbl">Library</div>
                            </div>
                            <div class="sc2-stat">
                                <div class="sc2-stat-val red" id="sc2-stat-miss">—</div>
                                <div class="sc2-stat-lbl">Not found</div>
                            </div>
                        </div>

                        <div class="sc2-log-wrap" id="sc2-log">
                            <div class="sc2-log-line info">
                                <span class="sc2-log-arrow">›</span>
                                <span class="sc2-log-msg">Ready. Paste a Spotify URL (playlist, album, or track) or upload a JSON backup.</span>
                            </div>
                        </div>

                        <div class="sc2-status-bar">
                            <div class="sc2-status-dot" id="sc2-status-dot"></div>
                            <span class="sc2-status-txt" id="sc2-status-txt">Idle</span>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelector('#sc2-close').onclick = () => this.close();
            modal.querySelector('#sc2-convert').onclick = () => this.startImportProcess();
            modal.querySelector('#sc2-stop').onclick = () => this.stopConversionProcess();
            modal.querySelector('#sc2-file').addEventListener('change', e => this.handleFileUpload(e));
            modal.querySelector('#sc2-pill-remove').onclick = () => this.clearFile();

            modal.querySelector('#sc2-field-x').addEventListener('click', () => {
                modal.querySelector('#sc2-url').value = '';
                modal.querySelector('#sc2-field-x').style.display = 'none';
                modal.querySelector('#sc2-preview').style.display = 'none';
                modal.querySelector('#sc2-dest-card').classList.remove('open');
                this.singleTrackData = null;
                this.detectedType = null;
                modal.querySelector('#sc2-url').focus();
            });

            // Instant auto-detection on URL paste or enter
            const urlInput = modal.querySelector('#sc2-url');
            urlInput.addEventListener('input', () => {
                const v = urlInput.value.trim();
                modal.querySelector('#sc2-field-x').style.display = v ? 'flex' : 'none';
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
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 12h20M2 12l5-5m-5 5l5 5"/><circle cx="12" cy="12" r="10"/>
                </svg>
                <span>Spotify Universal Importer</span>
            `;
            btn.onclick = () => this.open();
            this.api.ui.registerSlot('playerbar:menu', btn);
        },

        async open() {
            this.isOpen = true;
            document.getElementById('sc2-overlay')?.classList.add('open');
            document.getElementById('sc2-modal')?.classList.add('open');
            // Refresh playlists for destination picker
            try {
                this.cachedPlaylists = (await this.api.library.getPlaylists()) || [];
            } catch (e) {
                this.cachedPlaylists = [];
            }
        },

        close() {
            if (this.isConverting) return;
            this.isOpen = false;
            document.getElementById('sc2-overlay')?.classList.remove('open');
            document.getElementById('sc2-modal')?.classList.remove('open');
        },

        // ── URL Detection & Preview ─────────────────────────────────────────
        async onUrlEntered(rawUrl) {
            const str = rawUrl.trim();
            const trackMatch = str.match(/(?:track\/|track:)([a-zA-Z0-9]+)/);
            const playlistMatch = str.match(/(?:playlist\/|playlist:)([a-zA-Z0-9]+)/);
            const albumMatch = str.match(/(?:album\/|album:)([a-zA-Z0-9]+)/);

            if (trackMatch) {
                this.detectedType = 'track';
                this.fetchAndPreviewSingleTrack(trackMatch[1], str);
            } else if (playlistMatch) {
                this.detectedType = 'playlist';
                document.getElementById('sc2-dest-card')?.classList.remove('open');
                document.getElementById('sc2-convert').textContent = 'Convert playlist';
                this.fetchAndPreviewPlaylist(playlistMatch[1]);
            } else if (albumMatch) {
                this.detectedType = 'album';
                document.getElementById('sc2-dest-card')?.classList.remove('open');
                document.getElementById('sc2-convert').textContent = 'Convert album';
                this.fetchAndPreviewAlbum(albumMatch[1]);
            }
        },

        // ── Single Track Handling ───────────────────────────────────────────
        async fetchAndPreviewSingleTrack(trackId, rawUrl) {
            this.log(`Loading Spotify track (ID: ${trackId})…`, 'info');
            this.setStatus('Loading track…', 'active');

            try {
                let track = null;

                // 1. Fetch via Spotify embed HTML (has exact __NEXT_DATA__ entity with true title and artist)
                try {
                    const embedRes = await this.api.fetch(`https://open.spotify.com/embed/track/${trackId}`);
                    if (embedRes.ok) {
                        const html = await embedRes.text();
                        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                        if (nextDataMatch) {
                            const nextData = JSON.parse(nextDataMatch[1]);
                            const entity = nextData.props?.pageProps?.state?.data?.entity;
                            if (entity) {
                                track = {
                                    title: entity.title || entity.name,
                                    artist: (entity.artists || []).map(a => a.name).join(', ') || 'Unknown Artist',
                                    album: '',
                                    duration_ms: entity.duration || 180000,
                                    cover_url: entity.visualIdentity?.image?.[0]?.url || null,
                                    isrc: null
                                };
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[SpotifyImporter] Embed parser fallback:', e);
                }

                // 2. Fallback to oEmbed if needed
                if (!track) {
                    const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/track/${trackId}`)}`;
                    const oembedRes = await this.api.fetch(oembedUrl);
                    if (oembedRes.ok) {
                        const data = await oembedRes.json();
                        let title = data.title || 'Track';
                        let artist = '';
                        if (title.includes(' by ')) {
                            const p = title.split(' by ');
                            title = p[0].trim();
                            artist = p[1].trim();
                        }
                        track = {
                            title: title,
                            artist: artist,
                            album: '',
                            duration_ms: 180000,
                            cover_url: data.thumbnail_url || null,
                            isrc: null
                        };
                    }
                }

                if (!track) throw new Error('Could not fetch Spotify track info.');

                this.singleTrackData = track;

                // Show Preview Card
                const art = document.getElementById('sc2-prev-art');
                if (track.cover_url) {
                    art.innerHTML = `<img src="${track.cover_url}" alt="">`;
                } else {
                    art.innerHTML = `<span style="font-size:20px">🎵</span>`;
                }
                document.getElementById('sc2-prev-name').textContent = track.title;
                document.getElementById('sc2-prev-owner').style.display = 'flex';
                document.getElementById('sc2-prev-owner-text').textContent = track.artist || 'Single Track';
                document.getElementById('sc2-prev-count').textContent = 'Single Track';
                document.getElementById('sc2-prev-badge').textContent = 'TRACK';
                document.getElementById('sc2-preview').style.display = 'flex';

                // Populate and show destination card
                const destCard = document.getElementById('sc2-dest-card');
                const selectEl = document.getElementById('sc2-dest-select');
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
                destCard.classList.add('open');
                document.getElementById('sc2-convert').textContent = 'Save track';

                this.log(`Track: "${track.title}" by ${track.artist}`, 'info');
                this.setStatus('Ready to save', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Failed to fetch track: ${err.message}`, 'error');
                this.setStatus('Error', 'err');
            }
        },

        async saveSingleTrack() {
            const track = this.singleTrackData;
            if (!track) return;

            const convertBtn = document.getElementById('sc2-convert');
            convertBtn.disabled = true;
            this.setStatus('Searching stream…', 'active');
            this.log(`━━━━━━━━━━━━━━━━━━━━━━━`, 'divider');
            this.log(`Searching audio sources for: "${track.title}" - ${track.artist}`, 'info');

            try {
                const results = await this.searchAllSources(track, null);
                const best = this.pickBestResult(results);

                if (!best) {
                    this.log(`No match found on JioSaavn or Qobuz for "${track.title}".`, 'error');
                    this.updateStats(0, 0, 1);
                    this.setStatus('Not found', 'err');
                    convertBtn.disabled = false;
                    return;
                }

                if (!best.cover_url && track.cover_url) best.cover_url = track.cover_url;

                // Add to Audion library
                const libraryId = await this.addTrackToLibrary(best);
                this.log(`Added to library: "${best.title}" (${best.source_type})`, 'success');

                // Destination
                const destVal = document.querySelector('input[name="sc2-dest"]:checked')?.value || 'library';
                if (destVal === 'existing_playlist') {
                    const plId = document.getElementById('sc2-dest-select')?.value;
                    if (plId) {
                        await this.api.library.addTrackToPlaylist(plId, libraryId);
                        this.log(`Added to selected playlist!`, 'success');
                    }
                } else if (destVal === 'new_playlist') {
                    const newName = document.getElementById('sc2-dest-new-name')?.value?.trim() || `${track.title} Mix`;
                    const newPlId = await this.api.library.createPlaylist(newName, track.cover_url);
                    await this.api.library.addTrackToPlaylist(newPlId, libraryId);
                    this.log(`Created playlist "${newName}" and added track!`, 'success');
                }

                this.updateStats(1, 0, 0);
                this.updateProgress(100);
                this.setStatus('Saved!', 'done');
                this.log(`Track successfully imported!`, 'success');
            } catch (err) {
                console.error(err);
                this.log(`Error saving track: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            } finally {
                convertBtn.disabled = false;
            }
        },

        // ── Playlist & Album Fetching (Unlimited Pagination) ────────────────
        async fetchAndPreviewPlaylist(playlistId) {
            this.log(`Loading playlist (ID: ${playlistId})…`, 'info');
            this.setStatus('Loading playlist…', 'active');

            try {
                // First attempt: Check embed page for live accessToken
                let token = null;
                try {
                    const embedRes = await this.api.fetch(`https://open.spotify.com/embed/playlist/${playlistId}`);
                    if (embedRes.ok) {
                        const html = await embedRes.text();
                        const tokenMatch = html.match(/"accessToken":"([^"]+)"/);
                        if (tokenMatch) token = tokenMatch[1];
                    }
                } catch (e) { }

                let playlistData = null;

                // If token acquired from embed page, use official API with UNLIMITED pagination!
                if (token) {
                    this.log('Acquired Spotify session. Loading all pages with zero limits…', 'info');
                    try {
                        const metaRes = await this.api.fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description,images,owner,tracks.total`, {
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
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
                        console.warn('[SpotifyImporter] Official API paging error:', e);
                    }
                }

                // Fallback to Public Vercel Proxy if token method fails
                if (!playlistData) {
                    playlistData = await this.fetchPlaylistFromPublicAPI(playlistId);
                }

                this.importedPlaylistData = playlistData;
                this.showPlaylistPreview(playlistData);
                this.setStatus('Ready to convert', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            }
        },

        async fetchPlaylistFromPublicAPI(playlistId) {
            this.log('Fetching playlist via public proxy…', 'info');
            const limit = 100;
            let offset = 0, allTracks = [], playlistMeta = null, total = 0, page = 1;

            while (true) {
                const url = `${this.NEW_SPOTIFY_API_BASE}/${playlistId}?limit=${limit}&offset=${offset}`;
                const response = await this.api.fetch(url);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const json = await response.json();
                if (!json.success || !json.data) throw new Error('Invalid API response');
                const data = json.data;

                if (!playlistMeta) {
                    playlistMeta = {
                        title: data.name || 'Spotify Import',
                        description: data.description || '',
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

                if (!data.next || pageTracks.length === 0 || allTracks.length >= total) {
                    break;
                }
                offset += limit;
                page++;
            }

            return { ...playlistMeta, total: allTracks.length, tracks: allTracks };
        },

        async fetchAndPreviewAlbum(albumId) {
            this.log(`Loading album (ID: ${albumId})…`, 'info');
            this.setStatus('Loading album…', 'active');
            try {
                // Fetch embed page for album
                const embedRes = await this.api.fetch(`https://open.spotify.com/embed/album/${albumId}`);
                if (!embedRes.ok) throw new Error('Could not load album embed');
                const html = await embedRes.text();
                const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
                if (!nextDataMatch) throw new Error('Could not parse album data');
                const nextData = JSON.parse(nextDataMatch[1]);
                const entity = nextData.props?.pageProps?.state?.data?.entity;
                if (!entity) throw new Error('Album metadata not found');

                const albumTracks = (entity.trackList || []).map(t => ({
                    title: t.title,
                    artist: (t.artists || []).map(a => a.name).join(', ') || entity.subtitle || 'Unknown',
                    album: entity.name,
                    duration_ms: t.duration,
                    cover_url: entity.visualIdentity?.image?.[0]?.url || null,
                    isrc: null
                }));

                const albumData = {
                    title: entity.name,
                    image: entity.visualIdentity?.image?.[0]?.url || null,
                    owner: entity.subtitle || null,
                    total: albumTracks.length,
                    tracks: albumTracks
                };

                this.importedPlaylistData = albumData;
                this.showPlaylistPreview(albumData);
                this.setStatus('Ready to convert', 'idle');
            } catch (err) {
                console.error(err);
                this.log(`Album fetch error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            }
        },

        showPlaylistPreview(data) {
            const art = document.getElementById('sc2-prev-art');
            if (data.image) {
                art.innerHTML = `<img src="${data.image}" alt="">`;
            } else {
                art.innerHTML = `<span style="font-size:20px">📁</span>`;
            }
            document.getElementById('sc2-prev-name').textContent = data.title || 'Playlist';
            const ownerEl = document.getElementById('sc2-prev-owner');
            if (data.owner) {
                document.getElementById('sc2-prev-owner-text').textContent = data.owner;
                ownerEl.style.display = 'flex';
            } else {
                ownerEl.style.display = 'none';
            }
            const total = data.total || data.tracks.length;
            const fetched = data.tracks.length;
            document.getElementById('sc2-prev-count').textContent =
                (data.total && data.total > fetched) ? `${fetched} of ${total} tracks` : `${total} tracks`;
            document.getElementById('sc2-prev-badge').textContent = 'PLAYLIST';
            document.getElementById('sc2-preview').style.display = 'flex';
        },

        // ── Conversion Execution ────────────────────────────────────────────
        async startImportProcess() {
            if (this.detectedType === 'track') {
                return this.saveSingleTrack();
            }

            // Playlist or Album
            const convertBtn = document.getElementById('sc2-convert');
            const stopBtn = document.getElementById('sc2-stop');
            const urlEl = document.getElementById('sc2-url');

            let playlistData = this.importedPlaylistData;
            if (!playlistData) {
                this.log('Please enter a valid Spotify URL or upload a JSON backup.', 'error');
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
            this.setStatus('Converting…', 'active');

            document.getElementById('sc2-log').innerHTML = '';
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');
            this.log(`Playlist: ${playlistData.title}`, 'info');
            this.log(`${playlistData.tracks.length} tracks to process`, 'info');
            this.log('━━━━━━━━━━━━━━━━━━━━━━━', 'divider');

            try {
                const existingTracks = await this.getLibraryIndex();
                this.log(`${existingTracks.size} existing tracks in library index`, 'info');

                const audionPlaylistId = await this.api.library.createPlaylist(playlistData.title, playlistData.image);
                this.log('Playlist created in Audion', 'success');

                const total = playlistData.tracks.length;
                let processed = 0, successes = 0, fromLibrary = 0, notFound = 0;
                const concurrency = 5;
                const queue = playlistData.tracks.map((track, idx) => ({ track, idx }));
                const inFlight = new Map();

                const searchWorker = async () => {
                    while (queue.length > 0 && !this.stopConversion) {
                        const item = queue.shift();
                        if (!item) break;
                        const { track, idx } = item;
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

                        // Add track to Audion Playlist
                        if (trackId && audionPlaylistId) {
                            try {
                                await this.api.library.addTrackToPlaylist(audionPlaylistId, trackId);
                            } catch (e) { }
                        }

                        processed++;
                        this.updateProgress((processed / total) * 100);
                        this.updateStats(successes, fromLibrary, notFound);
                    }
                };

                const workers = Array.from({ length: concurrency }, () => searchWorker());
                await Promise.all(workers);

                if (this.stopConversion) {
                    this.log('Conversion stopped by user.', 'warn');
                    this.setStatus('Stopped', 'idle');
                } else {
                    this.log(`Finished! Successfully added ${successes + fromLibrary} of ${total} songs to "${playlistData.title}".`, 'success');
                    this.setStatus('Done', 'done');
                }
            } catch (err) {
                console.error(err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            } finally {
                this.isConverting = false;
                convertBtn.disabled = false;
                stopBtn.disabled = true;
                urlEl.disabled = false;
            }
        },

        stopConversionProcess() {
            this.stopConversion = true;
            if (this.abortController) this.abortController.abort();
        },

        // ── JSON Upload Handling ────────────────────────────────────────────
        handleFileUpload(event) {
            const file = event.target.files[0];
            if (!file) return;
            this.log(`Reading ${file.name}…`, 'info');
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const json = JSON.parse(e.target.result);
                    let playlistData = {
                        title: json.title || json.name || file.name.replace('.json', ''),
                        image: json.image || json.cover_url || null,
                        tracks: (Array.isArray(json) ? json : json.tracks || []).map(t => ({
                            title: t.title || t.name || 'Unknown',
                            artist: Array.isArray(t.artist) ? t.artist.join(', ') : (t.artist || 'Unknown'),
                            album: t.album || '',
                            duration_ms: t.duration_ms || 180000,
                            cover_url: t.cover_url || t.image || null,
                            isrc: t.isrc || null
                        }))
                    };
                    this.importedPlaylistData = playlistData;
                    this.detectedType = 'playlist';
                    document.getElementById('sc2-pill-text').textContent = `${playlistData.tracks.length} tracks · ${file.name}`;
                    document.getElementById('sc2-pill').style.display = 'flex';
                    document.getElementById('sc2-json-label').style.display = 'none';
                    document.getElementById('sc2-url').value = '';
                    document.getElementById('sc2-url').placeholder = 'Using uploaded JSON…';
                    document.getElementById('sc2-url').disabled = true;
                    this.showPlaylistPreview(playlistData);
                    this.log(`Loaded ${playlistData.tracks.length} tracks from JSON.`, 'success');
                } catch (err) {
                    this.log('Invalid JSON file.', 'error');
                }
            };
            reader.readAsText(file);
        },

        clearFile() {
            this.importedPlaylistData = null;
            document.getElementById('sc2-file').value = '';
            document.getElementById('sc2-url').value = '';
            document.getElementById('sc2-url').disabled = false;
            document.getElementById('sc2-url').placeholder = 'Paste Spotify Playlist, Album, or Track URL...';
            document.getElementById('sc2-pill').style.display = 'none';
            document.getElementById('sc2-json-label').style.display = 'flex';
            document.getElementById('sc2-preview').style.display = 'none';
            this.log('File removed.', 'info');
        },

        // ── Log & Stats Helpers ─────────────────────────────────────────────
        log(msg, type = 'info') {
            const log = document.getElementById('sc2-log');
            if (!log) return;
            const line = document.createElement('div');
            line.className = `sc2-log-line ${type}`;
            line.innerHTML = `<span class="sc2-log-arrow">›</span><span class="sc2-log-msg">${msg}</span>`;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
        },

        updateProgress(percent) {
            const p = Math.round(percent);
            const fill = document.getElementById('sc2-prog-fill');
            const pct = document.getElementById('sc2-prog-pct');
            if (fill) fill.style.width = `${p}%`;
            if (pct) pct.textContent = `${p}%`;
        },

        updateStats(n, l, m) {
            const sN = document.getElementById('sc2-stat-new');
            const sL = document.getElementById('sc2-stat-lib');
            const sM = document.getElementById('sc2-stat-miss');
            if (sN) sN.textContent = n;
            if (sL) sL.textContent = l;
            if (sM) sM.textContent = m;
        },

        setStatus(text, state = 'idle') {
            const txt = document.getElementById('sc2-status-txt');
            const dot = document.getElementById('sc2-status-dot');
            if (txt) txt.textContent = text;
            if (dot) {
                dot.className = 'sc2-status-dot';
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
