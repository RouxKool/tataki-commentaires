const form = document.getElementById("range-form");
const button = document.getElementById("download-btn");
const status = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const progressFill = progressBar.querySelector(".progress-bar-fill");
const MAX_CALLS = 200; // garde-fou contre une boucle infinie si l'API renvoyait toujours une page suivante
const CSV_HEADER = ["post", "post_date", "comment_id", "author", "text", "likes", "comment_date", "type", "parent_comment"];

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const start = document.getElementById("start").value;
  const end = document.getElementById("end").value;

  if (!start || !end) {
    setStatus("Merci de choisir une date de début et une date de fin.", "error");
    return;
  }
  if (start > end) {
    setStatus("La date de début doit précéder la date de fin.", "error");
    return;
  }

  button.disabled = true;
  showProgress(0);
  setStatus("Recherche des posts sur cette période...", "");

  try {
    // Le serveur traite l'export en plusieurs appels (limite Cloudflare de 50 sous-requêtes
    // par appel) : on le relance avec les posts restants tant qu'il en reste.
    let totalPosts = 0;
    let pending = null;
    const rows = [];

    for (let call = 0; call === 0 || pending.length; call++) {
      if (call >= MAX_CALLS) throw new Error("Export interrompu : trop de commentaires sur cette période.");

      const response = pending
        ? await fetch("/api/comments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pending }),
          })
        : await fetch(`/api/comments?start=${start}&end=${end}`);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `Erreur serveur (${response.status})`);
      }

      const result = await readProgressStream(response.body, (event) => {
        if (event.type === "total") {
          totalPosts = event.totalPosts;
          setStatus(
            totalPosts === 0 ? "Aucun post avec commentaires sur cette période." : `0 / ${totalPosts} post(s) traité(s)...`,
            ""
          );
          showProgress(totalPosts === 0 ? 100 : 0);
        } else if (event.type === "progress") {
          const postsDone = totalPosts - event.remaining;
          showProgress(totalPosts ? Math.round((postsDone / totalPosts) * 100) : 0);
          setStatus(
            `${postsDone} / ${totalPosts} post(s) traité(s) — ${rows.length + event.commentsSoFar} commentaire(s) récupéré(s)...`,
            ""
          );
        }
      });

      if (!result) {
        throw new Error("Réponse incomplète du serveur.");
      }
      rows.push(...result.rows);
      pending = result.pending;
    }

    showProgress(100);
    // Les appels successifs mélangent les posts : on regroupe par post, du plus récent au plus ancien (tri stable).
    rows.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
    const result = { csv: buildCsv(rows), postCount: totalPosts, commentCount: rows.length };

    const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
    const filename = `tataki_commentaires_${start}_${end}.csv`;

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus(`Téléchargement terminé — ${result.postCount} post(s), ${result.commentCount} commentaire(s).`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
    progressBar.hidden = true;
  }
});

/**
 * Le serveur envoie une ligne JSON par mise à jour ("total", "progress", puis
 * "result" avec les lignes récupérées et les posts restants). onEvent est appelé pour chaque ligne reçue ;
 * la fonction retourne l'objet "result" une fois le flux terminé.
 */
async function readProgressStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      const parsedEvent = JSON.parse(line);
      if (parsedEvent.type === "error") {
        throw new Error(parsedEvent.message);
      } else if (parsedEvent.type === "result") {
        result = parsedEvent;
      } else {
        onEvent(parsedEvent);
      }
    }
  }

  return result;
}

function showProgress(percent) {
  progressBar.hidden = false;
  progressFill.style.width = `${percent}%`;
}

function setStatus(message, kind) {
  status.textContent = message;
  status.className = kind ? `status ${kind}` : "status";
}

function buildCsv(rows) {
  const lines = [CSV_HEADER, ...rows].map((row) => row.map(csvEscape).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n"; // BOM pour qu'Excel affiche correctement les accents/emojis
}

function csvEscape(value) {
  const str = String(value ?? "");
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
