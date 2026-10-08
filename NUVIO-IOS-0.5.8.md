# NuvioWeb iOS 0.5.8

Standalone iOS/PWA project derived from the existing NuvioWeb iOS fork and aligned with NuvioMobile 0.5.8-beta.

## Project identity

- Project: NuvioWeb iOS 0.5.8
- Branch: `project-nuvio-ios-0.5.8`
- NuvioMobile base: `0.5.8-beta`
- NuvioMobile commit: `1ae5066a4dd5026228625e40082eacc3ada68436`
- Reference IPA: `nuvio-0.5.8-full-release.ipa`
- Reference IPA SHA-256: `7aa44bc33bfbf9e4edc8551fba5860d125e0ff5df418118d8bc2d668b5c4698f`

The production `web` branch is not modified by work in this project.

## Existing iOS/web features retained

- iPhone/iPad PWA support
- Safari native HLS plus hls.js fallback
- AirPlay and Picture in Picture
- CZ/SK stream priority and quality-aware ordering
- browser media proxy and provider header handling
- browser HLS remux support used by provider compatibility fixes
- subtitles, playback progress, Continue Watching and source switching
- installed Stremio/Nuvio addon compatibility

## NuvioMobile 0.5.8 port map

### Included / being ported

1. `ytId`-only stream compatibility (`NuvioMobile #2115`).
   The web repository already preserves `ytId` in parsed addon streams. The standalone project adds the playback-resolution/fallback layer rather than dropping these sources.
2. Next-episode transition reset (`#2193`).
   Web next-episode prefetch/launch state is reset on episode transition so a new episode can preload independently.
3. Hero stability (`#2190`).
   Mobile/tablet hero state must not move due to transient horizontal layout changes.
4. MDBList release-date ordering (`#2196`).
   Library-backed MDBList rows prefer release-date order when the upstream list provides release information.

### Experimental / isolated

5. Jellyfin and Emby (`#2081`).
   This remains an opt-in server integration. It must not alter or block Stremio addon loading or normal stream playback.
6. Croatian localization (`#2169`).
   Added only where the web translation surface has equivalent keys.

## Compatibility policy

Changes specific to the 0.5.8 mobile behavior must be additive. Existing provider fixes, iOS Safari playback paths, AirPlay/PiP and CZ/SK sorting are not replaced by mobile-only assumptions.

YouTube resolver URLs are treated as temporary and must not be stored as reusable stream links.
