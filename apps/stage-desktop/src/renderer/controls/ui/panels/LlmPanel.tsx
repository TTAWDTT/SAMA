import React, { useEffect, useMemo, useState } from "react";
import type { LlmConfig, StageDesktopApi } from "../api";
import { clamp, safeString } from "../lib/utils";

type ReplyStyle = "concise" | "normal" | "talkative";
type Tone = "gentle" | "playful" | "serious";
type Persona = { replyStyle: ReplyStyle; proactivity: number; tone: Tone };

const LS_PERSONA = "sama.ui.persona.v1";

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

export function LlmPanel(props: { api: StageDesktopApi | null; onToast: (msg: string, o?: any) => void }) {
  const { api, onToast } = props;

  const [loading, setLoading] = useState(false);
  const [runtimeProvider, setRuntimeProvider] = useState("unknown");
  const [cfg, setCfg] = useState<LlmConfig>({
    provider: "auto",
    openai: { apiKey: "", model: "", baseUrl: "" },
    deepseek: { apiKey: "", model: "", baseUrl: "" },
    aistudio: { apiKey: "", model: "", baseUrl: "" }
  });
  const [persona, setPersona] = useState<Persona>(loadPersona);

  const provider = safeString(cfg.provider, "auto");

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

