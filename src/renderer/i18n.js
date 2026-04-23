import en from '../locales/en.json';
import ko from '../locales/ko.json';
import zh from '../locales/zh.json';
import zhTW from '../locales/zh-TW.json';
import ja from '../locales/ja.json';
import es from '../locales/es.json';
import fr from '../locales/fr.json';
import de from '../locales/de.json';
import pt from '../locales/pt.json';
import ru from '../locales/ru.json';
import ar from '../locales/ar.json';
import hi from '../locales/hi.json';
import it from '../locales/it.json';
import nl from '../locales/nl.json';
import pl from '../locales/pl.json';
import tr from '../locales/tr.json';
import vi from '../locales/vi.json';
import th from '../locales/th.json';
import sv from '../locales/sv.json';
import da from '../locales/da.json';
import fi from '../locales/fi.json';
import nb from '../locales/nb.json';
import cs from '../locales/cs.json';
import el from '../locales/el.json';
import hu from '../locales/hu.json';
import ro from '../locales/ro.json';
import uk from '../locales/uk.json';
import id from '../locales/id.json';
import ms from '../locales/ms.json';
import he from '../locales/he.json';

const locales = {
  en, ko, zh, 'zh-TW': zhTW, ja, es, fr, de, pt, ru,
  ar, hi, it, nl, pl, tr, vi, th, sv, da,
  fi, nb, cs, el, hu, ro, uk, id, ms, he,
};

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ko', name: '한국어' },
  { code: 'zh', name: '简体中文' },
  { code: 'zh-TW', name: '繁體中文' },
  { code: 'ja', name: '日本語' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
  { code: 'pt', name: 'Português' },
  { code: 'ru', name: 'Русский' },
  { code: 'ar', name: 'العربية' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'tr', name: 'Türkçe' },
  { code: 'vi', name: 'Tiếng Việt' },
  { code: 'th', name: 'ไทย' },
  { code: 'sv', name: 'Svenska' },
  { code: 'da', name: 'Dansk' },
  { code: 'fi', name: 'Suomi' },
  { code: 'nb', name: 'Norsk' },
  { code: 'cs', name: 'Čeština' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'hu', name: 'Magyar' },
  { code: 'ro', name: 'Română' },
  { code: 'uk', name: 'Українська' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'he', name: 'עברית' },
];

let current = en;
let currentCode = 'en';

export function setLocale(code) {
  currentCode = locales[code] ? code : 'en';
  current = locales[currentCode];
  document.documentElement.lang = currentCode;
  document.body.dataset.dropText = current.dropHere;
}

export function t(key) {
  return current[key] || en[key] || key;
}

export function getLocaleCode() {
  return currentCode;
}
