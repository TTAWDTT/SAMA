import { setupChat } from "./chat";

const historyEl = document.getElementById("history") as HTMLDivElement | null;
const inputEl = document.getElementById("input") as HTMLInputElement | null;
const sendBtn = document.getElementById("send") as HTMLButtonElement | null;
const hintEl = document.getElementById("hint") as HTMLDivElement | null;
const statusEl = document.getElementById("status") as HTMLDivElement | null;

if (!historyEl || !inputEl || !sendBtn) throw new Error("missing chat elements");

setupChat({ historyEl, inputEl, sendBtn, hintEl: hintEl ?? undefined, statusEl: statusEl ?? undefined });
