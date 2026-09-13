// ============================================================
// Backend sécurisé pour l'assistant Gemini — Java Torréfié
// ============================================================
// Fonction serverless compatible Vercel (format par défaut).
// La clé GEMINI_API_KEY reste UNIQUEMENT dans les variables
// d'environnement du serveur : elle n'apparaît jamais dans le
// navigateur, dans index.html, script.js, gemini.js, ni dans
// le dépôt GitHub public.
//
// Déploiement :
//   1. Déployer ce projet sur Vercel (ou adapter pour Netlify,
//      Cloudflare Pages Functions, etc. — voir api/README.md).
//   2. Dans les paramètres du projet, définir la variable
//      d'environnement GEMINI_API_KEY (jamais dans le code).
//   3. Le frontend appelle POST /api/gemini (voir gemini.js).
// ============================================================

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

const SYSTEM_INSTRUCTION = `Tu es l'assistant pédagogique Gemini intégré au site "Java Torréfié" de Baba Niang, un guide d'apprentissage du langage Java.

Ton rôle est celui d'un professeur particulier de Java, bienveillant et rigoureux :
1. Comprendre la notion posée par l'étudiant.
2. L'expliquer simplement, avec des mots clairs.
3. Donner un petit exemple de code Java concret.
4. Faire pratiquer si pertinent.
5. Proposer un exercice adapté quand c'est utile.

Quand un étudiant ne comprend pas une notion, ne donne jamais directement "la" réponse toute faite sans explication : explique progressivement, quitte à poser une question en retour pour l'aider à raisonner.

Réponds toujours en français, de façon concise et structurée (utilise des exemples de code Java entre balises de code quand c'est pertinent). Si un contexte de fiche/chapitre est fourni, utilise-le pour cibler ta réponse sans qu'il soit besoin que l'étudiant le répète.

L'étudiant peut aussi joindre une capture d'écran (erreur de compilation, code, message dans un IDE...). Dans ce cas, analyse précisément ce que montre l'image (message d'erreur exact, ligne concernée, code visible) avant d'expliquer la cause et la correction.`;

// --- Rate limiting simple, en mémoire (best-effort) ---
// Sur une fonction serverless, l'instance peut être recréée à
// tout moment : ceci limite les abus basiques mais ne remplace
// pas une solution de rate-limiting persistante (ex. Upstash,
// Redis) pour une protection robuste en production.
const requestLog = new Map(); // ip -> [timestamps]
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "unknown";
}

// Domaine(s) autorisé(s) à appeler ce backend (ton site GitHub Pages).
// Remplace par ton vrai domaine, ex. "https://baba-niang.github.io".
// Mets "*" temporairement en test, mais restreins-le en production.
const ALLOWED_ORIGIN = "https://baba-niang.github.io";

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async function handler(req, res) {
  setCorsHeaders(res);

  // Le navigateur envoie une requête OPTIONS de pré-vérification
  // avant tout POST cross-domaine : il faut y répondre sans erreur.
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée." });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Ne jamais révéler de détails techniques dans l'erreur.
    res.status(501).json({ error: "L'assistant Gemini n'est pas encore configuré." });
    return;
  }

  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    res.status(429).json({
      error: "Trop de questions envoyées en peu de temps. Réessaie dans quelques instants.",
    });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }
  body = body || {};

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length > 4000) {
    res.status(400).json({ error: "Le message est trop long." });
    return;
  }

  // Image jointe optionnelle (capture d'écran, extrait de code...).
  const ALLOWED_IMAGE_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ];
  // ~3 Mo décodés → ~4 Mo en base64. Reste sous la limite habituelle
  // des fonctions serverless (ex. 4,5 Mo sur Vercel Hobby).
  const MAX_IMAGE_BASE64_CHARS = 4.2 * 1024 * 1024;

  let imagePart = null;
  if (body.image && typeof body.image === "object") {
    const mimeType = body.image.mimeType;
    const data = body.image.data;

    if (
      typeof mimeType !== "string" ||
      ALLOWED_IMAGE_MIME_TYPES.indexOf(mimeType) === -1
    ) {
      res.status(400).json({ error: "Format d'image non supporté." });
      return;
    }
    if (typeof data !== "string" || !data) {
      res.status(400).json({ error: "Image invalide." });
      return;
    }
    if (data.length > MAX_IMAGE_BASE64_CHARS) {
      res.status(413).json({ error: "L'image est trop volumineuse (max ~3 Mo)." });
      return;
    }

    imagePart = { inline_data: { mime_type: mimeType, data } };
  }

  if (!message && !imagePart) {
    res.status(400).json({ error: "Le message est vide." });
    return;
  }

  // Contexte optionnel et volontairement minimal (chapitre + fiche).
  const context = body.context && typeof body.context === "object" ? body.context : null;
  let contextLine = "";
  if (context) {
    const chapter = typeof context.chapter === "string" ? context.chapter : "";
    const fiche = typeof context.fiche === "string" ? context.fiche : "";
    if (chapter || fiche) {
      contextLine =
        "Contexte de la fiche actuellement consultée par l'étudiant — chapitre : " +
        (chapter || "inconnu") +
        ", fiche : " +
        (fiche || "inconnue") +
        ".\n\n";
    }
  }

  const textForModel =
    contextLine +
    (message || "Explique ce que montre cette capture d'écran et aide-moi à comprendre le problème Java concerné.");

  const parts = [{ text: textForModel }];
  if (imagePart) parts.push(imagePart);

  const requestPayload = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [
      {
        role: "user",
        parts: parts,
      },
    ],
    generationConfig: {
      temperature: 0.6,
      maxOutputTokens: 1024,
    },
  };

  try {
    const geminiResponse = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(requestPayload),
    });

    if (!geminiResponse.ok) {
  const errorText = await geminiResponse.text();

  console.error("GEMINI API ERROR", {
    status: geminiResponse.status,
    body: errorText,
  });

  res.status(502).json({
    error: "Diagnostic Gemini",
    googleStatus: geminiResponse.status,
    googleError: errorText,
  });
  return;
}
    const data = await geminiResponse.json();
    const reply =
      data &&
      data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text;

    if (!reply) {
      res.status(502).json({
        error: "Impossible de contacter Gemini pour le moment. Réessaie dans quelques instants.",
      });
      return;
    }

    res.status(200).json({ reply });
  } catch (err) {
    res.status(502).json({
      error: "Impossible de contacter Gemini pour le moment. Réessaie dans quelques instants.",
    });
  }
};
