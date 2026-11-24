'use strict';

const FAST_MODEL = 'gemini-3.1-pro-preview';
const PREMIUM_MODEL = 'gemini-3.1-pro-preview';
const { isValidModelName } = require('./settingsService');

function generationError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildBlacklistRule(blacklist) {
  if (!blacklist) return '';
  return `SZIGORÚ TILTÁS: a pedagógus az alábbiakat kifejezetten kizárta. Ezeket a témákat, dalokat, eszközöket, szavakat SEHOL ne használd és ne említsd a tervben (sem a táblázatban, sem az eszközlistában, sem a módszereknél), semmilyen formában vagy szinonímával kerülve a használatot: ${JSON.stringify(blacklist)}`;
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(prompt, {
  model = FAST_MODEL,
  maxOutputTokens = 12288,
  timeoutMs = 120000,
  blacklist = '',
  systemPrompt = '',
  maxRetries = 2,
  retryDelayMs = (process.env.GEMINI_RETRY_DELAY_MS ? Number(process.env.GEMINI_RETRY_DELAY_MS) : (process.env.NODE_ENV === 'test' ? 10 : 2000))
} = {}, deps = {}) {
  if (!isValidModelName(model)) {
    throw generationError(`Érvénytelen modellnév: ${String(model).slice(0, 60)}.`, 400);
  }
  const env = deps.env || process.env;
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw generationError('Hiányzik a GEMINI_API_KEY szerverbeállítás.', 503);
  }

  const fetchFn = deps.fetch || global.fetch;
  const sleepFn = deps.sleep || sleep;

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: (systemPrompt ? `${systemPrompt}\n\n` : '') + 'A feladatnak megfelelő, teljes magyar foglalkozástervet adj vissza egyetlen valid JSON objektumban. Ne használj markdown-kódblokkot vagy kísérőszöveget.' + (blacklist ? `\n\n${buildBlacklistRule(blacklist)}` : '') }]
          },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            topP: 0.95,
            maxOutputTokens,
            responseMimeType: 'application/json'
          }
        })
      });
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw generationError(`A Gemini kérés ${Math.round(timeoutMs / 1000)} másodpercen belül nem fejeződött be.`, 504);
      }
      throw generationError(`A Gemini API nem érhető el: ${error.message}`);
    }

    const responseText = await response.text();
    const data = safeParseJson(responseText);

    if (!response.ok) {
      const isRetryable = response.status === 503 || response.status === 529 || response.status === 500;
      const reason = data?.error?.message || response.statusText || 'Ismeretlen API-hiba';
      lastError = generationError(`Gemini API (${model}, HTTP ${response.status}): ${reason}`, response.status === 429 ? 429 : (response.status === 503 || response.status === 529 ? 503 : 502));

      if (isRetryable && attempt < maxRetries) {
        console.warn(`[geminiService] HTTP ${response.status} hiba a Gemini API-tól (${attempt + 1}/${maxRetries + 1}. kísérlet). Újrapróbálkozás ${retryDelayMs}ms múlva...`);
        await sleepFn(retryDelayMs);
        continue;
      }
      throw lastError;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw generationError('A Gemini API HTTP-válasza nem valid JSON.');
    }

    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const text = (candidate?.content?.parts || [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text).join('');
    console.info('Gemini generation:', {
      model,
      finishReason,
      promptTokens: data.usageMetadata?.promptTokenCount,
      outputTokens: data.usageMetadata?.candidatesTokenCount,
      thoughtTokens: data.usageMetadata?.thoughtsTokenCount,
      outputCharacters: text.length
    });

    if (finishReason === 'MAX_TOKENS') {
      throw generationError('A Gemini elérte a kimeneti tokenkeretet (MAX_TOKENS). A válasz nem teljes; nem jelenítünk meg csonka dokumentumot.');
    }
    if (finishReason && finishReason !== 'STOP') {
      throw generationError(`A Gemini megszakította a generálást: ${finishReason}.`);
    }
    if (!text.trim()) {
      throw generationError(`A Gemini nem adott dokumentumot.${data.promptFeedback?.blockReason ? ` Blokkolás: ${data.promptFeedback.blockReason}.` : ''}`);
    }
    return text;
  }
}

module.exports = {
  FAST_MODEL,
  PREMIUM_MODEL,
  callGemini,
  generationError,
  buildBlacklistRule,
  safeParseJson
};
