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
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
const ORIGINS = parseOrigins(ORIGIN_RAW);

const app = express();

function resolveNameToId(s: string): string | null {
  return USERS.resolveNameToId(s);
}



app.use(
  cors({
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  })
);
app.use(express.json());


function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    rec.count += 1;
    if (rec.count > opts.max) return res.status(429).json({ error: "RATE_LIMITED" });
    return next();
  };
}

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: {
    origin: ORIGINS === "*" ? true : ORIGINS,
    credentials: true
  }
});

let broadcastTimer: NodeJS.Timeout | null = null;
function broadcastParties() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    io.emit("partiesUpdated", { parties: STORE.listParties() });
  }, 150);
}
function broadcastParty(partyId: string) {
  const party = STORE.getParty(partyId);
  if (party) io.emit("partyUpdated", { party });
  broadcastParties();
}

let queueCountTimer: NodeJS.Timeout | null = null;
function broadcastQueueCounts() {
  if (queueCountTimer) return;
  queueCountTimer = setTimeout(() => {
    queueCountTimer = null;
    io.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() });
  }, 150);
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
  res.setHeader(
    "Set-Cookie",
    cookieSerialize("ml_session", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7
    })
  );
}

function requireAuth(req: express.Request, res: express.Response): { user: DiscordUser; sessionId: string } | null {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return null;
  }
  return { user: s.user, sessionId: s.sessionId };
}

app.post("/api/party/chat", (req, res) => {
  const { partyId, sender, msg } = req.body;
  if (!partyId || !msg) return res.status(400).json({ error: "MISSING_DATA" });
  
  const p = STORE.addMessage(partyId, sender || "익명", msg);
  if (p) {
    broadcastParty(partyId);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "PARTY_NOT_FOUND" });
  }
});

app.post("/api/party/channel", (req, res) => {
  const { partyId, channel } = req.body;
  if (!partyId || !channel) return res.status(400).json({ error: "MISSING_DATA" });
  
  const p = STORE.getParty(partyId);
  if (p) {
    p.channel = channel;
    p.updatedAt = Date.now();
    broadcastParty(partyId);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "PARTY_NOT_FOUND" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, now: Date.now() }));

app.get("/api/me", (req, res) => {
  const sid = extractSessionId(req);
  const s = getSession(sid);
  if (!s) return res.status(401).json({ error: "UNAUTHORIZED" });
  const up = USERS.get(s.user.id);
  res.json({ user: s.user, profile: up });
});

app.post("/api/logout", (req, res) => {
  const sid = extractSessionId(req);
  if (sid) deleteSession(sid);
  res.json({ ok: true });
});

app.get("/auth/discord", (_req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    DISCORD_REDIRECT_URI
  )}&response_type=code&scope=identify`;
  res.redirect(url);
});

app.get("/auth/discord/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    const tRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: DISCORD_REDIRECT_URI
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const tData = (await tRes.json()) as any;
    if (tData.error) throw new Error(tData.error_description);

    const uRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tData.access_token}` }
    });
    const uData = (await uRes.json()) as DiscordUser;

    const session = newSession(uData);
    setSessionCookie(res, session.sessionId);

    res.send(`<html><script>window.location.href="/#sid=${encodeURIComponent(session.sessionId)}";</script></html>`);
  } catch (e: any) {
    res.status(500).send(e.message);
  }
});

app.get("/api/parties", (_req, res) => {
  res.json({ parties: STORE.listParties() });
});

app.post("/api/party", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = createPartySchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.createParty({
      title: body.title,
      ownerId: auth.user.id,
      ownerName: auth.user.global_name ?? auth.user.username,
      lockPassword: body.lockPassword,
      groundId: body.groundId,
      groundName: body.groundName,
      ownerLevel: up?.level ?? 1,
      ownerJob: (up?.job as any) ?? "전사",
      ownerPower: up?.power ?? 0
    });
    broadcastParties();
    res.json({ party });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "CREATE_FAILED" });
  }
});

app.post("/api/party/join", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = joinPartySchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.joinParty({
      partyId: body.partyId,
      userId: auth.user.id,
      name: auth.user.global_name ?? auth.user.username,
      level: up?.level ?? 1,
      job: (up?.job as any) ?? "전사",
      power: up?.power ?? 0,
      lockPassword: body.lockPassword ?? null,
      groundId: body.groundId ?? null,
      groundName: body.groundName ?? null
    });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "JOIN_FAILED" });
  }
});

app.post("/api/party/rejoin", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = rejoinSchema.parse(req.body);
    const up = USERS.get(auth.user.id);
    const party = STORE.rejoin({
      partyId: body.partyId,
      userId: auth.user.id,
      name: auth.user.global_name ?? auth.user.username,
      level: up?.level ?? 1,
      job: (up?.job as any) ?? "전사",
      power: up?.power ?? 0
    });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "REJOIN_FAILED" });
  }
});

app.post("/api/party/leave", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = rejoinSchema.parse(req.body);
    STORE.leaveParty({ partyId: body.partyId, userId: auth.user.id });
    broadcastParty(body.partyId);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: "LEAVE_FAILED" });
  }
});

app.post("/api/party/title", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = updateTitleSchema.parse(req.body);
    const party = STORE.updateTitle({ partyId: body.partyId, userId: auth.user.id, title: body.title });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/member", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = updateMemberSchema.parse(req.body);
    const party = STORE.updateMemberName({ partyId: body.partyId, userId: auth.user.id, memberId: body.memberId, displayName: body.displayName });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/buffs", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = buffsSchema.parse(req.body);
    const party = STORE.updateBuffs({ partyId: body.partyId, userId: auth.user.id, buffs: body.buffs });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/lock", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = lockSchema.parse(req.body);
    const party = STORE.setLock({ partyId: body.partyId, userId: auth.user.id, isLocked: body.isLocked, lockPassword: body.lockPassword });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "UPDATE_FAILED" });
  }
});

app.post("/api/party/kick", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = kickSchema.parse(req.body);
    const party = STORE.kick({ partyId: body.partyId, userId: auth.user.id, targetUserId: body.targetUserId });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "KICK_FAILED" });
  }
});

app.post("/api/party/transfer", (req, res) => {
  const auth = requireAuth(req, res);
  if (!auth) return;
  try {
    const body = transferOwnerSchema.parse(req.body);
    const party = STORE.transferOwner({ partyId: body.partyId, userId: auth.user.id, newOwnerId: body.newOwnerId });
    broadcastParty(body.partyId);
    res.json({ party });
  } catch {
    res.status(400).json({ error: "TRANSFER_FAILED" });
  }
});



const socketToUserId = new Map<string, string>();

function cleanupPartyMembership(userId: string) {
  try {
    const cur = QUEUE.get(userId);
    let pid = cur?.partyId;

    if (!pid) {
      const parties = STORE.listParties();
      for (const sp of parties) {
        const full = STORE.getParty(sp.id);
        if (full?.members.some(m => m.userId === userId)) {
          pid = sp.id;
          break;
        }
      }
    }

    if (!pid) return;
    const before = STORE.getParty(pid);
    const out = STORE.leaveParty({ partyId: pid, userId });

    const p = out ?? STORE.getParty(pid);
    const wasAuto = !!before?.title?.startsWith("사냥터 ");
    if (wasAuto && p && p.members.length < 2) {
      STORE.deleteParty(pid);
      io.emit("partyDeleted", { partyId: pid });
      broadcastParties();
      return;
    }

    if (!p) {
      io.emit("partyDeleted", { partyId: pid });
      broadcastParties();
      return;
    }
    broadcastParty(pid);
  } catch {
  }
}

function requireSocketUser(socket: import("socket.io").Socket): DiscordUser | null {
  try {
    const cookieHeader = (socket.handshake.headers?.cookie ?? "") as string;
    const cookies = parseCookies(cookieHeader);
    const sid = cookies["ml_session"];
    const s = getSession(sid);
    return s?.user ?? null;
  } catch {
    return null;
  }
}

io.on("connection", (socket) => {
  socket.on("joinPartyRoom", ({ partyId }: { partyId: string }) => {
    if (!partyId) return;
    socket.join(partyId);
    const party = STORE.getParty(partyId);
    if (party) {
      const u = requireSocketUser(socket);
      if (u) {
        socketToUserId.set(socket.id, u.id);
        STORE.touchMember(partyId, u.id);
      }
      socket.emit("partyUpdated", { party });
    }
  });

  socket.on("party:sendChat", (payload: any) => {
    const { partyId, sender, msg } = payload;
    if (!msg || !msg.trim()) return;
    const p = STORE.addMessage(partyId, sender || "익명", msg.trim());
    if (p) {
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
      console.log(`[socket] CHANNEL UPDATED: [${partyId}] ${channel}`);
      // 모든 인원에게 즉시 파티 업데이트 공지
      io.emit("partyUpdated", { party: p });
      broadcastParties();
    }
  });

  socket.on("party:heartbeat", ({ partyId }: { partyId: string }) => {
    const u = requireSocketUser(socket);
    if (u && partyId) {
      socketToUserId.set(socket.id, u.id);
      const p = STORE.touchMember(String(partyId), u.id);
      if (p) broadcastParty(String(partyId));
    }
  });

  function emitQueueStatus(uid: string, socketId?: string) {
    const cur = QUEUE.get(uid);
    const emitter = socketId ? io.to(socketId) : socket;
    const pInStore = STORE.getPartyByUserId(uid);

    if (!cur || cur.state === "idle") {
      (emitter as any).emit("queue:status", { 
        state: "idle", 
        partyId: pInStore?.id ?? "" 
      });
      return;
    }
    if (cur.state === "searching") {
      (emitter as any).emit("queue:status", { 
        state: "searching", 
        partyId: pInStore?.id ?? cur.partyId ?? "" 
      });
      return;
    }
    const isLeader = !!cur.leaderId && cur.leaderId === uid;
    (emitter as any).emit("queue:status", {
      state: "matched",
      channel: cur.channel ?? "",
      isLeader,
      channelReady: !!cur.channel,
      partyId: pInStore?.id ?? cur.partyId ?? "",
    });
  }

  socket.on("queue:hello", async (_p: any) => {
    const u = requireSocketUser(socket);
    if (u) {
      socketToUserId.set(socket.id, u.id);
      emitQueueStatus(u.id);
      socket.emit("queue:counts", { counts: QUEUE.getCountsByGround(), avgWaitMs: QUEUE.getAvgWaitByGround() });
    }
  });

  socket.on("queue:updateProfile", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    socketToUserId.set(socket.id, u.id);
    const displayName = String(p?.displayName ?? (u.global_name ?? u.username) ?? u.username).trim() || (u.global_name ?? u.username);
    USERS.upsert(u.id, { displayName, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0) });
    const touched = STORE.updateMemberProfile(u.id, { name: displayName, level: Number(p?.level), job: p?.job, power: Number(p?.power) });
    for (const pid of touched) broadcastParty(pid);
  });

  socket.on("queue:join", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    socketToUserId.set(socket.id, u.id);
    const huntingGroundId = String(p?.huntingGroundId ?? "").trim();
    if (!huntingGroundId) return;
    const displayName = (u.global_name ?? u.username) || u.username;
    USERS.upsert(u.id, { displayName, level: Number(p?.level ?? 1), job: p?.job ?? "전사", power: Number(p?.power ?? 0), blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [] });
    
    QUEUE.upsert(socket.id, huntingGroundId, {
      userId: u.id,
      displayName,
      level: Number(p?.level ?? 1),
      job: p?.job ?? "전사",
      power: Number(p?.power ?? 0),
      blacklist: Array.isArray(p?.blacklist) ? p.blacklist : [],
    } as any);

    socket.emit("queue:status", { state: "searching" });
    broadcastQueueCounts();

    const matched = QUEUE.tryMatch(huntingGroundId, resolveNameToId);
    if (matched.ok) {
      try {
        const leaderId = matched.leaderId;
        const leaderEntry = matched.a.userId === leaderId ? matched.a : matched.b;
        const otherEntry = leaderEntry === matched.a ? matched.b : matched.a;

        const party = STORE.createParty({
          ownerId: leaderId,
          ownerName: leaderEntry.displayName,
          ownerLevel: Number(leaderEntry.level ?? 1),
          ownerJob: (leaderEntry.job as any) ?? "전사",
          ownerPower: Number(leaderEntry.power ?? 0),
          title: `사냥터 ${huntingGroundId}`,
          groundId: huntingGroundId,
          groundName: `사냥터 ${huntingGroundId}`,
          lockPassword: null
        });

        STORE.joinParty({
          partyId: party.id,
          userId: otherEntry.userId,
          name: otherEntry.displayName,
          level: Number(otherEntry.level ?? 1),
          job: (otherEntry.job as any) ?? "전사",
          power: Number(otherEntry.power ?? 0),
        });

        QUEUE.setPartyForMatch(matched.matchId, party.id);
        broadcastParty(party.id);
      } catch (e) {
        console.error("[queue] failed to auto-create party", e);
      }
      emitQueueStatus(matched.a.userId, matched.a.socketId);
      emitQueueStatus(matched.b.userId, matched.b.socketId);
      broadcastQueueCounts();
    }
  });

  socket.on("queue:setChannel", (p: any) => {
    const u = requireSocketUser(socket);
    if (!u) return;
    const letter = String(p?.letter ?? "").toUpperCase().trim();
    const num = String(p?.num ?? "").trim().padStart(3, "0");
    const channel = `${letter}-${num}`;
    const r = QUEUE.setChannelByLeader(u.id, channel);
    if (r.ok) {
      const first = r.members[0];
      if (first?.partyId) {
        const p = STORE.getParty(first.partyId);
        if (p) {
          p.channel = channel;
          broadcastParty(p.id);
        }
      }
      for (const m of r.members) emitQueueStatus(m.userId, m.socketId);
      broadcastQueueCounts();
    }
  });

  socket.on("queue:leave", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) {
      cleanupPartyMembership(uid);
      QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }
    socket.emit("queue:status", { state: "idle" });
    broadcastQueueCounts();
  });

  socket.on("disconnect", () => {
    const uid = socketToUserId.get(socket.id);
    if (uid) {
      const q = QUEUE.get(uid);
      if (q && q.state === "searching") QUEUE.leave(uid);
      socketToUserId.delete(socket.id);
    }
    broadcastQueueCounts();
  });
});


setInterval(() => {
  try {
    const changedPartyIds = STORE.sweepStaleMembers({ memberTtlMs: MEMBER_TTL_MS, partyTtlMs: PARTY_TTL_MS });
    if (changedPartyIds.length) {
      for (const pid of changedPartyIds) {
        if (!STORE.getParty(pid)) io.emit("partyDeleted", { partyId: pid });
      }
      broadcastParties();
    }
    const cleaned = QUEUE.cleanupDanglingParties((pid) => !!STORE.getParty(pid));
    if (cleaned.length) {
      for (const e of cleaned) io.to(e.socketId).emit("queue:status", { state: "idle" });
      broadcastQueueCounts();
    }
  } catch {}
}, 15_000).unref();

const webOut = path.resolve(process.cwd(), "../web/out");
if (fs.existsSync(webOut)) {
  app.use(express.static(webOut));
  app.get("*", (_req, res) => res.sendFile(path.join(webOut, "index.html")));
}

setInterval(() => cleanupSessions(), 60_000).unref();

server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
});