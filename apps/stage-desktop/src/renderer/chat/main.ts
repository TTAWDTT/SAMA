import { setupQuickSend } from "./quick-send";

const inputEl = document.getElementById("input");
if (!(inputEl instanceof HTMLTextAreaElement)) throw new Error("missing #input");

setupQuickSend({ inputEl });

