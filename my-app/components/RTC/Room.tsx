"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

// const URL = "https://poc-v2-19ly.vercel.app/";
const URL="http://localhost:3000"

// ---- Types for onboarding meta ----
type ExpBucket = 0 | 1 | 2 | 3;
type Meta = {
  profile: {
    years?: number;
    expBucket?: ExpBucket;
    industry: string;
    country: string;
    skills: string[];
  };
  prefs: {
    strict?: boolean;
    minExpBucket?: ExpBucket;
    industries?: string[];
    countries?: string[];
    subdomains?: string[];
  };
};

function toExpBucket(years: number): ExpBucket {
  if (years <= 2) return 0;
  if (years <= 5) return 1;
  if (years <= 10) return 2;
  return 3;
}
function normalizeMeta(raw: any): Meta {
  const prev = {
    profile: { expBucket: 0 as ExpBucket, industry: "OTH", country: "US", skills: [] as string[] },
    prefs:   { strict: false, industries: [] as string[], countries: [] as string[], subdomains: [] as string[] }
  };
  const r = raw ?? {};
  const years = r.profile?.years;
  const expBucket = (r.profile?.expBucket ?? (typeof years === "number" ? toExpBucket(years) : prev.profile.expBucket)) as ExpBucket;

  return {
    profile: {
      expBucket,
      industry: (r.profile?.industry ?? prev.profile.industry).toUpperCase(),
      country:  (r.profile?.country  ?? prev.profile.country).toUpperCase(),
      skills:   Array.isArray(r.profile?.skills)
        ? [...new Set((r.profile.skills as string[]).map((s) => s.trim().toLowerCase()))].slice(0, 15)
        : prev.profile.skills,
    },
    prefs: {
      strict: !!(r.prefs?.strict ?? prev.prefs.strict),
      minExpBucket: r.prefs?.minExpBucket as ExpBucket | undefined,
      industries: Array.isArray(r.prefs?.industries) ? r.prefs.industries.map((x: string) => x.toUpperCase()) : prev.prefs.industries,
      countries:  Array.isArray(r.prefs?.countries)  ? r.prefs.countries.map((x: string) => x.toUpperCase())  : prev.prefs.countries,
      subdomains: Array.isArray(r.prefs?.subdomains) ? r.prefs.subdomains : prev.prefs.subdomains,
    }
  };
}

export default function Room({
  name,
  localAudioTrack,
  localVideoTrack,
  meta, // NEW (optional) – if not provided, we’ll read from localStorage
}: {
  name: string;
  localAudioTrack: MediaStreamTrack | null;
  localVideoTrack: MediaStreamTrack | null;
  meta?: Meta;
}) {
  const router = useRouter();

  const [lobby, setLobby] = useState(true);
  const [status, setStatus] = useState<string>("Waiting to connect you to someone…");

  // DOM refs
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // socket/pc refs
  const socketRef = useRef<Socket | null>(null);
  const sendingPcRef = useRef<RTCPeerConnection | null>(null);
  const receivingPcRef = useRef<RTCPeerConnection | null>(null);
  const joinedRef = useRef(false);

  // persistent remote stream
  const remoteStreamRef = useRef<MediaStream | null>(null);

  // --- Helpers --------------------------------------------------------------

  // Bind/create remote stream to <video>/<audio>
  function ensureRemoteStream() {
    if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();

    const v = remoteVideoRef.current;
    if (v && v.srcObject !== remoteStreamRef.current) {
      v.srcObject = remoteStreamRef.current;
      v.playsInline = true;
      v.play().catch(() => {});
    }

    const a = remoteAudioRef.current;
    if (a && a.srcObject !== remoteStreamRef.current) {
      a.srcObject = remoteStreamRef.current;
      a.autoplay = true;
      a.muted = false;
      a.play().catch(() => {});
    }
  }

  // Detach the preview element’s own stream (do NOT stop the prop tracks here)
  function detachLocalPreview() {
    try {
      const localStream = localVideoRef.current?.srcObject as MediaStream | null;
      localStream?.getTracks().forEach((t) => {
        try { t.stop(); } catch {}
      });
    } catch {}
    if (localVideoRef.current) {
      try { localVideoRef.current.pause(); } catch {}
      localVideoRef.current.srcObject = null;
    }
  }

  // Stop the tracks we were given from the parent — call ONLY on explicit Leave
  function stopProvidedTracks() {
    try { localVideoTrack?.stop(); } catch {}
    try { localAudioTrack?.stop(); } catch {}
  }

  // Close PCs and clear ONLY remote media
  function teardownPeers(reason = "teardown") {
    try {
      if (sendingPcRef.current) {
        try {
          sendingPcRef.current.getSenders().forEach((sn) => {
            try { sendingPcRef.current?.removeTrack(sn); } catch {}
          });
        } catch {}
        sendingPcRef.current.close();
      }
      if (receivingPcRef.current) {
        try {
          receivingPcRef.current.getSenders().forEach((sn) => {
            try { receivingPcRef.current?.removeTrack(sn); } catch {}
          });
        } catch {}
        receivingPcRef.current.close();
      }
    } catch {}
    sendingPcRef.current = null;
    receivingPcRef.current = null;

    if (remoteStreamRef.current) {
      try { remoteStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
    }
    remoteStreamRef.current = null;

    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    setLobby(true);
    if (reason === "partner-left") {
      setStatus("Partner left. Finding a new match…");
    } else if (reason === "next") {
      setStatus("Searching for your next match…");
    } else {
      setStatus("Waiting to connect you to someone…");
    }
  }

  // --- Effects --------------------------------------------------------------

  // Bind remote when leaving lobby
  useEffect(() => {
    if (!lobby) ensureRemoteStream();
  }, [lobby]);

  // Local preview: attach once tracks exist; retry play on first click (autoplay)
  useEffect(() => {
    const el = localVideoRef.current;
    if (!el) return;
    if (!localVideoTrack && !localAudioTrack) return;

    const stream = new MediaStream([
      ...(localVideoTrack ? [localVideoTrack] : []),
      ...(localAudioTrack ? [localAudioTrack] : []),
    ]);

    el.srcObject = stream;
    el.muted = true;      // required for autoplay policies
    el.playsInline = true;

    const tryPlay = () => el.play().catch(() => {});
    tryPlay();

    const onceClick = () => { tryPlay(); window.removeEventListener("click", onceClick); };
    window.addEventListener("click", onceClick, { once: true });

    return () => window.removeEventListener("click", onceClick);
  }, [localAudioTrack, localVideoTrack]);

  // Socket / WebRTC wiring
  useEffect(() => {
    if (socketRef.current) return;

    const s = io(URL, {
      transports: ["websocket"],
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 5,
    });

    socketRef.current = s;
    s.connect();

    s.on("connect", () => {
      if (!joinedRef.current) {
        joinedRef.current = true;

        // ---- send onboarding meta (prop has priority, else localStorage) ----
        let rawMeta: any = meta ?? null;
        if (!rawMeta) {
          try {
            rawMeta = JSON.parse(localStorage.getItem("devmatch.onboarding") || "null");
          } catch {}
        }
        const m = normalizeMeta(rawMeta);
        s.emit("onboard:meta", m);

        // ---- immediately queue for a match ----
        s.emit("queue:next");
        setStatus("Searching for the best match…");
      }
    });

    // ----- CALLER -----
    s.on("send-offer", async ({ roomId }) => {
      setLobby(false);
      setStatus("Connecting…");

      const pc = new RTCPeerConnection();
      sendingPcRef.current = pc;

      // only add live tracks
      if (localVideoTrack && localVideoTrack.readyState === "live") pc.addTrack(localVideoTrack);
      if (localAudioTrack && localAudioTrack.readyState === "live") pc.addTrack(localAudioTrack);

      ensureRemoteStream();
      pc.ontrack = (e) => {
        remoteStreamRef.current!.addTrack(e.track);
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          s.emit("add-ice-candidate", { candidate: e.candidate, type: "sender", roomId });
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      s.emit("offer", { sdp: offer, roomId });
    });

    // ----- ANSWERER -----
    s.on("offer", async ({ roomId, sdp: remoteSdp }) => {
      setLobby(false);
      setStatus("Connecting…");

      const pc = new RTCPeerConnection();
      receivingPcRef.current = pc;

      if (localVideoTrack && localVideoTrack.readyState === "live") pc.addTrack(localVideoTrack);
      if (localAudioTrack && localAudioTrack.readyState === "live") pc.addTrack(localAudioTrack);

      await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));

      ensureRemoteStream();
      pc.ontrack = (e) => {
        remoteStreamRef.current!.addTrack(e.track);
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          s.emit("add-ice-candidate", { candidate: e.candidate, type: "receiver", roomId });
        }
      };

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      s.emit("answer", { roomId, sdp: answer });
    });

    // caller receives answer
    s.on("answer", async ({ sdp: remoteSdp }) => {
      const pc = sendingPcRef.current;
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(remoteSdp));
    });

    // trickle ICE
    s.on("add-ice-candidate", async ({ candidate, type }) => {
      try {
        const ice = new RTCIceCandidate(candidate);
        if (type === "sender") {
          await receivingPcRef.current?.addIceCandidate(ice);
        } else {
          await sendingPcRef.current?.addIceCandidate(ice);
        }
      } catch (e) {
        console.error("addIceCandidate error", e);
      }
    });

    // lobby / searching
    s.on("lobby", () => {
      setLobby(true);
      setStatus("Waiting to connect you to someone…");
    });
    s.on("queue:waiting", () => {
      setLobby(true);
      setStatus("Searching for the best match…");
    });

    // partner left
    s.on("partner:left", () => {
      teardownPeers("partner-left");
    });

    // ensure we leave queue and stop devices on real tab close
    const onBeforeUnload = () => {
      try { s.emit("queue:leave"); } catch {}
      // User is actually leaving the page: stop real devices
      stopProvidedTracks();
      detachLocalPreview();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);

      s.off("connect");
      s.off("send-offer");
      s.off("offer");
      s.off("answer");
      s.off("add-ice-candidate");
      s.off("lobby");
      s.off("queue:waiting");
      s.off("partner:left");
      try { s.emit("queue:leave"); } catch {}
      s.disconnect();
      socketRef.current = null;

      // Close PCs & clear remote only; keep local devices alive in dev
      try { sendingPcRef.current?.close(); } catch {}
      try { receivingPcRef.current?.close(); } catch {}
      sendingPcRef.current = null;
      receivingPcRef.current = null;

      if (remoteStreamRef.current) {
        try { remoteStreamRef.current.getTracks().forEach((t) => t.stop()); } catch {}
      }
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

      // IMPORTANT: Do NOT stop the provided tracks here — Strict Mode double-mount would kill them.
      // Only detach the preview element to avoid leaks.
      detachLocalPreview();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, localAudioTrack, localVideoTrack, meta]);

  // --- Actions --------------------------------------------------------------

  const handleNext = () => {
    const s = socketRef.current;
    if (!s) return;
    s.emit("queue:next");
    teardownPeers("next"); // keep local devices alive for fast rematch
  };

  const handleLeave = () => {
    const s = socketRef.current;
    try { s?.emit("queue:leave"); } catch {}
    teardownPeers("teardown");
    // Explicit user intent to leave → actually turn off camera & mic
    stopProvidedTracks();
    detachLocalPreview();
    router.push("/");
  };

  const handleRecheck = () => {
    setLobby(true);
    setStatus("Rechecking…");
  };

  // --- UI -------------------------------------------------------------------

  return (
    <div className="flex flex-col min-h-screen bg-gray-950 text-white">
      {/* Top bar */}
      <header className="w-full border-b border-white/10 bg-gray-900/60 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500" />
            <h1 className="text-lg font-semibold tracking-tight">DevMatch Room</h1>
          </div>
          <div className="text-sm text-white/70">
            Signed in as <span className="text-white">{name}</span>
          </div>
        </div>
      </header>

      {/* Video grid */}
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Local video */}
          <div className="rounded-2xl overflow-hidden border border-white/10 bg-white/[0.02] shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
            <div className="p-3 flex items-center justify-between border-b border-white/10">
              <div className="text-sm font-medium text-white/80">You</div>
              <div className="text-[10px] uppercase tracking-wider text-white/50">Local Preview</div>
            </div>
            <div className="relative aspect-video bg-black">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                className="absolute inset-0 h-full w-full object-cover"
              />
              <div className="absolute bottom-3 left-3 text-xs bg-black/60 px-2 py-1 rounded-md">
                {name}
              </div>
            </div>
          </div>

          {/* Remote video */}
          <div className="rounded-2xl overflow-hidden border border-white/10 bg-white/[0.02] shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
            <div className="p-3 flex items-center justify-between border-b border-white/10">
              <div className="text-sm font-medium text-white/80">Peer</div>
              <div className="text-[10px] uppercase tracking-wider text-white/50">Remote Stream</div>
            </div>
            <div className="relative aspect-video bg-black flex items-center justify-center">
              {lobby ? (
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-8 w-8 animate-spin text-white/60" />
                  <span className="text-sm text-white/60">{status}</span>
                </div>
              ) : (
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <div className="absolute bottom-3 left-3 text-xs bg-black/60 px-2 py-1 rounded-md">
                {lobby ? "—" : "Connected"}
              </div>
              {/* hidden remote audio sink so we can hear the peer */}
              <audio ref={remoteAudioRef} style={{ display: "none" }} />
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="w-full border-t border-white/10 bg-gray-900/60 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center gap-3 justify-end">
          <span className="mr-auto text-xs text-white/60">
            Tip: keep this tab active while matching.
          </span>

          <button
            className="h-10 rounded-xl border border-white/15 bg-white/[0.04] px-4 text-sm hover:bg-white/[0.08] transition"
            onClick={handleRecheck}
          >
            Recheck
          </button>

          <button
            className="h-10 rounded-xl border border-white/15 bg-white/[0.04] px-4 text-sm hover:bg-white/[0.08] transition"
            onClick={handleNext}
            title="Skip current partner and find another"
          >
            Next
          </button>

          <button
            className="h-10 rounded-xl bg-red-600 hover:bg-red-500 px-4 text-sm font-medium transition"
            onClick={handleLeave}
          >
            Leave
          </button>
        </div>
      </footer>
    </div>
  );
}
