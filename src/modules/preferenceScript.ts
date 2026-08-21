import { testDeepSeekConnection } from "./deepseek";

export async function registerPrefsScripts(prefWindow: Window): Promise<void> {
  addon.data.prefs = {
    window: prefWindow,
    columns: [],
    rows: [],
  };

  const doc = prefWindow.document;
  const testButton = doc.getElementById("inlinetranslate-test-connection");
  const status = doc.getElementById("inlinetranslate-test-status");
  testButton?.addEventListener("click", async () => {
    if (testButton.hasAttribute("disabled")) return;
    testButton.setAttribute("disabled", "true");
    if (status) status.textContent = "正在连接 DeepSeek…";
    try {
      const result = await testDeepSeekConnection();
      if (status) status.textContent = `连接成功：${result}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (status) status.textContent = message;
    } finally {
      testButton.removeAttribute("disabled");
    }
  });
}
