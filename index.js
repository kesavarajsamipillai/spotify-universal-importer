// Spotify Universal Importer for Audion
// Supports:
// 1. Unlimited playlist length (fixes 499-song cutoff bug with full pagination)
// 2. Full Albums
// 3. Single Songs with interactive "Where to save?" destination picker
// 4. Hybrid API mode (Zero-config public scraper + Optional official Spotify Developer API for 5000+ tracks)
// 5. High-speed multi-threaded source matching (JioSaavn, Qobuz, etc.)

(function () {
    'use strict';

    const SpotifyImporter = {
        name: 'Spotify Universal Importer',
        api: null,
        isOpen: false,
        isConverting: false,
        stopRequested: false,
        abortController: null,

        // Active State
        parsedItem: null, // { type: 'track' | 'playlist' | 'album', id: string, rawUrl: string }
        pendingTrackData: null, // For single song save picker
        cachedPlaylists: [],
        trackCache: new Map(),

        // Settings (Persisted via api.storage)
        settings: {
            clientId: '',
            clientSecret: '',
            concurrency: 6, // 6 concurrent searches for high speed
            autoPlayOnSingle: false
        },

        spotifyAccessToken: null,
        tokenExpiryTime: 0,

        // Public fallback endpoint
        PUBLIC_PLAYLIST_API: 'https://spotify-api-henna.vercel.app/api/playlist',

        // ── Lifecycle Hooks ──────────────────────────────────────────

        async init(api) {
            console.log('[SpotifyImporter] Initializing...');
            this.api = api;

            // Load saved settings
            await this.loadSettings();

            // Inject CSS styles
            this.injectStyles();

            // Build DOM modal and register buttons
            this.createModal();
            this.createUIButtons();

            console.log('[SpotifyImporter] Ready.');
        },

        start() {
            console.log('[SpotifyImporter] Started.');
        },

        stop() {
            console.log('[SpotifyImporter] Stopping...');
            this.stopConversion();
            if (this.api?.ui?.unregisterSlot) {
                this.api.ui.unregisterSlot('playerbar:right');
                this.api.ui.unregisterSlot('playerbar:menu');
            }
            const modal = document.getElementById('sui-overlay');
            if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
            const styles = document.getElementById('sui-styles');
            if (styles && styles.parentNode) styles.parentNode.removeChild(styles);
        },

        // ── Settings & Storage ───────────────────────────────────────

        async loadSettings() {
            if (!this.api?.storage?.get) return;
            try {
                const data = await this.api.storage.get('sui_config');
                if (data) {
                    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
                    this.settings = Object.assign(this.settings, parsed);
                }
            } catch (err) {
                console.warn('[SpotifyImporter] Failed to load settings:', err);
            }
        },

        async saveSettings() {
            if (!this.api?.storage?.set) return;
            try {
                await this.api.storage.set('sui_config', JSON.stringify(this.settings));
            } catch (err) {
                console.warn('[SpotifyImporter] Failed to save settings:', err);
            }
        },

        // ── Spotify Auth & Token Management ──────────────────────────

        async getSpotifyToken() {
            // Check if user has entered custom developer credentials
            if (!this.settings.clientId || !this.settings.clientSecret) {
                return null;
            }

            // Return cached token if valid
            if (this.spotifyAccessToken && Date.now() < this.tokenExpiryTime) {
                return this.spotifyAccessToken;
            }

            try {
                const creds = btoa(`${this.settings.clientId.trim()}:${this.settings.clientSecret.trim()}`);
                const res = await this.api.fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${creds}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: 'grant_type=client_credentials'
                });

                if (!res.ok) {
                    throw new Error(`Spotify Auth HTTP ${res.status}`);
                }

                const data = await res.json();
                if (data.access_token) {
                    this.spotifyAccessToken = data.access_token;
                    // Token lasts 3600 seconds, expire 2 minutes early
                    this.tokenExpiryTime = Date.now() + ((data.expires_in || 3600) - 120) * 1000;
                    this.log('Acquired official Spotify API token', 'success');
                    return this.spotifyAccessToken;
                }
            } catch (err) {
                this.log(`Spotify Token Error: ${err.message}. Falling back to public resolver.`, 'warn');
            }

            return null;
        },

        // ── URL & Identifier Parsing ─────────────────────────────────

        parseSpotifyInput(input) {
            if (!input || typeof input !== 'string') return null;
            const str = input.trim();

            // URI matching: spotify:track:..., spotify:playlist:..., spotify:album:...
            const uriMatch = str.match(/^spotify:(track|playlist|album):([a-zA-Z0-9]+)/);
            if (uriMatch) {
                return { type: uriMatch[1], id: uriMatch[2], rawUrl: str };
            }

            // Web URL matching
            const urlMatch = str.match(/spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
            if (urlMatch) {
                return { type: urlMatch[1], id: urlMatch[2], rawUrl: str };
            }

            return null;
        },

        // ── Metadata Fetchers ────────────────────────────────────────

        // 1. Fetch Single Track
        async fetchTrack(trackId, rawUrl) {
            this.log(`Fetching metadata for single track (ID: ${trackId})...`, 'info');
            const token = await this.getSpotifyToken();

            // Option A: Official Web API
            if (token) {
                try {
                    const res = await this.api.fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (res.ok) {
                        const t = await res.json();
                        return {
                            title: t.name,
                            artist: t.artists.map(a => a.name).join(', '),
                            album: t.album?.name || '',
                            duration_ms: t.duration_ms,
                            cover_url: t.album?.images?.[0]?.url || null,
                            isrc: t.external_ids?.isrc || null,
                            rawUrl: t.external_urls?.spotify || rawUrl
                        };
                    }
                } catch (e) {
                    console.warn('[SpotifyImporter] Official API track fetch error:', e);
                }
            }

            // Option B: Public oEmbed / Scraper (Instant zero-config)
            try {
                const targetUrl = rawUrl.startsWith('http') ? rawUrl : `https://open.spotify.com/track/${trackId}`;
                const oembedRes = await this.api.fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(targetUrl)}`);
                if (oembedRes.ok) {
                    const data = await oembedRes.json();
                    let title = data.title || 'Unknown Track';
                    let artist = 'Unknown Artist';

                    // Parse "Title - Artist" or "Title by Artist" if present
                    if (title.includes(' by ')) {
                        const parts = title.split(' by ');
                        title = parts[0].trim();
                        artist = parts[1].trim();
                    } else if (title.includes(' - ')) {
                        const parts = title.split(' - ');
                        artist = parts[0].trim();
                        title = parts[1].trim();
                    }

                    return {
                        title: title,
                        artist: artist,
                        album: '',
                        duration_ms: 180000,
                        cover_url: data.thumbnail_url || null,
                        isrc: null,
                        rawUrl: targetUrl
                    };
                }
            } catch (err) {
                console.error('[SpotifyImporter] oEmbed fallback failed:', err);
            }

            throw new Error(`Could not fetch metadata for Spotify track: ${trackId}`);
        },

        // 2. Fetch Playlist (Fixes 499 cutoff by handling unlimited pagination)
        async fetchPlaylist(playlistId) {
            this.log(`Fetching playlist (ID: ${playlistId})...`, 'info');
            const token = await this.getSpotifyToken();

            // Option A: Official Web API (Supports 10,000+ tracks with NO cap)
            if (token) {
                this.log('Using Official Spotify Web API with full pagination...', 'info');
                try {
                    // Fetch playlist details
                    const metaRes = await this.api.fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,description,images,owner,tracks.total`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (!metaRes.ok) throw new Error(`Spotify Playlist API returned ${metaRes.status}`);
                    const meta = await metaRes.json();

                    const playlistTitle = meta.name || 'Spotify Playlist';
                    const playlistCover = meta.images?.[0]?.url || null;
                    const totalTracks = meta.tracks?.total || 0;
                    let allTracks = [];
                    let offset = 0;
                    const limit = 100;

                    this.log(`Playlist "${playlistTitle}" has ${totalTracks} tracks. Fetching all pages...`, 'info');

                    while (offset < totalTracks) {
                        const pageRes = await this.api.fetch(
                            `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=items(track(name,artists(name),album(name,images),duration_ms,external_ids,external_urls))`,
                            { headers: { 'Authorization': `Bearer ${token}` } }
                        );

                        if (!pageRes.ok) throw new Error(`Page fetch failed at offset ${offset}`);
                        const pageData = await pageRes.json();
                        const items = pageData.items || [];
                        if (items.length === 0) break;

                        for (const item of items) {
                            const t = item.track;
                            if (!t || !t.name) continue;
                            allTracks.push({
                                title: t.name,
                                artist: t.artists ? t.artists.map(a => a.name).join(', ') : 'Unknown',
                                album: t.album?.name || '',
                                duration_ms: t.duration_ms || 0,
                                cover_url: t.album?.images?.[0]?.url || null,
                                isrc: t.external_ids?.isrc || null
                            });
                        }

                        this.log(`Loaded ${allTracks.length}/${totalTracks} tracks...`, 'info');
                        this.updateFetchStatus(`Fetching: ${allTracks.length}/${totalTracks} tracks`);
                        offset += limit;
                    }

                    this.log(`Successfully fetched ALL ${allTracks.length} tracks without cutoff!`, 'success');
                    return {
                        title: playlistTitle,
                        image: playlistCover,
                        total: allTracks.length,
                        tracks: allTracks
                    };
                } catch (err) {
                    this.log(`Official API error: ${err.message}. Falling back to public service...`, 'warn');
                }
            }

            // Option B: Public Service (Fallback with pagination retry)
            this.log('Using Public Multi-Page Service (Tip: Add your free Spotify API keys in Settings for 500+ track guarantee)', 'info');
            const limit = 100;
            let offset = 0, allTracks = [], playlistMeta = null, total = 0, page = 1;

            while (true) {
                const url = `${this.PUBLIC_PLAYLIST_API}/${playlistId}?limit=${limit}&offset=${offset}`;
                const response = await this.api.fetch(url);
                if (!response.ok) throw new Error(`API error: ${response.status}`);
                const json = await response.json();
                if (!json.success || !json.data) throw new Error('Invalid response from public API');
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
                    album: t.album || '',
                    duration_ms: t.duration_ms || 0,
                    cover_url: t.image || null,
                    isrc: null
                }));

                allTracks = allTracks.concat(pageTracks);
                this.log(`Page ${page}: ${pageTracks.length} tracks loaded (${allTracks.length}/${total})`, 'info');
                this.updateFetchStatus(`Loaded ${allTracks.length} of ${total} tracks`);

                if (!data.next || pageTracks.length === 0 || allTracks.length >= total) {
                    if (allTracks.length < total) {
                        this.log(`Public proxy stopped at ${allTracks.length} of ${total}. Set your free Spotify Developer keys in Settings tab to bypass public limits!`, 'warn');
                    }
                    break;
                }
                offset += limit;
                page++;
            }

            return { ...playlistMeta, total: allTracks.length, tracks: allTracks };
        },

        // 3. Fetch Album
        async fetchAlbum(albumId) {
            this.log(`Fetching album (ID: ${albumId})...`, 'info');
            const token = await this.getSpotifyToken();

            if (token) {
                const res = await this.api.fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (res.ok) {
                    const album = await res.json();
                    const tracks = (album.tracks?.items || []).map(t => ({
                        title: t.name,
                        artist: t.artists ? t.artists.map(a => a.name).join(', ') : album.artists?.[0]?.name,
                        album: album.name,
                        duration_ms: t.duration_ms,
                        cover_url: album.images?.[0]?.url || null,
                        isrc: null
                    }));

                    return {
                        title: `${album.name} - ${album.artists?.[0]?.name || ''}`,
                        image: album.images?.[0]?.url || null,
                        total: tracks.length,
                        tracks: tracks
                    };
                }
            }

            throw new Error('Please enter Spotify API keys in Settings tab to import full albums.');
        },

        // ── Audion Source Search & Matching ──────────────────────────

        searchAllSources(track, signal) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                const results = [];
                if (!this.api?.search?.query) {
                    resolve([]);
                    return;
                }

                this.api.search.query(
                    {
                        title: track.title,
                        artist: track.artist,
                        isrc: track.isrc,
                        duration_ms: track.duration_ms
                    },
                    (result) => {
                        if (signal?.aborted) {
                            reject(new DOMException('Aborted', 'AbortError'));
                            return;
                        }
                        results.push(result);
                    },
                    () => {
                        if (signal?.aborted) {
                            reject(new DOMException('Aborted', 'AbortError'));
                            return;
                        }
                        resolve(results);
                    }
                );
            });
        },

        pickBestResult(results) {
            const SOURCE_PRIORITY = ['qobuz', 'jiosaavn', 'universal', 'tidal'];
            const successes = results.filter(r => r.status === 'success');
            if (successes.length === 0) return null;

            for (const sourceId of SOURCE_PRIORITY) {
                const fromSource = successes
                    .filter(r => r.sourceId === sourceId)
                    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                if (fromSource.length > 0) return fromSource[0];
            }

            return successes.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] || null;
        },

        async getLibraryIndex() {
            const map = new Map();
            if (this.api?.library?.getTracks) {
                try {
                    const tracks = await this.api.library.getTracks();
                    if (Array.isArray(tracks)) {
                        tracks.forEach(t => {
                            if (t.source_type && t.external_id) {
                                map.set(`${t.source_type}:${t.external_id}`, t.id);
                            }
                        });
                    }
                } catch (e) {
                    console.error(e);
                }
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
                metadata_json: result.metadata_json || null
            });
        },

        // ── Single Track Destination Modal ───────────────────────────

        async openSingleTrackPrompt(track) {
            this.pendingTrackData = track;

            // Load all current Audion playlists
            try {
                this.cachedPlaylists = (await this.api.library.getPlaylists()) || [];
            } catch (err) {
                this.cachedPlaylists = [];
            }

            const promptModal = document.getElementById('sui-single-prompt');
            const previewImg = document.getElementById('sui-st-cover');
            const previewTitle = document.getElementById('sui-st-title');
            const previewArtist = document.getElementById('sui-st-artist');
            const playlistSelect = document.getElementById('sui-st-playlist-select');

            if (previewImg) previewImg.src = track.cover_url || 'https://via.placeholder.com/100';
            if (previewTitle) previewTitle.textContent = track.title;
            if (previewArtist) previewArtist.textContent = `${track.artist} ${track.album ? '• ' + track.album : ''}`;

            // Populate existing playlists dropdown
            if (playlistSelect) {
                playlistSelect.innerHTML = '';
                if (this.cachedPlaylists.length === 0) {
                    playlistSelect.innerHTML = '<option value="">(No playlists found)</option>';
                } else {
                    this.cachedPlaylists.forEach(pl => {
                        const opt = document.createElement('option');
                        opt.value = pl.id;
                        opt.textContent = pl.name || pl.title || `Playlist #${pl.id}`;
                        playlistSelect.appendChild(opt);
                    });
                }
            }

            if (promptModal) promptModal.classList.remove('hidden');
        },

        closeSingleTrackPrompt() {
            const promptModal = document.getElementById('sui-single-prompt');
            if (promptModal) promptModal.classList.add('hidden');
            this.pendingTrackData = null;
        },

        async executeSingleTrackSave(destination, extraData = {}) {
            const track = this.pendingTrackData;
            if (!track) return;

            this.closeSingleTrackPrompt();
            this.log(`Resolving stream source for: "${track.title}" - ${track.artist}...`, 'info');
            this.setStatus('Searching source...', 'active');

            try {
                // 1. Search Audion sources for the audio stream
                const results = await this.searchAllSources(track, null);
                const best = this.pickBestResult(results);

                if (!best) {
                    this.log(`Could not find an audio stream for "${track.title}" on configured sources.`, 'error');
                    alert(`Could not find a streamable audio source for "${track.title}". Make sure you have JioSaavn or Qobuz plugin installed.`);
                    this.setStatus('Ready', 'idle');
                    return;
                }

                if (!best.cover_url && track.cover_url) best.cover_url = track.cover_url;

                // 2. Add track to Audion library
                const libraryTrackId = await this.addTrackToLibrary(best);
                this.log(`Track added to library (ID: ${libraryTrackId})`, 'success');

                // 3. Handle user's selected destination
                if (destination === 'library') {
                    this.log(`Saved "${track.title}" directly to your Library!`, 'success');
                    alert(`Saved "${track.title}" to Library!`);
                } else if (destination === 'existing_playlist') {
                    const plId = extraData.playlistId;
                    if (plId) {
                        await this.api.library.addTrackToPlaylist(plId, libraryTrackId);
                        this.log(`Added "${track.title}" to selected playlist!`, 'success');
                        alert(`Added "${track.title}" to playlist!`);
                    }
                } else if (destination === 'new_playlist') {
                    const plName = extraData.playlistName || `${track.title} Radio`;
                    const newPlId = await this.api.library.createPlaylist(plName, track.cover_url);
                    await this.api.library.addTrackToPlaylist(newPlId, libraryTrackId);
                    this.log(`Created playlist "${plName}" and added track!`, 'success');
                    alert(`Created playlist "${plName}" with "${track.title}"!`);
                } else if (destination === 'download') {
                    if (this.api?.library?.downloadTrack && best.url) {
                        await this.api.library.downloadTrack({
                            url: best.url,
                            filename: `${track.artist} - ${track.title}.mp3`,
                            metadata: { title: track.title, artist: track.artist, album: track.album }
                        });
                        this.log(`Download started for "${track.title}".`, 'success');
                    } else {
                        alert('Direct audio download is not supported for this source format.');
                    }
                }

                // Optional: Play immediately if requested
                if (extraData.playNow && this.api?.player) {
                    this.api.player.setTrack({
                        title: track.title,
                        artist: track.artist,
                        album: track.album,
                        cover_url: track.cover_url,
                        source_type: best.source_type,
                        external_id: best.external_id
                    });
                    this.api.player.play?.();
                }

                this.setStatus('Success', 'ok');
            } catch (err) {
                console.error('[SpotifyImporter] Single track save error:', err);
                this.log(`Error: ${err.message}`, 'error');
                this.setStatus('Error', 'err');
            }
        },

        // ── Multi-Track Batch Importer (Playlists & Albums) ───────────

        async processBatchImport(data) {
            this.isConverting = true;
            this.stopRequested = false;
            this.abortController = new AbortController();

            const convertBtn = document.getElementById('sui-btn-convert');
            const stopBtn = document.getElementById('sui-btn-stop');
            if (convertBtn) convertBtn.disabled = true;
            if (stopBtn) stopBtn.disabled = false;

            this.updateProgress(0);
            this.setStatus('Importing…', 'active');
            this.log(`Starting import: ${data.tracks.length} tracks`, 'info');

            try {
                // 1. Get index of existing library tracks to prevent duplicate adds
                const existingTracks = await this.getLibraryIndex();

                // 2. Create the playlist in Audion
                let audionPlaylistId = null;
                if (this.api?.library?.createPlaylist) {
                    audionPlaylistId = await this.api.library.createPlaylist(data.title, data.image);
                    this.log(`Created Audion playlist: "${data.title}"`, 'success');
                }

                const total = data.tracks.length;
                let processed = 0, successes = 0, notFound = 0;
                const concurrency = Math.max(2, Math.min(10, this.settings.concurrency || 6));
                const queue = data.tracks.map((t, i) => ({ track: t, idx: i }));
                const inFlight = new Map();

                const worker = async () => {
                    while (queue.length > 0 && !this.stopRequested) {
                        const item = queue.shift();
                        if (!item) break;
                        const { track, idx } = item;
                        const cacheKey = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;

                        let trackId = null;
                        if (this.trackCache.has(cacheKey)) {
                            trackId = this.trackCache.get(cacheKey);
                            successes++;
                        } else if (inFlight.has(cacheKey)) {
                            try {
                                trackId = await inFlight.get(cacheKey);
                                if (trackId) successes++; else notFound++;
                            } catch (e) { notFound++; }
                        } else {
                            const searchPromise = (async () => {
                                try {
                                    const results = await this.searchAllSources(track, this.abortController.signal);
                                    const best = this.pickBestResult(results);
                                    if (best) {
                                        if (!best.cover_url && track.cover_url) best.cover_url = track.cover_url;
                                        const libKey = `${best.source_type}:${best.external_id}`;
                                        let resId;
                                        if (existingTracks.has(libKey)) {
                                            resId = existingTracks.get(libKey);
                                        } else {
                                            resId = await this.addTrackToLibrary(best);
                                            existingTracks.set(libKey, resId);
                                        }
                                        this.trackCache.set(cacheKey, resId);
                                        return resId;
                                    }
                                    return null;
                                } catch (err) {
                                    return null;
                                }
                            })();

                            inFlight.set(cacheKey, searchPromise);
                            trackId = await searchPromise;
                            inFlight.delete(cacheKey);

                            if (trackId) successes++; else notFound++;
                        }

                        // Add track to the created playlist
                        if (trackId && audionPlaylistId && this.api?.library?.addTrackToPlaylist) {
                            try {
                                await this.api.library.addTrackToPlaylist(audionPlaylistId, trackId);
                            } catch (err) {
                                console.warn(`Failed to add track to playlist: ${track.title}`);
                            }
                        }

                        processed++;
                        const pct = Math.round((processed / total) * 100);
                        this.updateProgress(pct);
                        this.updateStats(processed, successes, notFound);
                    }
                };

                // Launch concurrent workers
                const workers = Array.from({ length: concurrency }, () => worker());
                await Promise.all(workers);

                if (this.stopRequested) {
                    this.log('Import stopped by user.', 'warn');
                    this.setStatus('Stopped', 'idle');
                } else {
                    this.log(`Finished! Successfully imported ${successes} of ${total} songs into "${data.title}".`, 'success');
                    this.setStatus('Completed', 'ok');
                    if (this.api?.system?.notify) {
                        this.api.system.notify('Spotify Import Complete', `Added ${successes} songs to ${data.title}`);
                    }
                }
            } catch (err) {
                console.error('[SpotifyImporter] Import error:', err);
                this.log(`Import error: ${err.message}`, 'error');
                this.setStatus('Failed', 'err');
            } finally {
                this.isConverting = false;
                if (convertBtn) convertBtn.disabled = false;
                if (stopBtn) stopBtn.disabled = true;
            }
        },

        stopConversion() {
            this.stopRequested = true;
            if (this.abortController) {
                this.abortController.abort();
            }
        },

        // ── Main UI Modal ────────────────────────────────────────────

        createUIButtons() {
            // Player bar button
            const barBtn = document.createElement('button');
            barBtn.id = 'sui-bar-btn';
            barBtn.className = 'sui-icon-btn';
            barBtn.title = 'Spotify Universal Importer';
            barBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                </svg>
            `;
            barBtn.onclick = () => this.toggleModal();

            // Menu button
            const menuBtn = document.createElement('div');
            menuBtn.className = 'sui-menu-item';
            menuBtn.innerHTML = `<span>Spotify Importer</span>`;
            menuBtn.onclick = () => this.toggleModal();

            if (this.api?.ui?.registerSlot) {
                this.api.ui.registerSlot('playerbar:right', barBtn, 15);
                this.api.ui.registerSlot('playerbar:menu', menuBtn, 15);
            }
        },

        createModal() {
            if (document.getElementById('sui-overlay')) return;

            const overlay = document.createElement('div');
            overlay.id = 'sui-overlay';
            overlay.className = 'sui-overlay hidden';
            overlay.innerHTML = `
                <div class="sui-backdrop" id="sui-backdrop"></div>
                <div class="sui-dialog">
                    <header class="sui-header">
                        <div class="sui-brand">
                            <span class="sui-spotify-icon"></span>
                            <h2>Spotify Universal Importer</h2>
                        </div>
                        <button class="sui-close" id="sui-close-btn">&times;</button>
                    </header>

                    <nav class="sui-tabs">
                        <button class="sui-tab active" data-tab="import">Import Music</button>
                        <button class="sui-tab" data-tab="settings">API Settings</button>
                    </nav>

                    <div class="sui-body">
                        <!-- TAB 1: IMPORT -->
                        <div class="sui-tab-panel" id="sui-panel-import">
                            <div class="sui-input-group">
                                <label for="sui-url-input">Enter Spotify URL or URI</label>
                                <div class="sui-input-row">
                                    <input type="text" id="sui-url-input" class="sui-input" placeholder="Paste Spotify Playlist, Album, or Track link (e.g. open.spotify.com/track/...)" />
                                    <button class="sui-btn primary" id="sui-btn-fetch">Fetch</button>
                                </div>
                                <span class="sui-hint">Supports full playlists (500+ tracks), entire albums, and single tracks.</span>
                            </div>

                            <!-- Preview Box -->
                            <div class="sui-preview hidden" id="sui-preview-box">
                                <img id="sui-prev-img" class="sui-prev-img" src="" alt="" />
                                <div class="sui-prev-meta">
                                    <h4 id="sui-prev-title">Title</h4>
                                    <p id="sui-prev-sub">Details</p>
                                    <span class="sui-prev-badge" id="sui-prev-type">PLAYLIST</span>
                                </div>
                                <div class="sui-prev-actions">
                                    <button class="sui-btn primary" id="sui-btn-convert">Start Import</button>
                                    <button class="sui-btn danger" id="sui-btn-stop" disabled>Stop</button>
                                </div>
                            </div>

                            <!-- Progress & Stats -->
                            <div class="sui-progress-section hidden" id="sui-progress-box">
                                <div class="sui-progress-bar-bg">
                                    <div class="sui-progress-bar-fill" id="sui-progress-fill" style="width: 0%"></div>
                                </div>
                                <div class="sui-stats-row">
                                    <span>Processed: <strong id="sui-stat-proc">0</strong></span>
                                    <span>Matched: <strong id="sui-stat-matched" class="text-green">0</strong></span>
                                    <span>Not Found: <strong id="sui-stat-missed" class="text-red">0</strong></span>
                                    <span>Status: <strong id="sui-stat-status">Ready</strong></span>
                                </div>
                            </div>

                            <!-- Live Activity Log -->
                            <div class="sui-log-box" id="sui-log">
                                <div class="sui-log-item info">Ready. Paste any Spotify URL above to begin.</div>
                            </div>
                        </div>

                        <!-- TAB 2: SETTINGS -->
                        <div class="sui-tab-panel hidden" id="sui-panel-settings">
                            <div class="sui-card">
                                <h3>Official Spotify Developer API (Optional)</h3>
                                <p class="sui-p">Entering your free Spotify API keys completely unlocks unlimited 5,000+ track playlists with zero rate limits and blazing speed.</p>
                                
                                <div class="sui-field">
                                    <label>Client ID</label>
                                    <input type="text" id="sui-cfg-client-id" class="sui-input" placeholder="e.g. 4a8b7c..." />
                                </div>
                                <div class="sui-field">
                                    <label>Client Secret</label>
                                    <input type="password" id="sui-cfg-client-secret" class="sui-input" placeholder="e.g. 9f1e2d..." />
                                </div>

                                <div class="sui-field">
                                    <label>Search Concurrency (Worker Threads)</label>
                                    <input type="number" id="sui-cfg-concurrency" class="sui-input" min="2" max="10" value="6" />
                                    <span class="sui-hint">Higher values import faster. Default: 6</span>
                                </div>

                                <button class="sui-btn primary" id="sui-btn-save-cfg">Save Settings</button>

                                <div class="sui-guide">
                                    <strong>How to get free Spotify API keys in 1 minute:</strong>
                                    <ol>
                                        <li>Log in to <a href="https://developer.spotify.com/dashboard" target="_blank">developer.spotify.com/dashboard</a></li>
                                        <li>Click <strong>Create App</strong> (App Name: "Audion", Redirect URI: <code>http://localhost</code>)</li>
                                        <li>Click <strong>Settings</strong> to view your <strong>Client ID</strong> and <strong>Client Secret</strong>.</li>
                                    </ol>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- SINGLE TRACK SAVE DESTINATION MODAL -->
                <div class="sui-modal-dialog hidden" id="sui-single-prompt">
                    <div class="sui-prompt-card">
                        <h3>Choose Where to Save Track</h3>
                        <div class="sui-track-preview-row">
                            <img id="sui-st-cover" class="sui-track-thumb" src="" alt="" />
                            <div>
                                <h4 id="sui-st-title">Track Title</h4>
                                <p id="sui-st-artist">Artist Name</p>
                            </div>
                        </div>

                        <div class="sui-dest-options">
                            <label class="sui-radio-row">
                                <input type="radio" name="sui-dest" value="library" checked />
                                <span>Add to Main Library</span>
                            </label>

                            <label class="sui-radio-row">
                                <input type="radio" name="sui-dest" value="existing_playlist" />
                                <span>Add to an Existing Playlist:</span>
                            </label>
                            <select id="sui-st-playlist-select" class="sui-input sui-select"></select>

                            <label class="sui-radio-row">
                                <input type="radio" name="sui-dest" value="new_playlist" />
                                <span>Create a New Playlist:</span>
                            </label>
                            <input type="text" id="sui-st-new-playlist-name" class="sui-input" placeholder="e.g. My Favorites" />

                            <label class="sui-radio-row">
                                <input type="radio" name="sui-dest" value="download" />
                                <span>Download to Local Computer (MP3)</span>
                            </label>
                        </div>

                        <div class="sui-prompt-actions">
                            <button class="sui-btn" id="sui-st-cancel">Cancel</button>
                            <button class="sui-btn primary" id="sui-st-confirm">Save Track</button>
                        </div>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);
            this.bindEvents();
        },

        bindEvents() {
            // Close modal
            document.getElementById('sui-close-btn')?.addEventListener('click', () => this.closeModal());
            document.getElementById('sui-backdrop')?.addEventListener('click', () => this.closeModal());

            // Tab switching
            const tabs = document.querySelectorAll('.sui-tab');
            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    tabs.forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    const target = tab.getAttribute('data-tab');
                    document.getElementById('sui-panel-import')?.classList.toggle('hidden', target !== 'import');
                    document.getElementById('sui-panel-settings')?.classList.toggle('hidden', target !== 'settings');
                });
            });

            // Fetch Button
            const urlInput = document.getElementById('sui-url-input');
            const fetchBtn = document.getElementById('sui-btn-fetch');
            const onFetchClick = async () => {
                const raw = urlInput?.value?.trim();
                if (!raw) return alert('Please enter a Spotify link or URI.');

                const parsed = this.parseSpotifyInput(raw);
                if (!parsed) {
                    this.log('Invalid Spotify URL. Please paste a valid playlist, album, or track link.', 'error');
                    return;
                }
                this.parsedItem = parsed;

                try {
                    this.setStatus('Fetching...', 'active');
                    if (parsed.type === 'track') {
                        const trackData = await this.fetchTrack(parsed.id, parsed.rawUrl);
                        this.openSingleTrackPrompt(trackData);
                    } else if (parsed.type === 'playlist') {
                        const playlistData = await this.fetchPlaylist(parsed.id);
                        this.showPreview(playlistData, 'PLAYLIST');
                    } else if (parsed.type === 'album') {
                        const albumData = await this.fetchAlbum(parsed.id);
                        this.showPreview(albumData, 'ALBUM');
                    }
                } catch (err) {
                    this.log(`Error: ${err.message}`, 'error');
                    this.setStatus('Error', 'err');
                }
            };

            fetchBtn?.addEventListener('click', onFetchClick);
            urlInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') onFetchClick();
            });

            // Start Batch Convert
            document.getElementById('sui-btn-convert')?.addEventListener('click', () => {
                if (this.parsedItem?.data) {
                    document.getElementById('sui-progress-box')?.classList.remove('hidden');
                    this.processBatchImport(this.parsedItem.data);
                }
            });

            // Stop Convert
            document.getElementById('sui-btn-stop')?.addEventListener('click', () => {
                this.stopConversion();
            });

            // Save Settings
            document.getElementById('sui-btn-save-cfg')?.addEventListener('click', () => {
                const cid = document.getElementById('sui-cfg-client-id')?.value?.trim();
                const sec = document.getElementById('sui-cfg-client-secret')?.value?.trim();
                const conc = parseInt(document.getElementById('sui-cfg-concurrency')?.value, 10);

                this.settings.clientId = cid || '';
                this.settings.clientSecret = sec || '';
                this.settings.concurrency = isNaN(conc) ? 6 : conc;
                this.saveSettings();
                this.spotifyAccessToken = null; // Invalidate cached token
                alert('Settings saved successfully!');
            });

            // Single Track Prompt Actions
            document.getElementById('sui-st-cancel')?.addEventListener('click', () => {
                this.closeSingleTrackPrompt();
            });

            document.getElementById('sui-st-confirm')?.addEventListener('click', () => {
                const selectedRadio = document.querySelector('input[name="sui-dest"]:checked');
                const dest = selectedRadio ? selectedRadio.value : 'library';
                const plSelect = document.getElementById('sui-st-playlist-select');
                const newPlInput = document.getElementById('sui-st-new-playlist-name');

                this.executeSingleTrackSave(dest, {
                    playlistId: plSelect ? plSelect.value : null,
                    playlistName: newPlInput ? newPlInput.value.trim() : null
                });
            });
        },

        showPreview(data, typeBadge) {
            this.parsedItem.data = data;
            const box = document.getElementById('sui-preview-box');
            const img = document.getElementById('sui-prev-img');
            const title = document.getElementById('sui-prev-title');
            const sub = document.getElementById('sui-prev-sub');
            const badge = document.getElementById('sui-prev-type');

            if (img) img.src = data.image || 'https://via.placeholder.com/150';
            if (title) title.textContent = data.title;
            if (sub) sub.textContent = `${data.total} tracks ready to import`;
            if (badge) badge.textContent = typeBadge;

            if (box) box.classList.remove('hidden');
        },

        toggleModal() {
            if (this.isOpen) this.closeModal(); else this.openModal();
        },

        openModal() {
            this.isOpen = true;
            document.getElementById('sui-overlay')?.classList.remove('hidden');

            // Populate current settings into inputs
            const cid = document.getElementById('sui-cfg-client-id');
            const sec = document.getElementById('sui-cfg-client-secret');
            const conc = document.getElementById('sui-cfg-concurrency');
            if (cid) cid.value = this.settings.clientId || '';
            if (sec) sec.value = this.settings.clientSecret || '';
            if (conc) conc.value = this.settings.concurrency || 6;
        },

        closeModal() {
            this.isOpen = false;
            document.getElementById('sui-overlay')?.classList.add('hidden');
        },

        updateFetchStatus(msg) {
            this.log(msg, 'info');
        },

        updateProgress(percent) {
            const bar = document.getElementById('sui-progress-fill');
            if (bar) bar.style.width = `${percent}%`;
        },

        updateStats(proc, matched, missed) {
            const elProc = document.getElementById('sui-stat-proc');
            const elMatched = document.getElementById('sui-stat-matched');
            const elMissed = document.getElementById('sui-stat-missed');
            if (elProc) elProc.textContent = proc;
            if (elMatched) elMatched.textContent = matched;
            if (elMissed) elMissed.textContent = missed;
        },

        setStatus(text, type) {
            const el = document.getElementById('sui-stat-status');
            if (!el) return;
            el.textContent = text;
            el.className = type === 'ok' ? 'text-green' : (type === 'err' ? 'text-red' : '');
        },

        log(msg, type = 'info') {
            const box = document.getElementById('sui-log');
            if (!box) return;
            const div = document.createElement('div');
            div.className = `sui-log-item ${type}`;
            div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            box.prepend(div);
        },

        // ── Stylesheet ───────────────────────────────────────────────

        injectStyles() {
            if (document.getElementById('sui-styles')) return;
            const style = document.createElement('style');
            style.id = 'sui-styles';
            style.textContent = `
                .sui-icon-btn {
                    background: transparent;
                    border: none;
                    color: var(--text-secondary, #b3b3b3);
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 8px;
                    border-radius: 50%;
                    transition: all 0.2s ease;
                }
                .sui-icon-btn:hover {
                    color: #1ed760;
                    background: rgba(30, 215, 96, 0.1);
                }

                .sui-menu-item {
                    padding: 10px 14px;
                    color: #fff;
                    cursor: pointer;
                    font-size: 14px;
                }
                .sui-menu-item:hover {
                    background: rgba(255, 255, 255, 0.08);
                }

                .sui-overlay {
                    position: fixed; inset: 0;
                    z-index: 99999;
                    display: flex; align-items: center; justify-content: center;
                }
                .sui-overlay.hidden, .sui-modal-dialog.hidden, .sui-tab-panel.hidden, .hidden {
                    display: none !important;
                }

                .sui-backdrop {
                    position: absolute; inset: 0;
                    background: rgba(0, 0, 0, 0.75);
                    backdrop-filter: blur(6px);
                }

                .sui-dialog {
                    position: relative;
                    width: 720px;
                    max-width: 90vw;
                    max-height: 85vh;
                    background: var(--bg-surface, #181818);
                    border: 1px solid var(--border-color, #282828);
                    border-radius: 12px;
                    color: var(--text-primary, #fff);
                    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.7);
                    display: flex; flex-direction: column;
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                }

                .sui-header {
                    display: flex; align-items: center; justify-content: space-between;
                    padding: 16px 20px;
                    border-bottom: 1px solid #282828;
                }
                .sui-brand {
                    display: flex; align-items: center; gap: 10px;
                }
                .sui-brand h2 {
                    margin: 0; font-size: 17px; font-weight: 600;
                }
                .sui-spotify-icon {
                    width: 20px; height: 20px;
                    background: #1ed760;
                    border-radius: 50%;
                    display: inline-block;
                }
                .sui-close {
                    background: transparent; border: none;
                    color: #888; font-size: 24px; cursor: pointer;
                }
                .sui-close:hover { color: #fff; }

                .sui-tabs {
                    display: flex;
                    background: var(--bg-base, #121212);
                    border-bottom: 1px solid #282828;
                }
                .sui-tab {
                    padding: 12px 20px;
                    background: transparent; border: none;
                    border-bottom: 2px solid transparent;
                    color: #888; font-size: 13px; font-weight: 500; cursor: pointer;
                }
                .sui-tab.active {
                    color: #1ed760; border-bottom-color: #1ed760;
                }

                .sui-body {
                    padding: 20px; overflow-y: auto; flex: 1;
                    display: flex; flex-direction: column; gap: 16px;
                }

                .sui-input-group label {
                    display: block; font-size: 13px; margin-bottom: 6px; color: #bbb;
                }
                .sui-input-row {
                    display: flex; gap: 8px;
                }
                .sui-input {
                    flex: 1; padding: 10px 14px;
                    background: #101010; border: 1px solid #333;
                    border-radius: 6px; color: #fff; font-size: 13px;
                }
                .sui-input:focus {
                    outline: none; border-color: #1ed760;
                }
                .sui-hint {
                    display: block; margin-top: 6px; font-size: 11px; color: #777;
                }

                .sui-btn {
                    padding: 9px 18px; background: #282828;
                    border: 1px solid #3e3e3e; border-radius: 6px;
                    color: #fff; font-size: 13px; font-weight: 500; cursor: pointer;
                }
                .sui-btn:hover { background: #333; }
                .sui-btn.primary {
                    background: #1ed760; color: #000; border: none; font-weight: 600;
                }
                .sui-btn.primary:hover { filter: brightness(1.1); }
                .sui-btn.danger {
                    background: #992323; border-color: #771d1d;
                }
                .sui-btn:disabled {
                    opacity: 0.5; cursor: not-allowed;
                }

                .sui-preview {
                    display: flex; align-items: center; gap: 16px;
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid #282828; border-radius: 8px;
                    padding: 12px 16px;
                }
                .sui-prev-img {
                    width: 70px; height: 70px; border-radius: 6px; object-fit: cover;
                }
                .sui-prev-meta { flex: 1; }
                .sui-prev-meta h4 { margin: 0 0 4px 0; font-size: 15px; }
                .sui-prev-meta p { margin: 0 0 6px 0; font-size: 12px; color: #888; }
                .sui-prev-badge {
                    font-size: 10px; font-weight: 700; background: #1ed760;
                    color: #000; padding: 2px 6px; border-radius: 4px;
                }
                .sui-prev-actions { display: flex; gap: 8px; }

                .sui-progress-section {
                    display: flex; flex-direction: column; gap: 8px;
                }
                .sui-progress-bar-bg {
                    height: 8px; background: #282828; border-radius: 4px; overflow: hidden;
                }
                .sui-progress-bar-fill {
                    height: 100%; background: #1ed760; transition: width 0.2s ease;
                }
                .sui-stats-row {
                    display: flex; justify-content: space-between; font-size: 12px; color: #aaa;
                }
                .text-green { color: #1ed760; }
                .text-red { color: #e74c3c; }

                .sui-log-box {
                    background: #0d0d0d; border-radius: 6px;
                    border: 1px solid #222; padding: 10px 14px;
                    max-height: 160px; overflow-y: auto;
                    font-family: monospace; font-size: 11px;
                }
                .sui-log-item { padding: 2px 0; }
                .sui-log-item.info { color: #aaa; }
                .sui-log-item.success { color: #1ed760; }
                .sui-log-item.warn { color: #f39c12; }
                .sui-log-item.error { color: #e74c3c; }

                .sui-card {
                    background: rgba(255, 255, 255, 0.02);
                    border: 1px solid #282828; border-radius: 8px; padding: 18px;
                    display: flex; flex-direction: column; gap: 14px;
                }
                .sui-card h3 { margin: 0; font-size: 16px; }
                .sui-p { margin: 0; font-size: 13px; color: #888; line-height: 1.5; }
                .sui-field { display: flex; flex-direction: column; gap: 6px; }
                .sui-field label { font-size: 12px; color: #bbb; }
                .sui-guide {
                    background: rgba(30, 215, 96, 0.05); border: 1px solid rgba(30, 215, 96, 0.2);
                    border-radius: 6px; padding: 12px; font-size: 12px; color: #ccc;
                }
                .sui-guide ol { margin: 6px 0 0 16px; padding: 0; }
                .sui-guide a { color: #1ed760; }

                /* Single Track Destination Modal */
                .sui-modal-dialog {
                    position: fixed; inset: 0; z-index: 100000;
                    background: rgba(0, 0, 0, 0.8);
                    display: flex; align-items: center; justify-content: center;
                }
                .sui-prompt-card {
                    width: 480px; max-width: 90vw; background: #1a1a1a;
                    border: 1px solid #333; border-radius: 12px; padding: 22px;
                    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8);
                    display: flex; flex-direction: column; gap: 16px;
                }
                .sui-prompt-card h3 { margin: 0; font-size: 17px; }
                .sui-track-preview-row {
                    display: flex; gap: 14px; align-items: center;
                    background: #111; padding: 10px; border-radius: 8px;
                }
                .sui-track-thumb {
                    width: 50px; height: 50px; border-radius: 6px; object-fit: cover;
                }
                .sui-track-preview-row h4 { margin: 0 0 3px 0; font-size: 14px; }
                .sui-track-preview-row p { margin: 0; font-size: 12px; color: #888; }
                .sui-dest-options {
                    display: flex; flex-direction: column; gap: 10px;
                }
                .sui-radio-row {
                    display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;
                }
                .sui-select { margin-left: 22px; width: calc(100% - 22px); }
                #sui-st-new-playlist-name { margin-left: 22px; width: calc(100% - 22px); }
                .sui-prompt-actions {
                    display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px;
                }
            `;
            document.head.appendChild(style);
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
