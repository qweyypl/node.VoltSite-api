/**
 * REST API strony VoltCraft. Słucha wyłącznie na 127.0.0.1 (stronę woła serwer Next.js na tym samym VPS),
 * każde zapytanie musi mieć nagłówek "Authorization: Bearer <SITE_API_SECRET>". Połączenie z MongoDB to jedno
 * połączenie z VoltAPI SDK (URI w .env biblioteki). Czasy idą w milisekundach, daty jako ISO (UTC).
 *
 * GET  /online                   { online }
 * GET  /players/:nick            PlayerStats albo 404
 * GET  /players/:nick/exists     { exists, name }
 * GET  /discord/:id              { nick, uuid } konta Minecraft połączonego z tym kontem Discord (Accounts.Recover.DiscordId) albo 404
 * GET  /recruit-access/:id      { positions: [slug], override } rekrutacje, których podania widzi to konto Discord, i czy może zmienić wydaną decyzję
 * GET  /tops                     { <id topki>: [{ name, value, tag? }] } (malejąco)
 * GET  /clans                    [{ name, tag, members, xp, coins, voltcoins }] wszystkie klany (VOLT-MINECRAFT.Clans, VoltClans)
 * GET  /clans/:tag               ClanStats albo 404 (tag bez względu na wielkość liter)
 * GET  /clans-ranking?by=xp|coins|voltcoins|members  [{ place, name, tag, value }] (malejąco, 10 pierwszych)
 * GET  /visits?kind=player|clan  [{ key, monthlyVisits }] (bieżący miesiąc, VOLT-SITE.Visits)
 * POST /visits                   { kind, key, visitor } (visitor = adres IP + przeglądarka, liczony raz na dzień)
 * /recruit/...                  dane strony rekrutacji w VOLT-SITE: applications, open, blacklist, prefs (opis niżej, przy recruitRoute)
 * /content[/:key[/history[/:id]]] treści stron z panelu (opublikowane, szkice, historia wersji), opis przy contentRoute
 * GET  /panel-logs?limit=       ostatnie wpisy VOLT-LOGS.Panel (kto, kiedy, co zmienił w panelu, która wersja)
 * GET  /panel-access/:id        { keys, all } treści, które to konto Discord może edytować w panelu
 * GET  /auth/discord/authorize?redirect=&state=  { url } logowania Discord;  POST /auth/discord/login { code, redirect, site } -> { user }
 *                              (klucze aplikacji Discord tylko w .env API; konto zapisywane w VOLT-SITE.Users)
 * POST /purchases                { nick, product, amount, orderId? } -> zamówienie w VOLT-API.Orders,
 *                                które realizują wtyczki (rangi: VoltRanks, VoltCoiny: VoltEconomy)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sdk = require('voltapi-sdk');

const mongo = sdk.mongo;
const env = readEnv(path.join(__dirname, '.env'));
const PORT = Number(env.PORT || 3300);
const SECRET = env.SITE_API_SECRET || '';
const HOST = '127.0.0.1';
const NICK = /^[A-Za-z0-9_]{3,16}$/;
const COLLATION = { locale: 'en', strength: 2 };
const TOP_LIMIT = 10;
const ONLINE_BEAT_MS = 30_000;

function readEnv(file) {
    const values = {};
    if (!fs.existsSync(file)) {
        return values;
    }
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (match) {
            values[match[1]] = match[2].replace(/^["']|["']$/g, '');
        }
    }
    return values;
}

const game = () => mongo.minecraft();
const accounts = () => game().collection('Accounts');
const players = () => game().collection('PlayersData');
const config = () => game().collection('Config');
const instances = () => game().collection('Instances');
const clans = () => game().collection('Clans');
const orders = () => mongo.db(mongo.API).collection('Orders');
const visits = () => mongo.db('VOLT-SITE').collection('Visits');
// Kto już był dziś na danym profilu: skrót odwiedzającego (bez adresu IP w bazie), znika sam po 2 dniach (TTL).
const visitsSeen = () => mongo.db('VOLT-SITE').collection('VisitsSeen');

const num = (value) => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber(); // Long
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (value) => (value instanceof Date ? value.toISOString() : undefined);

// ---- gry ------------------------------------------------------------------------------------------

// Statystyki gier: na każdą grę suma (total), tryby, mapy i sezony. Gra, której nie ma na serwerze, ma zera.
const GAMES = [
    { id: 'bedwars', name: 'BedWars', fields: ['games', 'wins', 'kills', 'deaths', 'bedsBroken'] },
    { id: 'bedwars-duels', name: 'BedWars Duels', fields: ['games', 'wins', 'kills', 'deaths', 'bedsBroken'] },
    { id: 'skywars', name: 'SkyWars', fields: ['games', 'wins', 'kills', 'deaths', 'assists'] },
    { id: 'thebridge', name: 'The Bridge', fields: ['games', 'wins', 'kills', 'deaths', 'goals'] },
    { id: 'practice-18', name: 'Practice Legacy', fields: ['games', 'wins', 'kills', 'deaths', 'elo'] },
    { id: 'practice-121', name: 'Practice Modern', fields: ['games', 'wins', 'kills', 'deaths', 'elo'] },
    { id: 'bridge-practice', name: 'Bridge Practice', fields: ['bestTime', 'avgTime', 'attempts', 'completed', 'blocksPlaced', 'bestStreak'] },
    { id: 'uhc', name: 'UHC', fields: ['games', 'wins', 'kills', 'deaths', 'goldenApples'] },
    { id: 'murder-mystery', name: 'Murder Mystery', fields: ['games', 'wins', 'kills', 'deaths', 'winsAsMurderer', 'winsAsDetective'] },
    { id: 'party-games', name: 'Party Games', fields: ['games', 'wins', 'podiums', 'points'] },
    { id: 'agar', name: 'Agar.io', fields: ['maxMass', 'games', 'cellsEaten', 'playersEaten', 'deaths', 'playTime'] },
    { id: 'slither', name: 'Slither.io', fields: ['maxLength', 'games', 'orbsCollected', 'playersEaten', 'deaths', 'playTime'] },
];

// Skąd są dane gry w PlayersData.Stats; dziś zapisuje tylko VoltBedWars (Stats.BedWars).
const bedWarsRow = (row) => row && {
    games: num(row.Played),
    wins: num(row.Wins),
    kills: num(row.Kills),
    deaths: num(row.Deaths),
    bedsBroken: num(row.BedsBroken),
};
const SOURCES = {
    bedwars: (stats, season) => {
        const bw = stats && stats.BedWars;
        if (!bw) return null;
        if (season === undefined) return bedWarsRow(bw);
        return bedWarsRow(bw.Seasons && bw.Seasons[season]);
    },
};

// Nazwy sezonów (najstarszy pierwszy) z tego samego pola, co czyta hub: Config/VoltHUB -> stats-seasons.
async function seasonNames() {
    const document = await config().findOne({ _id: 'VoltHUB' }, { projection: { 'stats-seasons': 1 } });
    const list = document && Array.isArray(document['stats-seasons']) ? document['stats-seasons'] : [];
    return list.filter((name) => typeof name === 'string' && name.trim() !== '');
}

function games(stats, seasons) {
    return GAMES.map((definition) => {
        const zero = Object.fromEntries(definition.fields.map((field) => [field, 0]));
        const source = SOURCES[definition.id];
        const found = source ? source(stats) : null;
        const seasonRows = seasons.map((name) => ({ ...zero, ...((source && source(stats, name)) || {}), name }));
        return { id: definition.id, name: definition.name, total: { ...zero, ...(found || {}) }, modes: [], maps: [], seasons: seasonRows };
    });
}

// ---- gracze ---------------------------------------------------------------------------------------

/** Dokument gracza i jego konto po nicku (bez względu na wielkość liter), jak szuka VoltBans. */
async function findPlayer(nick) {
    const [data, account] = await Promise.all([
        players().findOne({ Nick: nick }, { collation: COLLATION }),
        accounts().findOne({ Nick: nick }, { collation: COLLATION, projection: { Nick: 1, PlayTime: 1, Ips: 1, Banned: 1 } }),
    ]);
    if (!data && !account) return null;
    return { data: data || {}, account: account || {}, name: (data && data.Nick) || account.Nick };
}

async function rankBook() {
    const document = await config().findOne({ _id: 'VoltRanks' }, { projection: { ranks: 1, 'default-normal': 1 } });
    return { ranks: (document && document.ranks) || {}, defaultNormal: (document && document['default-normal']) || 'gracz' };
}

async function levelCurve() {
    const document = await config().findOne({ _id: 'VoltEconomy' }, { projection: { levels: 1 } });
    const levels = (document && document.levels) || {};
    return { first: num(levels['first-level-xp']) || 228, step: num(levels['xp-per-level']) || 348.2 };
}

async function playerStats(nick) {
    const found = await findPlayer(nick);
    if (!found) return null;
    const [book, curve] = await Promise.all([rankBook(), levelCurve()]);
    const { data, account } = found;
    const voltRanks = data.VoltRanks || {};
    const economy = data.VoltEconomy || {};
    const stats = data.Stats || {};
    const now = Date.now();

    // Ranga ze sklepu: Gracz, gdy nie ma żadnej, to ranga domyślna albo już wygasła.
    let rank = 'Gracz';
    let rankExpires;
    const normal = voltRanks.Rank && book.ranks[voltRanks.Rank];
    const expire = voltRanks.Expire instanceof Date ? voltRanks.Expire : null;
    if (normal && voltRanks.Rank !== book.defaultNormal && (!expire || expire.getTime() > now)) {
        rank = normal.name || voltRanks.Rank.toUpperCase();
        rankExpires = iso(expire);
    }
    const functional = voltRanks.FunctionRank && book.ranks[voltRanks.FunctionRank];

    let marriedTo;
    const partner = data.VoltMarry && data.VoltMarry.Partner;
    if (partner) {
        const spouse = await players().findOne({ _id: partner }, { projection: { Nick: 1 } });
        marriedTo = spouse ? spouse.Nick : undefined;
    }

    const level = num(economy.Level);
    const ips = account.Ips || {};
    return {
        name: found.name,
        firstLogin: iso(ips.RegisteredAt),
        lastLogin: iso(ips.LastLoginAt),
        // Accounts.PlayTime liczy proxy w sekundach; przez API idzie w milisekundach.
        onlineMs: num(account.PlayTime) * 1000,
        rank,
        rankExpires,
        functionalRank: functional ? (functional.name || voltRanks.FunctionRank.toUpperCase()) : 'Brak',
        wins: num(stats.AllWin),
        losses: num(stats.AllLose),
        xp: num(economy.TotalXp),
        // Poziom liczy serwer (VoltEconomy): levelXp to XP zebrane w tym poziomie, levelNeeded koszt następnego.
        level,
        levelXp: num(economy.Xp),
        levelNeeded: Math.floor((2 * curve.step * level + 2 * curve.first + 1) / 2),
        coins: num(economy.Coins),
        voltcoins: num(economy.VoltCoins),
        banned: account.Banned === true,
        // Klan gracza (VoltClans); pole nie występuje, gdy gracz nie jest w żadnym klanie.
        ...(data.VoltClans && data.VoltClans.Tag ? { clan: { tag: String(data.VoltClans.Tag).toUpperCase() } } : {}),
        marriedTo,
        games: games(stats, await seasonNames()),
    };
}

// ---- topki ----------------------------------------------------------------------------------------

async function top(collection, field, value) {
    const rows = await collection
        .find({ [field]: { $exists: true, $ne: null } }, { projection: { Nick: 1, [field]: 1 } })
        .sort({ [field]: -1, _id: 1 })
        .limit(TOP_LIMIT)
        .toArray();
    const read = (row) => field.split('.').reduce((object, key) => (object == null ? undefined : object[key]), row);
    return rows.filter((row) => row.Nick).map((row) => ({ name: row.Nick, value: value(num(read(row))) }));
}

async function tops() {
    const same = (value) => value;
    const [wygrane, czas, przegrane, poziom, coiny, voltcoiny] = await Promise.all([
        top(players(), 'Stats.AllWin', same),
        top(accounts(), 'PlayTime', (seconds) => seconds * 1000),
        top(players(), 'Stats.AllLose', same),
        top(players(), 'VoltEconomy.Level', same),
        top(players(), 'VoltEconomy.Coins', same),
        top(players(), 'VoltEconomy.VoltCoins', same),
    ]);
    const rows = await allClans();
    const clanTop = (key) => rows.filter((clan) => clan[key] > 0)
        .sort((a, b) => b[key] - a[key] || a.tag.localeCompare(b.tag)).slice(0, TOP_LIMIT)
        .map((clan) => ({ name: clan.name, value: clan[key], tag: clan.tag }));
    return { wygrane, czas, przegrane, poziom, coiny, voltcoiny, 'klan-xp': clanTop('xp'), 'klan-coiny': clanTop('coins'), 'klan-voltcoiny': clanTop('voltcoins') };
}

// ---- klany (VoltClans: VOLT-MINECRAFT.Clans, _id = tag małymi literami) ----------------------------

const CLAN_TAG = /^[A-Za-z0-9]{1,16}$/;
const CLAN_ROLES = { LEADER: 'Lider', OFFICER: 'Zastępca', MEMBER: 'Członek' };
const CLAN_SORTS = { xp: 'xp', coins: 'coins', voltcoins: 'voltcoins', members: 'members' };

// Skarbiec klanu to Coins (wcześniej Bank); XP i VoltCoiny klanu to pola, które czytają też topki VoltCore.
function clanRow(doc) {
    const tag = String(doc.Tag || doc._id).toUpperCase();
    return {
        name: String(doc.Name || tag),
        tag,
        members: Array.isArray(doc.Members) ? doc.Members.length : 0,
        xp: num(doc.Xp),
        coins: num(doc.Coins != null ? doc.Coins : doc.Bank),
        voltcoins: num(doc.VoltCoins),
        created: doc.Created,
    };
}

async function allClans() {
    return (await clans().find({}, { projection: { Members: 1, Tag: 1, Name: 1, Xp: 1, Coins: 1, Bank: 1, VoltCoins: 1, Created: 1 } })
        .toArray()).map(clanRow);
}

async function clanList() {
    return (await allClans()).sort((a, b) => a.tag.localeCompare(b.tag))
        .map(({ name, tag, members, xp, coins, voltcoins }) => ({ name, tag, members, xp, coins, voltcoins }));
}

async function clanRanking(by) {
    const key = CLAN_SORTS[by] || 'xp';
    return (await allClans()).sort((a, b) => b[key] - a[key] || a.tag.localeCompare(b.tag)).slice(0, TOP_LIMIT)
        .map((clan, index) => ({ place: index + 1, name: clan.name, tag: clan.tag, value: clan[key] }));
}

async function clanStats(tag) {
    if (!CLAN_TAG.test(tag)) return null;
    const doc = await clans().findOne({ _id: tag.toLowerCase() });
    if (!doc) return null;
    const row = clanRow(doc);
    const settings = (await config().findOne({ _id: 'VoltClans' }, { projection: { 'max-members': 1 } })) || {};
    // Numer klanu: miejsce w kolejności założenia (najstarszy = 1).
    const created = doc.Created instanceof Date ? doc.Created : new Date(0);
    const older = await clans().countDocuments({ Created: { $lt: created } });
    const members = (Array.isArray(doc.Members) ? doc.Members : []).filter((m) => m && m.Nick).map((m) => ({
        name: String(m.Nick),
        role: CLAN_ROLES[m.Role] || 'Członek',
        joinedAt: iso(m.Joined),
        // Wkładu członków serwer jeszcze nie liczy.
        xp: 0,
        coins: 0,
        voltcoins: 0,
    }));
    return {
        id: older + 1,
        tag: row.tag,
        name: row.name,
        createdAt: iso(doc.Created),
        maxMembers: num(settings['max-members']) || members.length,
        xpTax: 0,
        coinTax: 0,
        members,
        xp: row.xp,
        coins: row.coins,
        voltcoins: row.voltcoins,
    };
}

async function online() {
    const since = new Date(Date.now() - ONLINE_BEAT_MS);
    const rows = await instances().find({ LastBeat: { $gte: since } }, { projection: { Online: 1 } }).toArray();
    return { online: rows.reduce((sum, row) => sum + num(row.Online), 0) };
}

// ---- odwiedziny -----------------------------------------------------------------------------------

const month = () => new Date().toISOString().slice(0, 7);
const VISIT_KINDS = ['player', 'clan'];

async function addVisit(body) {
    const kind = body && body.kind;
    const key = body && typeof body.key === 'string' ? body.key.trim() : '';
    const visitor = body && typeof body.visitor === 'string' ? body.visitor.slice(0, 512) : '';
    if (!VISIT_KINDS.includes(kind) || !/^[A-Za-z0-9_]{2,16}$/.test(key) || !visitor) return false;
    // Jedna wizyta na odwiedzającego, profil i dzień (UTC): odświeżanie strony nie nabija licznika.
    const day = new Date().toISOString().slice(0, 10);
    const seen = crypto.createHmac('sha256', SECRET).update(`${kind}:${key.toLowerCase()}:${day}:${visitor}`).digest('hex');
    try {
        await visitsSeen().insertOne({ _id: seen, ExpireAt: new Date(Date.now() + 2 * 86_400_000) });
    } catch (error) {
        if (error && error.code === 11000) return true;
        throw error;
    }
    const now = month();
    await visits().updateOne(
        { _id: `${kind}:${key.toLowerCase()}:${now}` },
        { $inc: { Count: 1 }, $set: { Kind: kind, Key: key, Month: now } },
        { upsert: true },
    );
    return true;
}

async function popular(kind) {
    if (!VISIT_KINDS.includes(kind)) return null;
    const rows = await visits().find({ Kind: kind, Month: month() }).sort({ Count: -1 }).limit(TOP_LIMIT).toArray();
    return rows.map((row) => ({ key: row.Key, monthlyVisits: num(row.Count) }));
}

// ---- zakupy ---------------------------------------------------------------------------------------

// Produkty sklepu strony (SITE/VoltCraft/src/config/shop.ts): rangi po 30 dni za sztukę i VoltCoiny w ilości.
const RANK_DAYS = 30;
const VOLTCOINS_PRODUCT = 'voltcoiny';
const MAX_AMOUNT = 1_000_000_000;

async function purchase(body) {
    const nick = body && typeof body.nick === 'string' ? body.nick.trim() : '';
    const product = body && typeof body.product === 'string' ? body.product : '';
    const amount = body && Number.isInteger(body.amount) ? body.amount : 0;
    const orderId = body && typeof body.orderId === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(body.orderId) ? body.orderId : crypto.randomUUID();
    if (!NICK.test(nick) || amount < 1) return { status: 400, body: { error: 'invalid' } };
    const found = await findPlayer(nick);
    if (!found) return { status: 404, body: { error: 'unknown-player' } };

    const order = { _id: orderId, Nick: found.name, Product: product, Amount: amount, Status: 'pending', CreatedAt: new Date() };
    if (product === VOLTCOINS_PRODUCT) {
        if (amount > MAX_AMOUNT) return { status: 400, body: { error: 'invalid' } };
        order.Kind = 'voltcoins';
    } else if (product.startsWith('ranga-')) {
        const rankId = product.slice('ranga-'.length);
        const book = await rankBook();
        const rank = book.ranks[rankId];
        if (!rank || rank.type !== 'normal' || rankId === book.defaultNormal || amount > 120) {
            return { status: 400, body: { error: 'unknown-product' } };
        }
        Object.assign(order, { Kind: 'rank', Rank: rankId, Time: `${RANK_DAYS * amount}d` });
    } else {
        return { status: 400, body: { error: 'unknown-product' } };
    }
    try {
        await orders().insertOne(order);
    } catch (error) {
        if (error && error.code === 11000) return { status: 200, body: { ok: true, orderId, duplicate: true } };
        throw error;
    }
    return { status: 201, body: { ok: true, orderId } };
}

// ---- rekrutacje: kto widzi podania których stanowisk ----------------------------------------------

// Ustawienia w VOLT-SITE.Config/Rekrutacje: positions = na stanowisko (slug strony rekrutacji) lista ID ról serwera głównego
// Discord (bota VoltCraft; wszystkie rangi są z nim synchronizowane); wystarczy jedna z nich.
const siteConfig = () => mongo.db('VOLT-SITE').collection('Config');
const RECRUIT_CONFIG = 'Rekrutacje';
const ACCESS_CACHE_MS = 30_000;
const accessCache = new Map();

/** Role członka na serwerze głównym Discord (klucze bota VoltCraft z .env VoltAPI SDK); [] gdy go tam nie ma. */
async function memberRoles(discordId) {
    const { Token: token, Guild: guild } = sdk.bot.discord('VoltCraft');
    if (!token || !guild) return [];
    const response = await fetch(`https://discord.com/api/v10/guilds/${guild}/members/${discordId}`, { headers: { Authorization: `Bot ${token}` } });
    if (!response.ok) return [];
    const member = await response.json();
    return Array.isArray(member.roles) ? member.roles : [];
}

async function recruitAccess(discordId) {
    const cached = accessCache.get(discordId);
    if (cached && cached.at > Date.now() - ACCESS_CACHE_MS) return cached.value;
    const config = await siteConfig().findOne({ _id: RECRUIT_CONFIG });
    const positions = (config && config.positions) || {};

    const held = await memberRoles(discordId).catch(() => []);
    const allowed = Object.entries(positions)
        .filter(([, ids]) => Array.isArray(ids) && ids.some((id) => held.includes(String(id))))
        .map(([slug]) => slug);
    // Override: role, które mogą zmienić już wydaną decyzję (przyjęte / odrzucone podanie).
    const override = Array.isArray(config && config.Override) && config.Override.some((id) => held.includes(String(id)));
    const value = { positions: allowed, override };
    accessCache.set(discordId, { at: Date.now(), value });
    return value;
}

// ---- rekrutacje: podania, otwarcie, blacklista, ustawienia graczy (VOLT-SITE) ---------------------
//
// VOLT-SITE.Applications  { _id: numer podania, Position, Status, Reason, CreatedAt, User: { Id, Username, Name }, Answers, History: [{ At, Status, Reason, By }] }
// VOLT-SITE.Counters      { _id: "Applications", Seq } (kolejny numer podania)
// VOLT-SITE.Config/Rekrutacje.Open  { <slug>: true/false } (ręczne otwarcie lub zamknięcie rekrutacji)
// VOLT-SITE.Blacklist     { _id: "<id Discord>:<slug>", User, Position, Reason, At }
// VOLT-SITE.Users         { _id: id Discord, Username, Name, Avatar, MinecraftNick, FirstLogin, LastLogin, LoginCount, Sites, LastSite, NotifyDiscord }
//                         (konta z logowania Discord, zapisywane przy /auth/discord/login; tu ustawienia gracza rekrutacji)
const site = (name) => mongo.db('VOLT-SITE').collection(name);
const STATUSES = ['pending', 'accepted', 'rejected'];
const SLUG = /^[a-z0-9-]{1,40}$/;
const DISCORD_ID = /^[0-9]{1,25}$/;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function applicationOut(doc) {
    const user = doc.User || {};
    return {
        id: doc._id,
        position: doc.Position,
        status: doc.Status,
        reason: doc.Reason || '',
        createdAt: iso(doc.CreatedAt),
        user: { id: user.Id, username: user.Username, name: user.Name },
        answers: doc.Answers || {},
        history: (doc.History || []).map((entry) => ({ at: iso(entry.At), status: entry.Status, reason: entry.Reason || '', by: entry.By || '' })),
    };
}

async function listApplications(userId) {
    const filter = userId ? { 'User.Id': userId } : {};
    return (await site('Applications').find(filter).sort({ _id: -1 }).toArray()).map(applicationOut);
}

async function createApplication(body) {
    const user = (body && body.user) || {};
    if (!SLUG.test((body && body.position) || '') || !DISCORD_ID.test(String(user.id || ''))) return null;
    const answers = {};
    for (const [key, value] of Object.entries((body && body.answers) || {})) {
        if (/^[A-Za-z0-9_-]{1,40}$/.test(key) && typeof value === 'string') answers[key] = value.slice(0, 5000);
    }
    const counter = await site('Counters').findOneAndUpdate({ _id: 'Applications' }, { $inc: { Seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const now = new Date();
    const doc = {
        _id: counter.Seq,
        Position: body.position,
        Status: 'pending',
        Reason: '',
        CreatedAt: now,
        User: { Id: String(user.id), Username: text(user.username, 100), Name: text(user.name, 100) },
        Answers: answers,
        History: [{ At: now, Status: 'pending', Reason: '', By: 'gracz' }],
    };
    await site('Applications').insertOne(doc);
    return applicationOut(doc);
}

// Zmiana statusu lub uzasadnienia; gdy coś się zmieniło, do historii trafia wpis z osobą, która to zrobiła.
async function updateApplication(id, body) {
    const current = await site('Applications').findOne({ _id: id });
    if (!current) return null;
    const status = STATUSES.includes(body && body.status) ? body.status : current.Status;
    const reason = body && typeof body.reason === 'string' ? body.reason.slice(0, 1000) : current.Reason;
    if (status === current.Status && reason === current.Reason) return applicationOut(current);
    const updated = await site('Applications').findOneAndUpdate(
        { _id: id },
        { $set: { Status: status, Reason: reason }, $push: { History: { At: new Date(), Status: status, Reason: reason, By: text(body && body.by, 100) || 'ekipa' } } },
        { returnDocument: 'after' },
    );
    return updated ? applicationOut(updated) : null;
}

async function openStates() {
    const doc = await siteConfig().findOne({ _id: RECRUIT_CONFIG }, { projection: { Open: 1 } });
    return (doc && doc.Open) || {};
}

async function listBlacklist(userId) {
    const rows = await site('Blacklist').find(userId ? { User: userId } : {}).sort({ At: -1 }).toArray();
    return rows.map((row) => ({ userId: row.User, slug: row.Position, reason: row.Reason || '' }));
}

async function recruitRoute(method, parts, url, request) {
    const [, what, key, extra] = parts;
    if (what === 'applications') {
        if (method === 'GET' && !key) {
            const user = url.searchParams.get('user');
            return { status: 200, body: await listApplications(user && DISCORD_ID.test(user) ? user : null) };
        }
        if (method === 'POST' && !key) {
            const created = await createApplication(await readBody(request));
            return created ? { status: 201, body: created } : { status: 400, body: { error: 'invalid' } };
        }
        if (key && /^\d+$/.test(key) && !extra) {
            const id = Number(key);
            if (method === 'GET') {
                const doc = await site('Applications').findOne({ _id: id });
                return doc ? { status: 200, body: applicationOut(doc) } : { status: 404, body: { error: 'not-found' } };
            }
            if (method === 'POST') {
                const updated = await updateApplication(id, await readBody(request));
                return updated ? { status: 200, body: updated } : { status: 404, body: { error: 'not-found' } };
            }
        }
    }
    if (what === 'open' && !key) {
        if (method === 'GET') return { status: 200, body: await openStates() };
        if (method === 'POST') {
            const body = await readBody(request);
            if (!SLUG.test((body && body.slug) || '') || typeof (body && body.open) !== 'boolean') return { status: 400, body: { error: 'invalid' } };
            await siteConfig().updateOne({ _id: RECRUIT_CONFIG }, { $set: { [`Open.${body.slug}`]: body.open } }, { upsert: true });
            return { status: 204 };
        }
    }
    if (what === 'blacklist') {
        if (method === 'GET' && !key) {
            const user = url.searchParams.get('user');
            return { status: 200, body: await listBlacklist(user && DISCORD_ID.test(user) ? user : null) };
        }
        if (method === 'POST' && (!key || key === 'remove')) {
            const body = await readBody(request);
            const userId = String((body && body.userId) || '');
            const slug = (body && body.slug) || '';
            if (!DISCORD_ID.test(userId) || !SLUG.test(slug)) return { status: 400, body: { error: 'invalid' } };
            if (key === 'remove') {
                await site('Blacklist').deleteOne({ _id: `${userId}:${slug}` });
            } else {
                await site('Blacklist').updateOne(
                    { _id: `${userId}:${slug}` },
                    { $set: { User: userId, Position: slug, Reason: text(body.reason, 1000), At: new Date() } },
                    { upsert: true },
                );
            }
            return { status: 204 };
        }
    }
    if (what === 'prefs' && key && DISCORD_ID.test(key) && !extra) {
        if (method === 'GET') {
            const doc = await site('Users').findOne({ _id: key });
            return { status: 200, body: { notifyDiscord: doc && typeof doc.NotifyDiscord === 'boolean' ? doc.NotifyDiscord : true } };
        }
        if (method === 'POST') {
            const body = await readBody(request);
            if (typeof (body && body.notifyDiscord) !== 'boolean') return { status: 400, body: { error: 'invalid' } };
            await site('Users').updateOne({ _id: key }, { $set: { NotifyDiscord: body.notifyDiscord } }, { upsert: true });
            return { status: 204 };
        }
    }
    return { status: 404, body: { error: 'not-found' } };
}

// ---- treści stron (panel): VOLT-SITE.Content, ContentHistory, logi w VOLT-LOGS.Panel ----------------
//
// VOLT-SITE.Content         { _id: klucz treści (np. "main.regulamin"), Data: opublikowana treść, Draft: szkic albo null,
//                             UpdatedAt, UpdatedBy, DraftAt, DraftBy }
// VOLT-SITE.ContentHistory  { _id, Key, Data, At, By, Action: "publish" | "restore" } (każda opublikowana wersja)
// VOLT-LOGS.Panel           { At, By, Key, Action } (kto co zmienił w panelu)
// VOLT-SITE.Config/Panel    { sections: { <klucz treści>: [id ról serwera głównego] }, Override: [id ról z dostępem do wszystkiego] }
// Strony czytają opublikowaną treść (albo szkic w trybie podglądu); brak dokumentu = treść wbudowana w stronę.
const CONTENT_KEY = /^[a-z]+\.[a-z0-9-]+$/;
const CONTENT_MAX = 20 * 1024 * 1024;
const contentCache = new Map();
const CONTENT_CACHE_MS = 3_000;
const { ObjectId } = require('voltapi-sdk').mongoose.Types;

async function readContent(key, draft) {
    const cached = !draft && contentCache.get(key);
    if (cached && cached.at > Date.now() - CONTENT_CACHE_MS) return cached.value;
    const doc = await site('Content').findOne({ _id: key });
    let value = null;
    if (doc) {
        const useDraft = draft && doc.Draft !== null && doc.Draft !== undefined;
        value = {
            data: useDraft ? doc.Draft : doc.Data,
            draft: useDraft,
            hasDraft: doc.Draft !== null && doc.Draft !== undefined,
            published: doc.Data !== null && doc.Data !== undefined,
            updatedAt: iso(doc.UpdatedAt),
            updatedBy: doc.UpdatedBy || null,
            draftAt: iso(doc.DraftAt),
            draftBy: doc.DraftBy || null,
        };
        if (!useDraft && !value.published) value = null;
    }
    if (!draft) contentCache.set(key, { at: Date.now(), value });
    return value;
}

// Wpis do logów panelu: kto (nazwa i ID konta Discord), co (klucz treści, akcja) i która wersja z historii (porównanie zmian).
async function panelLog(who, key, action, versionId) {
    const entry = { At: new Date(), By: who.by, ById: who.byId || null, Key: key, Action: action };
    if (versionId) entry.VersionId = String(versionId);
    await mongo.logs().collection('Panel').insertOne(entry).catch(() => {});
}

async function saveContent(key, body) {
    const by = text(body && body.by, 100) || 'panel';
    const who = { by, byId: /^[0-9]{5,25}$/.test(String(body && body.byId)) ? String(body.byId) : null };
    const mode = body && body.mode;
    if (mode === 'discard') {
        await site('Content').updateOne({ _id: key }, { $set: { Draft: null, DraftAt: null, DraftBy: null } });
        await panelLog(who, key, 'discard');
    } else {
        const data = body && body.data;
        if (data === undefined || data === null || typeof data !== 'object') return { status: 400, body: { error: 'invalid' } };
        if (JSON.stringify(data).length > CONTENT_MAX) return { status: 413, body: { error: 'too-large' } };
        const now = new Date();
        if (mode === 'draft') {
            await site('Content').updateOne({ _id: key }, { $set: { Draft: data, DraftAt: now, DraftBy: by } }, { upsert: true });
            await panelLog(who, key, 'draft');
        } else if (mode === 'publish' || mode === 'restore') {
            await site('Content').updateOne(
                { _id: key },
                { $set: { Data: data, Draft: null, DraftAt: null, DraftBy: null, UpdatedAt: now, UpdatedBy: by } },
                { upsert: true },
            );
            const version = await site('ContentHistory').insertOne({ Key: key, Data: data, At: now, By: by, ById: who.byId, Action: mode });
            await panelLog(who, key, mode, version.insertedId);
        } else {
            return { status: 400, body: { error: 'invalid' } };
        }
    }
    contentCache.delete(key);
    return { status: 200, body: await readContent(key, true) };
}

async function contentRoute(method, parts, url, request) {
    const [, key, what, id] = parts;
    if (method === 'GET' && !key) {
        const docs = await site('Content').find({}, { projection: { Data: 0, Draft: 0 } }).toArray();
        const drafts = await site('Content').find({ Draft: { $ne: null } }, { projection: { _id: 1 } }).toArray();
        const withDraft = new Set(drafts.map((doc) => doc._id));
        return { status: 200, body: docs.map((doc) => ({ key: doc._id, updatedAt: iso(doc.UpdatedAt), updatedBy: doc.UpdatedBy || null, hasDraft: withDraft.has(doc._id) })) };
    }
    if (!key || !CONTENT_KEY.test(key)) return { status: 404, body: { error: 'not-found' } };
    if (!what) {
        if (method === 'GET') {
            const value = await readContent(key, url.searchParams.get('draft') === '1');
            return value ? { status: 200, body: value } : { status: 404, body: { error: 'not-found' } };
        }
        if (method === 'POST') return saveContent(key, await readBody(request));
    }
    if (what === 'history' && method === 'GET') {
        if (!id) {
            const rows = await site('ContentHistory').find({ Key: key }, { projection: { Data: 0 } }).sort({ At: -1 }).limit(100).toArray();
            return { status: 200, body: rows.map((row) => ({ id: String(row._id), at: iso(row.At), by: row.By, action: row.Action })) };
        }
        if (!/^[0-9a-f]{24}$/.test(id)) return { status: 404, body: { error: 'not-found' } };
        const row = await site('ContentHistory').findOne({ _id: new ObjectId(id), Key: key });
        return row ? { status: 200, body: { id, at: iso(row.At), by: row.By, action: row.Action, data: row.Data } } : { status: 404, body: { error: 'not-found' } };
    }
    return { status: 404, body: { error: 'not-found' } };
}

// Dostęp do panelu treści: które klucze może edytować to konto Discord (role na serwerze głównym).
async function panelAccess(discordId) {
    const config = await siteConfig().findOne({ _id: 'Panel' });
    const held = await memberRoles(discordId).catch(() => []);
    const sections = (config && config.sections) || {};
    const all = Array.isArray(config && config.Override) && config.Override.some((role) => held.includes(String(role)));
    const keys = Object.entries(sections)
        .filter(([, roles]) => all || (Array.isArray(roles) && roles.some((role) => held.includes(String(role)))))
        .map(([key]) => key);
    return { keys, all };
}

// ---- logowanie przez Discord (OAuth2) dla stron: rekrutacje i panel treści ----------------------------
//
// Klucze aplikacji Discord są tylko tutaj (.env API: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET). Strona prosi o adres logowania,
// a po powrocie z Discorda oddaje kod; API wymienia go na konto i zapisuje je w VOLT-SITE.Users (Sites: na których stronach się logował).
// Sesję (ciasteczko) każda strona trzyma u siebie.
const DISCORD = 'https://discord.com/api/v10';
const AUTH_SITES = ['rekrutacje', 'panel'];
const discordConfigured = () => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);
const validRedirect = (value) => typeof value === 'string' && /^https?:\/\/[^\s]+\/api\/auth\/discord\/callback$/.test(value);

function authorizeUrl(redirect, state) {
    const params = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'identify', state, prompt: 'none' });
    return `https://discord.com/oauth2/authorize?${params}`;
}

async function discordLogin(body) {
    const code = typeof (body && body.code) === 'string' ? body.code : '';
    const redirect = body && body.redirect;
    const siteId = AUTH_SITES.includes(body && body.site) ? body.site : null;
    if (!code || !validRedirect(redirect) || !siteId) return { status: 400, body: { error: 'invalid' } };
    const token = await fetch(`${DISCORD}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect }),
    });
    if (!token.ok) return { status: 401, body: { error: 'discord-token' } };
    const accessToken = (await token.json()).access_token;
    const me = await fetch(`${DISCORD}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!me.ok) return { status: 401, body: { error: 'discord-user' } };
    const data = await me.json();
    const user = { id: String(data.id), username: String(data.username), name: String(data.global_name || data.username), avatar: data.avatar || null };

    const now = new Date();
    const linked = await accounts().findOne({ 'Recover.DiscordId': user.id }, { projection: { Nick: 1 } });
    await site('Users').updateOne(
        { _id: user.id },
        {
            $set: { Username: user.username, Name: user.name, Avatar: user.avatar, MinecraftNick: linked ? linked.Nick : null, LastLogin: now, LastSite: siteId },
            $setOnInsert: { FirstLogin: now, NotifyDiscord: true },
            $inc: { LoginCount: 1 },
            $addToSet: { Sites: siteId },
        },
        { upsert: true },
    );
    if (siteId === 'panel') await panelLog({ by: user.username, byId: user.id }, '-', 'login');
    return { status: 200, body: { user } };
}

async function authRoute(method, parts, url, request) {
    if (parts[1] !== 'discord') return { status: 404, body: { error: 'not-found' } };
    if (method === 'GET' && !parts[2]) return { status: 200, body: { configured: discordConfigured() } };
    if (!discordConfigured()) return { status: 503, body: { error: 'not-configured' } };
    if (method === 'GET' && parts[2] === 'authorize') {
        const redirect = url.searchParams.get('redirect');
        const state = url.searchParams.get('state') || '';
        if (!validRedirect(redirect) || !/^[0-9a-f]{16,64}$/.test(state)) return { status: 400, body: { error: 'invalid' } };
        return { status: 200, body: { url: authorizeUrl(redirect, state) } };
    }
    if (method === 'POST' && parts[2] === 'login') return discordLogin(await readBody(request));
    return { status: 404, body: { error: 'not-found' } };
}

// ---- serwer HTTP ----------------------------------------------------------------------------------

function authorized(request) {
    const header = request.headers.authorization || '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const expected = Buffer.from(SECRET);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Blokada zgadywania sekretu z zewnątrz: zapytania z portu 6500 przychodzą przez nginx, który ustawia X-Real-IP na adres
// klienta (strony na tym VPS wołają 127.0.0.1:3300 bez tego nagłówka i nigdy nie są blokowane). Po FAIL_LIMIT złych
// sekretach w FAIL_WINDOW_MS adres dostaje 403 na BLOCK_MS, także z dobrym sekretem.
const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const BLOCK_MS = 60 * 60_000;
const failures = new Map();

function clientIp(request) {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
    const ip = local ? request.headers['x-real-ip'] : request.socket.remoteAddress;
    return typeof ip === 'string' && ip ? ip : null;
}

function blocked(ip) {
    const entry = ip && failures.get(ip);
    return Boolean(entry && entry.blockedUntil > Date.now());
}

function recordFailure(ip) {
    if (!ip) return;
    const now = Date.now();
    let entry = failures.get(ip);
    if (!entry || now - entry.since > FAIL_WINDOW_MS) entry = { since: now, count: 0, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= FAIL_LIMIT) {
        entry.blockedUntil = now + BLOCK_MS;
        console.warn(`API: adres ${ip} zablokowany na ${BLOCK_MS / 60_000} min po ${entry.count} złych sekretach`);
    }
    failures.set(ip, entry);
}

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of failures) {
        if (entry.blockedUntil <= now && now - entry.since > FAIL_WINDOW_MS) failures.delete(ip);
    }
}, 10 * 60_000).unref();

// Limit ciała zapytania (20 MB, tyle co nginx i panel).
const BODY_LIMIT = 20 * 1024 * 1024;

function readBody(request, limit = BODY_LIMIT) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        request.on('data', (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('too large'));
                request.destroy();
            } else {
                chunks.push(chunk);
            }
        });
        request.on('end', () => {
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
            } catch (error) {
                resolve(null);
            }
        });
        request.on('error', reject);
    });
}

async function route(request) {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method;

    if (method === 'GET' && parts[0] === 'online' && parts.length === 1) return { status: 200, body: await online() };
    if (method === 'GET' && parts[0] === 'players' && NICK.test(parts[1] || '')) {
        if (parts.length === 2) {
            const stats = await playerStats(parts[1]);
            return stats ? { status: 200, body: stats } : { status: 404, body: { error: 'not-found' } };
        }
        if (parts.length === 3 && parts[2] === 'exists') {
            const found = await findPlayer(parts[1]);
            return { status: 200, body: { exists: !!found, name: found ? found.name : undefined } };
        }
    }
    if (method === 'GET' && parts[0] === 'discord' && parts.length === 2 && /^[0-9]{5,25}$/.test(parts[1])) {
        const account = await accounts().findOne({ 'Recover.DiscordId': parts[1] }, { projection: { Nick: 1 } });
        return account ? { status: 200, body: { nick: account.Nick, uuid: String(account._id) } } : { status: 404, body: { error: 'not-linked' } };
    }
    if (method === 'GET' && parts[0] === 'recruit-access' && parts.length === 2 && /^[0-9]{5,25}$/.test(parts[1])) {
        return { status: 200, body: await recruitAccess(parts[1]) };
    }
    if (method === 'GET' && parts[0] === 'tops' && parts.length === 1) return { status: 200, body: await tops() };
    if (method === 'GET' && parts[0] === 'clans' && parts.length === 1) return { status: 200, body: await clanList() };
    if (method === 'GET' && parts[0] === 'clans' && parts.length === 2) {
        const stats = await clanStats(decodeURIComponent(parts[1]));
        return stats ? { status: 200, body: stats } : { status: 404, body: { error: 'not-found' } };
    }
    if (method === 'GET' && parts[0] === 'clans-ranking' && parts.length === 1) {
        return { status: 200, body: await clanRanking(url.searchParams.get('by')) };
    }
    if (parts[0] === 'visits' && parts.length === 1) {
        if (method === 'GET') {
            const list = await popular(url.searchParams.get('kind'));
            return list ? { status: 200, body: list } : { status: 400, body: { error: 'invalid' } };
        }
        if (method === 'POST') {
            return (await addVisit(await readBody(request))) ? { status: 204 } : { status: 400, body: { error: 'invalid' } };
        }
    }
    if (parts[0] === 'recruit') return recruitRoute(method, parts, url, request);
    if (parts[0] === 'content') return contentRoute(method, parts, url, request);
    if (parts[0] === 'auth') return authRoute(method, parts, url, request);
    if (method === 'GET' && parts[0] === 'panel-logs' && parts.length === 1) {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const rows = await mongo.logs().collection('Panel').find({}).sort({ At: -1 }).limit(limit).toArray();
        return { status: 200, body: rows.map((row) => ({ at: iso(row.At), by: row.By, byId: row.ById || null, key: row.Key, action: row.Action, versionId: row.VersionId || null })) };
    }
    if (method === 'GET' && parts[0] === 'panel-access' && parts.length === 2 && /^[0-9]{5,25}$/.test(parts[1])) return { status: 200, body: await panelAccess(parts[1]) };
    if (method === 'POST' && parts[0] === 'purchases' && parts.length === 1) return purchase(await readBody(request));
    return { status: 404, body: { error: 'not-found' } };
}

async function main() {
    if (SECRET.length < 32) {
        console.error('SITE_API_SECRET w .env musi mieć co najmniej 32 znaki.');
        process.exit(1);
    }
    await mongo.connect();
    await visitsSeen().createIndex({ ExpireAt: 1 }, { expireAfterSeconds: 0 });
    // Kolekcje strony rekrutacji są od razu w bazie (także puste) i mają indeksy pod zapytania strony.
    const existing = new Set((await mongo.db('VOLT-SITE').db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    for (const name of ['Applications', 'Blacklist', 'Users', 'Counters', 'Content', 'ContentHistory']) {
        if (!existing.has(name)) await mongo.db('VOLT-SITE').db.createCollection(name);
    }
    await site('Applications').createIndex({ 'User.Id': 1, _id: -1 });
    await site('Blacklist').createIndex({ User: 1 });
    await site('ContentHistory').createIndex({ Key: 1, At: -1 });
    const server = http.createServer(async (request, response) => {
        let result;
        const ip = clientIp(request);
        if (blocked(ip)) {
            result = { status: 403, body: { error: 'blocked' } };
        } else if (!authorized(request)) {
            recordFailure(ip);
            result = { status: 401, body: { error: 'unauthorized' } };
        } else {
            try {
                result = await route(request);
            } catch (error) {
                console.error(`${request.method} ${request.url}:`, error && error.message);
                result = { status: 500, body: { error: 'server' } };
            }
        }
        response.writeHead(result.status, result.body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    });
    server.listen(PORT, HOST, () => console.log(`VoltCraft API: http://${HOST}:${PORT}`));
}

main();
