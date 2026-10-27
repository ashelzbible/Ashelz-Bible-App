# Design system

Source of truth: the supplied Wazzupp reference images. Measured values (sampled with PIL from the reference) were mapped onto the brand palette.

Tokens live in `web/src/styles/tokens.css` (brand values + semantic roles + dark theme). Components never use raw hex values except in the token file.

| Reference element | Implementation |
|---|---|
| Dark emerald rail + dark header with search, white inset list card | `.left-dark`, `.rail`, `.pane-top`, `.list-card` (`layout.css`) |
| Selected rail item (mint-tinted block, mint icon) | `.rail-item.active` |
| Chat panel: light header, warm doodle wallpaper, white/green bubbles with tails, blue double ticks | `.conv-head`, `.wallpaper` (`public/wallpaper-*.svg`), `.bubble`, `.tick.read` |
| Composer: emoji, attach, input pill, camera, green mic/send circle | `Composer.tsx` |
| Info panel: avatar, actions, media thumbnails, starred, mute toggle, disappearing | `InfoPanel.tsx` |
| Phone: deep green app bar, ringed status row, green unread badges, bottom tabs with red badge | `PaneFrame` mobile variant, `StatusStrip`, `.bottom-nav` |
| Tablet: white title header, filter chips, split panes | `PaneFrame` tablet variant |
| Call screen: dark emerald radial background, ringed avatar, round translucent controls, red end button | `.call-overlay` |
| Communities: coloured tiles, 3 columns, add button | `Communities.tsx` |
| Status viewer: segmented progress, avatar header, reply bar | `Status.tsx` |

Deliberate deviations: the reference uses a logo that closely resembles another company's mark and stock-photo avatars. Wazzupp uses its own supplied logo and initials/uploaded avatars. The reference's "end-to-end encrypted" copy is replaced with an accurate statement (E2EE is not implemented).

Breakpoints: phone < 700 px (single pane + bottom nav), tablet 700-1279 px (split panes), desktop >= 1280 px (rail + list + conversation + optional info panel at >= 1360 px).
