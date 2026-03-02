import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import http from "http";
import { Server as IOServer } from "socket.io";


function loadDotEnv() {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.error("[env] failed to load .env:", e);
  }
}
loadDotEnv();

import { STORE } from "./store.js";
import { PROFILES } from "./profileStore.js";
import { QUEUE } from "./queueStore.js";
import { USERS } from "./userStore.js";
import {
  createPartySchema,
  joinPartySchema,
  rejoinSchema,
  buffsSchema,
  updateMemberSchema,
  updateTitleSchema,
  kickSchema,
  transferOwnerSchema,
  lockSchema,
  profileSchema
} from "./validators.js";
import { cleanupSessions, cookieSerialize, deleteSession, getSession, newSession, parseCookies, type DiscordUser } from "./auth.js";

const PORT = Number(process.env.PORT ?? 8000);
const MEMBER_TTL_MS = Number(process.env.MEMBER_TTL_MS ?? 70_000); 
const PARTY_TTL_MS = Number(process.env.PARTY_TTL_MS ?? 10 * 60_000); 

const PUBLIC_URL = (process.env.PUBLIC_URL ?? process.env.ORIGIN ?? `http://localhost:${PORT}`).trim();
const ORIGIN_RAW = (process.env.ORIGIN ?? PUBLIC_URL).trim();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? "";
const DISCORD_REDIRECT_URI = (process.env.DISCORD_REDIRECT_URI ?? `${PUBLIC_URL.replace(/\/$/, "")}/auth/discord/callback`).trim();

function parseOrigins(raw: string): string[] | "*" {
  if (raw === "*") return "*";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
const ORIGINS = parseOrigins(ORIGIN_RAW);

const app = express();

function resolveNameToId(s: string): string | null {
  return USERS.resolveNameToId(s);
}

app.use(cors({ origin: ORIGINS === "*" ? true : ORIGINS, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: ORIGINS === "*" ? true : ORIGINS, credentials: true }
});

function broadcastParties() {
  io.emit("partiesUpdated", { parties: STORE.listParties() });
}

function broadcastParty(partyId: string) {
  const party = STORE.getParty(partyId);
  if (party) io.emit("partyUpdated", { party });
  broadcastParties();
}

function broadcastQueueCounts() {
  io.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() });
}

function extractSessionId(req: express.Request): string | undefined {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies["ml_session"];
  if (fromCookie) return fromCookie;
  const fromHeader = (req.headers["x-ml-session"] as string | undefined) ?? undefined;
  if (fromHeader && typeof fromHeader === "string") return fromHeader;
  return undefined;
}

function setSessionCookie(res: express.Response, sessionId: string) {
  res.setHeader("Set-Cookie", cookieSerialize("ml_session", sessionId, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7
  }));
}

function requireAuth(req: express.Request, res: express.Response): { user: DiscordUser; sessionId: string } | null {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) { res.status(401).json({ error: "UNAUTHORIZED" }); return null; }
  return { user: s.user, sessionId: s.sessionId };
}


app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/party/chat", (req, res) => {
  const { partyId, sender, msg } = req.body;
  if (!partyId || !msg) return res.status(400).json({ error: "MISSING_DATA" });
  const p = STORE.addMessage(partyId, sender || "익명", msg);
  if (p) {
    broadcastParty(partyId);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: "PARTY_NOT_FOUND" });
});

app.post("/api/party/channel", (req, res) => {
  const { partyId, channel } = req.body;
  if (!partyId || !channel) return res.status(400).json({ error: "MISSING_DATA" });
  const p = STORE.getParty(partyId);
  if (p) {
    p.channel = channel;
    p.updatedAt = Date.now();
    broadcastParty(partyId);
    return res.json({ ok: true });
  }
  res.status(404).json({ error: "PARTY_NOT_FOUND" });
});

app.get("/api/me", (req, res) => {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) return res.status(401).json({ error: "UNAUTHORIZED" });
  res.json({ user: s.user, profile: USERS.get(s.user.id) });
});

app.post("/api/logout", (req, res) => {
  const sid = extractSessionId(req);
  if (sid) deleteSession(sid);
  res.json({ ok: true });
});

app.get("/auth/discord", (_req, res) => {
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");
  try {
    const tRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: String(code), redirect_uri: DISCORD_REDIRECT_URI }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const tData = (await tRes.json()) as any;
    const uRes = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${tData.access_token}` } });
    const uData = (await uRes.json()) as DiscordUser;
    const session = newSession(uData);
    setSessionCookie(res, session.sessionId);
    res.send(`<html><script>window.location.href="/#sid=${encodeURIComponent(session.sessionId)}";</script></html>`);
  } catch (e: any) { res.status(500).send(e.message); }
});

app.get("/api/parties", (_req, res) => res.json({ parties: STORE.listParties() }));

app.post("/api/party", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = createPartySchema.parse(req.body);
  const up = USERS.get(auth.user.id);
  const party = STORE.createParty({ title: body.title, ownerId: auth.user.id, ownerName: auth.user.global_name ?? auth.user.username, lockPassword: body.lockPassword, groundId: body.groundId, groundName: body.groundName, ownerLevel: up?.level ?? 1, ownerJob: (up?.job as any) ?? "전사", ownerPower: up?.power ?? 0 });
  broadcastParties();
  res.json({ party });
});

app.post("/api/party/join", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = joinPartySchema.parse(req.body);
  const up = USERS.get(auth.user.id);
  const party = STORE.joinParty({ partyId: body.partyId, userId: auth.user.id, name: auth.user.global_name ?? auth.user.username, level: up?.level ?? 1, job: (up?.job as any) ?? "전사", power: up?.power ?? 0, lockPassword: body.lockPassword ?? null, groundId: body.groundId ?? null, groundName: body.groundName ?? null });
  broadcastParty(body.partyId);
  res.json({ party });
});

app.post("/api/party/rejoin", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = rejoinSchema.parse(req.body);
  const up = USERS.get(auth.user.id);
  const party = STORE.rejoin({ partyId: body.partyId, userId: auth.user.id, name: auth.user.global_name ?? auth.user.username, level: up?.level ?? 1, job: (up?.job as any) ?? "전사", power: up?.power ?? 0 });
  broadcastParty(body.partyId);
  res.json({ party });
});

app.post("/api/party/leave", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = rejoinSchema.parse(req.body);
  STORE.leaveParty({ partyId: body.partyId, userId: auth.user.id });
  broadcastParty(body.partyId);
  res.json({ ok: true });
});

app.post("/api/party/buffs", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = buffsSchema.parse(req.body);
  const party = STORE.updateBuffs({ partyId: body.partyId, userId: auth.user.id, buffs: body.buffs });
  broadcastParty(body.partyId);
  res.json({ party });
});

app.post("/api/party/transfer", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const body = transferOwnerSchema.parse(req.body);
  const party = STORE.transferOwner({ partyId: body.partyId, userId: auth.user.id, newOwnerId: body.newOwnerId });
  broadcastParty(body.partyId);
  res.json({ party });
});


const socketToUserId = new Map<string, string>();

function cleanupPartyMembership(userId: string) {
  try {
    const cur = QUEUE.get(userId);
    let pid = cur?.partyId;
    if (!pid) {
      for (const sp of STORE.listParties()) {
        const full = STORE.getParty(sp.id);
        if (full?.members.some(m => m.userId === userId)) { pid = sp.id; break; }
      }
    }
    if (!pid) return;
    const before = STORE.getParty(pid);
    const out = STORE.leaveParty({ partyId: pid, userId });
    const p = out ?? STORE.getParty(pid);
    if (!!before?.title?.startsWith("사냥터 ") && p && p.members.length < 2) {
      STORE.deleteParty(pid);
      io.emit("partyDeleted", { partyId: pid });
      broadcastParties();
      return;
    }
    if (!p) { io.emit("partyDeleted", { partyId: pid }); broadcastParties(); return; }
    broadcastParty(pid);
  } catch {}
}

function requireSocketUser(socket: import("socket.io").Socket): DiscordUser | null {
  try {
    const sid = parseCookies((socket.handshake.headers?.cookie ?? "") as string)["ml_session"];
    return getSession(sid)?.user ?? null;
  } catch { return null; }
}

io.on("connection", (socket) => {
  socket.on("joinPartyRoom", ({ partyId }: { partyId: string }) => {
    if (!partyId) return;
    socket.join(partyId);
    const party = STORE.getParty(partyId);
    if (party) {
      const u = requireSocketUser(socket);
      if (u) { socketToUserId.set(socket.id, u.id); STORE.touchMember(partyId, u.id); }
      socket.emit("partyUpdated", { party });
    }
  });

  socket.on("party:sendChat", (payload: any) => {
    const { partyId, sender, msg } = payload;
    if (!partyId || !msg || !msg.trim()) return;
    
    // 서버 메모리에 채팅 저장
    const p = STORE.addMessage(partyId, sender || "익명", msg.trim());
    
    // 저장된 파티 정보 전체를 모든 소켓에 공지 (룸 기능 미사용으로 전송 보장)
    if (p) {
      console.log(`[socket] Chat saved & broadcasted: [${partyId}] ${msg}`);
      io.emit("partyUpdated", { party: p });
    }
  });

  socket.on("party:setChannel", (payload: any) => {
    const { partyId, channel } = payload;
    if (!partyId || !channel) return;
    
    const p = STORE.getParty(partyId);
    if (p) {
      p.channel = channel;
      p.updatedAt = Date.now();
      console.log(`[socket] Channel saved & broadcasted: [${partyId}] ${channel}`);
      
      // 모든 소켓에 공지
      io.emit("partyUpdated", { party: p });
      io.emit("partiesUpdated", { parties: STORE.listParties() });
    }
  });

  socket.on("party:heartbeat", ({ partyId }: { partyId: string }) => {
    const u = requireSocketUser(socket);
    if (u && partyId) { socketToUserId.set(socket.id, u.id); if (STORE.touchMember(String(partyId), u.id)) broadcastParty(String(partyId)); }
  });

  function emitQueueStatus(uid: string, socketId?: string) {
    const cur = QUEUE.get(uid);
    const emitter = socketId ? io.to(socketId) : socket;
    const pInStore = STORE.getPartyByUserId(uid);
    if (!cur || cur.state === "idle") { (emitter as any).emit("queue:status", { state: "idle", partyId: pInStore?.id ?? "" }); return; }
    if (cur.state === "searching") { (emitter as any).emit("queue:status", { state: "searching", partyId: pInStore?.id ?? cur.partyId ?? "" }); return; }
    (emitter as any).emit("queue:status", { state: "matched", channel: cur.channel ?? "", isLeader: cur.leaderId === uid, channelReady: !!cur.channel, partyId: pInStore?.id ?? cur.partyId ?? "" });
  }

  socket.on("queue:hello", async () => {
    const u = requireSocketUser(socket);
    if (u) { socketToUserId.set(socket.id, u.id); emitQueueStatus(u.id); socket.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() }); }
  });

  socket.on("queue:updateProfile", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    socketToUserId.set(socket.id, u.id);
    const displayName = String(p?.displayName ?? u.global_name ?? u.username).trim();
    USERS.upsert(u.id, { displayName, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0) });
    const touched = STORE.updateMemberProfile(u.id, { name: displayName, level: Number(p?.level), job: p?.job, power: Number(p?.power) });
    for (const pid of touched) broadcastParty(pid);
  });

  socket.on("queue:join", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    socketToUserId.set(socket.id, u.id);
    const hg = String(p?.huntingGroundId ?? "").trim();
    if (!hg) return;
    USERS.upsert(u.id, { displayName: u.global_name ?? u.username, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0), blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [] });
    QUEUE.upsert(socket.id, hg, { userId: u.id, displayName: u.global_name ?? u.username, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0), blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [] });
    socket.emit("queue:status", { state: "searching" });
    broadcastQueueCounts();
    const matched = QUEUE.tryMatch(hg, resolveNameToId);
    if (matched.ok) {
      try {
        const leader = matched.a.userId === matched.leaderId ? matched.a : matched.b;
        const other = leader === matched.a ? matched.b : matched.a;
        const party = STORE.createParty({ ownerId: matched.leaderId, ownerName: leader.displayName, ownerLevel: Number(leader.level ?? 1), ownerJob: leader.job as any, ownerPower: Number(leader.power ?? 0), title: `사냥터 ${hg}`, groundId: hg, groundName: `사냥터 ${hg}`, lockPassword: null });
        STORE.joinParty({ partyId: party.id, userId: other.userId, name: other.displayName, level: Number(other.level ?? 1), job: other.job as any, power: Number(other.power ?? 0) });
        QUEUE.setPartyForMatch(matched.matchId, party.id);
        broadcastParty(party.id);
      } catch (e) { console.error(e); }
      emitQueueStatus(matched.a.userId, matched.a.socketId); emitQueueStatus(matched.b.userId, matched.b.socketId); broadcastQueueCounts();
    }
  });

  socket.on("queue:setChannel", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    const channel = `${String(p?.letter ?? "").toUpperCase().trim()}-${String(p?.num ?? "").trim().padStart(3, "0")}`;
    const r = QUEUE.setChannelByLeader(u.id, channel);
    if (r.ok && r.members[0]?.partyId) {
      const party = STORE.getParty(r.members[0].partyId);
      if (party) { party.channel = channel; broadcastParty(party.id); }
      for (const m of r.members) emitQueueStatus(m.userId, m.socketId);
      broadcastQueueCounts();
    }
  });

  socket.on("queue:leave", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) { cleanupPartyMembership(uid); QUEUE.leave(uid); socketToUserId.delete(socket.id); }
    socket.emit("queue:status", { state: "idle" }); broadcastQueueCounts();
  });

  socket.on("disconnect", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) { if (QUEUE.get(uid)?.state === "searching") QUEUE.leave(uid); socketToUserId.delete(socket.id); }
    broadcastQueueCounts();
  });
});

setInterval(() => {
  try {
    const changed = STORE.sweepStaleMembers({ memberTtlMs: MEMBER_TTL_MS, partyTtlMs: PARTY_TTL_MS });
    if (changed.length) { for (const pid of changed) { if (!STORE.getParty(pid)) io.emit("partyDeleted", { partyId: pid }); } broadcastParties(); }
    const cleaned = QUEUE.cleanupDanglingParties((pid) => !!STORE.getParty(pid));
    if (cleaned.length) { for (const e of cleaned) io.to(e.socketId).emit("queue:status", { state: "idle" }); broadcastQueueCounts(); }
  } catch {}
}, 15_000).unref();

const webOut = path.resolve(process.cwd(), "../web/out");
if (fs.existsSync(webOut)) {
  app.use(express.static(webOut));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "API_NOT_FOUND" });
    res.sendFile(path.join(webOut, "index.html"));
  });
}

setInterval(() => cleanupSessions(), 60_000).unref();
server.listen(PORT, () => console.log(`[server] listening on ${PORT}`));