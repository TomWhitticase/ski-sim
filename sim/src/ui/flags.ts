import { polyfillCountryFlagEmojis } from 'country-flag-emoji-polyfill';
// Bundled, not fetched from the package's CDN: the sim only goes online for its data.
import flagsFont from 'country-flag-emoji-polyfill/dist/TwemojiCountryFlags.woff2?url';

/**
 * Country flags (the menu's 🇫🇷 🇨🇭) on systems with no flag emoji of their own, i.e.
 * Windows: there they'd show as the letters "FR". This loads a small font of just the
 * flags (Twemoji, CC BY 4.0) only where it's needed; theme.css puts it first in the
 * font stacks, and it has no other characters, so the rest of the text is unchanged.
 */
export function polyfillFlags(): void {
  polyfillCountryFlagEmojis('Twemoji Country Flags', flagsFont);
}
