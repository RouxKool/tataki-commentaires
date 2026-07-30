const form = document.getElementById("range-form");
const button = document.getElementById("download-btn");
const status = document.getElementById("status");
const progressBar = document.getElementById("progress-bar");

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
  progressBar.hidden = false;
  setStatus("Récupération des posts et des commentaires en cours...", "");

  try {
    const response = await fetch(`/api/comments?start=${start}&end=${end}`);

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Erreur serveur (${response.status})`);
    }

    const postCount = response.headers.get("X-Post-Count") ?? "?";
    const commentCount = response.headers.get("X-Comment-Count") ?? "?";

    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : `tataki_commentaires_${start}_${end}.csv`;

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    setStatus(`Téléchargement terminé — ${postCount} post(s), ${commentCount} commentaire(s).`, "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    button.disabled = false;
    progressBar.hidden = true;
  }
});

function setStatus(message, kind) {
  status.textContent = message;
  status.className = kind ? `status ${kind}` : "status";
}
