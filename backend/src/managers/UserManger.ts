import { Socket } from "socket.io";
import { RoomManager } from "./RoomManager";

// === Matching meta types ===
type ExpBucket = 0 | 1 | 2 | 3; // 0:0–2y, 1:3–5y, 2:5–10y, 3:10y+

type Profile = {
  expBucket: ExpBucket;
  industry: string;   // normalized code, e.g. ENG, PM, MKT
  country: string;    // ISO2 "US","IN"
  skills: string[];   // lowercased, unique, capped
};

type Preferences = {
  strict?: boolean;           // if true, don’t relax matching
  minExpBucket?: ExpBucket;   // minimum acceptable experience
  industries?: string[];      // acceptable industries (codes)
  countries?: string[];       // acceptable countries (ISO2)
  subdomains?: string[];      // optional
};

// === Helpers ===
function toExpBucket(years: number): ExpBucket {
  if (years <= 2) return 0;
  if (years <= 5) return 1;
  if (years <= 10) return 2;
  return 3;
}
function normSkills(sk: string[] = []): string[] {
  return [...new Set(sk.map(s => s.trim().toLowerCase()))].slice(0, 15);
}
function jaccard(a: string[] = [], b: string[] = []) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni; // 0..1
}
function reverseAccepts(receiver: Preferences | undefined, cand: Profile | undefined) {
  if (!receiver || !cand) return true;
  if (receiver.minExpBucket != null && cand.expBucket < receiver.minExpBucket) return false;
  if (receiver.industries?.length && !receiver.industries.includes(cand.industry)) return false;
  if (receiver.countries?.length && !receiver.countries.includes(cand.country)) return false;
  return true;
}

// === Bucketed index (hash-like) ===
type BucketKey = string;
function key(parts: Array<string | number | undefined | null>) {
  return parts.map(v => (v == null ? "_" : String(v))).join("|");
}

class BucketIndex {
  private map: Map<BucketKey, Set<string>> = new Map();

  add(k: BucketKey, userId: string) {
    let s = this.map.get(k);
    if (!s) { s = new Set(); this.map.set(k, s); }
    s.add(userId);
  }
  remove(k: BucketKey, userId: string) {
    const s = this.map.get(k);
    if (!s) return;
    s.delete(userId);
    if (s.size === 0) this.map.delete(k);
  }
  all(k: BucketKey): string[] {
    const s = this.map.get(k);
    return s ? [...s] : [];
  }
}

function exactKey(p: Profile)       { return key(["EXACT", p.industry, p.country, p.expBucket]); }
function indCountryKey(p: Profile)  { return key(["IC",    p.industry, p.country]); }
function industryKey(p: Profile)    { return key(["IND",   p.industry]); }
function countryKey(p: Profile)     { return key(["CTRY",  p.country]); }
function expKeysPlusMinus1(p: Profile): BucketKey[] {
  const ks: BucketKey[] = [];
  const e = p.expBucket;
  for (const d of [-1, 1]) {
    const v = e + d;
    if (v >= 0 && v <= 3) ks.push(key(["EXP1", v]));
  }
  return ks;
}
const ANY_KEY: BucketKey = key(["ANY"]);

// === Your existing exported User interface ===
export interface User {
  socket: Socket;
  name: string;
  profile?: Profile;
  prefs?: Preferences;
  joinedAt?: number;
}

export class UserManager {
  private users: User[];
  private queue: string[];

  // presence/relations
  private partnerOf: Map<string, string>;
  private online: Set<string>;
  private roomOf: Map<string, string>;

  // meta
  private profileOf: Map<string, Profile>;
  private prefsOf: Map<string, Preferences>;
  private joinedAt: Map<string, number>;

  // buckets
  private buckets: BucketIndex;

  // ==== NEW: time-limited bans (to avoid deadlocks) ====
  private banUntil: Map<string, Map<string, number>> = new Map();
  private static readonly BAN_TTL_NEXT_MS  = 60_000; // 60s for "Next"
  private static readonly BAN_TTL_LEAVE_MS = 20_000; // 20s for leave/disconnect
  private static readonly SMALL_QUEUE_OVERRIDE_MAX = 3;

  private roomManager: RoomManager;
  
  constructor() {
    this.users = [];
    this.queue = [];
    this.roomManager = new RoomManager();

    this.partnerOf = new Map();
    this.online = new Set();
    this.roomOf = new Map();

    this.profileOf = new Map();
    this.prefsOf  = new Map();
    this.joinedAt = new Map();

    this.buckets = new BucketIndex();
  }

  // --- Utils ---
  private isPaired = (id: string) => this.partnerOf.has(id);
  private logQueueAndProfiles(tag = "") {
    console.log(`\n*** CLEAR QUEUE ${tag} ***`);
    console.log(`Current queue:`, this.queue);
    console.log(`Profiles:`);
    this.queue.forEach(uid => console.log(`  ${uid}:`, this.profileOf.get(uid)));
  }

  // ==== Ban helpers (TTL-based) ====
  private isBanned(a: string, b: string) {
    const t = this.banUntil.get(a)?.get(b) ?? 0;
    return Date.now() < t;
  }
  private setBan(a: string, b: string, ms: number) {
    let m = this.banUntil.get(a);
    if (!m) { m = new Map(); this.banUntil.set(a, m); }
    m.set(b, Date.now() + ms);
  }
  private clearExpiredBans() {
    const now = Date.now();
    for (const [a, map] of this.banUntil) {
      for (const [b, t] of map) if (t <= now) map.delete(b);
      if (map.size === 0) this.banUntil.delete(a);
    }
  }

  // --- Queue <-> Bucket sync ---
  private enqueueForMatch(userId: string, reason = "enqueue") {
    if (this.isPaired(userId)) {
      console.log(`[ENQUEUE SKIP] ${userId} is already paired. reason=${reason}`);
      return;
    }
    if (!this.queue.includes(userId)) {
      this.queue.push(userId);
      console.log(`[ENQUEUE] user=${userId} reason=${reason}`);
    }
    this.joinedAt.set(userId, Date.now());

    const prof = this.profileOf.get(userId);
    if (!prof) {
      console.log(`[ENQUEUE WARN] no profile for ${userId}`);
      return;
    }

    this.buckets.add(exactKey(prof), userId);
    this.buckets.add(indCountryKey(prof), userId);
    this.buckets.add(industryKey(prof), userId);
    this.buckets.add(countryKey(prof), userId);
    for (const k of expKeysPlusMinus1(prof)) this.buckets.add(k, userId);
    this.buckets.add(ANY_KEY, userId);
  }

  private dequeueFromMatch(userId: string, reason = "dequeue") {
    if (this.queue.includes(userId)) {
      console.log(`[DEQUEUE] user=${userId} reason=${reason}`);
    }
    this.queue = this.queue.filter(x => x !== userId);

    const prof = this.profileOf.get(userId);
    if (!prof) return;

    this.buckets.remove(exactKey(prof), userId);
    this.buckets.remove(indCountryKey(prof), userId);
    this.buckets.remove(industryKey(prof), userId);
    this.buckets.remove(countryKey(prof), userId);
    for (const k of expKeysPlusMinus1(prof)) this.buckets.remove(k, userId);
    this.buckets.remove(ANY_KEY, userId);
  }

  // --- Candidate keys for a requester (with relaxation & custom prefs) ---
  private getCandidateKeysFor(aProf: Profile, aPrefs?: Preferences): BucketKey[][] {
    if (aPrefs?.strict) return [[exactKey(aProf)]];

    const ladder: BucketKey[][] = [
      [exactKey(aProf)],         // Level 0: exact industry+country+exp
      [indCountryKey(aProf)],    // Level 1: industry+country
      [industryKey(aProf)],      // Level 2: industry
      [countryKey(aProf)],       // Level 3: country
      expKeysPlusMinus1(aProf),  // Level 4: exp +/- 1
      [ANY_KEY],                 // Level 5: anyone
    ];

    // Optional preference-driven keys (prepend as level - custom)
    const custom: BucketKey[] = [];
    if (aPrefs?.industries?.length && !aPrefs.strict) {
      for (const ind of aPrefs.industries) custom.push(key(["IND", ind]));
    }
    if (aPrefs?.countries?.length && !aPrefs.strict) {
      for (const c of aPrefs.countries) custom.push(key(["CTRY", c]));
    }
    return custom.length ? [custom, ...ladder] : ladder;
  }

  // --- Fast best-match finder with detailed logs ---
  private getBestMatchFor(userId: string): string | undefined {
    const aProf = this.profileOf.get(userId);
    const aPrefs = this.prefsOf.get(userId);
    if (!aProf) return;

    // Clean expired bans regularly
    this.clearExpiredBans();

    console.log(`\n=== MATCH SEARCH START ===`);
    console.log(`Requesting user: ${userId}`);
    console.log(`Profile:`, aProf);
    console.log(`Preferences:`, aPrefs);

    const levels = this.getCandidateKeysFor(aProf, aPrefs);

    let best: { id: string; score: number; ts: number; level: number } | undefined;

    for (let levelIndex = 0; levelIndex < levels.length; levelIndex++) {
      const keys = levels[levelIndex];

      console.log(`\n-- Relaxation Level ${levelIndex} --`);
      console.log(`Bucket keys:`, keys);

      const seen = new Set<string>();
      const pool: string[] = [];

      for (const k of keys) {
        const bucketMembers = this.buckets.all(k);
        console.log(`  Key ${k} => members:`, bucketMembers);
        for (const cand of bucketMembers) {
          if (cand !== userId && !seen.has(cand)) {
            seen.add(cand);
            pool.push(cand);
          }
        }
      }

      console.log(`  Raw pool:`, pool);

      const valids: string[] = [];
      for (const b of pool) {
        const rejectReasons: string[] = [];
        if (!this.online.has(b)) rejectReasons.push("offline");
        if (!this.queue.includes(b)) rejectReasons.push("not-in-queue");
        if (this.isPaired(b)) rejectReasons.push("already-in-room");
        if (this.isBanned(userId, b) || this.isBanned(b, userId)) rejectReasons.push("banned-one-way");

        const bProf = this.profileOf.get(b);
        if (!bProf) rejectReasons.push("no-profile");
        const bPrefs = this.prefsOf.get(b);

        let mutual = true;
        if (!rejectReasons.length && bProf) {
          if (!reverseAccepts(aPrefs, bProf)) { mutual = false; rejectReasons.push("a->b prefs fail"); }
          if (!reverseAccepts(bPrefs, aProf)) { mutual = false; rejectReasons.push("b->a prefs fail"); }
        }

        if (rejectReasons.length) {
          console.log(`  REJECT ${b}: ${rejectReasons.join(", ")}`);
          continue;
        }
        if (mutual) valids.push(b);
      }

      console.log(`  Valid candidates:`, valids);

      for (const b of valids) {
        const ts = this.joinedAt.get(b) ?? 0;
        const bProf = this.profileOf.get(b)!;
        const score =
          jaccard(aProf.skills, bProf.skills) * 3 +
          (aProf.industry === bProf.industry ? 2.5 : 0) +
          (aProf.country === bProf.country ? 2.0 : 0) +
          (Math.abs(aProf.expBucket - bProf.expBucket) === 0
            ? 1.5
            : Math.abs(aProf.expBucket - bProf.expBucket) === 1
            ? 0.75
            : 0);

        console.log(`    Candidate ${b} | profile:`, bProf);
        console.log(`    -> Match score: ${score.toFixed(2)} | joinedAt: ${ts}`);

        if (!best) {
          best = { id: b, score, ts, level: levelIndex };
        } else if (ts < best.ts || (ts === best.ts && score > best.score)) {
          best = { id: b, score, ts, level: levelIndex };
        }
      }

      if (best) {
        console.log(`  Selected at level ${levelIndex}:`, best);
        break; // stop at first level where we found something
      }

      // ---- FIXED: Small-queue override (demo-unblock) ----
      // * Runs only if strict=false
      // * Ignores ONLY bans, still enforces both users' preferences (minExp, industries, countries)
      if (levelIndex === levels.length - 1 && !best) {
        if (!aPrefs?.strict && this.queue.length <= UserManager.SMALL_QUEUE_OVERRIDE_MAX) {
          const consider = pool.filter(b => {
            if (!this.online.has(b)) return false;
            if (!this.queue.includes(b)) return false;
            if (this.isPaired(b)) return false;

            // DO NOT ignore preferences here; only ignore bans.
            const bProf = this.profileOf.get(b);
            const bPrefs = this.prefsOf.get(b);
            if (!bProf) return false;

            // Enforce mutual accept (minExpBucket, industries, countries)
            if (!reverseAccepts(aPrefs, bProf)) return false;
            if (!reverseAccepts(bPrefs, aProf)) return false;

            return true;
          });

          if (consider.length) {
            // pick oldest (FIFO)
            let chosen = consider[0];
            let bestTs = this.joinedAt.get(chosen) ?? 0;
            for (const b of consider) {
              const ts = this.joinedAt.get(b) ?? 0;
              if (ts < bestTs) { bestTs = ts; chosen = b; }
            }
            console.log(`  [OVERRIDE SAFE] Small queue: ignoring bans ONLY, selecting ${chosen}`);
            best = { id: chosen, score: -1, ts: bestTs, level: levelIndex };
            break;
          }
        }
      }
    }

    console.log(`=== MATCH SEARCH END ===\n`);
    return best?.id;
  }

  // ---------- MATCHING / QUEUE ----------
  clearQueue(callerTag: string = "") {
    if (this.queue.length < 2) return;

    // Purge: keep only online & NOT in a room
    const before = [...this.queue];
    for (const id of before) {
      if (!this.online.has(id) || this.isPaired(id)) {
        this.dequeueFromMatch(id, !this.online.has(id) ? "purge-offline" : "purge-paired");
      }
    }

    if (this.queue.length < 2) return;

    this.logQueueAndProfiles(callerTag);

    // Iterate a snapshot FIFO
    const snapshot = [...this.queue].sort((a, b) => (this.joinedAt.get(a) ?? 0) - (this.joinedAt.get(b) ?? 0));

    for (const a of snapshot) {
      if (!this.queue.includes(a)) continue; // might have been matched already
      if (!this.online.has(a)) { this.dequeueFromMatch(a, "offline-in-loop"); continue; }
      if (this.isPaired(a))    { this.dequeueFromMatch(a, "paired-in-loop"); continue; }

      const b = this.getBestMatchFor(a);
      if (!b) {
        console.log(`No match found for ${a}`);
        continue;
      }

      // Found a pair
      this.dequeueFromMatch(a, "paired");
      this.dequeueFromMatch(b, "paired");

      const user1 = this.users.find(u => u.socket.id === a);
      const user2 = this.users.find(u => u.socket.id === b);
      if (!user1 || !user2) continue;

      const roomId = this.roomManager.createRoom(user1, user2);
      console.log(`MATCH FOUND: ${a} <-> ${b}`);
      console.log(`Created room ${roomId} for ${user1.name} and ${user2.name}`);

      this.partnerOf.set(a, b);
      this.partnerOf.set(b, a);
      this.roomOf.set(a, roomId);
      this.roomOf.set(b, roomId);

      // Clear FIFO timestamps (reset when requeued)
      this.joinedAt.delete(a);
      this.joinedAt.delete(b);
    }
  }

  // Try to get this user matched immediately (used after requeue)
  private tryMatchFor(userId: string) {
    if (!this.online.has(userId)) return;
    if (!this.queue.includes(userId)) this.enqueueForMatch(userId, "tryMatch");
    this.clearQueue("tryMatch");
  }

  // --- Lifecycle ---
  addUser(name: string, socket: Socket) {
    console.log("a user connected", socket.id);
    this.users.push({ name, socket, joinedAt: Date.now() });
    this.online.add(socket.id);

    // defaults (in case client hasn't sent onboard:meta yet)
    if (!this.profileOf.has(socket.id)) {
      this.profileOf.set(socket.id, { expBucket: 0, industry: "OTH", country: "US", skills: [] });
    }
    if (!this.prefsOf.has(socket.id)) {
      this.prefsOf.set(socket.id, { strict: false, industries: [], countries: [] });
    }

    // put user into queue & buckets
    this.enqueueForMatch(socket.id, "addUser");

    socket.emit("lobby");
    this.clearQueue("addUser");

    this.initHandlers(socket);
  }

  removeUser(socketId: string) {
    console.log("user disconnected", socketId);
    // remove from queue/buckets
    if (this.queue.includes(socketId)) this.dequeueFromMatch(socketId, "removeUser");

    // remove from list
    this.users = this.users.filter(x => x.socket.id !== socketId);

    // clean presence
    this.online.delete(socketId);

    // if they were in a room/paired, handle like leave
    this.handleLeave(socketId, "explicit-remove");

    // optional: clean meta
    this.profileOf.delete(socketId);
    this.prefsOf.delete(socketId);
    this.joinedAt.delete(socketId);
  }

  // ---------- LEAVE / DISCONNECT / NEXT ----------
  private handleLeave(leaverId: string, reason: string = "leave") {
    const partnerId = this.partnerOf.get(leaverId);

    // always remove leaver from queue/buckets
    if (this.queue.includes(leaverId)) this.dequeueFromMatch(leaverId, `leave-${reason}`);

    // clean leaver links
    const leaverRoomId = this.roomOf.get(leaverId);
    if (leaverRoomId) {
      this.roomManager.teardownUser(leaverRoomId, leaverId);
      this.roomOf.delete(leaverId);
    }
    this.partnerOf.delete(leaverId);

    if (partnerId) {
      // leave/disconnect => set a short ONE-WAY ban (leaver -> partner)
      this.setBan(leaverId, partnerId, UserManager.BAN_TTL_LEAVE_MS);

      // clean partner side of the room/pair
      const partnerRoomId = this.roomOf.get(partnerId);
      if (partnerRoomId) {
        this.roomManager.teardownUser(partnerRoomId, partnerId);
        this.roomOf.delete(partnerId);
      }
      this.partnerOf.delete(partnerId);

      // keep partner waiting: requeue + notify + try match now
      const partnerUser = this.users.find(u => u.socket.id === partnerId);
      if (partnerUser && this.online.has(partnerId)) {
        partnerUser.socket.emit("partner:left", { reason });
        this.enqueueForMatch(partnerId, `partner-requeue-${reason}`);
        this.tryMatchFor(partnerId);
      }
    }
  }

  private onNext(userId: string) {
    const partnerId = this.partnerOf.get(userId);
    if (!partnerId) {
      // user is not currently paired; ensure they are queued
      this.enqueueForMatch(userId, "next-standalone");
      this.tryMatchFor(userId);
      return;
    }

    // "Next" => symmetric ban (both directions) for a while to avoid rematch loop
    this.setBan(userId, partnerId, UserManager.BAN_TTL_NEXT_MS);
    this.setBan(partnerId, userId, UserManager.BAN_TTL_NEXT_MS);

    // Teardown room links for both
    const roomIdU = this.roomOf.get(userId);
    if (roomIdU) this.roomManager.teardownRoom(roomIdU);

    this.partnerOf.delete(userId);
    this.partnerOf.delete(partnerId);
    this.roomOf.delete(userId);
    this.roomOf.delete(partnerId);

    // Requeue caller immediately
    this.enqueueForMatch(userId, "next-caller");

    // Notify partner + requeue partner
    const partnerUser = this.users.find(u => u.socket.id === partnerId);
    if (partnerUser && this.online.has(partnerId)) {
      partnerUser.socket.emit("partner:left", { reason: "next" });
      this.enqueueForMatch(partnerId, "next-partner");
    }

    // Try to rematch the caller right away
    this.tryMatchFor(userId);
  }

  // ---------- SOCKET HANDLERS ----------
  initHandlers(socket: Socket) {
    // WebRTC signaling passthrough
    socket.on("offer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
      this.roomManager.onOffer(roomId, sdp, socket.id);
    });

    socket.on("answer", ({ sdp, roomId }: { sdp: string, roomId: string }) => {
      this.roomManager.onAnswer(roomId, sdp, socket.id);
    });

    socket.on("add-ice-candidate", ({ candidate, roomId, type }) => {
      this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
    });

    // Onboarding/meta from client
    socket.on("onboard:meta", (meta: {
      profile?: { years?: number; expBucket?: ExpBucket; industry?: string; country?: string; skills?: string[] },
      prefs?: Preferences
    }) => {
      const prev = this.profileOf.get(socket.id) ?? { expBucket: 0 as ExpBucket, industry: "OTH", country: "US", skills: [] };
      const expBucket = (meta.profile?.expBucket ?? (meta.profile?.years != null ? toExpBucket(meta.profile.years) : prev.expBucket)) as ExpBucket;

      const profile: Profile = {
        expBucket,
        industry: (meta.profile?.industry ?? prev.industry).toUpperCase(),
        country:  (meta.profile?.country  ?? prev.country).toUpperCase(),
        skills:   normSkills(meta.profile?.skills ?? prev.skills)
      };
      const old = this.prefsOf.get(socket.id) ?? {};
      const prefs: Preferences = {
        strict: meta.prefs?.strict ?? old.strict ?? false,
        minExpBucket: meta.prefs?.minExpBucket ?? old.minExpBucket,
        industries: meta.prefs?.industries ?? old.industries ?? [],
        countries:  meta.prefs?.countries  ?? old.countries  ?? [],
        subdomains: meta.prefs?.subdomains ?? old.subdomains ?? [],
      };

      console.log(`[META] ${socket.id} -> profile=`, profile, " prefs=", prefs);

      this.profileOf.set(socket.id, profile);
      this.prefsOf.set(socket.id, prefs);

      // mirror on user object (optional)
      const u = this.users.find(x => x.socket.id === socket.id);
      if (u) { u.profile = profile; u.prefs = prefs; }

      // If user is queued (and NOT paired), refresh their bucket placement
      if (this.queue.includes(socket.id) && !this.isPaired(socket.id)) {
        this.dequeueFromMatch(socket.id, "meta-refresh");
        this.enqueueForMatch(socket.id, "meta-refresh");
        this.clearQueue("meta-refresh");
      } else {
        console.log(`[META] skip re-bucket because user is not queued or already paired`);
      }
    });

    // User actions
    socket.on("queue:next", () => {
      console.log(`[ACTION] queue:next by ${socket.id}`);
      this.onNext(socket.id);
    });

    socket.on("queue:leave", () => {
      console.log(`[ACTION] queue:leave by ${socket.id}`);
      if (this.queue.includes(socket.id)) this.dequeueFromMatch(socket.id, "leave-button");
      this.handleLeave(socket.id, "leave-button");
    });

    socket.on("disconnect", () => {
      console.log(`[ACTION] disconnect by ${socket.id}`);
      if (this.queue.includes(socket.id)) this.dequeueFromMatch(socket.id, "disconnect");
      this.handleLeave(socket.id, "disconnect");
      this.online.delete(socket.id);
    });
  }
}
