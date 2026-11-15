import fr from './fr.json';
import en from './en.json';

export type Locale = 'fr' | 'en';
export type MessageKey = keyof typeof fr;
const dicts: Record<Locale, Record<MessageKey, string>> = { fr, en };

/** French is the default; a missing English key falls back to French. */
export function translate(locale: Locale, key: MessageKey): string {
  return dicts[locale][key] ?? dicts.fr[key] ?? key;
}
