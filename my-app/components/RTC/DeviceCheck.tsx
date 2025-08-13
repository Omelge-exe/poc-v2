"use client";
import { useEffect, useRef, useState } from "react";
import Room from "./Room";

type ExpBucket = 0 | 1 | 2 | 3;
type Meta = {
  profile: { years?: number; expBucket?: ExpBucket; industry: string; country: string; skills: string[] };
  prefs: { strict?: boolean; minExpBucket?: ExpBucket; industries?: string[]; countries?: string[]; subdomains?: string[] };
};

const PROFESSIONS = [
  "Software Developer","Data Scientist","Product Manager","UX/UI Designer","DevOps Engineer",
  "Cybersecurity Specialist","Business Analyst","Marketing Professional","Sales Professional",
  "Consultant","Entrepreneur","Student","Other"
];

const EXPERIENCE = ["0-2","2-5","5-10","10+"];

const COUNTRIES = ["US","IN","CA","GB","DE","FR","SG","AU"];

const TAGS = ["React","Node","DevOps","Python","ML","TypeScript","Kubernetes","AWS","Design","SEO"];

function toExpBucketLabel(exp: string): ExpBucket {
  if (exp === "0-2") return 0;
  if (exp === "2-5") return 1;
  if (exp === "5-10") return 2;
  return 3;
}
function mapProfessionToIndustryCode(p: string): string {
  const s = p.toLowerCase();
  if (/(software|devops|data|engineer)/.test(s)) return "ENG";
  if (/product/.test(s)) return "PM";
  if (/(ux|ui|design)/.test(s)) return "DES";
  if (/(security|cyber)/.test(s)) return "SEC";
  if (/marketing/.test(s)) return "MKT";
  if (/sales/.test(s)) return "SLS";
  if (/(consult)/.test(s)) return "CNS";
  if (/(analyst)/.test(s)) return "BA";
  if (/(entrepreneur|founder)/.test(s)) return "ENT";
  if (/(student)/.test(s)) return "STD";
  return "OTH";
}
function uniqLower(arr: string[]) {
  return [...new Set(arr.map(s => s.trim().toLowerCase()))];
}

export default function DeviceCheck() {
  const [name, setName] = useState("");
  const [localAudioTrack, setLocalAudioTrack] = useState<MediaStreamTrack | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<MediaStreamTrack | null>(null);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoOn, setVideoOn] = useState(true);
  const [audioOn, setAudioOn] = useState(true);

  // Onboarding fields
  const [profession, setProfession] = useState<string>("Software Developer");
  const [experience, setExperience] = useState<string>("2-5");
  const [country, setCountry] = useState<string>("IN");
  const [pickedTags, setPickedTags] = useState<string[]>([]);
  const [prefStrict, setPrefStrict] = useState(false);
  const [prefTarget, setPrefTarget] = useState<"similar"|"mentor"|"mentee"|"any">("any");
  const [prefGeo, setPrefGeo] = useState<"same"|"global">("global");

  const videoRef = useRef<HTMLVideoElement>(null);

  const getCam = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: videoOn,
        audio: audioOn,
      });
      const audioTrack = stream.getAudioTracks()[0] || null;
      const videoTrack = stream.getVideoTracks()[0] || null;
      setLocalAudioTrack(audioTrack);
      setLocalVideoTrack(videoTrack);

      if (videoRef.current) {
        videoRef.current.srcObject = videoTrack ? new MediaStream([videoTrack]) : null;
        if (videoTrack) await videoRef.current.play().catch(() => {});
      }
    } catch (e: any) {
      setError(e?.message || "Could not access camera/microphone");
    }
  };

  useEffect(() => {
    getCam();
    return () => {
      [localAudioTrack, localVideoTrack].forEach((t) => t?.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getCam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoOn, audioOn]);

  function toggleTag(t: string) {
    setPickedTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  }

  // Build Meta from onboarding selections
  function buildMeta(): Meta {
    const expBucket = toExpBucketLabel(experience);
    const industry = mapProfessionToIndustryCode(profession);
    const skills = uniqLower(pickedTags).slice(0, 15);

    // prefs
    let minExpBucket: ExpBucket | undefined = undefined;
    if (prefTarget === "mentor") {
      // want more experienced: at least same bucket as me (or one above)
      minExpBucket = (expBucket === 3 ? 3 : (expBucket + 1)) as ExpBucket;
    } else if (prefTarget === "mentee") {
      minExpBucket = 0; // open to all
    } else if (prefTarget === "similar") {
      minExpBucket = expBucket as ExpBucket;
    }

    const industries = ["similar","mentor","mentee"].includes(prefTarget) ? [industry] : []; // “any” => any industry
    const countries = prefGeo === "same" ? [country.toUpperCase()] : []; // empty => any

    return {
      profile: {
        expBucket,
        industry: industry.toUpperCase(),
        country: country.toUpperCase(),
        skills,
      },
      prefs: {
        strict: prefStrict,
        minExpBucket,
        industries: industries.map(x => x.toUpperCase()),
        countries,
        subdomains: [], // optional
      }
    };
  }

  function handleJoin() {
    const meta = buildMeta();
    // (Optional) Persist for later sessions
    try { localStorage.setItem("devmatch.onboarding", JSON.stringify(meta)); } catch {}
    setJoined(true);
  }

  if (joined) {
    const meta = buildMeta();
    return (
      <Room
        name={name}
        localAudioTrack={localAudioTrack}
        localVideoTrack={localVideoTrack}
        meta={meta} // <- pass to Room
      />
    );
  }

  return (
    <div className="min-h-[calc(100vh-6rem)] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-4xl rounded-2xl border bg-white/60 backdrop-blur shadow-lg p-6 md:p-8 dark:bg-gray-900/70 dark:border-gray-800">
        <h1 className="text-2xl font-semibold mb-1">Device & Onboarding</h1>
        <p className="text-sm text-gray-500 mb-6">
          Preview your camera & mic, set your profile and preferences, then join a match.
        </p>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Video preview */}
          <div>
            <div className="aspect-video w-full overflow-hidden rounded-xl border bg-black">
              <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setVideoOn((v) => !v)}
                className={`px-3 py-2 text-sm rounded-lg border transition ${
                  videoOn ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                          : "bg-white dark:bg-gray-800 text-gray-700 dark:text-white"
                }`}
              >
                {videoOn ? "Turn camera off" : "Turn camera on"}
              </button>
              <button
                type="button"
                onClick={() => setAudioOn((a) => !a)}
                className={`px-3 py-2 text-sm rounded-lg border transition ${
                  audioOn ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                          : "bg-white dark:bg-gray-800 text-gray-700 dark:text-white"
                }`}
              >
                {audioOn ? "Mute mic" : "Unmute mic"}
              </button>
              <button
                type="button"
                onClick={getCam}
                className="px-3 py-2 text-sm rounded-lg border bg-white hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700"
              >
                Re-check
              </button>
            </div>
            {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          </div>

          {/* Join form + Onboarding */}
          <div className="space-y-4">
            {/* Name */}
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Display name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Jayanth"
                className="mt-1 h-11 w-full rounded-lg border px-4 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
              />
            </label>

            {/* Profession */}
            <label className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Primary Profession</span>
              <select
                value={profession}
                onChange={(e) => setProfession(e.target.value)}
                className="mt-1 h-11 w-full rounded-lg border px-3 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
              >
                {PROFESSIONS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>

            {/* Experience + Country */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Experience</span>
                <select
                  value={experience}
                  onChange={(e) => setExperience(e.target.value)}
                  className="mt-1 h-11 w-full rounded-lg border px-3 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
                >
                  {EXPERIENCE.map(e => <option key={e} value={e}>{e} years</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Country</span>
                <select
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="mt-1 h-11 w-full rounded-lg border px-3 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
                >
                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>

            {/* Skills tags */}
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">Skills / Tags</span>
              <div className="flex flex-wrap gap-2">
                {TAGS.map((t) => {
                  const active = pickedTags.includes(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTag(t)}
                      className={`px-3 py-1.5 text-xs rounded-full border transition ${
                        active ? "bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                               : "bg-white dark:bg-gray-800 text-gray-700 dark:text-white"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Preferences */}
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Who to connect with</span>
                <select
                  value={prefTarget}
                  onChange={(e) => setPrefTarget(e.target.value as any)}
                  className="mt-1 h-11 w-full rounded-lg border px-3 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
                >
                  <option value="any">Any experience / role</option>
                  <option value="similar">Similar role & level</option>
                  <option value="mentor">More experienced (mentors)</option>
                  <option value="mentee">Less experienced (to mentor)</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Geography</span>
                <select
                  value={prefGeo}
                  onChange={(e) => setPrefGeo(e.target.value as any)}
                  className="mt-1 h-11 w-full rounded-lg border px-3 text-sm bg-white dark:bg-gray-900 dark:text-white dark:border-gray-800"
                >
                  <option value="global">Global</option>
                  <option value="same">Same country</option>
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={prefStrict}
                onChange={(e) => setPrefStrict(e.target.checked)}
              />
              Strict match only (don’t relax filters)
            </label>

            <button
              type="button"
              onClick={handleJoin}
              disabled={!name}
              className="w-full h-11 rounded-lg bg-gray-900 text-white disabled:opacity-50 dark:bg-white dark:text-gray-900"
            >
              Join match
            </button>

            <p className="text-xs text-gray-500">You can change camera/mic after joining too.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
