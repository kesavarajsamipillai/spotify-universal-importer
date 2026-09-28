# Spotify Universal Importer for Audion

A high-performance Spotify importer for [Audion](https://github.com/dupitydumb/Audion) designed to resolve the limitations of existing converters.

---

## ⚡ Key Improvements Over Existing Plugins

1. **No 500-Song Cutoff (Full Pagination)**:
   - Existing plugins stopped at 499 tracks due to fragile, non-paginated proxy endpoints.
   - Spotify Universal Importer features complete chunked pagination (`limit=100`, dynamic offset loop) supporting **500+, 1,000+, and even 5,000+ songs**.

2. **Single Song Support with Destination Picker**:
   - Accepts any track URL (e.g. `open.spotify.com/track/...`).
   - Displays track preview and prompts the user:
     - *Add to Main Library*
     - *Add to an Existing Playlist* (dynamically loaded from Audion)
     - *Create a New Playlist*
     - *Download MP3 Locally*

3. **Full Album Support**:
   - Supports importing entire albums directly into Audion as playlists or library collections.

4. **Hybrid API Authentication**:
   - **Zero-Config Public Mode**: Works out-of-the-box without requiring any developer setup.
   - **Official Spotify Developer API Mode**: Enter your free Spotify Client ID & Secret in the Settings tab to enjoy zero rate-limiting and blazing fast imports for massive libraries.

5. **Multi-Threaded Parallel Search Matching**:
   - Configurable search concurrency (up to 10 workers) matching songs against Audion sources (JioSaavn, Qobuz, etc.) in parallel.

---

## 🚀 Installation & Local Testing

### Fast Install (Windows)
Run in PowerShell:
```powershell
powershell -ExecutionPolicy Bypass -File .\install-local.ps1
```

### In Audion:
1. Open **Audion**.
2. Go to **Settings > Plugins**.
3. Click **Reload Plugins** and enable **Spotify Universal Importer**.
4. Click the Spotify icon in the bottom right player bar or popup plugin menu.

---

## 🌐 Publishing to Audion Marketplace

To make this plugin available in the global Audion Marketplace:
1. Push this folder to a public GitHub repository (e.g. `https://github.com/kesavarajsamipillai/spotify-universal-importer`).
2. In your GitHub repository settings, add the topic:
   ```text
   audion-plugins
   ```
3. Audion's automated indexer will validate your `plugin.json` and list it in the in-app marketplace.
