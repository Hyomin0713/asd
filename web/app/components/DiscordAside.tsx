"use client";

import React from "react";

type Props = {
  isLoggedIn: boolean;
  discordName: string;
  discordTag: string;
  nickname: string;
  level: number;
  job: string;
  power: number;
  onLogin: () => void;
  onLogout: () => void;
  onOpenSettings: () => void;
  muted: React.CSSProperties;
  card: React.CSSProperties;
  cardHeader: React.CSSProperties;
  fmtNumber: (n: number) => string;
  className?: string;
};

export function DiscordAside({
  isLoggedIn,
  discordName,
  discordTag,
  nickname,
  level,
  job,
  power,
  onLogin,
  onLogout,
  onOpenSettings,
  muted,
  card,
  cardHeader,
  fmtNumber,
  className,
}: Props) {
  const displayName = nickname || discordName;

  return (
    <aside
      className={className}
      style={{
        ...card,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ ...cardHeader, padding: "8px 12px" }}>
        <div style={{ fontWeight: 800, fontSize: 14 }}>메랜큐</div>
        <div style={{ ...muted, fontSize: 10 }}>beta</div>
      </div>

      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {!isLoggedIn ? (
          <>
            <div style={{ fontWeight: 700, fontSize: 13 }}>디스코드 로그인</div>
            <button
              onClick={onLogin}
              style={{
                width: "100%",
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(88,101,242,0.18)",
                color: "#e6e8ee",
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                fontWeight: 700,
                fontSize: 13,
              }}
            >
              로그인
            </button>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 10,
                  background: "rgba(255,255,255,0.10)",
                  display: "grid",
                  placeItems: "center",
                  fontWeight: 800,
                  fontSize: 14,
                }}
              >
                {displayName.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ lineHeight: 1.1 }}>
                <div style={{ fontWeight: 800, fontSize: 14 }}>{displayName}</div>
                <div style={{ ...muted, fontSize: 10 }}>@{discordTag}</div>
              </div>
            </div>

            {/* 내 상세 정보 표시 영역 - 높이 축소 */}
            <div style={{ 
              background: "rgba(255,255,255,0.03)", 
              padding: "8px", 
              borderRadius: "8px", 
              border: "1px solid rgba(255,255,255,0.06)",
              display: "grid",
              gap: "2px"
            }}>
              <div style={{ fontSize: "11px", display: "flex", justifyContent: "space-between" }}>
                <span style={muted}>직업</span>
                <span style={{ fontWeight: 700 }}>{job}</span>
              </div>
              <div style={{ fontSize: "11px", display: "flex", justifyContent: "space-between" }}>
                <span style={muted}>레벨</span>
                <span style={{ fontWeight: 700 }}>Lv. {level}</span>
              </div>
              <div style={{ fontSize: "11px", display: "flex", justifyContent: "space-between" }}>
                <span style={muted}>스공</span>
                <span style={{ fontWeight: 700 }}>{fmtNumber(power)}</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={onLogout}
                style={{
                  flex: 1,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "6px 10px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                로그아웃
              </button>
              <button
                onClick={onOpenSettings}
                style={{
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(255,255,255,0.06)",
                  color: "#e6e8ee",
                  padding: "6px 10px",
                  borderRadius: 10,
                  cursor: "pointer",
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                ⚙
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
