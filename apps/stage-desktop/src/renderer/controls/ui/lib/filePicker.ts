export async function pickFileViaFileInput(
  accept: string
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener(
      "change",
      async () => {
        try {
          const file = input.files?.[0];
          if (!file) {
            resolve(null);
            return;
          }
          const buf = await file.arrayBuffer();
          resolve({ bytes: new Uint8Array(buf), fileName: String(file.name ?? "") });
        } catch {
          resolve(null);
        } finally {
          input.remove();
        }
      },
      { once: true }
    );

    input.click();
  });
}

