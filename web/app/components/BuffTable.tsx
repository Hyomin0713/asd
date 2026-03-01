"use client";

import React, { useMemo } from "react";

type Job = "전사" | "도적" | "궁수" | "마법사";

type Member = {
  userId: string;
  name: string;
  level?: number | null;
  job?: Job | null;
  power?: number | null;
  buffs?: { simbi: number; ppeongbi: number; syapbi: number };
};

export function BuffTable(props: {
  partyId: string;
  party: any;
  me: any;
  myBuffs: { simbi: number; ppeongbi: number; syapbi: number };
  onChangeMyBuffs: (b: { simbi: number; ppeongbi: number; syapbi: number }) => void;
  onPushMyBuffs: (b: { simbi: number; ppeongbi: number; syapbi: number }) => void;
  onTransferOwner: (newOwnerId: string) => void;
  fmtNumber: (n: number) => string;
  card: React.CSSProperties;
  muted: React.CSSProperties;
  chip: React.CSSProperties;
  input: React.CSSProperties;
}) {
  const { party, me, myBuffs, onChangeMyBuffs, onPushMyBuffs, onTransferOwner, card, muted, chip, input } = props;

  if (!party || !me) return null;

  const members = (party.members || []) as Member[];
  const isOwner = party.ownerId === me.user.id;

  const handleUpdate = (key: keyof typeof myBuffs, val: string) => {
    const n = Math.max(0, Math.floor(Number(val) || 0));
    const next = { ...myBuffs, [key]: n };
    onChangeMyBuffs(next);
  };

  const saveBuffs = () => {
    onPushMyBuffs(myBuffs);
    alert("버프 정보가 저장되었습니다.");
  };

  return (
    <div style={{ ...card, background: "rgba(255,255,255,0.04)" }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontWeight: 900, fontSize: 14 }}>파티 버프 / 비용 설정</div>
        <button onClick={saveBuffs} style={{ 
          background: "rgba(120,200,255,0.15)", 
          border: "1px solid rgba(120,200,255,0.3)", 
          color: "#fff", 
          padding: "4px 10px", 
          borderRadius: "8px", 
          fontSize: "12px",
          cursor: "pointer" 
        }}>내 정보 저장</button>
      </div>

      <div style={{ padding: 10, display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ ...muted, fontSize: 10 }}>심비</div>
            <input 
              style={{ ...input, padding: "6px", fontSize: "12px", width: "100%", boxSizing: "border-box" }} 
              value={myBuffs.simbi || ""} 
              onChange={e => handleUpdate("simbi", e.target.value)}
              placeholder="0"
            />
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ ...muted, fontSize: 10 }}>뻥비</div>
            <input 
              style={{ ...input, padding: "6px", fontSize: "12px", width: "100%", boxSizing: "border-box" }} 
              value={myBuffs.ppeongbi || ""} 
              onChange={e => handleUpdate("ppeongbi", e.target.value)}
              placeholder="0"
            />
          </div>
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ ...muted, fontSize: 10 }}>샾비</div>
            <input 
              style={{ ...input, padding: "6px", fontSize: "12px", width: "100%", boxSizing: "border-box" }} 
              value={myBuffs.syapbi || ""} 
              onChange={e => handleUpdate("syapbi", e.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
          {members.map(m => {
            const mIsOwner = party.ownerId === m.userId;
            const mIsMe = me.user.id === m.userId;
            return (
              <div key={m.userId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: "13px", color: mIsMe ? "#74c0fc" : "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {mIsOwner && "👑 "}{m.name}
                  </div>
                  {isOwner && !mIsMe && (
                    <button 
                      onClick={() => {
                        if (window.confirm(`${m.name}님에게 파티장을 넘길까요?`)) onTransferOwner(m.userId);
                      }}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: "12px", padding: 0, flexShrink: 0 }}
                      title="파티장 양도"
                    >
                      🔄
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  <span style={{ ...chip, fontSize: "10px", padding: "2px 5px", opacity: m.buffs?.simbi ? 1 : 0.3, minWidth: "35px", textAlign: "center" }}>심 {m.buffs?.simbi || 0}</span>
                  <span style={{ ...chip, fontSize: "10px", padding: "2px 5px", opacity: m.buffs?.ppeongbi ? 1 : 0.3, minWidth: "35px", textAlign: "center" }}>뻥 {m.buffs?.ppeongbi || 0}</span>
                  <span style={{ ...chip, fontSize: "10px", padding: "2px 5px", opacity: m.buffs?.syapbi ? 1 : 0.3, minWidth: "35px", textAlign: "center" }}>샾 {m.buffs?.syapbi || 0}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
