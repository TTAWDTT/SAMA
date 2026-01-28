import { setupChat } from "./chat";

const historyEl = document.getElementById("history") as HTMLDivElement | null;
const inputEl = document.getElementById("input") as HTMLInputElement | null;
const sendBtn = document.getElementById("send") as HTMLButtonElement | null;

if (!historyEl || !inputEl || !sendBtn) throw new Error("missing chat elements");

setupChat({ historyEl, inputEl, sendBtn });

