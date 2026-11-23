# Site CMV – server (Node.js + Express)

API-ul site-ului Colegiului „Mihai Viteazul” Ineu: noutăți, orar, supliniri, profesori, conturi și datele de contact.
Datele sunt într-o bază de date **MySQL** (pe Clever Cloud). Site-ul propriu-zis e în folderul `client` (pe Netlify).

```
Netlify (client)  ──fetch──>  Render (server, acest folder)  ──MySQL──>  Clever Cloud (baza de date)
```

## Rulare locală

Ai nevoie de Node.js 20+ și de un MySQL/MariaDB local.

```powershell
cd server
npm install
copy .env.example .env      # apoi completează datele bazei de date în .env
npm run dev                 # pornește API-ul ȘI site-ul pe http://localhost:5173
npm run populate            # (opțional) date demonstrative: orar, supliniri, conturi de test
```

`npm run dev` afișează și adresa de rețea (ex. `http://192.168.x.x:5173`) pentru telefon.

Conturi de test create de `npm run populate`:

| Rol      | Email               | Parolă          |
|----------|---------------------|-----------------|
| elev     | elev@demo.local     | elev-demo-1     |
| profesor | profesor@demo.local | profesor-demo-1 |
| admin    | admin@demo.local    | admin-demo-1 (doar dacă nu exista alt admin) |

## Publicare

### 1. Baza de date – Clever Cloud (MySQL)

1. În Clever Cloud: **Create → an add-on → MySQL**. Alege un plan (vezi nota de mai jos).
2. În pagina add-on-ului copiază **Connection URI** (`MYSQL_ADDON_URI`, de forma `mysql://user:parola@host:port/baza`).
3. Tabelele se creează singure la prima configurare din `/admin` (sau cu `npm run populate`).

Ca să muți baza de date de pe calculator (cu tot ce ai introdus deja):

```powershell
mysqldump -u cmv -p cmv > cmv.sql
mysql -h HOST -P PORT -u USER -p NUME_BAZA < cmv.sql     # datele din pagina add-on-ului
```

> **Notă:** fișierele atașate la noutăți (poze, PDF-uri) se păstrează în baza de date, pentru că
> Render (planul gratuit) nu are disc permanent. Planul gratuit MySQL de la Clever Cloud are foarte
> puțin spațiu și puține conexiuni: pentru site-ul real alege un plan cu mai mult spațiu, mai ales
> dacă vei atașa multe poze. `DB_POOL` (implicit 4) limitează conexiunile deschise.

### 2. Serverul – Render

1. Pune folderul `server` pe GitHub (repo separat, sau împreună cu `client`).
2. În Render: **New → Blueprint** și alege repo-ul (folosește `render.yaml`).
   Dacă `server` e un subfolder al repo-ului, decomentează `rootDir: server` în `render.yaml`.
   Fără Blueprint: **New → Web Service**, Build `npm ci --omit=dev`, Start `npm start`.
3. La **Environment** completează:

| Variabilă       | Valoare | De ce |
|-----------------|---------|-------|
| `DATABASE_URL`  | `mysql://...` (Connection URI de la Clever Cloud) | baza de date |
| `CLIENT_ORIGIN` | `https://NUMELE-TAU.netlify.app` | doar site-ul tău are voie să folosească API-ul (mai multe adrese: despărțite prin virgulă) |
| `TRUST_PROXY`   | `1` | Render pune un proxy în față; limitarea încercărilor de login vede IP-ul real |
| `MAX_UPLOAD_MB` | `10` | mărimea maximă a unui fișier atașat |
| `NODE_VERSION`  | `22` | |

4. După deploy, adresa serverului (ex. `https://cmv-server.onrender.com`) se pune în
   `client/js/config.js`.

Verificare: `https://cmv-server.onrender.com/api/site` trebuie să răspundă cu JSON.

> Pe planul gratuit Render serverul „adoarme” după 15 minute fără vizitatori; prima cerere
> după aceea durează ~30–50 de secunde.

## Cum funcționează

- `src/index.js` – pornirea serverului, CORS, fișierele statice (doar local), erorile.
- `src/routes.js` – toate rutele `/api/...` (aceleași ca în vechea versiune PHP).
- `src/auth.js` – autentificare: la login serverul dă un token, pe care browserul îl trimite în
  antetul `Authorization`. Site-ul și panoul `/admin` au autentificări separate. Sesiunea expiră
  după 8 ore fără activitate; 10 parole greșite de pe același IP blochează login-ul 15 minute.
- `src/asc.js` – citirea fișierului XML exportat din aSc Orare.
- `src/data.js` – datele implicite (contact, organizare, linkuri), schema, importul orarului.
- `schema.sql` – tabelele. O bază de date veche (din versiunea PHP) e actualizată automat la pornire.
- `scripts/populate.js` – datele demonstrative.
