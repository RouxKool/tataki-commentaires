const GRAPH_API_VERSION = "v22.0";
const MEDIA_FIELDS = "id,permalink,timestamp,caption,comments_count";
const COMMENT_FIELDS =
  "id,text,username,timestamp,like_count,replies.limit(50){id,text,username,timestamp,like_count}";
const CSV_HEADER = [
  "post_id",
  "post_permalink",
  "post_date",
  "comment_id",
  "author",
  "text",
  "likes",
  "comment_date",
  "is_reply",
  "parent_comment_id",
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/comments" && request.method === "GET") {
      return handleComments(url, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleComments(url, env) {
  const startParam = url.searchParams.get("start");
  const endParam = url.searchParams.get("end");

  const range = parseRange(startParam, endParam);
  if (range.error) {
    return jsonError(range.error, 400);
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
      const posts = await fetchPostsInRange({ accessToken, businessAccountId, start: range.start, end: range.end });
      const postsWithComments = posts.filter((post) => post.comments_count);
      await send({ type: "total", totalPosts: postsWithComments.length });

      const commentsByPostId = await fetchAllCommentsForPosts({
        accessToken,
        posts: postsWithComments,
        onProgress: (progress) => send({ type: "progress", totalPosts: postsWithComments.length, ...progress }),
      });

      const rows = [];
      for (const post of postsWithComments) {
        for (const comment of commentsByPostId.get(post.id) ?? []) {
          rows.push(commentToRow(post, comment));
        }
      }

      const csv = buildCsv(rows);
      await send({ type: "result", postCount: postsWithComments.length, commentCount: rows.length, csv });
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
async function fetchPostsInRange({ accessToken, businessAccountId, start, end }) {
  const posts = [];
  let apiUrl = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${businessAccountId}/media`);
  apiUrl.searchParams.set("fields", MEDIA_FIELDS);
  apiUrl.searchParams.set("limit", "50");
  apiUrl.searchParams.set("access_token", accessToken);

  while (apiUrl) {
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
const MAX_ROUNDS = 200; // garde-fou contre une boucle infinie en cas de réponse inattendue

/**
 * Récupère les commentaires (+ réponses) de tous les posts en regroupant les
 * appels par lots via l'endpoint batch de la Graph API : jusqu'à 50 posts
 * interrogés en une seule requête HTTP (donc une seule "sous-requête" pour
 * Cloudflare), au lieu d'un appel par post. On avance par "rounds" : à chaque
 * round, chaque post encore actif reçoit sa page de commentaires suivante ;
 * un post sort de la boucle dès qu'il n'a plus de page suivante.
 */
async function fetchAllCommentsForPosts({ accessToken, posts, onProgress }) {
  const commentsByPostId = new Map(posts.map((post) => [post.id, []]));
  const cursorByPostId = new Map(posts.map((post) => [post.id, undefined]));
  const done = new Set();

  let round = 0;
  while (posts.some((post) => !done.has(post.id)) && round < MAX_ROUNDS) {
    const active = posts.filter((post) => !done.has(post.id));

    for (let i = 0; i < active.length; i += BATCH_SIZE) {
      const chunk = active.slice(i, i + BATCH_SIZE);
      const batchRequests = chunk.map((post) => ({
        method: "GET",
        relative_url: commentsRelativeUrl(post.id, cursorByPostId.get(post.id)),
      }));

      const results = await runBatch(batchRequests, accessToken);

      chunk.forEach((post, index) => {
        const parsed = parseBatchResult(results[index]);
        if (!parsed) {
          done.add(post.id);
          return;
        }

        for (const item of parsed.data ?? []) {
          commentsByPostId.get(post.id).push({ ...item, is_reply: false, parent_id: null });
          for (const reply of item.replies?.data ?? []) {
            commentsByPostId.get(post.id).push({ ...reply, is_reply: true, parent_id: item.id });
          }
        }

        const after = parsed.paging?.cursors?.after;
        if (parsed.paging?.next && after) {
          cursorByPostId.set(post.id, after);
        } else {
          done.add(post.id);
        }
      });

      if (onProgress) {
        const commentsSoFar = posts.reduce((sum, post) => sum + commentsByPostId.get(post.id).length, 0);
        await onProgress({ postsDone: done.size, commentsSoFar });
      }
    }

    round++;
  }

  return commentsByPostId;
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
    post.id,
    post.permalink ?? "",
    post.timestamp ?? "",
    comment.id ?? "",
    comment.username ?? "",
    (comment.text ?? "").replace(/\r?\n/g, " ").trim(),
    comment.like_count ?? 0,
    comment.timestamp ?? "",
    comment.is_reply ? "oui" : "non",
    comment.parent_id ?? "",
  ];
}

function buildCsv(rows) {
  const lines = [CSV_HEADER, ...rows].map((row) => row.map(csvEscape).join(","));
  const bom = "﻿"; // pour qu'Excel affiche correctement les accents/emojis
  return bom + lines.join("\r\n") + "\r\n";
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
