const GRAPH_API_VERSION = "v22.0";
const MEDIA_FIELDS = "id,permalink,timestamp,caption,comments_count";
const COMMENT_FIELDS =
  "id,text,username,timestamp,like_count,replies.limit(50){id,text,username,timestamp,like_count}";
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/comments" && (request.method === "GET" || request.method === "POST")) {
      return handleComments(request, url, env);
    }
    return env.ASSETS.fetch(request);
  },
};

/**
 * Le plan gratuit Cloudflare limite chaque appel à 50 sous-requêtes. Un export
 * se fait donc en plusieurs appels : le 1er (GET start/end) liste les posts, puis
 * chaque appel récupère des pages de commentaires jusqu'à épuiser son budget et
 * renvoie les posts encore incomplets ("pending"). Le navigateur relance alors
 * un POST avec ce "pending", jusqu'à ce qu'il soit vide.
 */
async function handleComments(request, url, env) {
  let range = null;
  let pending = null;
  if (request.method === "GET") {
    range = parseRange(url.searchParams.get("start"), url.searchParams.get("end"));
    if (range.error) return jsonError(range.error, 400);
  } else {
    pending = parsePending(await request.json().catch(() => null));
    if (!pending) return jsonError("Corps de requête invalide.", 400);
  }

  const accessToken = env.INSTAGRAM_ACCESS_TOKEN;
  const businessAccountId = env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!accessToken || !businessAccountId) {
    return jsonError(
      "Configuration manquante : INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID ne sont pas définis.",
      500
    );
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event) => writer.write(encoder.encode(JSON.stringify(event) + "\n"));

  (async () => {
    try {
      const budget = { left: SUBREQUEST_BUDGET };
      if (range) {
        const posts = await fetchPostsInRange({ accessToken, businessAccountId, start: range.start, end: range.end, budget });
        pending = posts
          .filter((post) => post.comments_count)
          .map((post) => ({ id: post.id, caption: post.caption ?? "", timestamp: post.timestamp ?? "", after: null }));
        await send({ type: "total", totalPosts: pending.length });
      }

      const result = await fetchComments({
        accessToken,
        posts: pending,
        budget,
        onProgress: (progress) => send({ type: "progress", ...progress }),
      });

      await send({ type: "result", rows: result.rows, pending: result.pending });
    } catch (error) {
      await send({ type: "error", message: `Échec de la récupération : ${error.message}` });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/** Valide l'état renvoyé par le navigateur (frontière de confiance : l'id finit dans une URL Graph API). */
function parsePending(body) {
  const list = body?.pending;
  if (!Array.isArray(list) || list.length > 10000) return null;
  const ok = list.every(
    (p) =>
      typeof p?.id === "string" && /^\d+$/.test(p.id) &&
      typeof p.caption === "string" && typeof p.timestamp === "string" &&
      (p.after === null || (typeof p.after === "string" && p.after.length < 2000))
  );
  return ok ? list.map(({ id, caption, timestamp, after }) => ({ id, caption, timestamp, after })) : null;
}

function parseRange(startParam, endParam) {
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!startParam || !endParam || !dateRe.test(startParam) || !dateRe.test(endParam)) {
    return { error: "Paramètres 'start' et 'end' requis, au format YYYY-MM-DD." };
  }
  const start = new Date(`${startParam}T00:00:00Z`);
  const end = new Date(`${endParam}T23:59:59Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return { error: "Plage de dates invalide (la date de début doit précéder la date de fin)." };
  }
  return { start, end };
}

/**
 * Les posts sont renvoyés du plus récent au plus ancien par l'API : on arrête
 * la pagination dès qu'un post est antérieur à `start`, inutile d'aller plus loin.
 */
async function fetchPostsInRange({ accessToken, businessAccountId, start, end, budget }) {
  const posts = [];
  let apiUrl = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${businessAccountId}/media`);
  apiUrl.searchParams.set("fields", MEDIA_FIELDS);
  apiUrl.searchParams.set("limit", "50");
  apiUrl.searchParams.set("access_token", accessToken);

  while (apiUrl) {
    // shortcut: la liste des posts doit tenir dans un seul appel (~2000 posts plus récents que le début), sinon erreur claire
    if (budget.left-- <= 0) {
      throw new Error("trop de posts entre la date de début et aujourd'hui. Choisis une date de début plus récente.");
    }
    const body = await graphFetch(apiUrl);
    let reachedOlderThanStart = false;

    for (const item of body.data ?? []) {
      const timestamp = new Date(item.timestamp);
      if (timestamp < start) {
        reachedOlderThanStart = true;
        break;
      }
      if (timestamp <= end) {
        posts.push(item);
      }
    }

    if (reachedOlderThanStart) break;
    const next = body.paging?.next;
    apiUrl = next ? new URL(next) : null;
  }

  return posts;
}

const BATCH_SIZE = 50; // max sous-requêtes par appel batch Graph API
const SUBREQUEST_BUDGET = 45; // plan gratuit Cloudflare : 50 sous-requêtes par appel, on garde une marge

/**
 * Récupère les commentaires (+ réponses) en regroupant les appels via l'endpoint
 * batch de la Graph API : jusqu'à 50 posts interrogés en une seule requête HTTP
 * (une seule sous-requête Cloudflare). On avance par "rounds" : à chaque round,
 * chaque post encore actif reçoit sa page de commentaires suivante. On s'arrête
 * quand tout est récupéré ou quand le budget de sous-requêtes est épuisé ; les
 * posts incomplets sont renvoyés (avec leur curseur) pour l'appel suivant.
 */
async function fetchComments({ accessToken, posts, budget, onProgress }) {
  const rows = [];
  let active = posts;

  while (active.length && budget.left > 0) {
    const stillActive = [];
    for (let i = 0; i < active.length; i += BATCH_SIZE) {
      const chunk = active.slice(i, i + BATCH_SIZE);
      if (budget.left <= 0) {
        stillActive.push(...chunk);
        continue;
      }
      budget.left--;

      const batchRequests = chunk.map((post) => ({
        method: "GET",
        relative_url: commentsRelativeUrl(post.id, post.after),
      }));
      const results = await runBatch(batchRequests, accessToken);

      chunk.forEach((post, index) => {
        const parsed = parseBatchResult(results[index]);
        if (!parsed) return;

        for (const item of parsed.data ?? []) {
          rows.push(commentToRow(post, { ...item, is_reply: false, parent_text: null }));
          for (const reply of item.replies?.data ?? []) {
            rows.push(commentToRow(post, { ...reply, is_reply: true, parent_text: item.text }));
          }
        }

        const after = parsed.paging?.cursors?.after;
        if (parsed.paging?.next && after) stillActive.push({ ...post, after });
      });

      const notYetVisited = active.length - i - chunk.length;
      await onProgress({ remaining: stillActive.length + notYetVisited, commentsSoFar: rows.length });
    }
    active = stillActive;
  }

  return { rows, pending: active };
}

function commentsRelativeUrl(postId, afterCursor) {
  const params = new URLSearchParams({ fields: COMMENT_FIELDS, limit: "50" });
  if (afterCursor) params.set("after", afterCursor);
  return `${postId}/comments?${params.toString()}`;
}

async function runBatch(batch, accessToken) {
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: accessToken, batch }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Erreur batch API Instagram (${response.status})`);
  }
  return body;
}

function parseBatchResult(result) {
  if (!result || result.code !== 200) return null;
  try {
    return JSON.parse(result.body);
  } catch {
    return null;
  }
}

async function graphFetch(apiUrl) {
  const response = await fetch(apiUrl);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Erreur API Instagram (${response.status})`);
  }
  return body;
}

function commentToRow(post, comment) {
  return [
    excerpt(post.caption) || "(sans légende)",
    post.timestamp ?? "",
    comment.id ?? "",
    comment.username ?? "",
    (comment.text ?? "").replace(/\r?\n/g, " ").trim(),
    comment.like_count ?? 0,
    comment.timestamp ?? "",
    comment.is_reply ? "réponse" : "commentaire",
    comment.is_reply ? excerpt(comment.parent_text) : "",
  ];
}

/** Extrait les ~60 premiers caractères d'un texte (légende ou commentaire) pour l'identifier facilement dans le CSV. */
function excerpt(text, maxLength = 60) {
  const clean = (text ?? "").replace(/\r?\n/g, " ").trim();
  if (!clean) return "";
  return clean.length > maxLength ? `${clean.slice(0, maxLength).trim()}…` : clean;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
