# Tataki — Export des commentaires Instagram

Petit site interne : on choisit une période (date de début / date de fin), on clique sur
**Télécharger**, et on récupère un fichier CSV avec tous les commentaires (et réponses) de
tous les posts Instagram publiés par Tataki durant cette période.

Pensé pour que l'équipe puisse s'en servir seule pendant l'absence d'Alessandro, sans rien
installer.

## Architecture

```
Cloudflare Worker (frontend + fonction serveur, tout au même endroit)
   ├─ index.html / app.js / style.css   → page avec le calendrier + bouton
   │                                       (servis tels quels via les "assets" du Worker)
   └─ src/worker.js                     → reçoit start/end sur /api/comments, appelle
         l'Instagram Graph API avec le token (caché côté serveur), récupère les
         posts de la période + tous leurs commentaires, renvoie un CSV en
         téléchargement direct. Pour toute autre URL, sert les fichiers statiques.
```

Contrairement à `insta-recherche` (site 100% statique sur GitHub Pages, données pré-calculées
par un cron), ici le token Instagram doit rester secret ET la récupération se fait à la demande
avec des dates choisies par l'utilisateur — il faut donc une vraie fonction serveur. GitHub
Pages ne sait pas faire ça : c'est pour ça que ce projet est hébergé sur **Cloudflare** (gratuit)
plutôt que GitHub Pages. GitHub reste uniquement le dépôt de code ; Cloudflare se connecte au
repo et redéploie automatiquement à chaque push.

(Note technique : l'ancien mode simple "Cloudflare Pages" n'est plus proposé aux nouveaux
comptes Cloudflare — le fichier `wrangler.jsonc` à la racine du projet configure le mode
"Workers" actuel, qui fait la même chose.)

## Schéma du CSV téléchargé

Une ligne par commentaire (les réponses à un commentaire sont incluses comme des lignes à part) :

| Colonne | Description |
|---|---|
| `post_id` | ID du post Instagram |
| `post_permalink` | Lien vers le post |
| `post_date` | Date de publication du post |
| `comment_id` | ID du commentaire |
| `author` | Pseudo Instagram de l'auteur du commentaire |
| `text` | Texte du commentaire |
| `likes` | Nombre de likes du commentaire |
| `comment_date` | Date du commentaire |
| `is_reply` | "oui" si c'est une réponse à un autre commentaire, sinon "non" |
| `parent_comment_id` | ID du commentaire parent (si `is_reply` = oui) |

Le fichier s'ouvre directement dans Excel/Google Sheets (encodage UTF-8, accents et emojis
inclus).

## Mise en place (à faire une fois)

### 1. Créer le repo GitHub

```bash
cd /Users/alessandromauro/Claude/tataki-commentaires
git init
git add .
git commit -m "Initial commit"
```

Puis créer un repo **public** vide sur GitHub nommé `tataki-commentaires` (compte `RouxKool`,
comme `insta-recherche`), et :

```bash
git remote add origin https://github.com/RouxKool/tataki-commentaires.git
git branch -M main
git push -u origin main
```

### 2. Déployer sur Cloudflare

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Connect to Git** (ou onglet **Workers**, selon la version du tableau de bord).
2. Choisir le repo `tataki-commentaires`.
3. Build settings : **Build command : (laisser vide)**, **Deploy command : `npx wrangler deploy`**
   (déjà pré-rempli par défaut). La configuration (nom, fichiers à servir) vient du fichier
   `wrangler.jsonc` du repo, rien d'autre à remplir.
4. Déployer.

### 3. Ajouter les secrets

Dans le projet Cloudflare → **Settings → Variables and Secrets**, ajouter (type **Secret**) :

- `INSTAGRAM_ACCESS_TOKEN`
- `INSTAGRAM_BUSINESS_ACCOUNT_ID`

Ce sont **les mêmes valeurs que celles déjà utilisées pour `insta-recherche`** (même compte
Instagram Business) — pas besoin de recréer un token.

⚠️ **Le token Instagram expire après 60 jours.** Renouvellement : `GET
https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=...`,
puis mettre à jour la variable ici (et dans les secrets GitHub de `insta-recherche`, si les deux
doivent rester synchronisés).

Après avoir ajouté/modifié les variables, redéployer (onglet **Deployments** → **Retry
deployment**) pour qu'elles soient prises en compte.

### 4. Restreindre l'accès à l'équipe (Cloudflare Access)

Le site est public par défaut (repo public = obligatoire pour l'hébergement gratuit), donc
n'importe qui avec le lien pourrait déclencher des téléchargements. Pour limiter l'accès à
l'équipe :

1. [one.dash.cloudflare.com](https://one.dash.cloudflare.com) (Zero Trust) → **Access →
   Applications → Add an application → Self-hosted**.
2. **Application domain** : le domaine `*.workers.dev` attribué au projet (visible dans l'onglet
   **Deployments** du projet Cloudflare, ou domaine personnalisé si configuré).
3. **Policy** : Action **Allow**, règle **Emails** → lister les adresses email de l'équipe.
4. Sauvegarder.

Résultat : à la première visite, chaque personne doit confirmer son adresse email (code reçu
par mail) avant d'accéder au site. Aucun code à écrire, tout se configure dans le dashboard.

## Développement local

```bash
npm install
npx wrangler dev
```

Créer un fichier `.env` (non commité, voir `.gitignore`) avec :

```
INSTAGRAM_ACCESS_TOKEN=...
INSTAGRAM_BUSINESS_ACCOUNT_ID=...
```

Wrangler les charge automatiquement pour simuler le Worker en local.

## Fichiers clés

- `index.html` / `style.css` — page avec le calendrier (dates de début/fin) et le bouton
- `app.js` — déclenche l'appel à `/api/comments`, gère le téléchargement du CSV
- `src/worker.js` — logique serveur : appelle l'Instagram Graph API (pagination des posts puis
  des commentaires/réponses de chaque post dans la période), génère le CSV ; sert les fichiers
  statiques pour toute autre URL
- `wrangler.jsonc` — configuration Cloudflare (nom du projet, fichier serveur, dossier des
  fichiers statiques)

## Limites connues

- **Pagination des posts** : l'API renvoie les posts du plus récent au plus ancien ; la fonction
  s'arrête dès qu'elle atteint un post antérieur à la date de début (pas besoin de tout
  parcourir), donc les périodes récentes sont rapides même si le compte a beaucoup de posts.
- **Volume de commentaires** : les commentaires sont récupérés par lots via l'endpoint batch de
  la Graph API (jusqu'à 50 posts interrogés en une seule requête HTTP), pour rester loin de la
  limite de sous-requêtes du plan gratuit Cloudflare Workers (50 par appel). Si malgré tout un
  export échoue sur une période avec un nombre exceptionnel de posts/commentaires ("trop de
  sous-requêtes"), réessayer sur une période plus courte, ou passer au plan Cloudflare Workers
  payant (5$/mois, limite à 1000 sous-requêtes).
- **Réponses aux commentaires** : les 50 premières réponses par commentaire sont incluses ; au
  delà (rare), les suivantes ne sont pas récupérées.
