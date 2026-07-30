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

  try {
    const posts = await fetchPostsInRange({ accessToken, businessAccountId, start: range.start, end: range.end });
    const postsWithComments = posts.filter((post) => post.comments_count);

    const commentsByPost = await Promise.all(
      postsWithComments.map((post) => fetchAllComments({ accessToken, postId: post.id }))
    );

    const rows = [];
    postsWithComments.forEach((post, index) => {
      for (const comment of commentsByPost[index]) {
        rows.push(commentToRow(post, comment));
      }
    });

    const csv = buildCsv(rows);
    const filename = `tataki_commentaires_${startParam}_${endParam}.csv`;

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return jsonError(`Échec de la récupération : ${error.message}`, 502);
  }
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

async function fetchAllComments({ accessToken, postId }) {
  const comments = [];
  let apiUrl = new URL(`https://graph.facebook.com/${GRAPH_API_VERSION}/${postId}/comments`);
  apiUrl.searchParams.set("fields", COMMENT_FIELDS);
  apiUrl.searchParams.set("limit", "50");
  apiUrl.searchParams.set("access_token", accessToken);

  while (apiUrl) {
    const body = await graphFetch(apiUrl);
    for (const item of body.data ?? []) {
      comments.push({ ...item, is_reply: false, parent_id: null });
      for (const reply of item.replies?.data ?? []) {
        comments.push({ ...reply, is_reply: true, parent_id: item.id });
      }
    }
    const next = body.paging?.next;
    apiUrl = next ? new URL(next) : null;
  }

  return comments;
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
