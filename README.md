# VoltSite-api

Dane z MongoDB dla stron VoltCraft. Słucha tylko na `127.0.0.1:3300` i wymaga nagłówka `Authorization: Bearer <SITE_API_SECRET>`. Zakupy zapisuje do `VOLT-API.Orders`, które realizują VoltRanks i VoltEconomy.

- **Typ:** Usługa Node.js
- **Wymaga:** `voltapi-sdk`
- **Repo:** `qweyypl/node.VoltSite-api`

---

## Spis

| Sekcja | Co znajdziesz |
|---|---|
| [Uruchomienie](#uruchomienie) | jak uruchomić lokalnie |
| [Konfiguracja](#konfiguracja) | gdzie są ustawienia |
| [Endpointy klanów](#endpointy-klanów) | dane klanów dla stron |
| [Wdrożenie](#wdrożenie) | jak to chodzi na VPS |

---

## Uruchomienie

```bash
npm install
npm start
```

---

## Konfiguracja

- `.env`: `PORT`, `SITE_API_SECRET`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`.

---

## Endpointy klanów

| Endpoint | Co zwraca |
|---|---|
| `GET /clans` | lista klanów |
| `GET /clans/:tag` | szczegóły klanu |
| `GET /clans-ranking` | ranking klanów |

---

## Wdrożenie

- pm2: `VoltSite-API` w `/var/lib/VoltSite-API`.
- `pm2 restart VoltSite-API`
