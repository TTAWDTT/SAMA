import React, { useEffect, useMemo, useState } from "react";
import type { LlmConfig, StageDesktopApi } from "../api";
import { clamp, safeString } from "../lib/utils";

type ReplyStyle = "concise" | "normal" | "talkative";
type Tone = "gentle" | "playful" | "serious";
type Persona = { replyStyle: ReplyStyle; proactivity: number; tone: Tone };

const LS_PERSONA = "sama.ui.persona.v1";

function isZhVoice(v: SpeechSynthesisVoice) {
  const lang = String(v?.lang ?? "").toLowerCase();
  return lang.startsWith("zh") || lang.includes("cmn");
}

function pickRecommendedVoice(voices: SpeechSynthesisVoice[]) {
  const list = Array.isArray(voices) ? voices : [];
  if (!list.length) return null;

  const femaleHints = ["xiaoxiao", "huihui", "xiaoyi", "yaoyao", "meimei", "yating", "jiajia", "xiaohan"];
  const score = (v: SpeechSynthesisVoice) => {
    const name = String(v?.name ?? "").toLowerCase();
    const lang = String(v?.lang ?? "").toLowerCase();
    let s = 0;
    if (lang.startsWith("zh")) s += 120;
    if (lang.includes("zh-cn") || lang.includes("cmn")) s += 20;
    if (name.includes("natural") || name.includes("online")) s += 18;
    if (femaleHints.some((h) => name.includes(h))) s += 26;
    if (name.includes("female") || name.includes("girl")) s += 10;
    if (name.includes("male") || name.includes("man")) s -= 18;
    if (v.default) s += 2;
    return s;
  };

  return [...list].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function loadPersona(): Persona {
  try {
    const raw = localStorage.getItem(LS_PERSONA);
    const p = raw ? (JSON.parse(raw) as any) : null;
    const replyStyle: ReplyStyle =
      p?.replyStyle === "concise" || p?.replyStyle === "talkative" ? p.replyStyle : "normal";
    const tone: Tone = p?.tone === "playful" || p?.tone === "serious" ? p.tone : "gentle";
    const proactivity = clamp(Number(p?.proactivity ?? 0.45), 0, 1);
    return { replyStyle, tone, proactivity };
  } catch {
    return { replyStyle: "normal", proactivity: 0.45, tone: "gentle" };
  }
}

function savePersona(p: Persona) {
  try {
    localStorage.setItem(LS_PERSONA, JSON.stringify(p));
  } catch {
    // ignore
  }
}

export function LlmPanel(props: {
  api: StageDesktopApi | null;
  onToast: (msg: string, o?: any) => void;
  onConfigSaved?: () => void;
}) {
  const { api, onToast, onConfigSaved } = props;

  const [loading, setLoading] = useState(false);
  const [runtimeProvider, setRuntimeProvider] = useState("unknown");
  const [skillsDir, setSkillsDir] = useState("");
  const [availableSkills, setAvailableSkills] = useState<string[]>([]);
  const [cfg, setCfg] = useState<LlmConfig>({
    provider: "auto",
    openai: { apiKey: "", model: "", baseUrl: "" },
    deepseek: { apiKey: "", model: "", baseUrl: "" },
    aistudio: { apiKey: "", model: "", baseUrl: "" },
    webSearch: { enabled: false, tavilyApiKey: "", maxResults: 6 },
    tts: { autoPlay: false, voice: "", rate: 1.08, pitch: 1.12, volume: 1 },
    skills: { dir: "", enabled: [] }
  });
  const [persona, setPersona] = useState<Persona>(loadPersona);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  const provider = safeString(cfg.provider, "auto");
  const recommendedVoice = useMemo(() => pickRecommendedVoice(voices), [voices]);
  const zhVoices = useMemo(() => voices.filter(isZhVoice), [voices]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return;
    const synth = window.speechSynthesis;

    const refresh = () => {
      try {
        const v = synth.getVoices();
        setVoices(Array.isArray(v) ? v : []);
      } catch {
        setVoices([]);
      }
    };

    refresh();
    const prev = (synth as any).onvoiceschanged;
    try {
      (synth as any).onvoiceschanged = () => refresh();
    } catch {}

    return () => {
      try {
        (synth as any).onvoiceschanged = prev ?? null;
      } catch {}
    };
  }, []);

  const help = useMemo(() => {
    if (provider === "off") return "已禁用：不会调用 LLM。";
    if (provider === "openai") return "OpenAI：只展示 OpenAI 配置。";
    if (provider === "deepseek") return "DeepSeek：只展示 DeepSeek 配置。";
    if (provider === "aistudio") return "AIStudio/Gemini：只展示 Gemini 配置。";
    return "auto：你可以填写任意一个 Key；系统会自动选择可用的。";
  }, [provider]);

  async function refreshRuntime() {
    if (!api || typeof api.getAppInfo !== "function") {
      setRuntimeProvider("preload missing");
      return;
    }
    try {
      const info = await api.getAppInfo();
      setRuntimeProvider(safeString(info?.llmProvider, "unknown"));
    } catch {
      setRuntimeProvider("unknown");
    }
  }

  async function loadConfig() {
    if (!api || typeof api.getLlmConfig !== "function") {
      onToast("preload API 缺失：无法读取 LLM 配置", { timeoutMs: 4200 });
      return;
    }
    setLoading(true);
    try {
      const res = await api.getLlmConfig();
      const stored = (res?.stored ?? null) || {};
      setSkillsDir(safeString((res as any)?.skillsDir));
      setAvailableSkills(Array.isArray((res as any)?.availableSkills) ? ((res as any).availableSkills as any[]).map((s) => safeString(s)).filter(Boolean) : []);

      setCfg({
        provider: safeString((stored as any).provider, "auto"),
        openai: {
          apiKey: safeString((stored as any).openai?.apiKey),
          model: safeString((stored as any).openai?.model),
          baseUrl: safeString((stored as any).openai?.baseUrl)
        },
        deepseek: {
          apiKey: safeString((stored as any).deepseek?.apiKey),
          model: safeString((stored as any).deepseek?.model),
          baseUrl: safeString((stored as any).deepseek?.baseUrl)
        },
        aistudio: {
          apiKey: safeString((stored as any).aistudio?.apiKey),
          model: safeString((stored as any).aistudio?.model),
          baseUrl: safeString((stored as any).aistudio?.baseUrl)
        },
        webSearch: {
          enabled: Boolean((stored as any).webSearch?.enabled ?? false),
          tavilyApiKey: safeString((stored as any).webSearch?.tavilyApiKey),
          maxResults: clamp(Number((stored as any).webSearch?.maxResults ?? 6), 1, 10)
        },
        tts: {
          autoPlay: Boolean((stored as any).tts?.autoPlay ?? false),
          voice: safeString((stored as any).tts?.voice),
          rate: clamp(Number((stored as any).tts?.rate ?? 1.08), 0.7, 1.35),
          pitch: clamp(Number((stored as any).tts?.pitch ?? 1.12), 0.8, 1.5),
          volume: clamp(Number((stored as any).tts?.volume ?? 1), 0, 1)
        },
        skills: {
          dir: safeString((stored as any).skills?.dir),
          enabled: Array.isArray((stored as any).skills?.enabled)
            ? ((stored as any).skills.enabled as any[]).map((x) => safeString(x)).filter(Boolean)
            : []
        }
      });

      onToast("已读取配置", { timeoutMs: 1200 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`读取失败：${msg}`, { timeoutMs: 5200 });
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    if (!api || typeof api.setLlmConfig !== "function") {
      onToast("preload API 缺失：无法保存 LLM 配置", { timeoutMs: 4200 });
      return;
    }

    setLoading(true);
    try {
      const res = await api.setLlmConfig(cfg as any);
      if (!res?.ok) {
        onToast(`保存失败：${safeString(res?.message, "unknown")}`, { timeoutMs: 5200 });
        return;
      }
      savePersona(persona);
      await refreshRuntime();
      onToast("已保存（无需重启）", { timeoutMs: 1600 });
      onConfigSaved?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast(`保存失败：${msg}`, { timeoutMs: 5200 });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshRuntime();
    void loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function renderProviderFields(p: "openai" | "deepseek" | "aistudio") {
    const keyVal = p === "openai" ? cfg.openai?.apiKey : p === "deepseek" ? cfg.deepseek?.apiKey : cfg.aistudio?.apiKey;
    const setKey = (v: string) =>
      setCfg((c) => ({
        ...c,
        [p]: { ...(c as any)[p], apiKey: v }
      }));

    const modelVal = p === "openai" ? cfg.openai?.model : p === "deepseek" ? cfg.deepseek?.model : cfg.aistudio?.model;
    const setModel = (v: string) =>
      setCfg((c) => ({
        ...c,
        [p]: { ...(c as any)[p], model: v }
      }));

    const baseVal =
      p === "openai" ? cfg.openai?.baseUrl : p === "deepseek" ? cfg.deepseek?.baseUrl : cfg.aistudio?.baseUrl;
    const setBaseUrl = (v: string) =>
      setCfg((c) => ({
        ...c,
        [p]: { ...(c as any)[p], baseUrl: v }
      }));

    const label = p === "openai" ? "OpenAI" : p === "deepseek" ? "DeepSeek" : "AIStudio / Gemini";

    return (
      <div className="panelGroup" key={p}>
        <div className="panelGroupTitle">{label}</div>
        <div className="field">
          <div className="label">API Key</div>
          <input
            className="input"
            type="password"
            autoComplete="off"
            aria-label={`${label} API Key`}
            placeholder={p === "openai" ? "sk-..." : "..."}
            value={safeString(keyVal)}
            onChange={(e) => setKey(e.target.value)}
          />
          <div className="help">Key 会保存到本地配置（请勿在直播/截图时泄露）。</div>
        </div>

        <details className="subDetails">
          <summary>Advanced（模型 / Base URL）</summary>
          <div className="subDetailsBody">
            <div className="field">
              <div className="label">Model（可选）</div>
              <input className="input" type="text" value={safeString(modelVal)} onChange={(e) => setModel(e.target.value)} />
            </div>
            <div className="field">
              <div className="label">Base URL（可选）</div>
              <input
                className="input"
                type="text"
                value={safeString(baseVal)}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={p === "openai" ? "https://api.openai.com/v1" : ""}
              />
            </div>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <div className="panelTitle">LLM</div>
          <div className="panelSub">配置 Provider + 轻量人格偏好（不绑死模型参数）。</div>
        </div>
        <div className="panelMeta">运行：{runtimeProvider}</div>
      </div>

      <div className="card">
        <div className="field">
          <div className="label">Provider</div>
          <select
            className="select"
            value={provider}
            onChange={(e) => setCfg((c) => ({ ...c, provider: e.target.value }))}
            disabled={loading}
          >
            <option value="openai">openai</option>
            <option value="deepseek">deepseek</option>
            <option value="aistudio">aistudio</option>
            <option value="auto">auto</option>
            <option value="off">off</option>
          </select>
          <div className="help">{help}</div>
        </div>

        <div className="divider" />

        <div className="field">
          <div className="label">Web Search（联网搜索）</div>
          <label className="switchRow" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={Boolean((cfg as any).webSearch?.enabled)}
              onChange={(e) => {
                const v = Boolean(e.target.checked);
                setCfg((c) => ({ ...c, webSearch: { ...(c as any).webSearch, enabled: v } }));
              }}
              disabled={loading}
            />
            <span className="switchLabel">启用 Web Search（/search 与 /web）</span>
          </label>
          <div className="help">实现方式：Tavily；用于让 SAMA 能“搜一下再回答”。</div>

          <div className="divider" />

          <div className="field">
            <div className="label">Tavily API Key</div>
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="tvly-..."
              value={safeString((cfg as any).webSearch?.tavilyApiKey)}
              onChange={(e) => setCfg((c) => ({ ...c, webSearch: { ...(c as any).webSearch, tavilyApiKey: e.target.value } }))}
              disabled={loading}
            />
            <div className="help">会保存到本地配置（请勿泄露）。也可用环境变量 `TAVILY_API_KEY`。</div>
          </div>

          <div className="field">
            <div className="label">Max results</div>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={Number((cfg as any).webSearch?.maxResults ?? 6)}
              onChange={(e) =>
                setCfg((c) => ({
                  ...c,
                  webSearch: { ...(c as any).webSearch, maxResults: clamp(Number(e.target.value || 6), 1, 10) }
                }))
              }
              disabled={loading}
            />
          </div>
        </div>

        <div className="divider" />

        <div className="field">
          <div className="label">Skills（本地）</div>
          <div className="help">从 `{skillsDir || "~/.claude/skills"}` 读取。勾选后会注入 system prompt（影响后续对话）。</div>

          <div className="btnRow" style={{ marginTop: 8 }}>
            <button className="btn btnSm" type="button" onClick={() => void loadConfig()} disabled={loading}>
              刷新列表
            </button>
            <button
              className="btn btnSm"
              type="button"
              onClick={() => setCfg((c) => ({ ...c, skills: { ...(c as any).skills, enabled: [] } }))}
              disabled={loading}
            >
              全部取消
            </button>
          </div>

          {availableSkills.length ? (
            <div className="memList" style={{ marginTop: 10, maxHeight: 260, overflow: "auto" }}>
              {availableSkills.map((name) => {
                const enabled = new Set(Array.isArray((cfg as any).skills?.enabled) ? (cfg as any).skills.enabled : []);
                const checked = enabled.has(name);
                return (
                  <label key={name} className="switchRow" style={{ padding: "8px 10px" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const next = Boolean(e.target.checked);
                        setCfg((c) => {
                          const cur = new Set(Array.isArray((c as any).skills?.enabled) ? (c as any).skills.enabled : []);
                          if (next) cur.add(name);
                          else cur.delete(name);
                          return { ...c, skills: { ...(c as any).skills, enabled: Array.from(cur) } };
                        });
                      }}
                      disabled={loading}
                    />
                    <span className="switchLabel">{name}</span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="help" style={{ marginTop: 8 }}>
              未发现任何 skill（需要每个子目录下有 `SKILL.md`）。
            </div>
          )}
        </div>

        <div className="divider" />

        <div className="field">
          <div className="label">Voice（朗读）</div>
          <label className="switchRow" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={Boolean((cfg as any).tts?.autoPlay)}
              onChange={(e) => {
                const v = Boolean(e.target.checked);
                setCfg((c) => ({ ...c, tts: { ...(c as any).tts, autoPlay: v } }));
              }}
              disabled={loading}
            />
            <span className="switchLabel">自动朗读 SAMA 的回复（只读第一段）</span>
          </label>

          <div className="help">每条消息也可以点“朗读”按钮手动播放。</div>

          <div className="divider" />

          <div className="field">
            <div className="label">Voice</div>
            <select
              className="select"
              value={safeString((cfg as any).tts?.voice)}
              onChange={(e) => setCfg((c) => ({ ...c, tts: { ...(c as any).tts, voice: e.target.value } }))}
              disabled={loading}
            >
              <option value="">
                自动（推荐：{recommendedVoice?.name ? `${recommendedVoice.name} / ${recommendedVoice.lang}` : "系统默认"}）
              </option>
              {zhVoices.map((v) => (
                <option key={`${v.name}|${v.lang}`} value={v.name}>
                  {v.name} / {v.lang}
                </option>
              ))}
              {voices.length > zhVoices.length ? (
                <optgroup label="Other">
                  {voices
                    .filter((v) => !isZhVoice(v))
                    .map((v) => (
                      <option key={`${v.name}|${v.lang}`} value={v.name}>
                        {v.name} / {v.lang}
                      </option>
                    ))}
                </optgroup>
              ) : null}
            </select>
            <div className="help">可爱少女感：建议选中文女声（如 Xiaoxiao / Huihui）。</div>
          </div>

          <div className="field">
            <div className="label">Rate</div>
            <input
              className="range"
              type="range"
              min={0.7}
              max={1.35}
              step={0.01}
              value={Number((cfg as any).tts?.rate ?? 1.08)}
              onChange={(e) => setCfg((c) => ({ ...c, tts: { ...(c as any).tts, rate: clamp(Number(e.target.value), 0.7, 1.35) } }))}
              disabled={loading}
            />
            <div className="help">{Number((cfg as any).tts?.rate ?? 1.08).toFixed(2)}</div>
          </div>

          <div className="field">
            <div className="label">Pitch</div>
            <input
              className="range"
              type="range"
              min={0.8}
              max={1.5}
              step={0.01}
              value={Number((cfg as any).tts?.pitch ?? 1.12)}
              onChange={(e) => setCfg((c) => ({ ...c, tts: { ...(c as any).tts, pitch: clamp(Number(e.target.value), 0.8, 1.5) } }))}
              disabled={loading}
            />
            <div className="help">{Number((cfg as any).tts?.pitch ?? 1.12).toFixed(2)}</div>
          </div>

          <div className="field">
            <div className="label">Volume</div>
            <input
              className="range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={Number((cfg as any).tts?.volume ?? 1)}
              onChange={(e) => setCfg((c) => ({ ...c, tts: { ...(c as any).tts, volume: clamp(Number(e.target.value), 0, 1) } }))}
              disabled={loading}
            />
            <div className="help">{Number((cfg as any).tts?.volume ?? 1).toFixed(2)}</div>
          </div>

          <div className="btnRow">
            <button
              className="btn btnSm"
              type="button"
              onClick={() => {
                if (!api?.sendPetControl) {
                  onToast("preload API 缺失：无法朗读", { timeoutMs: 2400 });
                  return;
                }
                api.sendPetControl({
                  type: "PET_CONTROL",
                  ts: Date.now(),
                  action: "SPEAK_TEXT",
                  text: "你好呀，我是 SAMA～",
                  options: {
                    voice: safeString((cfg as any).tts?.voice),
                    rate: Number((cfg as any).tts?.rate ?? 1.08),
                    pitch: Number((cfg as any).tts?.pitch ?? 1.12),
                    volume: Number((cfg as any).tts?.volume ?? 1)
                  }
                } as any);
              }}
              disabled={loading}
            >
              试听
            </button>
            <button
              className="btn btnSm"
              type="button"
              onClick={() => {
                api?.sendPetControl?.({ type: "PET_CONTROL", ts: Date.now(), action: "SPEAK_STOP" } as any);
              }}
              disabled={loading}
            >
              停止
            </button>
          </div>
        </div>

        <div className="divider" />

        <div className="segRow">
          <div className="segLabel">Reply style</div>
          <div className="seg">
            {(["concise", "normal", "talkative"] as ReplyStyle[]).map((v) => (
              <button
                key={v}
                className={`segBtn ${persona.replyStyle === v ? "isActive" : ""}`}
                type="button"
                onClick={() => setPersona((p) => ({ ...p, replyStyle: v }))}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="segRow">
          <div className="segLabel">Tone</div>
          <div className="seg">
            {(["gentle", "playful", "serious"] as Tone[]).map((v) => (
              <button
                key={v}
                className={`segBtn ${persona.tone === v ? "isActive" : ""}`}
                type="button"
                onClick={() => setPersona((p) => ({ ...p, tone: v }))}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <div className="label">Proactivity</div>
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={persona.proactivity}
            onChange={(e) => setPersona((p) => ({ ...p, proactivity: clamp(Number(e.target.value), 0, 1) }))}
          />
          <div className="help">quiet ←→ clingy · {persona.proactivity.toFixed(2)}</div>
        </div>

        <div className="btnRow">
          <button className="btn" type="button" onClick={() => void loadConfig()} disabled={loading}>
            重新读取
          </button>
          <button className="btn btnPrimary" type="button" onClick={() => void saveConfig()} disabled={loading}>
            保存
          </button>
        </div>

        <div className="help">提示：保存后立即生效（无需重启）。人格偏好会存到本地 UI。</div>
      </div>

      {provider === "off" ? null : provider === "auto" ? (
        <>
          {renderProviderFields("openai")}
          {renderProviderFields("deepseek")}
          {renderProviderFields("aistudio")}
        </>
      ) : provider === "openai" ? (
        renderProviderFields("openai")
      ) : provider === "deepseek" ? (
        renderProviderFields("deepseek")
      ) : (
        renderProviderFields("aistudio")
      )}
    </div>
  );
}
