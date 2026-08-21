import { getPref } from "../utils/prefs";

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

function getErrorMessage(error: unknown): string {
  try {
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }
  } catch {
    // Cross-compartment errors can reject property access. String conversion
    // below still gives Zotero's error name and message.
  }
  return String(error);
}

function getEndpoint(): string {
  const base = String(getPref("apiBase") || "https://api.deepseek.com")
    .trim()
    .replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function readResponse(xhr: XMLHttpRequest): DeepSeekResponse {
  return JSON.parse(xhr.responseText || "{}") as DeepSeekResponse;
}

export async function translateWithDeepSeek(text: string): Promise<string> {
  const apiKey = String(getPref("apiKey") || "").trim();
  if (!apiKey) {
    throw new Error(
      "请先在 Zotero 设置 → Inline Translate 中填写 DeepSeek API Key",
    );
  }

  const source = text.trim();
  if (!source) {
    throw new Error("没有可翻译的文字");
  }

  const targetLanguage = String(getPref("targetLanguage") || "简体中文");
  const systemPrompt = String(getPref("systemPrompt") || "").trim();
  const model = String(getPref("model") || "deepseek-v4-flash").trim();
  const body: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "system",
        content: `${systemPrompt}\n目标语言：${targetLanguage}\n保持原文的段落结构。原文有几个段落，译文也必须有相同数量的段落；段落之间只用一个空行分隔，不要合并段落，不要添加编号或说明。`,
      },
      { role: "user", content: source },
    ],
    stream: false,
  };
  // DeepSeek V4 enables thinking by default. Translation is faster and cheaper
  // in non-thinking mode, while third-party OpenAI-compatible APIs should not
  // receive a DeepSeek-specific field.
  if (model.startsWith("deepseek-v4-")) {
    body.thinking = { type: "disabled" };
  }

  let xhr: XMLHttpRequest;
  try {
    const options = {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Keep the response as text. A JSON response object belongs to Zotero's
      // privileged window and Firefox 140 rejects passing it into the plugin
      // sandbox ("Permission denied to pass object to privileged code").
      responseType: "text",
      timeout: 60_000,
    };
    // The callback starts in Zotero Reader's content window. Clone nested
    // request data into Zotero's privileged main-window compartment before
    // invoking Zotero.HTTP.request; Firefox 140 otherwise rejects the options
    // object with "Permission denied to pass object to privileged code".
    const mainWindow = Zotero.getMainWindow();
    // Parse inside the target window so the resulting object is owned by the
    // same privileged realm as Zotero.HTTP. Only a JSON string crosses the
    // boundary, which Firefox permits.
    const privilegedOptions = mainWindow.JSON.parse(JSON.stringify(options));
    xhr = await Zotero.HTTP.request("POST", getEndpoint(), privilegedOptions);
  } catch (error) {
    throw new Error(`DeepSeek 网络请求失败：${getErrorMessage(error)}`);
  }

  const data = readResponse(xhr);
  if (data.error?.message) {
    throw new Error(`DeepSeek 返回错误：${data.error.message}`);
  }
  const translation = data.choices?.[0]?.message?.content?.trim();
  if (!translation) {
    throw new Error("DeepSeek 没有返回译文");
  }
  return translation;
}

export async function testDeepSeekConnection(): Promise<string> {
  return translateWithDeepSeek(
    "Translate this sentence: Academic reading is important.",
  );
}
