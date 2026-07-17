/**
 * Translation Service
 *
 * Detects language and translates messages between English and
 * the customer's native language.
 *
 * Features:
 *   - Automatic language detection
 *   - Translation to English for CRM viewing
 *   - Translation back to customer language for replies
 *   - Preserves original text — never overwrites
 *   - Supports all major languages
 *
 * Currently uses a simple API-based approach.
 * In production, integrate with Google Cloud Translation API,
 * AWS Translate, or DeepL.
 */
const axios = require("axios");

// ─── Configuration ─────────────────────────────────────────────────────────

const TRANSLATION_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || null;
const TRANSLATION_API_URL = "https://translation.googleapis.com/language/translate/v2";

// ─── Supported Languages ───────────────────────────────────────────────────

const SUPPORTED_LANGUAGES = {
  af: "Afrikaans",
  sq: "Albanian",
  am: "Amharic",
  ar: "Arabic",
  hy: "Armenian",
  az: "Azerbaijani",
  eu: "Basque",
  be: "Belarusian",
  bn: "Bengali",
  bs: "Bosnian",
  bg: "Bulgarian",
  ca: "Catalan",
  ceb: "Cebuano",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  co: "Corsican",
  hr: "Croatian",
  cs: "Czech",
  da: "Danish",
  nl: "Dutch",
  en: "English",
  eo: "Esperanto",
  et: "Estonian",
  fi: "Finnish",
  fr: "French",
  fy: "Frisian",
  gl: "Galician",
  ka: "Georgian",
  de: "German",
  el: "Greek",
  gu: "Gujarati",
  ht: "Haitian Creole",
  ha: "Hausa",
  haw: "Hawaiian",
  he: "Hebrew",
  hi: "Hindi",
  hmn: "Hmong",
  hu: "Hungarian",
  is: "Icelandic",
  ig: "Igbo",
  id: "Indonesian",
  ga: "Irish",
  it: "Italian",
  ja: "Japanese",
  jw: "Javanese",
  kn: "Kannada",
  kk: "Kazakh",
  km: "Khmer",
  rw: "Kinyarwanda",
  ko: "Korean",
  ku: "Kurdish",
  ky: "Kyrgyz",
  lo: "Lao",
  la: "Latin",
  lv: "Latvian",
  lt: "Lithuanian",
  lb: "Luxembourgish",
  mk: "Macedonian",
  mg: "Malagasy",
  ms: "Malay",
  ml: "Malayalam",
  mt: "Maltese",
  mi: "Maori",
  mr: "Marathi",
  mn: "Mongolian",
  my: "Myanmar (Burmese)",
  ne: "Nepali",
  no: "Norwegian",
  ny: "Nyanja (Chichewa)",
  or: "Odia (Oriya)",
  ps: "Pashto",
  fa: "Persian",
  pl: "Polish",
  pt: "Portuguese",
  pa: "Punjabi",
  ro: "Romanian",
  ru: "Russian",
  sm: "Samoan",
  gd: "Scots Gaelic",
  sr: "Serbian",
  st: "Sesotho",
  sn: "Shona",
  sd: "Sindhi",
  si: "Sinhala (Sinhalese)",
  sk: "Slovak",
  sl: "Slovenian",
  so: "Somali",
  es: "Spanish",
  su: "Sundanese",
  sw: "Swahili",
  sv: "Swedish",
  tl: "Tagalog (Filipino)",
  tg: "Tajik",
  ta: "Tamil",
  tt: "Tatar",
  te: "Telugu",
  th: "Thai",
  tr: "Turkish",
  tk: "Turkmen",
  uk: "Ukrainian",
  ur: "Urdu",
  ug: "Uyghur",
  uz: "Uzbek",
  vi: "Vietnamese",
  cy: "Welsh",
  xh: "Xhosa",
  yi: "Yiddish",
  yo: "Yoruba",
  zu: "Zulu",
};

/**
 * Get a human-readable language name from a language code.
 *
 * @param {string} code - Language code (e.g., 'es', 'fr')
 * @returns {string} Language name
 */
function getLanguageName(code) {
  return SUPPORTED_LANGUAGES[code] || code || "Unknown";
}

/**
 * Detect the language of a text string.
 *
 * Uses Google Cloud Translation API if configured.
 * Falls back to simple heuristics.
 *
 * @param {string} text - Text to detect language for
 * @returns {Promise<{language: string, confidence: number}>}
 */
async function detectLanguage(text) {
  if (!text || text.trim().length < 3) {
    return { language: "en", confidence: 1.0 };
  }

  // If API key is configured, use Google Cloud Translation
  if (TRANSLATION_API_KEY) {
    try {
      const response = await axios.post(
        `${TRANSLATION_API_URL}/detect`,
        { q: text },
        { params: { key: TRANSLATION_API_KEY } }
      );

      const detection = response.data?.data?.detections?.[0]?.[0];
      if (detection) {
        return {
          language: detection.language,
          confidence: detection.confidence || 1.0,
        };
      }
    } catch (err) {
      console.warn("[TRANSLATION] Detection API error:", err.message);
    }
  }

  // Simple heuristic: check if text contains mostly ASCII characters
  const nonAsciiRatio = [...text].filter((c) => c.charCodeAt(0) > 127).length / text.length;

  if (nonAsciiRatio < 0.1) {
    return { language: "en", confidence: 0.6 };
  }

  // If we can't detect, assume English
  return { language: "en", confidence: 0.5 };
}

/**
 * Translate text from one language to another.
 *
 * Used for:
 *   - Customer message → English (for CRM viewing)
 *   - Agent reply → Customer language (for sending)
 *
 * @param {string} text - Text to translate
 * @param {string} targetLanguage - Target language code (e.g., 'en', 'es')
 * @param {string} [sourceLanguage] - Source language code (auto-detect if not provided)
 * @returns {Promise<{translatedText: string, detectedLanguage: string|null}>}
 */
async function translate(text, targetLanguage, sourceLanguage = null) {
  if (!text || text.trim().length === 0) {
    return { translatedText: text, detectedLanguage: null };
  }

  // If target is same as source, no translation needed
  if (sourceLanguage && sourceLanguage === targetLanguage) {
    return { translatedText: text, detectedLanguage: sourceLanguage };
  }

  // If API key is configured, use Google Cloud Translation
  if (TRANSLATION_API_KEY) {
    try {
      const params = {
        q: text,
        target: targetLanguage,
        key: TRANSLATION_API_KEY,
      };

      if (sourceLanguage) {
        params.source = sourceLanguage;
      }

      const response = await axios.post(TRANSLATION_API_URL, null, { params });

      const translation = response.data?.data?.translations?.[0];
      if (translation) {
        return {
          translatedText: translation.translatedText,
          detectedLanguage: translation.detectedSourceLanguage || null,
        };
      }
    } catch (err) {
      console.warn("[TRANSLATION] API error:", err.message);
    }
  }

  // Fallback: return original text
  return { translatedText: text, detectedLanguage: sourceLanguage };
}

/**
 * Translate a customer message to English for CRM viewing.
 *
 * @param {string} text - Original message text
 * @param {string} [sourceLanguage] - Detected or assumed source language
 * @returns {Promise<{translatedText: string, originalLanguage: string|null}>}
 */
async function translateToEnglish(text, sourceLanguage = null) {
  const detected = sourceLanguage || (await detectLanguage(text)).language;

  if (detected === "en") {
    return { translatedText: text, originalLanguage: "en" };
  }

  const result = await translate(text, "en", detected);
  return {
    translatedText: result.translatedText,
    originalLanguage: detected,
  };
}

/**
 * Translate an agent's reply to the customer's language.
 *
 * @param {string} text - Agent's reply in English
 * @param {string} targetLanguage - Customer's language code
 * @returns {Promise<string>} Translated text
 */
async function translateReply(text, targetLanguage) {
  if (targetLanguage === "en") return text;

  const result = await translate(text, targetLanguage, "en");
  return result.translatedText;
}

/**
 * Check if a language is not English (needs translation).
 *
 * @param {string} languageCode - Language code to check
 * @returns {boolean}
 */
function needsTranslation(languageCode) {
  if (!languageCode) return false;
  return languageCode !== "en";
}

module.exports = {
  detectLanguage,
  translate,
  translateToEnglish,
  translateReply,
  getLanguageName,
  needsTranslation,
  SUPPORTED_LANGUAGES,
};