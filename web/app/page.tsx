"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

import { ToastBanner } from "./components/ToastBanner";
import { DiscordAside } from "./components/DiscordAside";
import { SearchHeader } from "./components/SearchHeader";
import { GroundCardList } from "./components/GroundCardList";
import { PublicPartyPanel } from "./components/PublicPartyPanel";
import { BuffTable } from "./components/BuffTable";

type Job = "전사" | "도적" | "궁수" | "마법사";
type MatchState = "idle" | "searching" | "matched";
type QueueStatusPayload = { state: MatchState; channel?: string; message?: string; isLeader?: boolean; channelReady?: boolean; partyId?: string };
type MeResponse = { user: { id: string; username: string; global_name: string | null; avatar: string | null }; profile?: { displayName: string } | null };

type Toast = { type: "ok" | "err" | "info"; msg: string };

const API = process.env.NEXT_PUBLIC_API_BASE ?? "";

function apiUrl(path: string) {
  return API ? `${API}${path}` : path;
}

function tryCopy(text: string) {
  try {
    void navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type HuntingGround = {
  id: string;
  name: string;
  area: string;
  recommendedLevel: string;
  tags: string[];
  note: string;
};

const GROUNDS: HuntingGround[] = [];

function clampInt(v: string, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeLocalGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function safeLocalSet(key: string, value: any) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export default function Page() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const isLoggedIn = !!me?.user?.id;

  const [toast, setToast] = useState<Toast | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sid = typeof window !== "undefined" && window.location.hash.startsWith("#sid=")
          ? window.location.hash.slice("#sid=".length)
          : "";

        const res = await fetch(apiUrl("/api/me"), {
          credentials: "include",
          headers: sid ? { "x-ml-session": decodeURIComponent(sid) } : undefined,
        });
        if (!alive) return;
        if (!res.ok) {
          setMe(null);
          return;
        }
        const data = (await res.json()) as MeResponse;
        setMe(data);

        if (sid && typeof window !== "undefined") {
          window.history.replaceState(null, "", window.location.pathname + window.location.search);
        }
      } catch {
        setMe(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const discordName = (me?.user?.global_name ?? me?.user?.username ?? "User").trim() || "User";
  const discordTag = (me?.user?.username ?? "unknown").trim() || "unknown";
  const [nickname, setNickname] = useState("");

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(GROUNDS[0]?.id ?? "");

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createPartyOpen, setCreatePartyOpen] = useState(false);

  const [customGrounds, setCustomGrounds] = useState<HuntingGround[]>([]);
  const [groundEditorOpen, setGroundEditorOpen] = useState(false);
  const [groundDraft, setGroundDraft] = useState<HuntingGround | null>(null);

  useEffect(() => {
    const saved = safeLocalGet("mlq.grounds.custom", [] as any);
    if (Array.isArray(saved)) {
      const cleaned: HuntingGround[] = saved
        .filter((x: any) => x && typeof x.id === "string" && typeof x.name === "string")
        .map((x: any) => ({
          id: String(x.id),
          name: String(x.name),
          area: String(x.area ?? ""),
          recommendedLevel: String(x.recommendedLevel ?? ""),
          tags: Array.isArray(x.tags) ? x.tags.map((t: any) => String(t)) : [],
          note: String(x.note ?? ""),
        }));
      setCustomGrounds(cleaned);
    }
  }, []);

  useEffect(() => {
    safeLocalSet("mlq.grounds.custom", customGrounds);
  }, [customGrounds]);

  const ALL_GROUNDS = useMemo(() => [...GROUNDS, ...customGrounds], [customGrounds]);

  const [level, setLevel] = useState(50);
  const [job, setJob] = useState<Job>("전사");
  const [power, setPower] = useState(12000);
  const [isCaptain, setIsCaptain] = useState(false);
  const canBeCaptain = job === "궁수" && level >= 120;

  useEffect(() => {
    if (isCaptain && !canBeCaptain) {
      setIsCaptain(false);
    }
  }, [job, level, isCaptain, canBeCaptain]);

  useEffect(() => {
    const saved = safeLocalGet("mlq.profile", null as any);
    if (saved && typeof saved === "object") {
      if (typeof saved.nickname === "string") setNickname(saved.nickname);
      if (typeof saved.level === "number") setLevel(clampInt(String(saved.level), 1, 300));
      if (typeof saved.job === "string") setJob((saved.job as Job) ?? "전사");
      if (typeof saved.power === "number") setPower(clampInt(String(saved.power), 0, 9_999_999));
      if (typeof saved.isCaptain === "boolean") setIsCaptain(saved.isCaptain);
    }
  }, []);

  useEffect(() => {
    safeLocalSet("mlq.profile", { nickname, level, job, power, isCaptain });
  }, [nickname, level, job, power, isCaptain]);

  const [blackInput, setBlackInput] = useState("");
  const [blacklist, setBlacklist] = useState<string[]>([]);

  const [matchState, setMatchState] = useState<MatchState>("idle");
  const [channel, setChannel] = useState<string>("");
  const [isLeader, setIsLeader] = useState(false);
  const [channelReady, setChannelReady] = useState(false);
  const [partyId, setPartyId] = useState<string>("");
  const [party, setParty] = useState<any | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [avgWaitMs, setAvgWaitMs] = useState<Record<string, number>>({});
  const [myBuffs, setMyBuffs] = useState<{ simbi: number; ppeongbi: number; syapbi: number }>({ simbi: 0, ppeongbi: 0, syapbi: 0 });
  const [channelLetter, setChannelLetter] = useState("A");
  const [channelNum, setChannelNum] = useState("001");
  const [joinCode, setJoinCode] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createLocked, setCreateLocked] = useState(false);
  const [createPassword, setCreatePassword] = useState("");

  const [partyList, setPartyList] = useState<any[]>([]);
  const [chatMessages, setChatMessages] = useState<{ sender: string; msg: string; time: number }[]>([]);
  const [chatInput, setChatInput] = useState("");

  const normalizeKey = (s: any) => String(s ?? "").toLowerCase().replace(/\s+/g, "");

  const fmtNumber = (n: any) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "-";
    return Math.max(0, Math.floor(v)).toLocaleString();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_GROUNDS;
    return ALL_GROUNDS.filter((g) => {
      const blob = `${g.name} ${g.area} ${g.recommendedLevel} ${g.tags.join(" ")} ${g.note}`.toLowerCase();
      return blob.includes(q);
    });
  }, [query, ALL_GROUNDS]);

  const selected = useMemo(
    () => ALL_GROUNDS.find((g) => g.id === selectedId) ?? filtered[0] ?? ALL_GROUNDS[0],
    [selectedId, filtered, ALL_GROUNDS]
  );

  const partiesForSelected = useMemo(() => {
    if (!selected?.name) return partyList;
    return partyList.filter((p) => {
      const pid = String(p?.groundId ?? "");
      if (pid && pid === selectedId) return true;
      const key = normalizeKey(selected.name);
      if (!key) return true;
      return normalizeKey(p?.title).includes(key);
    });
  }, [partyList, selected, selectedId]);

  const [dotTick, setDotTick] = useState(1);
  useEffect(() => {
    if (matchState !== "searching") {
      setDotTick(1);
      return;
    }
    const id = setInterval(() => setDotTick((t) => (t % 3) + 1), 650);
    return () => clearInterval(id);
  }, [matchState]);

  const socketRef = useRef<Socket | null>(null);

  const getSid = () => {
    if (typeof window === "undefined") return "";
    return window.location.hash.startsWith("#sid=") ? decodeURIComponent(window.location.hash.slice("#sid=".length)) : "";
  };

  const emitProfile = (s: Socket | null) => {
    if (!s || !isLoggedIn) return;
    s.emit("queue:updateProfile", {
      displayName: nickname.trim() || discordName,
      level,
      job,
      power,
      isCaptain,
    });
  };

  useEffect(() => {
    if (!isLoggedIn) return;
    emitProfile(socketRef.current);
  }, [isLoggedIn]);

  const [sockConnected, setSockConnected] = useState(false);
  const isCustomSelected = useMemo(() => selectedId.startsWith("c_"), [selectedId]);

  const openNewGround = () => {
    const id = `c_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setGroundDraft({ id, name: "", area: "", recommendedLevel: "", tags: [], note: "" });
    setGroundEditorOpen(true);
  };

  const openEditGround = () => {
    const g = customGrounds.find((x) => x.id === selectedId);
    if (!g) return;
    setGroundDraft({ ...g, tags: [...(g.tags ?? [])] });
    setGroundEditorOpen(true);
  };

  const saveGroundDraft = () => {
    if (!groundDraft) return;
    const name = groundDraft.name.trim();
    if (!name) return;
    const cleaned: HuntingGround = {
      ...groundDraft,
      name,
      area: (groundDraft.area ?? "").trim(),
      recommendedLevel: (groundDraft.recommendedLevel ?? "").trim(),
      tags: (groundDraft.tags ?? []).map((t) => t.trim()).filter(Boolean),
      note: (groundDraft.note ?? "").trim(),
    };
    setCustomGrounds((prev) => {
      const idx = prev.findIndex((x) => x.id === cleaned.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = cleaned;
        return next;
      }
      return [cleaned, ...prev];
    });
    setSelectedId(cleaned.id);
    setGroundEditorOpen(false);
    setGroundDraft(null);
  };

  const deleteSelectedGround = () => {
    if (!isCustomSelected) return;
    setCustomGrounds((prev) => prev.filter((x) => x.id !== selectedId));
    const next = GROUNDS[0]?.id ?? "";
    setSelectedId(next);
  };

  useEffect(() => {
    const saved = safeLocalGet("mlq.queueForm", null as any);
    if (saved) {
      if (typeof saved.level === "number") setLevel(saved.level);
      if (typeof saved.job === "string") setJob(saved.job as Job);
      if (typeof saved.power === "number") setPower(saved.power);
      if (Array.isArray(saved.blacklist)) setBlacklist(saved.blacklist.filter((x: any) => typeof x === "string"));
    }
  }, []);

  useEffect(() => {
    safeLocalSet("mlq.queueForm", { level, job, power, nickname, blacklist });
  }, [level, job, power, nickname, blacklist]);

  const sendChat = () => {
    const sck = socketRef.current;
    if (!sck || !partyId || !chatInput.trim()) return;
    const msgData = { partyId, sender: nickname || discordName, msg: chatInput.trim() };
    sck.emit("party:sendChat", msgData);
    setChatInput("");
  };

  useEffect(() => {
    const sck = io({
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
    socketRef.current = sck;

    sck.on("connect", () => {
      setSockConnected(true);
      emitProfile(sck);
    });
    sck.on("disconnect", () => setSockConnected(false));

    sck.on("queue:status", (p: QueueStatusPayload) => {
      if (!p) return;
      setMatchState(p.state);
      setChannel(p.channel ?? "");
      setIsLeader(!!p.isLeader);
      setChannelReady(!!p.channelReady);
      setPartyId(p.partyId ?? "");
    });

    sck.on("partyUpdated", (payload: any) => {
      if (!payload?.party) return;
      setParty(payload.party);
    });

    sck.on("party:message", (payload: any) => {
      if (payload?.sender && payload?.msg) {
        setChatMessages(prev => [...prev, { sender: payload.sender, msg: payload.msg, time: Date.now() }].slice(-50));
      }
    });

    sck.on("partiesUpdated", (payload: any) => {
      if (!payload?.parties) return;
      setPartyList(payload.parties);
    });

    sck.on("queue:counts", (payload: any) => {
      const counts = payload?.counts;
      if (!counts || typeof counts !== "object") return;
      setQueueCounts(counts as Record<string, number>);
      const nextAvg = payload?.avgWaitMs;
      if (nextAvg && typeof nextAvg === "object") setAvgWaitMs(nextAvg as Record<string, number>);
    });

    sck.emit("queue:hello", { nickname, level, job, power, blacklist });

    return () => {
      sck.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const saved = safeLocalGet<string>("mlq.partyId", "") as string;
    if (saved && !partyId) setPartyId(saved);
  }, []);

  useEffect(() => {
    refreshParties();
  }, []);

  useEffect(() => {
    const sck = socketRef.current;
    if (!sck || !partyId) return;
    safeLocalSet("mlq.partyId", partyId);
    sck.emit("joinPartyRoom", { partyId });
  }, [partyId]);

  useEffect(() => {
    const sck = socketRef.current;
    if (!sck || !sockConnected || !partyId) return;
    const beat = () => sck.emit("party:heartbeat", { partyId });
    beat();
    const t = setInterval(beat, 25_000);
    return () => clearInterval(t);
  }, [partyId, sockConnected]);

  useEffect(() => {
    if (!party || !me) return;
    const my = (party.members ?? []).find((m: any) => m.userId === me.user.id);
    if (!my) return;
    setMyBuffs({
      simbi: Number(my.buffs?.simbi ?? 0),
      ppeongbi: Number(my.buffs?.ppeongbi ?? 0),
      syapbi: Number(my.buffs?.syapbi ?? 0),
    });
  }, [party, me]);

  useEffect(() => {
    const sck = socketRef.current;
    if (!sck || !sockConnected) return;
    sck.emit("queue:updateProfile", { nickname, level, job, power, blacklist });
  }, [nickname, level, job, power, blacklist, sockConnected]);

  const pushMyBuffs = async (next: { simbi: number; ppeongbi: number; syapbi: number }) => {
    if (!partyId) return;
    try {
      const sid = getSid();
      await fetch(apiUrl("/api/party/buffs"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ partyId, buffs: next }),
      });
    } catch {}
  };

  const transferOwner = async (newOwnerId: string) => {
    if (!partyId) return;
    try {
      const sid = getSid();
      await fetch(apiUrl("/api/party/transfer"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ partyId, newOwnerId }),
      });
    } catch {}
  };

  const joinPartyByCode = async () => {
    const code = joinCode.trim();
    if (!code) return;
    try {
      const sid = getSid();
      const res = await fetch(apiUrl("/api/party/join"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ partyId: code, lockPassword: joinPassword.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setJoinPassword("");
      setJoinCode("");
    } catch (e: any) {
      alert(`파티 입장 실패: ${e?.message ?? e}`);
    }
  };

  const leavePartyOnServer = async (pid: string) => {
    try {
      const sid = getSid();
      await fetch(apiUrl("/api/party/leave"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ partyId: pid }),
      });
    } catch {}
  };

  const joinPartyDirect = async (targetPartyId: string, lockPassword?: string) => {
    if (!validateProfile()) return;
    if (!targetPartyId || isJoining) return;
    setIsJoining(true);
    try {
      setToast(null);
      if (partyId && partyId !== targetPartyId) await leavePartyOnServer(partyId);
      const sid = getSid();
      const res = await fetch(apiUrl("/api/party/join"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ partyId: targetPartyId, lockPassword: lockPassword || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        let msg = data?.error || "파티 참가 실패";
        if (msg === "FULL") msg = "파티가 이미 꽉 찼습니다.";
        if (msg === "BAD_PASSWORD") msg = "비밀번호가 일치하지 않습니다.";
        if (msg === "NOT_FOUND") msg = "파티를 찾을 수 없습니다.";
        throw new Error(msg);
      }
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setToast({ type: "ok", msg: "파티에 참가했습니다." });
    } catch (e: any) {
      setToast({ type: "err", msg: e?.message || "파티 참가 실패" });
    } finally {
      setIsJoining(false);
    }
  };

  const joinFromList = async (p: any, lockPassword?: string) => {
    const pid = typeof p === "string" ? p : p?.id;
    if (!pid) return;
    if (!lockPassword && (p?.isLocked || p?.locked)) {
      const pw = window.prompt("이 파티는 잠금 상태입니다. 비밀번호를 입력하세요.");
      if (pw === null) return;
      await joinPartyDirect(pid, pw);
    } else {
      await joinPartyDirect(pid, lockPassword);
    }
  };

  const validateProfile = () => {
    if (!nickname.trim() || nickname === "User" || !level || !job || power === 12000) {
      alert("프로필 정보(닉네임, 레벨, 직업, 스공)를 먼저 설정해 주세요.");
      setSettingsOpen(true);
      return false;
    }
    return true;
  };

  const refreshParties = async () => {
    try {
      const res = await fetch(apiUrl("/api/parties"));
      const data = await res.json();
      if (data?.parties) setPartyList(data.parties);
    } catch {}
  };

  const createPartyManual = async () => {
    if (!validateProfile()) return;
    if (isJoining) return;
    setIsJoining(true);
    try {
      let titlePrefix = "";
      if (selectedId === "octopus" && !isCaptain) {
        titlePrefix = "[선장님 없음] ";
      }
      const autoTitle = selected?.name ? `${selected.name} 파티` : "파티";
      const title = (titlePrefix + (createTitle || autoTitle)).trim();
      const pw = createLocked ? createPassword.trim() : "";
      if (createLocked && pw.length < 2) {
        alert("비밀번호는 2글자 이상으로 설정해줘.");
        return;
      }
      if (partyId) await leavePartyOnServer(partyId);
      const sid = getSid();
      const res = await fetch(apiUrl("/api/party"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(sid ? { "x-ml-session": sid } : {}) },
        body: JSON.stringify({ title, lockPassword: createLocked ? pw : undefined, groundId: selectedId || undefined, groundName: selected?.name || undefined }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      const pid = String(data?.party?.id ?? "");
      if (!pid) throw new Error("INVALID_RESPONSE");
      setPartyId(pid);
      safeLocalSet("mlq.partyId", pid);
      setCreateTitle("");
      setCreatePassword("");
      setCreateLocked(false);
      setCreatePartyOpen(false);
      setToast({ type: "ok", msg: "파티가 생성되었습니다." });
    } catch (e: any) {
      setToast({ type: "err", msg: `파티 생성 실패: ${e?.message ?? e}` });
    } finally {
      setIsJoining(false);
    }
  };

  const joinQueue = (opts?: { partyId?: string | null }) => {
    const sck = socketRef.current;
    if (!sck) return;
    setMatchState("searching");
    setChannel("");
    setIsLeader(false);
    setChannelReady(false);
    sck.emit("queue:join", {
      huntingGroundId: selectedId,
      nickname,
      level,
      job,
      power,
      blacklist,
      partyId: opts?.partyId ?? partyId ?? null,
    });
  };

  const leaveQueue = () => {
    const sck = socketRef.current;
    if (!sck) return;
    sck.emit("queue:leave");
    setMatchState("idle");
    setChannel("");
    setIsLeader(false);
    setChannelReady(false);
  };

  function setChannelByLeader() {
    const sck = socketRef.current;
    if (!sck) return;
    const ch = `${channelLetter}-${channelNum}`;
    
    if (partyId) {
      // 파티 상태일 때 채널 설정
      sck.emit("party:setChannel", { partyId, channel: ch });
    } else if (isLeader && matchState === "matched") {
      // 매칭 직후 상태일 때 채널 설정
      sck.emit("queue:setChannel", { letter: channelLetter, num: channelNum });
    }
    setChannel("");
  }

  function onSelectGround(id: string) {
    setSelectedId(id);
    setMatchState("idle");
    setChannel("");
  }

  function addBlacklist() {
    const v = blackInput.trim();
    if (!v) return;
    if (blacklist.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setBlackInput("");
      return;
    }
    setBlacklist((prev) => [v, ...prev].slice(0, 50));
    setBlackInput("");
  }

  function removeBlacklist(v: string) {
    setBlacklist((prev) => prev.filter((x) => x !== v));
  }

  async function startMatching() {
    if (!validateProfile()) return;
    if (!selected || matchState === "searching") return;
    if (party && me) {
      const isOwner = party.ownerId === me.user.id;
      if (!isOwner) {
        await leavePartyOnServer(partyId);
        setPartyId("");
        setParty(null);
      }
    }
    joinQueue();
  }

  function rematch() {
    leaveQueue();
    joinQueue();
  }

  const shell: React.CSSProperties = { minHeight: "100vh", boxSizing: "border-box" };
  const card: React.CSSProperties = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, boxShadow: "0 8px 24px rgba(0,0,0,0.3)", overflow: "hidden" };
  const cardHeader: React.CSSProperties = { padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
  const muted: React.CSSProperties = { color: "rgba(230,232,238,0.7)", fontSize: 11 };
  const chip: React.CSSProperties = { fontSize: 11, padding: "3px 8px", borderRadius: 999, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "rgba(230,232,238,0.92)", fontWeight: 800, letterSpacing: 0.1, display: "inline-flex", alignItems: "center", lineHeight: 1 };
  const input: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(0,0,0,0.22)", color: "rgba(245,246,250,0.95)", outline: "none", fontSize: 13 };
  const formRow: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
  const label: React.CSSProperties = { fontSize: 11, color: "rgba(230,232,238,0.75)", marginBottom: 4 };
  const btn: React.CSSProperties = { border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.06)", color: "#e6e8ee", padding: "6px 10px", borderRadius: 10, cursor: "pointer", fontWeight: 800, fontSize: 12 };
  const btnSmall: React.CSSProperties = { ...btn, padding: "6px 8px", fontSize: 12 };
  const btnSm: React.CSSProperties = btnSmall;
  const btnPrimary: React.CSSProperties = { ...btn, background: "rgba(120,200,255,0.14)", borderColor: "rgba(120,200,255,0.35)" };
  const listCard: React.CSSProperties = { border: "1px solid rgba(255,255,255,0.10)", background: "rgba(255,255,255,0.04)", borderRadius: 12, padding: 8 };
  const pill: React.CSSProperties = { ...chip, padding: "2px 6px", fontSize: 10 };

  return (
    <div className="shell" style={shell}>
      <ToastBanner toast={toast} onClose={() => setToast(null)} />

      <DiscordAside
        className="discord-aside"
        isLoggedIn={isLoggedIn}
        discordName={discordName}
        discordTag={discordTag}
        nickname={nickname}
        level={level}
        job={job}
        power={power}
        onLogin={() => (window.location.href = apiUrl("/auth/discord"))}
        onLogout={async () => {
          try { await fetch(apiUrl("/api/logout"), { method: "POST", credentials: "include" }); } catch {}
          window.location.reload();
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        muted={muted}
        card={card}
        cardHeader={cardHeader}
        fmtNumber={fmtNumber}
      />

      <SearchHeader
        className="search-header"
        query={query}
        onChangeQuery={setQuery}
        countText={`${filtered.length}개`}
        muted={muted}
        card={card}
        cardHeader={cardHeader}
      />

      <aside className="aside-right" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <section style={{ ...card, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 300, flex: "1 1 auto", maxHeight: "88vh" }}>
          <div style={{ ...cardHeader, alignItems: "flex-start" }}>
            <div style={{ display: "grid", gap: 1 }}>
              <div style={{ fontWeight: 800 }}>파티 정보</div>
            </div>
            <div style={{ ...muted, marginLeft: "auto" }}>
              {matchState === "idle" ? "대기" : matchState === "searching" ? (() => {
                const n = queueCounts[selectedId] ?? 0;
                const eta = avgWaitMs[selectedId];
                const etaMin = typeof eta === "number" && eta > 0 ? Math.max(1, Math.round(eta / 60000)) : 0;
                return `매칭중${".".repeat(dotTick)} · ${n}명${etaMin ? ` · ${etaMin}분` : ""}`;
              })() : `완료 (${channel || "채널 발급"})`}
            </div>
          </div>

          <div style={{ padding: 10, display: "grid", gap: 8, overflowY: "auto", flex: 1, minHeight: 0 }}>
            {party ? (
              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ fontWeight: 800, display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                  <span>파티원 목록</span>
                  <span style={muted}>{party.members?.length ?? 0}/6명</span>
                </div>
                <div style={{ display: "grid", gap: 5 }}>
                  {(party.members || []).map((m: any) => {
                    const jobColor = m.job === "전사" ? "#ff6b6b" : m.job === "도적" ? "#cc5de8" : m.job === "궁수" ? "#51cf66" : m.job === "마법사" ? "#339af0" : "#e6e8ee";
                    const isOwner = party.ownerId === m.userId;
                    return (
                      <div key={m.userId || m.id} style={{ ...listCard, padding: "6px 8px", borderLeft: `3px solid ${jobColor}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            {isOwner && <span style={{ fontSize: 12 }} title="파티장">👑</span>}
                            <span style={{ fontWeight: 800, fontSize: 13 }}>{m.name || m.displayName}</span>
                          </div>
                          <div style={{ color: jobColor, fontWeight: 700, fontSize: 11 }}>Lv.{m.level} {m.job}</div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                          <div style={{ ...muted, fontSize: 10 }}>스공: {fmtNumber(m.power)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ ...muted, padding: "30px 10px", textAlign: "center" }}>
                파티 없음
              </div>
            )}

            <div style={{ display: "grid", gap: 6, marginTop: "auto" }}>
              <div style={{ fontWeight: 800, fontSize: 13 }}>매칭 상태</div>
              {matchState === "searching" && (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 999, background: "rgba(255,255,255,0.65)", animation: "pulse 1.2s ease-in-out infinite" }} />
                    <div style={{ fontWeight: 850, fontSize: 12 }}>{`매칭중${".".repeat(dotTick)}`}</div>
                  </div>
                  <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0, width: "45%", background: "rgba(120,200,255,0.20)", animation: "mlqIndeterminate 1.35s ease-in-out infinite" }} />
                  </div>
                </div>
              )}

              {matchState === "matched" && (
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ fontWeight: 900, fontSize: 14 }}>매칭완료!</div>
                  {channel ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ ...chip, padding: "2px 6px" }}>채널</div>
                      <div style={{ fontWeight: 1000, fontSize: 16 }}>{channel}</div>
                      <button onClick={() => { if (tryCopy(channel)) setToast({ type: "ok", msg: "복사 완료" }); }} style={btnSm}>복사</button>
                    </div>
                  ) : <div style={{ ...muted, fontSize: 11 }}>채널 대기 중...</div>}
                  
                  {isLeader && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", display: "grid", gap: 6 }}>
                      <div style={{ fontWeight: 800, fontSize: 12 }}>채널 설정 (파티장 전용)</div>
                      <div style={{ display: "flex", gap: 4 }}>
                        <select value={channelLetter} onChange={(e) => setChannelLetter(e.target.value)} style={{ ...input, padding: "4px", flex: 1 }}>
                          {Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)).map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select value={channelNum} onChange={(e) => setChannelNum(e.target.value)} style={{ ...input, padding: "4px", flex: 1 }}>
                          {Array.from({ length: 999 }, (_, i) => String(i+1).padStart(3, '0')).map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <button onClick={setChannelByLeader} style={{ ...btnPrimary, padding: "4px 8px" }}>확정</button>
                      </div>
                    </div>
                  )}

                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input style={{ ...input, flex: 1, padding: "6px 8px" }} placeholder="코드" value={joinCode} onChange={(e) => setJoinCode(e.target.value)} />
                      <button style={btnSm} onClick={joinPartyByCode}>입장</button>
                    </div>
                  </div>
                </div>
              )}

              {partyId && (
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "rgba(255,255,255,0.5)" }}>파티 채팅</div>
                  <div style={{ height: 120, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, paddingRight: 4 }}>
                    {chatMessages.length === 0 && <div style={{ ...muted, fontSize: 10, textAlign: "center", marginTop: 40 }}>메시지가 없습니다.</div>}
                    {chatMessages.map((c, i) => (
                      <div key={i} style={{ fontSize: 12, lineHeight: 1.4 }}>
                        <span style={{ fontWeight: 800, color: "#74c0fc" }}>{c.sender}: </span>
                        <span>{c.msg}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <input 
                      style={{ ...input, padding: "6px", fontSize: "12px", flex: 1 }} 
                      value={chatInput} 
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && sendChat()}
                      placeholder="메시지 입력..."
                    />
                    <button onClick={sendChat} style={{ ...btnPrimary, padding: "4px 8px" }}>전송</button>
                  </div>
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                {matchState === "searching" && <button onClick={leaveQueue} style={{ ...btn, flex: 1, background: "rgba(255,120,120,0.12)", padding: "8px" }}>큐 취소</button>}
                {matchState === "matched" && (
                  <>
                    <button onClick={rematch} style={{ ...btn, flex: 1, background: "rgba(120,200,255,0.14)", padding: "8px" }}>다시 매칭</button>
                    <button onClick={leaveQueue} style={{ ...btn, background: "rgba(255,120,120,0.12)", padding: "8px" }}>나가기</button>
                  </>
                )}
                {partyId && matchState !== "searching" && matchState !== "matched" && (
                  <button 
                    onClick={async () => {
                      if (window.confirm("파티에서 나갈까요?")) {
                        await leavePartyOnServer(partyId);
                        setPartyId("");
                        setParty(null);
                      }
                    }} 
                    style={{ ...btn, flex: 1, background: "rgba(255,80,80,0.15)", borderColor: "rgba(255,80,80,0.3)", padding: "8px" }}
                  >
                    파티 나가기
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      </aside>

      <main className="main-content" style={{ ...card, display: "grid", gridTemplateColumns: partyId ? "1fr" : "280px 1fr" }}>
        {!partyId && (
          <GroundCardList
            className="ground-card-list"
            filtered={filtered}
            selectedId={selected?.id ?? ""}
            onSelectGround={onSelectGround}
            isCustomSelected={isCustomSelected}
            openNewGround={openNewGround}
            openEditGround={openEditGround}
            deleteSelectedGround={deleteSelectedGround}
            cardHeader={cardHeader}
            muted={muted}
            btn={btn}
            queueCounts={queueCounts}
          />
        )}
        <section>
          <div style={cardHeader}>
            <div style={{ fontWeight: 900 }}>{selected?.name ?? "사냥터 선택"}</div>
            <div style={muted}>{selected?.recommendedLevel ?? ""}</div>
          </div>
          <div style={{ padding: 10, display: "grid", gap: 10 }}>
            <div style={{ ...card, background: "rgba(0,0,0,0.20)", padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div><div style={{ fontWeight: 900, fontSize: 13 }}>정보</div><div style={muted}>{selected?.area ?? ""}</div></div>
                <div style={{ textAlign: "right" }}><div style={{ fontWeight: 900, fontSize: 13 }}>현재 큐</div><div style={muted}>{queueCounts[selected?.id ?? ""] ?? 0}명</div></div>
              </div>
              <div style={{ ...muted, marginTop: 4, fontSize: 11 }}>{selected?.note ?? ""}</div>
            </div>
            <PublicPartyPanel
              selectedName={selected?.name ?? null} selectedId={selected?.id ?? null} myPartyId={partyId || null}
              parties={(selected?.name ? partiesForSelected : partyList) as any[]} onRefresh={refreshParties} onJoin={joinFromList}
              isJoining={isJoining} card={card} muted={muted} btnSm={btnSm} listCard={listCard} pill={pill}
            />
            {partyId && (
              <BuffTable
                partyId={partyId} party={party} me={me} myBuffs={myBuffs} onChangeMyBuffs={setMyBuffs}
                onPushMyBuffs={pushMyBuffs} onTransferOwner={transferOwner} fmtNumber={fmtNumber}
                card={card} muted={muted} chip={chip} input={input}
              />
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => startMatching()} style={{ ...btn, flex: 1, background: "rgba(120,200,255,0.14)", padding: "10px" }}>큐 참가</button>
              <button onClick={() => { if (!isLoggedIn) { setToast({ type: "err", msg: "로그인 필요" }); return; } setCreatePartyOpen(true); }} style={{ ...btn, padding: "10px" }}>파티 만들기</button>
            </div>

            {partyId && (
              <div style={{ marginTop: 10, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 4 }}>현재 자리 / 채널</div>
                <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 1, color: channel ? "#74c0fc" : "#ff8787" }}>
                  {channel || "채널 미설정"}
                </div>
                {!channel && isLeader && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 4 }}>오른쪽 ‘채널 설정’에서 확정해주세요.</div>}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="footer-content" style={{ ...card, background: "rgb(12,16,24)", padding: 8 }}>
        <div style={{ textAlign: "center", ...muted }}>하단 영역</div>
      </footer>

      {settingsOpen && (
        <div onClick={() => setSettingsOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.60)", display: "grid", placeItems: "center", zIndex: 90 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(480px, 96vw)", borderRadius: 14, background: "rgba(18,18,22,0.98)", padding: 14, border: "1px solid rgba(255,255,255,0.12)" }}>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10 }}>설정</div>
            <div style={{ display: "grid", gap: 14 }}>
              <div style={formRow}><div style={label}>닉네임</div><input style={input} value={nickname} onChange={(e) => setNickname(e.target.value)} /></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div style={formRow}><div style={label}>레벨</div><input style={input} value={String(level)} onChange={(e) => setLevel(clampInt(e.target.value, 1, 300))} /></div>
                <div style={formRow}><div style={label}>직업</div><select style={input} value={job} onChange={(e) => setJob(e.target.value as Job)}><option value="전사">전사</option><option value="도적">도적</option><option value="궁수">궁수</option><option value="마법사">마법사</option></select></div>
              </div>
              <div style={formRow}><div style={label}>스공</div><input style={input} value={String(power)} onChange={(e) => setPower(clampInt(e.target.value, 0, 9999999))} /></div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, opacity: canBeCaptain ? 1 : 0.5 }}>
                <input 
                  type="checkbox" 
                  checked={isCaptain} 
                  disabled={!canBeCaptain}
                  onChange={e => setIsCaptain(e.target.checked)} 
                  style={{ width: 16, height: 16, cursor: canBeCaptain ? "pointer" : "not-allowed" }} 
                />
                <div style={{ display: "grid", gap: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>선장님이신가요? (위바협2 전용)</div>
                  {!canBeCaptain && <div style={{ fontSize: 10, color: "#ff8787" }}>궁수 직업, 120레벨 이상만 가능합니다.</div>}
                </div>
              </div>
              <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 8 }}>
                <div style={label}>블랙리스트</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input style={{ ...input, flex: 1 }} value={blackInput} onChange={(e) => setBlackInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addBlacklist()} />
                  <button onClick={addBlacklist} style={btnSm}>추가</button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                  {blacklist.map(b => <button key={b} onClick={() => removeBlacklist(b)} style={{ ...chip, background: "rgba(255,80,80,0.1)" }}>{b} ✕</button>)}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setSettingsOpen(false)} style={btn}>닫기</button>
              <button onClick={() => { emitProfile(socketRef.current); setToast({ type: "ok", msg: "저장 완료" }); setSettingsOpen(false); }} style={btnPrimary}>저장</button>
            </div>
          </div>
        </div>
      )}

      {createPartyOpen && (
        <div onClick={() => setCreatePartyOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.60)", display: "grid", placeItems: "center", zIndex: 100 }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "min(400px, 96vw)", borderRadius: 14, background: "rgba(18,18,22,0.98)", padding: 16, border: "1px solid rgba(255,255,255,0.12)" }}>
            <div style={{ fontSize: 16, fontWeight: 900, marginBottom: 12 }}>파티 만들기</div>
            <div style={{ display: "grid", gap: 10 }}>
              <input style={input} placeholder="파티 제목" value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} />
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}><input type="checkbox" checked={createLocked} onChange={(e) => setCreateLocked(e.target.checked)} /> 비밀번호 설정</label>
              {createLocked && <input style={input} placeholder="비밀번호" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} />}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => setCreatePartyOpen(false)} style={{ ...btn, flex: 1 }}>취소</button>
              <button onClick={createPartyManual} style={{ ...btnPrimary, flex: 1 }}>생성하기</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        * { box-sizing: border-box; }
        .shell { display: grid; grid-template-columns: 240px 1fr 320px; grid-template-rows: 60px 1fr auto; gap: 10px; padding: 10px; max-width: 1600px; margin: 0 auto; }
        .discord-aside { grid-column: 1; grid-row: 1 / span 3; }
        .search-header { grid-column: 2; grid-row: 1; }
        .main-content { grid-column: 2; grid-row: 2; grid-template-columns: 280px 1fr; gap: 0; }
        .aside-right { grid-column: 3; grid-row: 1 / span 3; }
        .footer-content { grid-column: 2 / span 2; grid-row: 3; }
        @media (max-width: 1200px) {
          .shell { grid-template-columns: 220px 1fr; grid-template-rows: 60px auto auto auto; }
          .aside-right { grid-column: 1 / span 2; grid-row: 3; }
          .footer-content { grid-column: 1 / span 2; grid-row: 4; }
        }
        @media (max-width: 900px) { .main-content { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .shell { grid-template-columns: 1fr; grid-template-rows: auto; padding: 8px; gap: 8px; }
          .discord-aside, .search-header, .main-content, .aside-right, .footer-content { grid-column: 1 !important; grid-row: auto !important; }
        }
        @keyframes pulse { 0%, 100% { transform: scale(1); opacity: .55; } 50% { transform: scale(1.4); opacity: 1; } }
        @keyframes mlqIndeterminate { 0% { transform: translateX(-110%); } 50% { transform: translateX(40%); } 100% { transform: translateX(210%); } }
        button { transition: all 0.2s; }
        button:active { transform: scale(0.98); }
      `}</style>
    </div>
  );
}
