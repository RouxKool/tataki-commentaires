const form = document.getElementById("range-form");
const button = document.getElementById("download-btn");
const status = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");
const progressFill = progressBar.querySelector(".progress-bar-fill");

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
    const response = await fetch(`/api/comments?start=${start}&end=${end}`);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Erreur serveur (${response.status})`);
    }

    const result = await readProgressStream(response.body, (event) => {
      if (event.type === "total") {
        setStatus(
          event.totalPosts === 0
            ? "Aucun post avec commentaires sur cette période."
            : `0 / ${event.totalPosts} post(s) traité(s)...`,
          ""
        );
        showProgress(event.totalPosts === 0 ? 100 : 0);
      } else if (event.type === "progress") {
        const pct = event.totalPosts ? Math.round((event.postsDone / event.totalPosts) * 100) : 0;
        showProgress(pct);
        setStatus(
          `${event.postsDone} / ${event.totalPosts} post(s) traité(s) — ${event.commentsSoFar} commentaire(s) récupéré(s)...`,
          ""
        );
      }
    });

    if (!result) {
      throw new Error("Réponse incomplète du serveur.");
    }

    showProgress(100);

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
 * "result" avec le CSV final). onEvent est appelé pour chaque ligne reçue ;
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
