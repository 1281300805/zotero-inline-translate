import { getPref } from "../utils/prefs";
import { mapSourceRangeToTarget } from "./annotationMapping";
import { translateWithDeepSeek } from "./deepseek";
import {
  OverlayStore,
  PdfRect,
  TranslationOverlay,
  TranslationRegion,
  TranslationSourceStyle,
} from "./overlayStore";

type ReaderInstance = any;
type PdfWindow = Window & {
  PDFViewerApplication?: any;
};

interface ReaderState {
  reader: ReaderInstance;
  readerCandidates?: Set<ReaderInstance>;
  attachmentKey: string;
  pdfWindow: PdfWindow;
  eventBus: any;
  visible: boolean;
  redrawTimer?: ReturnType<typeof setTimeout>;
  annotationSyncTimer?: ReturnType<typeof setTimeout>;
  annotationBridgeRetryTimer?: ReturnType<typeof setTimeout>;
  annotationBridgeEventsAttached?: boolean;
  annotationObserver?: MutationObserver;
  annotationShadowRoot?: ShadowRoot;
  annotationRenderRoot?: HTMLElement;
  annotationProxyRoot?: HTMLElement;
  viewerContainer?: HTMLElement;
  lastPopupPositionKey?: string;
  proxySelectedAnnotationID?: string;
  sourceSelectedAnnotationID?: string;
  drawSourceSelectionProxy?: boolean;
  annotationPopupFirstFrame?: number;
  annotationPopupSecondFrame?: number;
  annotationPopupFallbackTimer?: ReturnType<typeof setTimeout>;
  nativeHiddenAnnotations?: Map<string, any>;
  nativeAnnotationSuppressedUntil?: number;
  annotationDiagnostic?: Record<string, any>;
  annotationSyncRuns?: number;
  annotationLastSyncError?: string;
  annotationLastSyncMatchCount?: number;
  annotationLastSyncProxyCount?: number;
  leftPointerStart?: { x: number; y: number };
  leftPointerDragged?: boolean;
  pageTextStyleCache?: Map<number, PageTextStyleCache>;
  pageTextStyleLoads?: Map<number, Promise<void>>;
  onPageRendered: (event: { pageNumber?: number }) => void;
  onViewChanged: () => void;
  onViewerScroll: () => void;
  onNativeAnnotationEvent: (event: Event) => void;
  onOverlayClick: (event: Event) => void;
  onOverlayContextMenu: (event: Event) => void;
}

interface CapturedSelection {
  text: string;
  pageIndex: number;
  rects: PdfRect[];
  nextPageRects: PdfRect[];
}

const STYLE_ID = "rpt-inline-translate-style";
const LEGACY_SEMANTIC_BREAK_MARKER = "[[[BR]]]";
const OVERLAY_CLASS = "rpt-translation-overlay";
const OVERLAY_NODE_CLASS = "rpt-translation-node";
const OVERLAY_TEXT_CLASS = "rpt-translation-text";
const OVERLAY_ITALIC_TEXT_CLASS = "rpt-translation-text-italic";
const PENDING_SELECTION_CLASS = "rpt-pending-selection";
const ANNOTATION_PROXY_ROOT_ID = "rpt-annotation-proxy-root";
const ANNOTATION_PROXY_CLASS = "rpt-annotation-proxy";
const ANNOTATION_SELECTION_CLASS = "rpt-annotation-selection";
const TRANSLATION_HIT_TARGET_CLASS = "rpt-translation-hit-target";
const NATIVE_PAINT_MASK_CLASS = "rpt-native-annotation-paint-mask";
const ANNOTATION_SHADOW_STYLE_ID = "rpt-annotation-shadow-style";
const NATIVE_ANNOTATION_HIDDEN_CLASS = "rpt-native-annotation-hidden";
const NATIVE_SELECTION_HIDDEN_CLASS = "rpt-native-selection-hidden";
const NATIVE_INTERACTION_DISABLED_CLASS =
  "rpt-native-annotation-interaction-disabled";
const GLOBAL_MANAGER_KEY = "__inlineTranslateReaderOverlayManager";
const ANNOTATION_DIAGNOSTIC_PATH = PathUtils.join(
  PathUtils.tempDir,
  "inline-translate-annotation-debug.json",
);
const FONT_DIAGNOSTIC_PATH = PathUtils.join(
  PathUtils.tempDir,
  "inline-translate-font-debug.json",
);

interface AnnotationOverlayMatch {
  annotation: any;
  overlay: TranslationOverlay;
  targetStart: number;
  targetEnd: number;
}

interface ClientBounds {
  pageIndex: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ParagraphLayout {
  lineTexts: string[];
  paragraphStarts: boolean[];
}

type FontCategory = "serif" | "sans" | "mono";

interface SourceLineStyle extends TranslationSourceStyle {
  metadataReliable?: boolean;
}

interface PdfFontHints {
  name: string;
  bold: boolean;
  italic: boolean;
  category?: FontCategory;
  identifiers: string[];
}

interface PageTextStyleItem {
  text: string;
  fontName: string;
  fontFamily: string;
}

interface PageTextStyleCache {
  items: PageTextStyleItem[];
}

interface TranslationLineMetric {
  rect: { left: number; top: number; right: number; bottom: number };
  bleedX: number;
  bleedY: number;
  width: number;
  height: number;
  fontSize: number;
  minimumFontSize: number;
  capacity: number;
  sourceStyle: SourceLineStyle;
}

function copyRects(rects: unknown): PdfRect[] {
  if (!Array.isArray(rects)) return [];
  // `rects` originates in the reader iframe. Calling its own filter/map
  // methods creates another Array in that foreign compartment. Read only
  // primitive coordinates and rebuild both Array levels locally instead.
  const copied: PdfRect[] = [];
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (!Array.isArray(rect) || rect.length !== 4) continue;
    const x1 = rect[0];
    const y1 = rect[1];
    const x2 = rect[2];
    const y2 = rect[3];
    if (
      typeof x1 !== "number" ||
      typeof y1 !== "number" ||
      typeof x2 !== "number" ||
      typeof y2 !== "number"
    ) {
      continue;
    }
    copied.push([x1, y1, x2, y2]);
  }
  return copied;
}

function makeID(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function characterWidthUnits(character: string): number {
  if (/\s/u.test(character)) return 0.34;
  if (/[A-Za-z0-9]/u.test(character)) return 0.56;
  if (/^[\x20-\x7E]$/u.test(character)) return 0.5;
  return 1;
}

function isAsciiWordCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_./:%-]/u.test(character));
}

function rectIntersectionArea(a: PdfRect, b: PdfRect): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return width * height;
}

function normalizeText(text: unknown): string {
  return String(text || "")
    .split(LEGACY_SEMANTIC_BREAK_MARKER)
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

function colorWithAlpha(color: unknown, alpha: number): string {
  const value = String(color || "#ffd400").trim();
  const short = /^#([0-9a-f]{3})$/iu.exec(value);
  const full = /^#([0-9a-f]{6})$/iu.exec(value);
  const hex = full?.[1] || (short ? short[1].replace(/(.)/gu, "$1$1") : "");
  if (!hex) return `rgba(255, 212, 0, ${alpha})`;
  return `rgba(${Number.parseInt(hex.slice(0, 2), 16)}, ${Number.parseInt(
    hex.slice(2, 4),
    16,
  )}, ${Number.parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
}

function getAttachmentKey(reader: ReaderInstance): string | undefined {
  const item = Zotero.Items.get(reader.itemID);
  return item?.key;
}

function getErrorMessage(error: unknown): string {
  try {
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }
  } catch {
    // Fall through for protected cross-compartment error objects.
  }
  return String(error);
}

export class ReaderOverlayManager {
  private readonly store = new OverlayStore();
  private readonly states = new Set<ReaderState>();
  private readonly stateByReader = new WeakMap<object, ReaderState>();
  private readonly stateByPdfWindow = new WeakMap<object, ReaderState>();
  private readonly pendingStateByReader = new WeakMap<
    object,
    Promise<ReaderState | undefined>
  >();
  private readonly pendingRegionsByAttachment = new Map<
    string,
    TranslationRegion[]
  >();
  private selectionHandler?: (event: any) => void;
  private toolbarHandler?: (event: any) => void;
  private readonly annotationDiagnostics: Record<string, any>[] = [];
  private readonly fontDiagnostics: Record<string, any>[] = [];
  private readonly fontDiagnosticKeys = new Set<string>();
  private readonly pdfFontHintsCache = new Map<string, PdfFontHints>();
  private fontDiagnosticTimer?: ReturnType<typeof setTimeout>;

  private recordAnnotationDiagnostic(entry: Record<string, any>): void {
    this.annotationDiagnostics.push(entry);
    if (this.annotationDiagnostics.length > 12) {
      this.annotationDiagnostics.splice(
        0,
        this.annotationDiagnostics.length - 12,
      );
    }
    void Zotero.File.putContentsAsync(
      ANNOTATION_DIAGNOSTIC_PATH,
      JSON.stringify(this.annotationDiagnostics, null, 2),
    ).catch(() => undefined);
  }

  private recordFontDiagnostic(entry: Record<string, any>): void {
    const key = JSON.stringify([
      entry.pageNumber,
      entry.text,
      entry.computedFamily,
      entry.inlineFamily,
      entry.textContentFontName,
      entry.pdfHints?.name,
      entry.pdfHints?.bold,
      entry.pdfHints?.italic,
      entry.detectedCategory,
      entry.detectedWeight,
      entry.detectedItalic,
    ]);
    if (this.fontDiagnosticKeys.has(key)) return;
    this.fontDiagnosticKeys.add(key);
    this.fontDiagnostics.push(entry);
    if (this.fontDiagnostics.length > 40) {
      const removed = this.fontDiagnostics.shift();
      if (removed) {
        this.fontDiagnosticKeys.delete(
          JSON.stringify([
            removed.pageNumber,
            removed.text,
            removed.computedFamily,
            removed.inlineFamily,
            removed.textContentFontName,
            removed.pdfHints?.name,
            removed.pdfHints?.bold,
            removed.pdfHints?.italic,
            removed.detectedCategory,
            removed.detectedWeight,
            removed.detectedItalic,
          ]),
        );
      }
    }
    clearTimeout(this.fontDiagnosticTimer);
    this.fontDiagnosticTimer = setTimeout(() => {
      void Zotero.File.putContentsAsync(
        FONT_DIAGNOSTIC_PATH,
        JSON.stringify(this.fontDiagnostics, null, 2),
      ).catch(() => undefined);
    }, 80);
  }

  async startup(): Promise<void> {
    await this.store.load();
    this.recordAnnotationDiagnostic({
      event: "startup",
      version: "0.4.40",
      time: new Date().toISOString(),
    });

    // Zotero 9's unregisterEventListener currently leaves matching listeners
    // behind during a live add-on update. Remove every older listener for this
    // add-on directly before registering the current instance, otherwise both
    // versions append buttons and redraw overlays with different algorithms.
    const readerAPI = Zotero.Reader as any;
    if (Array.isArray(readerAPI._registeredListeners)) {
      readerAPI._registeredListeners = readerAPI._registeredListeners.filter(
        (listener: any) => listener.pluginID !== addon.data.config.addonID,
      );
    }
    const mainWindow = Zotero.getMainWindow() as any;
    const previousManager = mainWindow[GLOBAL_MANAGER_KEY];
    if (previousManager && previousManager !== this) {
      try {
        previousManager.shutdown?.();
      } catch (error) {
        Zotero.debug(
          `[Inline Translate] Unable to stop previous manager: ${getErrorMessage(error)}`,
        );
      }
    }
    mainWindow[GLOBAL_MANAGER_KEY] = this;

    this.selectionHandler = (event) => this.renderSelectionAction(event);
    this.toolbarHandler = (event) => this.renderToolbarAction(event);

    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this.selectionHandler,
      addon.data.config.addonID,
    );
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this.toolbarHandler,
      addon.data.config.addonID,
    );

    // A restored reader can finish rendering before the plugin registers the
    // toolbar callback. Attach to already-open readers as well.
    const existingReaders = (Zotero.Reader as any)._readers;
    if (Array.isArray(existingReaders)) {
      for (const reader of existingReaders) void this.attachReader(reader);
    }
  }

  shutdown(): void {
    clearTimeout(this.fontDiagnosticTimer);
    if (this.selectionHandler) {
      Zotero.Reader.unregisterEventListener(
        "renderTextSelectionPopup",
        this.selectionHandler,
      );
    }
    if (this.toolbarHandler) {
      Zotero.Reader.unregisterEventListener(
        "renderToolbar",
        this.toolbarHandler,
      );
    }

    for (const state of [...this.states]) {
      if (this.isStateAlive(state)) {
        this.removeNodes(
          state.pdfWindow.document,
          `.${OVERLAY_CLASS}, .${OVERLAY_NODE_CLASS}, .${PENDING_SELECTION_CLASS}, .${NATIVE_PAINT_MASK_CLASS}, #${ANNOTATION_PROXY_ROOT_ID}`,
        );
        this.restoreNativeAnnotationVisuals(state);
      }
      this.detachState(state);
    }
    this.states.clear();
    try {
      const mainWindow = Zotero.getMainWindow() as any;
      if (mainWindow[GLOBAL_MANAGER_KEY] === this) {
        delete mainWindow[GLOBAL_MANAGER_KEY];
      }
    } catch {
      // Zotero may already be shutting down its main window.
    }
  }

  private renderSelectionAction({ reader, doc, params, append }: any): void {
    if (!getPref("enabled")) return;

    const text = String(params?.annotation?.text || "").trim();
    const position = params?.annotation?.position;
    const rects = copyRects(position?.rects);
    if (!text || !rects.length || !Number.isInteger(position?.pageIndex)) {
      return;
    }

    // Copy selection data synchronously. Zotero disposes the popup after a click.
    const selection: CapturedSelection = {
      text,
      pageIndex: Number(position.pageIndex),
      rects,
      nextPageRects: copyRects(position.nextPageRects),
    };
    const attachmentKey = getAttachmentKey(reader);
    const existingPending = attachmentKey
      ? this.pendingRegionsByAttachment.get(attachmentKey)
      : undefined;

    // Once multi-region mode has started, every subsequent normal mouse
    // selection is retained automatically. The user can therefore release the
    // mouse and select another column/page without Ctrl or Shift.
    if (attachmentKey && existingPending?.length) {
      this.addPendingSelection(attachmentKey, selection);
      void this.attachReader(reader).then((state) => {
        if (state) this.scheduleRender(state);
      });
      this.renderPendingSelectionActions({
        reader,
        doc,
        append,
        attachmentKey,
      });
      return;
    }

    const button = doc.createElement("button");
    button.className = "toolbar-button wide-button";
    button.dataset.tabstop = "1";
    button.textContent = "翻译并替换（DeepSeek）";
    button.title = "使用 DeepSeek 翻译，并在原文位置显示中文";
    button.addEventListener("click", async (domEvent: Event) => {
      domEvent.preventDefault();
      domEvent.stopPropagation();
      button.setAttribute("disabled", "true");
      button.textContent = "正在翻译…";
      // Capture everything tied to the live reader before the asynchronous
      // request. Zotero may destroy the selection popup while DeepSeek runs.
      const attachmentKey = getAttachmentKey(reader);
      const overlayRegions: TranslationRegion[] = [
        {
          pageIndex: selection.pageIndex,
          rects: selection.rects,
          original: selection.text,
        },
      ];
      if (selection.nextPageRects.length) {
        overlayRegions.push({
          pageIndex: selection.pageIndex + 1,
          rects: selection.nextPageRects,
          original: "",
        });
      }
      const structuredSource = this.structureSourceParagraphs(
        selection.text,
        overlayRegions,
      );
      const statePromise = this.attachReader(reader);
      let translation: string;
      try {
        translation = await translateWithDeepSeek(structuredSource);
      } catch (error) {
        const message = getErrorMessage(error);
        this.updatePopupButton(button, "翻译失败，点击重试", message, false);
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: message, type: "fail", progress: 100 })
          .show();
        return;
      }

      if (!attachmentKey) {
        this.updatePopupButton(button, "无法取得 PDF 信息", undefined, false);
        return;
      }

      const state = await statePromise;
      const overlay: TranslationOverlay = {
        id: makeID(),
        attachmentKey,
        pageIndex: selection.pageIndex,
        rects: selection.rects,
        nextPageRects: selection.nextPageRects.length
          ? selection.nextPageRects
          : undefined,
        original: structuredSource,
        translation,
        createdAt: new Date().toISOString(),
        sourceStyles: state
          ? this.captureTranslationSourceStyles(state, overlayRegions)
          : undefined,
      };

      try {
        await this.store.upsert(overlay);
        this.updatePopupButton(button, "翻译成功");
        if (state) {
          // The startup renderer is known to work, while drawing inside this
          // async popup callback can still be treated as a cross-compartment
          // operation. Defer the same full-page renderer until the popup click
          // has completely returned. A 20 ms redraw is still effectively
          // immediate to the user.
          this.scheduleRender(state, overlay.pageIndex);
          this.clearTextSelection(state);
        } else {
          throw new Error("当前 PDF 阅读器尚未就绪");
        }
      } catch (error) {
        // Translation and persistence have already succeeded. A reader redraw
        // problem must not be reported as a failed DeepSeek request.
        const message = `译文已保存；如果没有立即显示，请重新打开 PDF。${getErrorMessage(error)}`;
        this.updatePopupButton(button, "译文已保存", message);
        Zotero.debug(`[Inline Translate] ${message}`);
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: message, type: "default", progress: 100 })
          .show();
      }
    });
    append(button);

    if (attachmentKey) {
      const keepButton = doc.createElement("button");
      keepButton.className = "toolbar-button wide-button";
      keepButton.dataset.tabstop = "1";
      keepButton.textContent = "保留此区域，继续选择";
      keepButton.title =
        "保留当前文字区域；之后可松开鼠标，在其他栏、其他位置或其他页面继续选择";
      keepButton.addEventListener("click", async (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        const count = this.addPendingSelection(attachmentKey, selection);
        this.updatePopupButton(
          keepButton,
          `已保留 ${count} 个区域，请继续选择`,
        );
        const state = await this.attachReader(reader);
        if (state) {
          this.scheduleRender(state);
          this.clearTextSelection(state);
        }
      });
      append(keepButton);
    }
  }

  private addPendingSelection(
    attachmentKey: string,
    selection: CapturedSelection,
  ): number {
    const pending = this.pendingRegionsByAttachment.get(attachmentKey) || [];
    const candidates: TranslationRegion[] = [
      {
        pageIndex: selection.pageIndex,
        rects: selection.rects.map((rect) => [...rect] as PdfRect),
        original: selection.text,
      },
    ];
    if (selection.nextPageRects.length) {
      candidates.push({
        pageIndex: selection.pageIndex + 1,
        rects: selection.nextPageRects.map((rect) => [...rect] as PdfRect),
        // Zotero exposes one combined text string for a native cross-page
        // selection. Keep it on the first region so it is sent only once.
        original: "",
      });
    }

    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.pageIndex, candidate.rects]);
      const exists = pending.some(
        (region) => JSON.stringify([region.pageIndex, region.rects]) === key,
      );
      if (!exists) pending.push(candidate);
    }
    this.pendingRegionsByAttachment.set(attachmentKey, pending);
    return pending.length;
  }

  private renderPendingSelectionActions({
    reader,
    doc,
    append,
    attachmentKey,
  }: any): void {
    const pending = this.pendingRegionsByAttachment.get(attachmentKey) || [];

    const translateButton = doc.createElement("button");
    translateButton.className = "toolbar-button wide-button";
    translateButton.dataset.tabstop = "1";
    translateButton.textContent = `翻译 ${pending.length} 个区域`;
    translateButton.title =
      "使用 DeepSeek，按照区域加入顺序拼接原文，并作为一个上下文翻译";
    translateButton.addEventListener("click", async (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      translateButton.setAttribute("disabled", "true");
      translateButton.textContent = "正在翻译多个区域…";

      const regions = (
        this.pendingRegionsByAttachment.get(attachmentKey) || []
      ).map((region) => ({
        pageIndex: region.pageIndex,
        rects: region.rects.map((rect) => [...rect] as PdfRect),
        original: region.original,
      }));
      const source = this.structureSourceParagraphs(
        regions
          .map((region) => region.original.trim())
          .filter(Boolean)
          .join(" "),
        regions,
      );
      if (!regions.length || !source) {
        this.updatePopupButton(
          translateButton,
          "没有可翻译的保留区域",
          undefined,
          false,
        );
        return;
      }

      const statePromise = this.attachReader(reader);
      let translation: string;
      try {
        translation = await translateWithDeepSeek(source);
      } catch (error) {
        const message = getErrorMessage(error);
        this.updatePopupButton(
          translateButton,
          "翻译失败，点击重试",
          message,
          false,
        );
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: message, type: "fail", progress: 100 })
          .show();
        return;
      }

      const firstRegion = regions[0];
      const state = await statePromise;
      const overlay: TranslationOverlay = {
        id: makeID(),
        attachmentKey,
        pageIndex: firstRegion.pageIndex,
        rects: firstRegion.rects,
        original: source,
        translation,
        createdAt: new Date().toISOString(),
        regions,
        sourceStyles: state
          ? this.captureTranslationSourceStyles(state, regions)
          : undefined,
      };

      try {
        await this.store.upsert(overlay);
        this.pendingRegionsByAttachment.delete(attachmentKey);
        this.updatePopupButton(translateButton, "多区域翻译成功");
        if (!state) throw new Error("当前 PDF 阅读器尚未就绪");
        this.scheduleRender(state);
        this.clearTextSelection(state);
      } catch (error) {
        const message = `译文已保存，但页面重绘失败：${getErrorMessage(error)}`;
        this.updatePopupButton(translateButton, "译文已保存", message);
        new ztoolkit.ProgressWindow(addon.data.config.addonName)
          .createLine({ text: message, type: "default", progress: 100 })
          .show();
      }
    });
    append(translateButton);

    const cancelButton = doc.createElement("button");
    cancelButton.className = "toolbar-button wide-button";
    cancelButton.dataset.tabstop = "1";
    cancelButton.textContent = "取消多选";
    cancelButton.addEventListener("click", async (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      this.pendingRegionsByAttachment.delete(attachmentKey);
      const state = await this.attachReader(reader);
      if (state) {
        this.scheduleRender(state);
        this.clearTextSelection(state);
      }
    });
    append(cancelButton);
  }

  private renderToolbarAction({ reader, doc, append }: any): void {
    void this.attachReader(reader);

    const button = doc.createElement("button");
    button.className = "toolbar-button";
    button.textContent = "译文";
    button.title = "显示或隐藏页面内译文";
    button.addEventListener("click", async () => {
      const state = await this.attachReader(reader);
      if (!state) return;
      state.visible = !state.visible;
      state.pdfWindow.document.documentElement?.classList.toggle(
        "rpt-hide-translations",
        !state.visible,
      );
      this.updateNativeAnnotationInteraction(state);
      button.textContent = state.visible ? "译文" : "原文";
      this.scheduleAnnotationSync(state);
    });
    button.addEventListener("contextmenu", async (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const state = await this.attachReader(reader);
      if (!state) return;
      if (!state.pdfWindow.confirm("删除当前 PDF 的全部页面内译文？")) return;
      await this.store.clearAttachment(state.attachmentKey);
      this.scheduleRender(state);
    });
    button.title += "；右键可清除当前 PDF 的全部译文";
    append(button);
  }

  private refreshBestReader(
    state: ReaderState,
    incoming?: ReaderInstance,
  ): ReaderInstance {
    state.readerCandidates ||= new Set();
    if (state.reader) state.readerCandidates.add(state.reader);
    if (incoming) state.readerCandidates.add(incoming);
    const registered = (Zotero.Reader as any)._readers;
    if (Array.isArray(registered)) {
      for (const candidate of registered) {
        try {
          const candidateWindow =
            candidate?._internalReader?._primaryView?._iframeWindow;
          if (candidateWindow === state.pdfWindow) {
            state.readerCandidates.add(candidate);
            this.stateByReader.set(candidate, state);
          }
        } catch {
          // Ignore a reader wrapper that is being destroyed.
        }
      }
    }

    let best = state.reader;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of state.readerCandidates) {
      try {
        const internal = candidate?._internalReader;
        const view = internal?._primaryView;
        const annotations = internal?._state?.annotations;
        const hasAnnotationArray = Boolean(
          annotations && typeof annotations.length === "number",
        );
        const annotationCount = hasAnnotationArray
          ? Number(annotations.length) || 0
          : 0;
        const score =
          (hasAnnotationArray ? 1000 : 0) +
          annotationCount * 20 +
          (view?._annotationShadowRoot ? 200 : 0) +
          (view?._annotationRenderRootEl ? 200 : 0) +
          (view?._iframeWindow === state.pdfWindow ? 100 : 0);
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      } catch {
        // Try the next live candidate.
      }
    }
    state.reader = best;
    return best;
  }

  private getReaderAnnotations(state: ReaderState): any {
    const reader = this.refreshBestReader(state);
    return reader?._internalReader?._state?.annotations;
  }

  private buildAnnotationDiagnosticSnapshot(
    state: ReaderState,
    overlayID?: string,
  ): Record<string, any> {
    try {
      const annotations = this.getReaderAnnotations(state);
      const annotationSamples: Record<string, any>[] = [];
      if (annotations && typeof annotations.length === "number") {
        for (let index = 0; index < Math.min(12, annotations.length); index++) {
          const annotation = annotations[index];
          annotationSamples.push({
            id: String(annotation?.id || ""),
            type: String(annotation?.type || ""),
            text: normalizeText(annotation?.text).slice(0, 180),
            pageIndex: Number(annotation?.position?.pageIndex),
            rects: copyRects(annotation?.position?.rects),
            nextPageRects: copyRects(annotation?.position?.nextPageRects),
          });
        }
      }
      const candidateSummary: Record<string, any>[] = [];
      for (const candidate of state.readerCandidates || []) {
        try {
          const internal = candidate?._internalReader;
          const view = internal?._primaryView;
          const candidateAnnotations = internal?._state?.annotations;
          candidateSummary.push({
            chosen: candidate === state.reader,
            samePdfWindow: view?._iframeWindow === state.pdfWindow,
            hasAnnotationArray: Boolean(
              candidateAnnotations &&
              typeof candidateAnnotations.length === "number",
            ),
            annotationCount: Number(candidateAnnotations?.length) || 0,
            hasShadowRoot: Boolean(view?._annotationShadowRoot),
            hasRenderRoot: Boolean(view?._annotationRenderRootEl),
          });
        } catch {
          candidateSummary.push({ inaccessible: true });
        }
      }
      const overlay = overlayID
        ? this.store
            .getForAttachment(state.attachmentKey)
            .find((candidate) => candidate.id === overlayID)
        : undefined;
      const serializeRegions = (item: TranslationOverlay | undefined) =>
        item
          ? this.getOverlayRegions(item).map((region) => ({
              pageIndex: region.pageIndex,
              rects: region.rects.map(
                (rect) => [rect[0], rect[1], rect[2], rect[3]] as PdfRect,
              ),
            }))
          : [];
      const allMatches = this.getAnnotationOverlayMatches(state, false);
      const visibleMatches = this.getAnnotationOverlayMatches(state, true);
      const currentView = state.reader?._internalReader?._primaryView;
      return {
        stateCount: this.states.size,
        statesForPdfWindow: [...this.states].filter(
          (candidate) => candidate.pdfWindow === state.pdfWindow,
        ).length,
        readerCandidateCount: state.readerCandidates?.size || 0,
        readerCandidates: candidateSummary,
        annotationCount: Number(annotations?.length) || 0,
        annotationSamples,
        bridge: {
          stateHasShadowRoot: Boolean(state.annotationShadowRoot),
          stateHasRenderRoot: Boolean(state.annotationRenderRoot),
          stateHasObserver: Boolean(state.annotationObserver),
          eventsAttached: Boolean(state.annotationBridgeEventsAttached),
          currentHasShadowRoot: Boolean(currentView?._annotationShadowRoot),
          currentHasRenderRoot: Boolean(currentView?._annotationRenderRootEl),
          shadowRootMatches:
            state.annotationShadowRoot === currentView?._annotationShadowRoot,
          renderRootMatches:
            state.annotationRenderRoot === currentView?._annotationRenderRootEl,
        },
        proxyCounts: {
          all: state.pdfWindow.document.querySelectorAll(
            `.${ANNOTATION_PROXY_CLASS}`,
          ).length,
          underlines: state.pdfWindow.document.querySelectorAll(
            `.${ANNOTATION_PROXY_CLASS}.rpt-underline`,
          ).length,
          selections: state.pdfWindow.document.querySelectorAll(
            `.${ANNOTATION_SELECTION_CLASS}`,
          ).length,
        },
        sync: {
          runs: state.annotationSyncRuns || 0,
          lastError: state.annotationLastSyncError,
          lastMatchCount: state.annotationLastSyncMatchCount,
          lastProxyCount: state.annotationLastSyncProxyCount,
        },
        targetOverlay: overlay
          ? {
              id: overlay.id,
              original: normalizeText(overlay.original).slice(0, 240),
              translation: normalizeText(overlay.translation).slice(0, 240),
              visible: this.isOverlayTranslationVisible(state, overlay.id),
              regions: serializeRegions(overlay),
            }
          : undefined,
        allMatches: allMatches.map((match) => ({
          annotationID: String(match.annotation?.id || ""),
          overlayID: match.overlay.id,
          targetStart: match.targetStart,
          targetEnd: match.targetEnd,
        })),
        visibleMatches: visibleMatches.map((match) => ({
          annotationID: String(match.annotation?.id || ""),
          overlayID: match.overlay.id,
          targetStart: match.targetStart,
          targetEnd: match.targetEnd,
        })),
      };
    } catch (error) {
      return { diagnosticError: getErrorMessage(error) };
    }
  }

  private async attachReader(
    reader: ReaderInstance,
  ): Promise<ReaderState | undefined> {
    const existing = this.stateByReader.get(reader);
    if (existing && this.isStateAlive(existing)) {
      this.refreshBestReader(existing, reader);
      this.ensureAnnotationBridge(existing);
      return existing;
    }
    if (existing) this.detachState(existing);

    const pending = this.pendingStateByReader.get(reader);
    if (pending) return pending;

    const creation = this.createReaderState(reader);
    this.pendingStateByReader.set(reader, creation);
    try {
      return await creation;
    } finally {
      if (this.pendingStateByReader.get(reader) === creation) {
        this.pendingStateByReader.delete(reader);
      }
    }
  }

  private async createReaderState(
    reader: ReaderInstance,
  ): Promise<ReaderState | undefined> {
    try {
      const attachmentKey = getAttachmentKey(reader);
      if (!attachmentKey) return undefined;

      let pdfWindow: PdfWindow | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        pdfWindow = reader._internalReader?._primaryView?._iframeWindow;
        if (
          pdfWindow?.document?.documentElement &&
          pdfWindow.PDFViewerApplication?.pdfViewer
        ) {
          break;
        }
        await Zotero.Promise.delay(100);
      }
      const eventBus = pdfWindow?.PDFViewerApplication?.eventBus;
      if (!pdfWindow || !eventBus || !pdfWindow.document?.documentElement) {
        return undefined;
      }

      // Zotero can provide a fresh privileged wrapper for the same reader in
      // each selection-popup callback. Object identity of `reader` is therefore
      // not a stable state key. Canonicalize by the actual PDF iframe Window so
      // only one renderer/annotation bridge can own and clear its proxy root.
      const windowState = this.stateByPdfWindow.get(pdfWindow);
      if (windowState && this.isStateAlive(windowState)) {
        this.refreshBestReader(windowState, reader);
        this.stateByReader.set(reader, windowState);
        this.ensureAnnotationBridge(windowState);
        return windowState;
      }

      const state = {} as ReaderState;
      state.reader = reader;
      state.readerCandidates = new Set([reader]);
      state.attachmentKey = attachmentKey;
      state.pdfWindow = pdfWindow;
      state.eventBus = eventBus;
      state.visible = true;
      state.onPageRendered = (event) => {
        const pageIndex = event.pageNumber ? event.pageNumber - 1 : undefined;
        this.scheduleRender(state, pageIndex);
      };
      state.onViewChanged = () => this.scheduleRender(state);
      state.onViewerScroll = () => this.scheduleAnnotationSync(state);
      state.onNativeAnnotationEvent = (event) =>
        this.handleNativeAnnotationEvent(state, event);
      state.onOverlayClick = (event) => this.handleOverlayClick(state, event);
      state.onOverlayContextMenu = (event) =>
        this.handleOverlayContextMenu(state, event);

      this.stateByReader.set(reader, state);
      this.stateByPdfWindow.set(pdfWindow, state);
      this.states.add(state);
      this.refreshBestReader(state);
      this.ensureStyles(pdfWindow.document);
      this.ensureAnnotationBridge(state);

      eventBus.on("pagerendered", state.onPageRendered);
      eventBus.on("textlayerrendered", state.onPageRendered);
      eventBus.on("scalechanging", state.onViewChanged);
      eventBus.on("rotationchanging", state.onViewChanged);
      state.viewerContainer =
        pdfWindow.PDFViewerApplication?.pdfViewer?.container ||
        (pdfWindow.document.getElementById(
          "viewerContainer",
        ) as HTMLElement | null) ||
        undefined;
      state.viewerContainer?.addEventListener("scroll", state.onViewerScroll, {
        passive: true,
      });
      try {
        pdfWindow.addEventListener("click", state.onOverlayClick, true);
        pdfWindow.addEventListener(
          "contextmenu",
          state.onOverlayContextMenu,
          true,
        );
      } catch (error) {
        // Drawing and toolbar controls remain available even if this Zotero
        // build rejects delegated pointer callbacks in the PDF iframe.
        Zotero.debug(
          `[Inline Translate] Unable to register overlay pointer controls: ${getErrorMessage(error)}`,
        );
      }
      this.scheduleRender(state);
      return state;
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to attach reader: ${getErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private scheduleRender(state: ReaderState, pageIndex?: number): void {
    clearTimeout(state.redrawTimer);
    state.redrawTimer = setTimeout(
      () => {
        if (!this.isStateAlive(state)) return;
        try {
          this.renderAll(state, pageIndex);
        } catch (error) {
          const message = `页面译文绘制失败：${getErrorMessage(error)}`;
          Zotero.debug(`[Inline Translate] ${message}`);
          new ztoolkit.ProgressWindow(addon.data.config.addonName)
            .createLine({ text: message, type: "fail", progress: 100 })
            .show();
        }
      },
      pageIndex === undefined ? 120 : 20,
    );
  }

  private renderAll(state: ReaderState, pageIndex?: number): void {
    if (!this.isStateAlive(state)) return;
    const selector =
      pageIndex === undefined
        ? `.${OVERLAY_CLASS}, .${OVERLAY_NODE_CLASS}, .${PENDING_SELECTION_CLASS}`
        : `.${OVERLAY_CLASS}[data-rpt-page-index="${pageIndex}"], .${OVERLAY_NODE_CLASS}[data-rpt-page-index="${pageIndex}"], .${PENDING_SELECTION_CLASS}[data-rpt-page-index="${pageIndex}"]`;
    try {
      this.removeNodes(state.pdfWindow.document, selector);
    } catch (error) {
      throw new Error(`清理页面旧译文：${getErrorMessage(error)}`);
    }

    for (const overlay of this.store.getForAttachment(state.attachmentKey)) {
      const affectsPage = this.getOverlayRegions(overlay).some(
        (region) => region.pageIndex === pageIndex,
      );
      if (pageIndex === undefined || affectsPage) {
        this.renderOverlay(state, overlay, pageIndex);
      }
    }
    this.renderPendingSelections(state, pageIndex);
    this.updateNativeAnnotationInteraction(state);
    this.scheduleAnnotationSync(state);
  }

  private renderOverlay(
    state: ReaderState,
    overlay: TranslationOverlay,
    onlyPageIndex?: number,
  ): void {
    if (!this.isStateAlive(state)) return;
    const regions = this.getOverlayRegions(overlay);
    const layoutRegions = regions.map((region) => ({
      ...region,
      rects: this.normalizeRegionRectsForTranslation(region.rects),
    }));
    const allCapacities: number[] = [];
    const inferredSourceStyles: TranslationSourceStyle[] = [];
    let canBackfillSourceStyles = !overlay.sourceStyles?.length;
    let metricOffset = 0;
    for (const region of layoutRegions) {
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(
          region.pageIndex,
        );
      for (const rect of region.rects) {
        const storedStyle = this.getStoredSourceStyle(overlay, metricOffset++);
        if (pageView?.div && pageView?.viewport) {
          const metric = this.getTranslationLineMetric(
            state,
            pageView,
            rect,
            storedStyle,
          );
          allCapacities.push(metric.capacity);
          if (canBackfillSourceStyles) {
            if (metric.sourceStyle.metadataReliable) {
              inferredSourceStyles.push({
                fontCategory: metric.sourceStyle.fontCategory,
                fontWeight: metric.sourceStyle.fontWeight,
                fontStyle: metric.sourceStyle.fontStyle,
                fontSize: metric.sourceStyle.fontSize,
              });
            } else {
              canBackfillSourceStyles = false;
            }
          }
          continue;
        }
        canBackfillSourceStyles = false;
        const width = Math.abs(rect[2] - rect[0]);
        const height = Math.max(1, Math.abs(rect[3] - rect[1]));
        allCapacities.push(
          Math.max(1, Math.floor(width / (height * 0.84 * 0.98))),
        );
      }
    }
    if (
      canBackfillSourceStyles &&
      inferredSourceStyles.length === metricOffset &&
      inferredSourceStyles.length > 0
    ) {
      overlay.sourceStyles = inferredSourceStyles;
      void this.store
        .updateSourceStyles(overlay.id, inferredSourceStyles)
        .catch((error) =>
          Zotero.debug(
            `[Inline Translate] Unable to persist source styles: ${getErrorMessage(error)}`,
          ),
        );
    }
    const sourceParagraphs = this.getOverlaySourceParagraphs(overlay, regions);
    const translatedParagraphs = this.getTranslatedParagraphs(
      overlay.translation,
      sourceParagraphs,
    );
    const paragraphLayout = this.layoutTranslationParagraphs(
      translatedParagraphs,
      allCapacities,
    );
    const allLineTexts = paragraphLayout.lineTexts;
    let lineOffset = 0;
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
      const region = regions[regionIndex];
      const layoutRegion = layoutRegions[regionIndex];
      const regionLineTexts = allLineTexts.slice(
        lineOffset,
        lineOffset + region.rects.length,
      );
      const regionSourceStyles = overlay.sourceStyles?.slice(
        lineOffset,
        lineOffset + region.rects.length,
      );
      const regionParagraphStarts = paragraphLayout.paragraphStarts.slice(
        lineOffset,
        lineOffset + region.rects.length,
      );
      lineOffset += region.rects.length;
      if (onlyPageIndex !== undefined && region.pageIndex !== onlyPageIndex) {
        continue;
      }
      this.renderPageOverlay(
        state,
        overlay,
        region.pageIndex,
        layoutRegion.rects,
        "",
        regionIndex,
        regionLineTexts,
        regionSourceStyles,
        regionParagraphStarts,
      );
    }
  }

  private getOverlayRegions(overlay: TranslationOverlay): TranslationRegion[] {
    if (overlay.regions?.length) return overlay.regions;
    const regions: TranslationRegion[] = [
      {
        pageIndex: overlay.pageIndex,
        rects: overlay.rects,
        original: overlay.original,
      },
    ];
    if (overlay.nextPageRects?.length) {
      regions.push({
        pageIndex: overlay.pageIndex + 1,
        rects: overlay.nextPageRects,
        original: "",
      });
    }
    return regions;
  }

  private splitExplicitParagraphs(text: string): string[] {
    return String(text || "")
      .replace(/\r\n?/gu, "\n")
      .split(/\n\s*\n+/gu)
      .map((paragraph) => normalizeText(paragraph))
      .filter(Boolean);
  }

  private getRegionIndentGeometry(rects: PdfRect[]): {
    bodyLeft: number;
    indentThreshold: number;
  } {
    const lefts = rects.map((rect) => Math.min(rect[0], rect[2]));
    const heights = rects
      .map((rect) => Math.abs(rect[3] - rect[1]))
      .sort((left, right) => left - right);
    const widths = rects
      .map((rect) => Math.abs(rect[2] - rect[0]))
      .sort((left, right) => left - right);
    const sortedLefts = [...lefts].sort((left, right) => left - right);
    const bodyLeft =
      sortedLefts[Math.floor((sortedLefts.length - 1) * 0.25)] || 0;
    const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
    const medianWidth = widths[Math.floor(widths.length / 2)] || 1;
    return {
      bodyLeft,
      indentThreshold: Math.max(3, medianHeight * 0.65, medianWidth * 0.025),
    };
  }

  private normalizeRegionRectsForTranslation(rects: PdfRect[]): PdfRect[] {
    if (rects.length <= 1) return rects.map((rect) => [...rect] as PdfRect);
    const { bodyLeft, indentThreshold } = this.getRegionIndentGeometry(rects);
    return rects.map((rect, index) => {
      const left = Math.min(rect[0], rect[2]);
      // A source paragraph-start line is narrower only because its English
      // text begins farther right. Chinese content flowing through that line
      // must not inherit the indent unless it is itself a paragraph start.
      // Expand only the left whitespace and preserve the selected right edge,
      // so an intentionally partial final line never covers unselected text.
      if (index > 0 && left - bodyLeft >= indentThreshold) {
        return [bodyLeft, rect[1], rect[2], rect[3]];
      }
      return [...rect] as PdfRect;
    });
  }

  private getParagraphStartLineIndices(regions: TranslationRegion[]): number[] {
    const starts = [0];
    let lineOffset = 0;
    for (const region of regions) {
      const rects = region.rects;
      if (rects.length > 1) {
        const lefts = rects.map((rect) => Math.min(rect[0], rect[2]));
        const { bodyLeft, indentThreshold } =
          this.getRegionIndentGeometry(rects);
        for (let index = 1; index < rects.length; index++) {
          if (lefts[index] - bodyLeft >= indentThreshold) {
            starts.push(lineOffset + index);
          }
        }
      }
      lineOffset += rects.length;
    }
    return [...new Set(starts)].sort((left, right) => left - right);
  }

  private getParagraphBreakRatios(
    regions: TranslationRegion[],
    starts: number[],
  ): number[] {
    const lineWeights: number[] = [];
    for (const region of regions) {
      for (const rect of region.rects) {
        const width = Math.max(1, Math.abs(rect[2] - rect[0]));
        const height = Math.max(1, Math.abs(rect[3] - rect[1]));
        lineWeights.push(width / height);
      }
    }
    const total = lineWeights.reduce((sum, weight) => sum + weight, 0);
    if (!total) return [];
    return starts.slice(1).map((start) => {
      const before = lineWeights
        .slice(0, start)
        .reduce((sum, weight) => sum + weight, 0);
      return Math.max(0.01, Math.min(0.99, before / total));
    });
  }

  private splitTextByRatios(text: string, ratios: number[]): string[] {
    const normalized = normalizeText(text);
    if (!normalized || !ratios.length) return normalized ? [normalized] : [];
    const sentenceBreaks: number[] = [];
    const sentencePattern =
      /(?:[。！？!?]|(?<!\d)\.(?!\d))["'”’）\])】》]*\s*/gu;
    let match: RegExpExecArray | null;
    while ((match = sentencePattern.exec(normalized))) {
      if (match.index + match[0].length < normalized.length) {
        sentenceBreaks.push(match.index + match[0].length);
      }
    }

    const breaks: number[] = [];
    let previous = 0;
    for (let index = 0; index < ratios.length; index++) {
      const remainingBreaks = ratios.length - index - 1;
      const target = Math.round(normalized.length * ratios[index]);
      const candidates = sentenceBreaks.filter(
        (position) =>
          position > previous + 1 &&
          position < normalized.length - remainingBreaks,
      );
      let selected = candidates.reduce<number | undefined>(
        (best, position) =>
          best === undefined ||
          Math.abs(position - target) < Math.abs(best - target)
            ? position
            : best,
        undefined,
      );
      if (selected === undefined) {
        selected = Math.max(
          previous + 1,
          Math.min(normalized.length - 1, target),
        );
        while (
          selected < normalized.length - 1 &&
          !/\s/u.test(normalized[selected])
        ) {
          selected++;
        }
      }
      breaks.push(selected);
      previous = selected;
    }

    const paragraphs: string[] = [];
    let offset = 0;
    for (const boundary of breaks) {
      const paragraph = normalized.slice(offset, boundary).trim();
      if (paragraph) paragraphs.push(paragraph);
      offset = boundary;
    }
    const tail = normalized.slice(offset).trim();
    if (tail) paragraphs.push(tail);
    return paragraphs;
  }

  private structureSourceParagraphs(
    text: string,
    regions: TranslationRegion[],
  ): string {
    const explicit = this.splitExplicitParagraphs(text);
    if (explicit.length > 1) return explicit.join("\n\n");
    const starts = this.getParagraphStartLineIndices(regions);
    if (starts.length <= 1) return normalizeText(text);
    return this.splitTextByRatios(
      text,
      this.getParagraphBreakRatios(regions, starts),
    ).join("\n\n");
  }

  private getOverlaySourceParagraphs(
    overlay: TranslationOverlay,
    regions: TranslationRegion[],
  ): string[] {
    const explicit = this.splitExplicitParagraphs(overlay.original);
    if (explicit.length > 1) return explicit;
    const starts = this.getParagraphStartLineIndices(regions);
    if (starts.length <= 1) return explicit;
    return this.splitTextByRatios(
      overlay.original,
      this.getParagraphBreakRatios(regions, starts),
    );
  }

  private getTranslatedParagraphs(
    translation: string,
    sourceParagraphs: string[],
  ): string[] {
    const explicit = this.splitExplicitParagraphs(translation);
    if (sourceParagraphs.length <= 1) return [normalizeText(translation)];
    if (explicit.length === sourceParagraphs.length) return explicit;
    const sourceSentenceCounts = sourceParagraphs.map(
      (paragraph) => this.splitSentences(paragraph).length,
    );
    const translatedSentences = this.splitSentences(translation);
    const totalSourceSentences = sourceSentenceCounts.reduce(
      (sum, count) => sum + count,
      0,
    );
    if (
      translatedSentences.length >= sourceParagraphs.length &&
      totalSourceSentences > 0
    ) {
      const paragraphs: string[] = [];
      let sourceConsumed = 0;
      let translatedOffset = 0;
      for (let index = 0; index < sourceParagraphs.length; index++) {
        sourceConsumed += sourceSentenceCounts[index];
        const remainingParagraphs = sourceParagraphs.length - index - 1;
        const targetEnd =
          index === sourceParagraphs.length - 1
            ? translatedSentences.length
            : Math.max(
                translatedOffset + 1,
                Math.min(
                  translatedSentences.length - remainingParagraphs,
                  Math.round(
                    (sourceConsumed / totalSourceSentences) *
                      translatedSentences.length,
                  ),
                ),
              );
        paragraphs.push(
          translatedSentences.slice(translatedOffset, targetEnd).join(""),
        );
        translatedOffset = targetEnd;
      }
      return paragraphs;
    }
    const totalSourceLength = sourceParagraphs.reduce(
      (sum, paragraph) => sum + paragraph.length,
      0,
    );
    let consumed = 0;
    const ratios = sourceParagraphs.slice(0, -1).map((paragraph) => {
      consumed += paragraph.length;
      return totalSourceLength ? consumed / totalSourceLength : 0;
    });
    return this.splitTextByRatios(translation, ratios);
  }

  private mapOverlaySourceRangeToTarget(
    overlay: TranslationOverlay,
    sourceStart: number,
    sourceEnd: number,
  ): [number, number] {
    const source = normalizeText(overlay.original);
    const target = normalizeText(overlay.translation);
    if (!source || !target) return [0, target.length];

    // Lock the match to the corresponding paragraph before comparing sentence
    // positions. A sentence-count mismatch in a later paragraph must never
    // shift "Therefore" backwards or map the first sentence of a new paragraph
    // onto the final sentence of the preceding paragraph.
    const sourceParagraphs = this.getOverlaySourceParagraphs(
      overlay,
      this.getOverlayRegions(overlay),
    ).map((paragraph) => normalizeText(paragraph));
    const targetParagraphs = this.getTranslatedParagraphs(
      overlay.translation,
      sourceParagraphs,
    ).map((paragraph) => normalizeText(paragraph));
    if (
      sourceParagraphs.length <= 1 ||
      sourceParagraphs.length !== targetParagraphs.length
    ) {
      return mapSourceRangeToTarget(source, target, sourceStart, sourceEnd);
    }

    let sourceCursor = 0;
    let targetCursor = 0;
    for (let index = 0; index < sourceParagraphs.length; index++) {
      const sourceParagraph = sourceParagraphs[index];
      const targetParagraph = targetParagraphs[index];
      const foundSource = source.indexOf(sourceParagraph, sourceCursor);
      const foundTarget = target.indexOf(targetParagraph, targetCursor);
      if (foundSource < 0 || foundTarget < 0) {
        return mapSourceRangeToTarget(source, target, sourceStart, sourceEnd);
      }
      const sourceParagraphEnd = foundSource + sourceParagraph.length;
      if (
        sourceStart >= foundSource &&
        sourceStart < sourceParagraphEnd &&
        sourceEnd <= sourceParagraphEnd
      ) {
        const [localStart, localEnd] = mapSourceRangeToTarget(
          sourceParagraph,
          targetParagraph,
          sourceStart - foundSource,
          sourceEnd - foundSource,
        );
        return [foundTarget + localStart, foundTarget + localEnd];
      }
      sourceCursor = sourceParagraphEnd;
      targetCursor = foundTarget + targetParagraph.length;
    }

    return mapSourceRangeToTarget(source, target, sourceStart, sourceEnd);
  }

  private splitSentences(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const sentences: string[] = [];
    let start = 0;
    for (let index = 0; index < normalized.length; index++) {
      const character = normalized[index];
      let boundary = "。！？!?".includes(character);
      if (character === ".") {
        const previous = normalized[index - 1];
        const next = normalized[index + 1];
        const recent = normalized
          .slice(Math.max(0, index - 4), index + 1)
          .toLowerCase();
        boundary = !(
          (/\d/u.test(previous || "") && /\d/u.test(next || "")) ||
          /[A-Za-z]/u.test(next || "") ||
          recent.endsWith("e.g.") ||
          recent.endsWith("i.e.")
        );
      }
      if (!boundary) continue;
      let end = index + 1;
      while (
        end < normalized.length &&
        /["'”’）\])】》]/u.test(normalized[end])
      ) {
        end++;
      }
      while (end < normalized.length && /\s/u.test(normalized[end])) end++;
      const sentence = normalized.slice(start, end).trim();
      if (sentence) sentences.push(sentence);
      start = end;
      index = end - 1;
    }
    const tail = normalized.slice(start).trim();
    if (tail) sentences.push(tail);
    return sentences.length ? sentences : [normalized];
  }

  private layoutTranslationParagraphs(
    paragraphs: string[],
    capacities: number[],
  ): ParagraphLayout {
    const lineTexts = capacities.map(() => "");
    const paragraphStarts = capacities.map(() => false);
    let lineOffset = 0;
    for (
      let paragraphIndex = 0;
      paragraphIndex < paragraphs.length;
      paragraphIndex++
    ) {
      const paragraph = normalizeText(paragraphs[paragraphIndex]);
      if (!paragraph) continue;
      if (lineOffset >= capacities.length) {
        if (lineTexts.length) {
          lineTexts[lineTexts.length - 1] += normalizeText(paragraph);
        }
        continue;
      }
      const paragraphsAfter = paragraphs.length - paragraphIndex - 1;
      const availableEnd = Math.max(
        lineOffset + 1,
        capacities.length - paragraphsAfter,
      );
      const paragraphCapacities = capacities.slice(lineOffset, availableEnd);
      if (paragraphIndex > 0 && paragraphCapacities.length) {
        paragraphCapacities[0] = Math.max(1, paragraphCapacities[0] - 1);
        paragraphStarts[lineOffset] = true;
      }
      const chunks = this.layoutTranslation(paragraph, paragraphCapacities);
      let consumedLines = chunks.length;
      while (consumedLines > 1 && !chunks[consumedLines - 1]) consumedLines--;
      for (let index = 0; index < consumedLines; index++) {
        lineTexts[lineOffset + index] = chunks[index];
      }
      lineOffset += Math.max(1, consumedLines);
    }
    return { lineTexts, paragraphStarts };
  }

  private getStoredSourceStyle(
    overlay: TranslationOverlay,
    index: number,
  ): TranslationSourceStyle | undefined {
    const style = overlay.sourceStyles?.[index];
    if (
      !style ||
      !["serif", "sans", "mono"].includes(style.fontCategory) ||
      !["normal", "italic"].includes(style.fontStyle) ||
      !Number.isFinite(style.fontWeight)
    ) {
      return;
    }
    return style;
  }

  private getPageTextStyleCache(
    state: ReaderState,
    pageView: any,
  ): PageTextStyleCache | undefined {
    const pageNumber = Number(pageView.pdfPage?.pageNumber || pageView.id);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return;
    const pageIndex = pageNumber - 1;
    state.pageTextStyleCache ||= new Map();
    state.pageTextStyleLoads ||= new Map();
    const cached = state.pageTextStyleCache.get(pageIndex);
    if (cached) return cached;
    if (!state.pageTextStyleLoads.has(pageIndex)) {
      const loading = this.loadPageTextStyleCache(
        state,
        pageView,
        pageIndex,
      ).finally(() => state.pageTextStyleLoads?.delete(pageIndex));
      state.pageTextStyleLoads.set(pageIndex, loading);
    }
    return undefined;
  }

  private async loadPageTextStyleCache(
    state: ReaderState,
    pageView: any,
    pageIndex: number,
  ): Promise<void> {
    try {
      // Do not pass an options object across Zotero's compartment boundary.
      // The default TextContent result already contains the original fontName
      // for every text item, which is precisely the information the normalized
      // HTML text layer removes.
      const content = await pageView.pdfPage?.getTextContent?.();
      const sourceItems = content?.items;
      if (!sourceItems || typeof sourceItems.length !== "number") return;
      const items: PageTextStyleItem[] = [];
      for (let index = 0; index < sourceItems.length; index++) {
        const sourceItem = sourceItems[index];
        const fontName = String(sourceItem?.fontName || "");
        const sourceStyle = fontName ? content?.styles?.[fontName] : undefined;
        items.push({
          text: String(sourceItem?.str || ""),
          fontName,
          fontFamily: String(sourceStyle?.fontFamily || ""),
        });
      }
      if (!this.isStateAlive(state)) return;
      state.pageTextStyleCache ||= new Map();
      state.pageTextStyleCache.set(pageIndex, { items });
      this.scheduleRender(state, pageIndex);
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to read PDF TextContent fonts: ${getErrorMessage(error)}`,
      );
    }
  }

  private matchPageTextStyleItem(
    cache: PageTextStyleCache | undefined,
    index: number,
    text: string,
  ): PageTextStyleItem | undefined {
    if (!cache) return;
    const normalized = normalizeText(text);
    const direct = cache.items[index];
    if (!normalized || normalizeText(direct?.text) === normalized)
      return direct;
    for (let distance = 1; distance <= 4; distance++) {
      for (const candidateIndex of [index - distance, index + distance]) {
        const candidate = cache.items[candidateIndex];
        if (candidate && normalizeText(candidate.text) === normalized) {
          return candidate;
        }
      }
    }
    for (const candidate of cache.items) {
      if (normalizeText(candidate.text) === normalized) return candidate;
    }
    return direct;
  }

  private getTranslationLineMetric(
    state: ReaderState,
    pageView: any,
    pdfRect: PdfRect,
    storedStyle?: TranslationSourceStyle,
  ): TranslationLineMetric {
    const transform = pageView.viewport.transform;
    const matrixA = Number(transform[0]);
    const matrixB = Number(transform[1]);
    const matrixC = Number(transform[2]);
    const matrixD = Number(transform[3]);
    const matrixE = Number(transform[4]);
    const matrixF = Number(transform[5]);
    const x1 = matrixA * pdfRect[0] + matrixC * pdfRect[1] + matrixE;
    const y1 = matrixB * pdfRect[0] + matrixD * pdfRect[1] + matrixF;
    const x2 = matrixA * pdfRect[2] + matrixC * pdfRect[3] + matrixE;
    const y2 = matrixB * pdfRect[2] + matrixD * pdfRect[3] + matrixF;
    const rect = {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      right: Math.max(x1, x2),
      bottom: Math.max(y1, y2),
    };
    const lineHeight = Math.max(8, rect.bottom - rect.top);
    const bleedX = Math.max(0.75, lineHeight * 0.035);
    const bleedY = Math.max(1, lineHeight * 0.08);
    const width = Math.max(8, rect.right - rect.left + bleedX * 2);
    const height = Math.max(8, lineHeight + bleedY * 2);
    const sourceStyle: SourceLineStyle = storedStyle
      ? {
          fontCategory: storedStyle.fontCategory,
          fontWeight: storedStyle.fontWeight,
          fontStyle: storedStyle.fontStyle,
          fontSize: storedStyle.fontSize,
          metadataReliable: true,
        }
      : this.readSourceLineStyle(state, pageView, rect, lineHeight);
    const sampledFontSize = Number(sourceStyle.fontSize);
    const fontSize = Math.min(
      lineHeight * 0.98,
      Math.max(
        lineHeight * 0.82,
        Number.isFinite(sampledFontSize)
          ? sampledFontSize * 0.94
          : lineHeight * 0.84,
      ),
    );
    const minimumScale = sourceStyle.fontWeight >= 600 ? 0.88 : 0.84;
    const minimumFontSize = Math.max(7, fontSize * minimumScale);
    const widthFactor = sourceStyle.fontWeight >= 600 ? 1.01 : 0.98;
    const capacity = Math.max(
      1,
      Math.floor((width - 2) / (fontSize * widthFactor)),
    );
    return {
      rect,
      bleedX,
      bleedY,
      width,
      height,
      fontSize,
      minimumFontSize,
      capacity,
      sourceStyle,
    };
  }

  private captureTranslationSourceStyles(
    state: ReaderState,
    regions: TranslationRegion[],
  ): TranslationSourceStyle[] | undefined {
    const styles: TranslationSourceStyle[] = [];
    for (const region of regions) {
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(
          region.pageIndex,
        );
      if (!pageView?.div || !pageView.viewport) return;
      for (const rect of region.rects) {
        const sourceStyle = this.getTranslationLineMetric(
          state,
          pageView,
          rect,
        ).sourceStyle;
        // Persist only a style derived from the PDF's actual font metadata.
        // A normalized DOM fallback would permanently save a false "normal".
        if (!sourceStyle.metadataReliable) return;
        styles.push({
          fontCategory: sourceStyle.fontCategory,
          fontWeight: sourceStyle.fontWeight,
          fontStyle: sourceStyle.fontStyle,
          fontSize: sourceStyle.fontSize,
        });
      }
    }
    return styles.length ? styles : undefined;
  }

  private readSourceLineStyle(
    state: ReaderState,
    pageView: any,
    lineRect: { left: number; top: number; right: number; bottom: number },
    lineHeight: number,
  ): SourceLineStyle {
    const fallback: SourceLineStyle = {
      fontCategory: "serif",
      fontWeight: 400,
      fontStyle: "normal",
      metadataReliable: false,
    };
    try {
      const pageBounds = pageView.div?.getBoundingClientRect?.();
      if (!pageBounds) return fallback;
      const textDivs = pageView.textLayer?.textDivs;
      const candidates: HTMLElement[] = [];
      if (textDivs && typeof textDivs.length === "number") {
        for (let index = 0; index < textDivs.length; index++) {
          const node = textDivs[index] as HTMLElement | undefined;
          if (node?.getBoundingClientRect) candidates.push(node);
        }
      } else {
        const nodes = pageView.div.querySelectorAll(
          ".textLayer span",
        ) as NodeListOf<HTMLElement>;
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes.item(index);
          if (node) candidates.push(node);
        }
      }
      if (!candidates.length) return fallback;
      const pageTextStyle = this.getPageTextStyleCache(state, pageView);
      const pageFontSizes: number[] = [];
      for (const candidate of candidates) {
        const candidateStyle = state.pdfWindow.getComputedStyle(candidate);
        const candidateSize = Number.parseFloat(candidateStyle?.fontSize || "");
        if (Number.isFinite(candidateSize) && candidateSize > 0) {
          pageFontSizes.push(candidateSize);
        }
      }
      pageFontSizes.sort((left, right) => left - right);
      const pageMedianFontSize = pageFontSizes.length
        ? pageFontSizes[Math.floor(pageFontSizes.length / 2)]
        : 0;

      let total = 0;
      let bold = 0;
      let italic = 0;
      let metadataReliable = 0;
      let weightedFontSize = 0;
      const categoryWeights: Record<FontCategory, number> = {
        serif: 0,
        sans: 0,
        mono: 0,
      };
      for (
        let candidateIndex = 0;
        candidateIndex < candidates.length;
        candidateIndex++
      ) {
        const span = candidates[candidateIndex];
        const bounds = span.getBoundingClientRect();
        const local = {
          left: bounds.left - pageBounds.left,
          top: bounds.top - pageBounds.top,
          right: bounds.right - pageBounds.left,
          bottom: bounds.bottom - pageBounds.top,
        };
        const overlapWidth = Math.max(
          0,
          Math.min(local.right, lineRect.right) -
            Math.max(local.left, lineRect.left),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(local.bottom, lineRect.bottom) -
            Math.max(local.top, lineRect.top),
        );
        if (!overlapWidth || overlapHeight < Math.min(2, lineHeight * 0.18)) {
          continue;
        }

        const computed = state.pdfWindow.getComputedStyle(span);
        if (!computed) continue;
        const computedFamily = String(computed.fontFamily || "");
        const inlineFamily = String(span.style.fontFamily || "");
        const datasetFont = String(span.dataset.fontName || "");
        const textStyleItem = this.matchPageTextStyleItem(
          pageTextStyle,
          candidateIndex,
          String(span.textContent || ""),
        );
        const pdfHints = this.readPdfFontHints(state, pageView, [
          textStyleItem?.fontName || "",
          textStyleItem?.fontFamily || "",
          inlineFamily,
          computedFamily,
          datasetFont,
        ]);
        const fontDescription = `${textStyleItem?.fontName || ""} ${textStyleItem?.fontFamily || ""} ${computedFamily} ${inlineFamily} ${datasetFont} ${pdfHints.name}`;
        const category =
          pdfHints.category || this.classifyFont(fontDescription);
        const weight = this.parseFontWeight(
          computed.fontWeight,
          fontDescription,
          pdfHints.bold,
        );
        const isItalic =
          pdfHints.italic ||
          this.hasItalicFontName(
            `${computed.fontStyle || ""} ${fontDescription}`,
          );
        const cssFontSize = Number.parseFloat(computed.fontSize);
        const visualFontSize = Math.max(
          Number.isFinite(cssFontSize) ? cssFontSize : 0,
          Math.min(lineHeight, bounds.height) * 0.88,
        );
        const textWeight = Math.max(1, normalizeText(span.textContent).length);
        const overlapRatio = Math.min(
          1,
          overlapWidth / Math.max(1, bounds.width),
        );
        const sampleWeight = textWeight * Math.max(0.25, overlapRatio);
        if (pageTextStyle) {
          this.recordFontDiagnostic({
            time: new Date().toISOString(),
            pageNumber:
              Number(pageView.pdfPage?.pageNumber || pageView.id) || 0,
            text: normalizeText(span.textContent).slice(0, 120),
            computedFamily,
            inlineFamily,
            datasetFont,
            textContentFontName: textStyleItem?.fontName || "",
            textContentFontFamily: textStyleItem?.fontFamily || "",
            computedWeight: String(computed.fontWeight || ""),
            computedStyle: String(computed.fontStyle || ""),
            pdfHints,
            detectedCategory: category,
            detectedWeight: weight,
            detectedItalic: isItalic,
            cssFontSize,
            visualFontSize,
          });
        }
        total += sampleWeight;
        categoryWeights[category] += sampleWeight;
        if (weight >= 600) bold += sampleWeight;
        if (isItalic) italic += sampleWeight;
        if (pdfHints.name || pdfHints.bold || pdfHints.italic) {
          metadataReliable += sampleWeight;
        }
        weightedFontSize += visualFontSize * sampleWeight;
      }
      if (!total) return fallback;

      const fontCategory = (Object.entries(categoryWeights).sort(
        (left, right) => right[1] - left[1],
      )[0]?.[0] || "serif") as FontCategory;
      const averageFontSize = weightedFontSize / total;
      const headingLike = Boolean(
        pageMedianFontSize && averageFontSize >= pageMedianFontSize * 1.14,
      );
      return {
        fontCategory,
        fontWeight: bold / total >= 0.35 || headingLike ? 700 : 400,
        fontStyle: italic / total >= 0.35 ? "italic" : "normal",
        fontSize: averageFontSize,
        metadataReliable: metadataReliable / total >= 0.35,
      };
    } catch {
      return fallback;
    }
  }

  private readPdfFontHints(
    state: ReaderState,
    pageView: any,
    families: string[],
  ): PdfFontHints {
    const identifiers = new Set<string>();
    for (const family of families) {
      const matches = family.match(/g_[a-z0-9_]+/giu) || [];
      for (const match of matches) identifiers.add(match);
    }
    const pageNumber = Number(pageView.pdfPage?.pageNumber || pageView.id) || 0;
    for (const identifier of identifiers) {
      const cacheKey = `${state.attachmentKey}:${pageNumber}:${identifier}`;
      const cached = this.pdfFontHintsCache.get(cacheKey);
      if (cached) {
        return { ...cached, identifiers: [...identifiers] };
      }
      try {
        const font = pageView.pdfPage?.commonObjs?.get?.(identifier);
        if (!font) continue;
        const cssFontInfo = font.cssFontInfo;
        const embedded = this.readEmbeddedFontHints(font.data);
        const declaredName = [
          font.name,
          font.fontFamily,
          font.fallbackName,
          font.loadedName,
          cssFontInfo?.fontFamily,
          cssFontInfo?.fullName,
          cssFontInfo?.postScriptName,
        ]
          .map((value) => String(value || ""))
          .filter(Boolean)
          .join(" ");
        const name = [declaredName, embedded.name].filter(Boolean).join(" ");
        const flags = Number(font.flags) || 0;
        const bold = Boolean(
          font.bold ||
          font.black ||
          flags & 0x40000 ||
          embedded.bold ||
          this.hasBoldFontName(name),
        );
        const italic = Boolean(
          font.italic ||
          flags & 0x40 ||
          Number(cssFontInfo?.italicAngle) ||
          embedded.italic ||
          this.hasItalicFontName(name),
        );
        let category: FontCategory | undefined;
        if (font.isMonospace || flags & 0x1) category = "mono";
        else if (font.isSerifFont || flags & 0x2) category = "serif";
        // The embedded PostScript name is authoritative for weight/style, but
        // changing the CJK family from it made every existing body translation
        // visibly switch typeface in 0.4.23. Keep category selection aligned
        // with the reader's declared/DOM family instead.
        else if (declaredName) category = this.classifyFont(declaredName);
        const result = {
          name,
          bold,
          italic,
          category,
          identifiers: [...identifiers],
        };
        // PDF.js may clear the converted font bytes after installing the font.
        // Cache only a result backed by real embedded/style metadata, then
        // reuse it for delete/retranslate and later redraws of this page.
        if (
          embedded.name ||
          embedded.bold ||
          embedded.italic ||
          font.bold ||
          font.italic ||
          Number(cssFontInfo?.italicAngle)
        ) {
          this.pdfFontHintsCache.set(cacheKey, result);
        }
        return result;
      } catch {
        // Try the next extracted PDF.js loaded-font identifier.
      }
    }
    return {
      name: "",
      bold: false,
      italic: false,
      identifiers: [...identifiers],
    };
  }

  /**
   * PDF.js deliberately exposes only a generated family name for some embedded
   * fonts and may also lose the PDF FontDescriptor italic flag. The converted
   * OpenType program still contains authoritative style bits and its original
   * name, so read those primitives directly instead of relying on PDF.js's
   * normalized DOM style.
   */
  private readEmbeddedFontHints(data: any): {
    name: string;
    bold: boolean;
    italic: boolean;
  } {
    const fallback = { name: "", bold: false, italic: false };
    try {
      const length = Number(data?.length || data?.byteLength || 0);
      if (!Number.isInteger(length) || length < 12) return fallback;
      const byte = (offset: number): number => {
        if (offset < 0 || offset >= length) return 0;
        return Number(data[offset]) & 0xff;
      };
      const uint16 = (offset: number): number =>
        (byte(offset) << 8) | byte(offset + 1);
      const uint32 = (offset: number): number =>
        (byte(offset) * 0x1000000 +
          (byte(offset + 1) << 16) +
          (byte(offset + 2) << 8) +
          byte(offset + 3)) >>>
        0;
      const int32 = (offset: number): number => {
        const value = uint32(offset);
        return value > 0x7fffffff ? value - 0x100000000 : value;
      };
      const tagAt = (offset: number): string =>
        String.fromCharCode(
          byte(offset),
          byte(offset + 1),
          byte(offset + 2),
          byte(offset + 3),
        );

      const tables = new Map<string, { offset: number; length: number }>();
      const tableCount = Math.min(256, uint16(4));
      for (let index = 0; index < tableCount; index++) {
        const recordOffset = 12 + index * 16;
        if (recordOffset + 15 >= length) break;
        const tableOffset = uint32(recordOffset + 8);
        const tableLength = uint32(recordOffset + 12);
        if (tableOffset < length && tableLength <= length - tableOffset) {
          tables.set(tagAt(recordOffset), {
            offset: tableOffset,
            length: tableLength,
          });
        }
      }

      const names = new Set<string>();
      const nameTable = tables.get("name");
      if (nameTable && nameTable.length >= 6) {
        const count = Math.min(512, uint16(nameTable.offset + 2));
        const stringsStart = nameTable.offset + uint16(nameTable.offset + 4);
        for (let index = 0; index < count; index++) {
          const record = nameTable.offset + 6 + index * 12;
          if (record + 11 >= nameTable.offset + nameTable.length) break;
          const platform = uint16(record);
          const nameID = uint16(record + 6);
          if (![1, 2, 4, 6, 17].includes(nameID)) continue;
          const stringLength = Math.min(512, uint16(record + 8));
          const stringOffset = stringsStart + uint16(record + 10);
          if (
            stringOffset < nameTable.offset ||
            stringOffset + stringLength > nameTable.offset + nameTable.length
          ) {
            continue;
          }
          let value = "";
          if (platform === 0 || platform === 3) {
            for (let cursor = 0; cursor + 1 < stringLength; cursor += 2) {
              value += String.fromCharCode(uint16(stringOffset + cursor));
            }
          } else {
            for (let cursor = 0; cursor < stringLength; cursor++) {
              const code = byte(stringOffset + cursor);
              if (code >= 32 && code < 127) value += String.fromCharCode(code);
            }
          }
          value = value.replace(/\0/gu, "").trim();
          if (value) names.add(value);
        }
      }

      // Converted Type1 fonts commonly retain their PostScript name as the
      // first CFF INDEX even when the OpenType name table is sparse.
      const cffTable = tables.get("CFF ");
      if (cffTable && cffTable.length >= 8) {
        const cffStart = cffTable.offset;
        const headerSize = byte(cffStart + 2);
        const indexStart = cffStart + headerSize;
        const count = uint16(indexStart);
        const offsetSize = byte(indexStart + 2);
        if (count > 0 && count < 64 && offsetSize >= 1 && offsetSize <= 4) {
          const readIndexOffset = (position: number): number => {
            let value = 0;
            for (let index = 0; index < offsetSize; index++) {
              value = value * 256 + byte(position + index);
            }
            return value;
          };
          const offsetsStart = indexStart + 3;
          const dataStart = offsetsStart + (count + 1) * offsetSize;
          for (let index = 0; index < count; index++) {
            const start = readIndexOffset(offsetsStart + index * offsetSize);
            const end = readIndexOffset(
              offsetsStart + (index + 1) * offsetSize,
            );
            if (start < 1 || end <= start || end - start > 256) continue;
            let value = "";
            for (let cursor = start - 1; cursor < end - 1; cursor++) {
              const code = byte(dataStart + cursor);
              if (code >= 32 && code < 127) value += String.fromCharCode(code);
            }
            if (value.trim()) names.add(value.trim());
          }
        }
      }

      const os2 = tables.get("OS/2");
      const head = tables.get("head");
      const post = tables.get("post");
      const selection = os2 && os2.length >= 64 ? uint16(os2.offset + 62) : 0;
      const macStyle = head && head.length >= 46 ? uint16(head.offset + 44) : 0;
      const italicAngle = post && post.length >= 8 ? int32(post.offset + 4) : 0;
      const name = [...names].join(" ");
      return {
        name,
        bold: Boolean(
          selection & 0x20 || macStyle & 0x1 || this.hasBoldFontName(name),
        ),
        italic: Boolean(
          selection & 0x1 ||
          selection & 0x200 ||
          macStyle & 0x2 ||
          italicAngle ||
          this.hasItalicFontName(name),
        ),
      };
    } catch {
      return fallback;
    }
  }

  private classifyFont(description: string): FontCategory {
    if (/biolinum/iu.test(description)) return "sans";
    if (/libertine/iu.test(description)) return "serif";
    if (
      /mono|courier|consolas|code|typewriter|cmtt|lmmono|inconsolata/iu.test(
        description,
      )
    ) {
      return "mono";
    }
    if (
      /sans|helvetica|arial|calibri|roboto|verdana|tahoma|grotesk|cmss|lmsans|biolinum|nimbussans/iu.test(
        description,
      )
    ) {
      return "sans";
    }
    if (
      /serif|times|cambria|georgia|garamond|palatino|roman|baskerville|libertine|stix|cmr|cmbx|cmti|minion|nimbusrom|bookman|charter|utopia/iu.test(
        description,
      )
    ) {
      return "serif";
    }
    return "serif";
  }

  private hasBoldFontName(description: string): boolean {
    return /bold|black|demi|semi[-_ ]?bold|heavy|extra[-_ ]?bold|ultra[-_ ]?bold|cmbx|cmssbx|(?:libertine|biolinum)t(?:bi|b)(?:$|[^a-z])|(?:^|[^a-z])(?:bd|rb|bx)(?:$|[^a-z])/iu.test(
      description,
    );
  }

  private hasItalicFontName(description: string): boolean {
    return /italic|oblique|slanted|cmti|cmmi|(?:libertine|biolinum)t(?:bi|i)(?:$|[^a-z])|(?:^|[^a-z])(?:it|ri)(?:$|[^a-z])/iu.test(
      description,
    );
  }

  private parseFontWeight(
    value: string,
    description: string,
    metadataBold: boolean,
  ): number {
    if (metadataBold || this.hasBoldFontName(description)) {
      return 700;
    }
    if (value === "bold" || value === "bolder") return 700;
    const numeric = Number.parseInt(value, 10);
    return Number.isFinite(numeric) && numeric >= 600 ? 700 : 400;
  }

  private getTranslationFontFamily(style: SourceLineStyle): string {
    if (style.fontCategory === "mono") {
      return '"Sarasa Mono SC", "Noto Sans Mono CJK SC", Consolas, monospace';
    }
    if (style.fontCategory === "sans") {
      return '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';
    }
    if (style.fontStyle === "italic") {
      return '"STKaiti", "KaiTi", "Noto Serif CJK SC", "Source Han Serif SC", "SimSun", serif';
    }
    return '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';
  }

  private renderPendingSelections(
    state: ReaderState,
    onlyPageIndex?: number,
  ): void {
    const regions =
      this.pendingRegionsByAttachment.get(state.attachmentKey) || [];
    for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
      const region = regions[regionIndex];
      if (onlyPageIndex !== undefined && region.pageIndex !== onlyPageIndex) {
        continue;
      }
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(
          region.pageIndex,
        );
      if (!pageView?.div || !pageView.viewport) continue;

      const matrixA = pageView.viewport.transform[0] as number;
      const matrixB = pageView.viewport.transform[1] as number;
      const matrixC = pageView.viewport.transform[2] as number;
      const matrixD = pageView.viewport.transform[3] as number;
      const matrixE = pageView.viewport.transform[4] as number;
      const matrixF = pageView.viewport.transform[5] as number;
      for (let rectIndex = 0; rectIndex < region.rects.length; rectIndex++) {
        const rect = region.rects[rectIndex];
        const x1 = matrixA * rect[0] + matrixC * rect[1] + matrixE;
        const y1 = matrixB * rect[0] + matrixD * rect[1] + matrixF;
        const x2 = matrixA * rect[2] + matrixC * rect[3] + matrixE;
        const y2 = matrixB * rect[2] + matrixD * rect[3] + matrixF;
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.max(2, Math.abs(x2 - x1));
        const height = Math.max(2, Math.abs(y2 - y1));
        const domID = `rpt-pending-${regionIndex}-${region.pageIndex}-${rectIndex}`;
        pageView.div.insertAdjacentHTML(
          "beforeend",
          `<div id="${domID}" class="${PENDING_SELECTION_CLASS}" data-rpt-page-index="${region.pageIndex}"></div>`,
        );
        const element = state.pdfWindow.document.getElementById(
          domID,
        ) as HTMLElement | null;
        if (!element) continue;
        element.style.left = `${left}px`;
        element.style.top = `${top}px`;
        element.style.width = `${width}px`;
        element.style.height = `${height}px`;
      }
    }
  }

  private renderPageOverlay(
    state: ReaderState,
    overlay: TranslationOverlay,
    pageIndex: number,
    rects: PdfRect[],
    pageTranslation: string,
    regionIndex = 0,
    presetLineTexts?: string[],
    presetSourceStyles?: TranslationSourceStyle[],
    presetParagraphStarts?: boolean[],
  ): void {
    let stage = "获取 PDF 页面";
    try {
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(pageIndex);
      if (!pageView?.div || !pageView.viewport || !rects.length) return;

      stage = "读取 PDF 坐标矩阵";
      // Calculate the PDF.js viewport transform locally. Calling a function
      // owned by the PDF iframe can return a protected cross-compartment Array.
      // Never retain that Array in the add-on compartment: copy its primitive
      // number members one by one and construct a new local Array.
      stage = "换算选区矩形";
      const normalizedText = pageTranslation.replace(/\s+/g, " ").trim();
      const lineMetrics = rects.map((rect, index) =>
        this.getTranslationLineMetric(
          state,
          pageView,
          rect,
          presetSourceStyles?.[index],
        ),
      );
      const lineTexts =
        presetLineTexts ||
        this.layoutTranslation(
          normalizedText,
          lineMetrics.map((metric) => metric.capacity),
        );

      for (let lineIndex = 0; lineIndex < lineMetrics.length; lineIndex++) {
        const {
          rect,
          bleedX,
          bleedY,
          width,
          height,
          fontSize,
          minimumFontSize,
          sourceStyle,
        } = lineMetrics[lineIndex];
        const lineText = lineTexts[lineIndex];

        stage = `插入第 ${lineIndex + 1} 行`;
        const domID = `rpt-${overlay.id}-${pageIndex}-${regionIndex}-${lineIndex}`;
        pageView.div.insertAdjacentHTML(
          "beforeend",
          `<div id="${domID}" class="${OVERLAY_CLASS} ${OVERLAY_NODE_CLASS}" data-rpt-id="${overlay.id}" data-rpt-page-index="${pageIndex}" data-rpt-region-index="${regionIndex}" data-rpt-line-index="${lineIndex}"></div>`,
        );
        const element = state.pdfWindow.document.getElementById(
          domID,
        ) as HTMLElement | null;
        if (!element) throw new Error("PDF 页面拒绝创建译文覆盖层");

        stage = `设置第 ${lineIndex + 1} 行内容`;
        const textElement = state.pdfWindow.document.createElement("span");
        textElement.className = OVERLAY_TEXT_CLASS;
        if (sourceStyle.fontStyle === "italic") {
          textElement.classList.add(OVERLAY_ITALIC_TEXT_CLASS);
        }
        textElement.textContent = lineText;
        element.append(textElement);
        element.style.left = `${rect.left - bleedX}px`;
        element.style.top = `${rect.top - bleedY}px`;
        element.style.width = `${width}px`;
        element.style.height = `${height}px`;
        element.style.fontSize = `${fontSize}px`;
        element.style.lineHeight = `${height}px`;
        element.style.fontFamily = this.getTranslationFontFamily(sourceStyle);
        element.style.fontWeight = String(sourceStyle.fontWeight);
        // The inner span provides a deterministic visual slant even when the
        // chosen CJK font has no native italic face and Gecko declines to
        // synthesize one. Keep the positioned overlay box itself untransformed.
        element.style.fontStyle = "normal";
        element.dataset.rptFontCategory = sourceStyle.fontCategory;
        if (presetParagraphStarts?.[lineIndex]) {
          element.style.textIndent = "1em";
          element.dataset.rptParagraphStart = "true";
        }

        stage = `调整第 ${lineIndex + 1} 行字号`;
        this.fitText(element, minimumFontSize);
      }
    } catch (error) {
      throw new Error(`${stage}：${getErrorMessage(error)}`);
    }
  }

  private layoutTranslation(text: string, capacities: number[]): string[] {
    const result = capacities.map(() => "");
    const characters = Array.from(text);
    if (!characters.length || !capacities.length) return result;

    const closingPunctuation = "，。；：！？、）】》”’」』,.!?;:";
    const openingPunctuation = "（【《“‘「『";
    const chunks = capacities.map(() => [] as string[]);
    let offset = 0;
    for (let lineIndex = 0; lineIndex < capacities.length; lineIndex++) {
      while (offset < characters.length && /\s/u.test(characters[offset])) {
        offset++;
      }
      if (offset >= characters.length) break;

      // Normal paragraph flow: fill the current line before using the next
      // one. Width is measured in CJK-em units so Latin abbreviations, digits,
      // spaces and URLs no longer consume a full Chinese-character slot.
      let take = 0;
      let usedWidth = 0;
      while (offset + take < characters.length) {
        const width = characterWidthUnits(characters[offset + take]);
        if (take > 0 && usedWidth + width > capacities[lineIndex]) break;
        usedWidth += width;
        take++;
      }

      // Keep an ASCII word together when it fits on a fresh line. Very long
      // URLs may still wrap, preventing them from shrinking the entire line.
      if (
        offset + take < characters.length &&
        isAsciiWordCharacter(characters[offset + take]) &&
        isAsciiWordCharacter(characters[offset + take - 1])
      ) {
        let wordStart = take - 1;
        while (
          wordStart > 0 &&
          isAsciiWordCharacter(characters[offset + wordStart - 1])
        ) {
          wordStart--;
        }
        if (wordStart > 0) take = wordStart;
      }

      // Keep bracketed citations such as [45] and [20, 23, 25] on one line.
      // A citation is short enough to fit on a fresh line, and splitting it
      // after '[' or before ']' is much more distracting than a ragged edge.
      const provisional = characters.slice(offset, offset + take).join("");
      const openCitation = provisional.lastIndexOf("[");
      const closeCitation = provisional.lastIndexOf("]");
      if (openCitation > closeCitation && openCitation > 0) {
        take = openCitation;
      }

      while (
        offset + take < characters.length &&
        closingPunctuation.includes(characters[offset + take]) &&
        usedWidth + characterWidthUnits(characters[offset + take]) <=
          capacities[lineIndex] + 1.2
      ) {
        usedWidth += characterWidthUnits(characters[offset + take]);
        take++;
      }
      while (
        take > 1 &&
        openingPunctuation.includes(characters[offset + take - 1])
      ) {
        take--;
      }
      chunks[lineIndex] = characters.slice(offset, offset + take);
      offset += take;
    }

    // If the translation is longer than the estimated total capacity, retain
    // it on the final selected line and let fitText shrink that line slightly.
    if (offset < characters.length) {
      chunks[chunks.length - 1].push(...characters.slice(offset));
    }

    // Avoid a short semantic tail such as "资源有限。" on the final line by
    // moving a few characters from the preceding line. This remains local to
    // the final two lines, so the paragraph still fills normally from the top.
    let lastLine = chunks.length - 1;
    while (lastLine > 0 && chunks[lastLine].length === 0) lastLine--;
    if (lastLine > 0) {
      const orphanThreshold = Math.min(
        capacities[lastLine],
        Math.max(7, Math.round(capacities[lastLine] * 0.3)),
      );
      const missing = orphanThreshold - chunks[lastLine].length;
      const previous = chunks[lastLine - 1];
      if (missing > 0 && previous.length > missing + orphanThreshold) {
        let move = missing;
        while (
          move < previous.length &&
          closingPunctuation.includes(previous[previous.length - move])
        ) {
          move++;
        }
        chunks[lastLine].unshift(...previous.splice(previous.length - move));
      }
    }

    for (let index = 0; index < chunks.length; index++) {
      result[index] = chunks[index].join("").trim();
    }
    return result;
  }

  private ensureAnnotationBridge(state: ReaderState): void {
    clearTimeout(state.annotationBridgeRetryTimer);
    if (this.setupAnnotationBridge(state)) return;
    state.annotationBridgeRetryTimer = setTimeout(() => {
      if (this.isStateAlive(state)) this.ensureAnnotationBridge(state);
    }, 100);
  }

  private setupAnnotationBridge(state: ReaderState): boolean {
    try {
      this.refreshBestReader(state);

      // The translated annotation layer and its event interception live in the
      // PDF iframe itself. They must not depend on Zotero's private annotation
      // Shadow DOM fields: Zotero 9 builds no longer consistently expose
      // `_annotationShadowRoot` or `_annotationRenderRootEl`. Previously the
      // early return below prevented every translated annotation feature from
      // starting even though annotations and text mappings were available.
      this.ensureAnnotationProxyRoot(state);
      if (!state.annotationBridgeEventsAttached) {
        for (const eventName of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "mousedown",
          "mouseup",
          "click",
        ]) {
          state.pdfWindow.addEventListener(
            eventName,
            state.onNativeAnnotationEvent,
            true,
          );
        }
        state.annotationBridgeEventsAttached = true;
      }

      const view = state.reader?._internalReader?._primaryView;
      const shadowRoot = view?._annotationShadowRoot as ShadowRoot | undefined;
      const renderRoot = view?._annotationRenderRootEl as
        | HTMLElement
        | undefined;

      // Native-root access is only an optional enhancement used to hide
      // Zotero's own source-coordinate SVG. Proxy underlines, translated hit
      // targets, language switching and popup routing continue without it.
      if (!shadowRoot || !renderRoot) return false;
      if (
        state.annotationShadowRoot === shadowRoot &&
        state.annotationRenderRoot === renderRoot &&
        state.annotationObserver
      ) {
        return true;
      }

      state.annotationObserver?.disconnect();
      state.annotationShadowRoot = shadowRoot;
      state.annotationRenderRoot = renderRoot;
      if (!shadowRoot.getElementById(ANNOTATION_SHADOW_STYLE_ID)) {
        const style = state.pdfWindow.document.createElement("style");
        style.id = ANNOTATION_SHADOW_STYLE_ID;
        style.textContent = `
          .${NATIVE_ANNOTATION_HIDDEN_CLASS} {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
          #annotation-render-root.${NATIVE_SELECTION_HIDDEN_CLASS}
            rect[fill="none"],
          #annotation-render-root.${NATIVE_SELECTION_HIDDEN_CLASS}
            rect[stroke-dasharray] {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
          }
          #annotation-render-root.${NATIVE_INTERACTION_DISABLED_CLASS}
            .annotation-container,
          #annotation-render-root.${NATIVE_INTERACTION_DISABLED_CLASS}
            .annotation-div,
          #annotation-render-root.${NATIVE_INTERACTION_DISABLED_CLASS}
            .inherit-pointer-events,
          #annotation-render-root.${NATIVE_INTERACTION_DISABLED_CLASS}
            .needs-pointer-events,
          :host(.${NATIVE_INTERACTION_DISABLED_CLASS})
            .annotation-container,
          :host(.${NATIVE_INTERACTION_DISABLED_CLASS}) .annotation-div,
          :host(.${NATIVE_INTERACTION_DISABLED_CLASS})
            .inherit-pointer-events,
          :host(.${NATIVE_INTERACTION_DISABLED_CLASS})
            .needs-pointer-events {
            pointer-events: none !important;
          }
        `;
        shadowRoot.append(style);
      }

      this.updateNativeAnnotationInteraction(state);
      const Observer = state.pdfWindow.MutationObserver;
      const observer = new Observer(() => this.scheduleAnnotationSync(state));
      observer.observe(renderRoot, {
        childList: true,
        subtree: true,
      });
      state.annotationObserver = observer;
      this.scheduleAnnotationSync(state);
      return true;
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to attach annotation bridge: ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  private ensureAnnotationProxyRoot(state: ReaderState): HTMLElement {
    let root = state.pdfWindow.document.getElementById(
      ANNOTATION_PROXY_ROOT_ID,
    ) as HTMLElement | null;
    if (!root) {
      root = state.pdfWindow.document.createElement("div");
      root.id = ANNOTATION_PROXY_ROOT_ID;
      state.pdfWindow.document.body?.append(root);
    }
    state.annotationProxyRoot = root;
    return root;
  }

  private scheduleAnnotationSync(state: ReaderState): void {
    clearTimeout(state.annotationSyncTimer);
    state.annotationSyncTimer = setTimeout(() => {
      if (!this.isStateAlive(state)) return;
      try {
        this.ensureAnnotationBridge(state);
        this.syncAnnotationVisuals(state);
      } catch (error) {
        state.annotationLastSyncError = getErrorMessage(error);
        Zotero.debug(
          `[Inline Translate] Unable to synchronize annotations: ${getErrorMessage(error)}`,
        );
      }
    }, 16);
  }

  private syncAnnotationVisuals(state: ReaderState): void {
    state.annotationSyncRuns = (state.annotationSyncRuns || 0) + 1;
    state.annotationLastSyncError = undefined;
    const root = this.ensureAnnotationProxyRoot(state);
    root.replaceChildren();
    this.removeNodes(state.pdfWindow.document, `.${NATIVE_PAINT_MASK_CLASS}`);
    this.renderTranslationHitTargets(state, root);
    this.restoreNativeAnnotationVisuals(state);
    this.updateNativeAnnotationInteraction(state);
    if (!state.visible) {
      state.annotationLastSyncMatchCount = 0;
      state.annotationLastSyncProxyCount = 0;
      this.syncNativeAnnotationRendering(state, new Set());
      return;
    }
    if (state.sourceSelectedAnnotationID) {
      this.renderSourceAnnotationSelection(
        state,
        root,
        state.sourceSelectedAnnotationID,
      );
      this.positionSourceAnnotationPopup(
        state,
        state.sourceSelectedAnnotationID,
      );
    }

    const matches = this.getAnnotationOverlayMatches(state);
    state.annotationLastSyncMatchCount = matches.length;
    if (!matches.length) {
      state.annotationLastSyncProxyCount = 0;
      this.syncNativeAnnotationRendering(state, new Set());
      return;
    }
    const selectedIDs = this.getSelectedAnnotationIDs(state);
    const hiddenIDs = new Set(
      matches.map((match) => String(match.annotation.id)),
    );
    this.syncNativeAnnotationRendering(state, hiddenIDs);
    this.hideNativeAnnotationVisuals(state, hiddenIDs, selectedIDs);

    for (const match of matches) {
      this.renderAnnotationProxy(
        state,
        root,
        match,
        selectedIDs.has(String(match.annotation.id)) ||
          state.proxySelectedAnnotationID === String(match.annotation.id),
      );
    }
    state.annotationLastSyncProxyCount = root.querySelectorAll(
      `.${ANNOTATION_PROXY_CLASS}`,
    ).length;

    const selectedProxyID =
      (state.proxySelectedAnnotationID &&
      hiddenIDs.has(state.proxySelectedAnnotationID)
        ? state.proxySelectedAnnotationID
        : undefined) || [...selectedIDs].find((id) => hiddenIDs.has(id));
    if (selectedProxyID) {
      for (const match of matches) {
        if (String(match.annotation.id) === selectedProxyID) {
          this.renderNativeAnnotationPaintMask(state, match.annotation);
        }
      }
    }
    const outerDocument = state.reader?._iframeWindow?.document as
      | Document
      | undefined;
    if (selectedProxyID && outerDocument?.querySelector(".annotation-popup")) {
      this.openAnnotationPopupAtProxy(state, selectedProxyID, false);
    } else if (!outerDocument?.querySelector(".annotation-popup")) {
      state.lastPopupPositionKey = undefined;
    }
  }

  private getAnnotationOverlayMatches(
    state: ReaderState,
    visibleOnly = true,
  ): AnnotationOverlayMatch[] {
    const annotations = this.getReaderAnnotations(state);
    if (!annotations || typeof annotations.length !== "number") return [];
    const overlays = this.store
      .getForAttachment(state.attachmentKey)
      .filter(
        (overlay) =>
          !visibleOnly || this.isOverlayTranslationVisible(state, overlay.id),
      );
    if (!overlays.length) return [];

    const matches: AnnotationOverlayMatch[] = [];
    for (
      let annotationIndex = 0;
      annotationIndex < annotations.length;
      annotationIndex++
    ) {
      const annotation = annotations[annotationIndex];
      if (
        !annotation?.id ||
        !["highlight", "underline"].includes(String(annotation.type))
      ) {
        continue;
      }
      const position = annotation.position;
      const pageIndex = Number(position?.pageIndex);
      const annotationRegions: TranslationRegion[] = [];
      if (Number.isInteger(pageIndex)) {
        const rects = copyRects(position?.rects);
        if (rects.length) {
          annotationRegions.push({ pageIndex, rects, original: "" });
        }
        const nextPageRects = copyRects(position?.nextPageRects);
        if (nextPageRects.length) {
          annotationRegions.push({
            pageIndex: pageIndex + 1,
            rects: nextPageRects,
            original: "",
          });
        }
      }
      if (!annotationRegions.length) continue;

      let bestOverlay: TranslationOverlay | undefined;
      let bestIntersection = 0;
      for (const overlay of overlays) {
        let intersection = 0;
        for (const annotationRegion of annotationRegions) {
          for (const overlayRegion of this.getOverlayRegions(overlay)) {
            if (annotationRegion.pageIndex !== overlayRegion.pageIndex)
              continue;
            for (const annotationRect of annotationRegion.rects) {
              for (const overlayRect of overlayRegion.rects) {
                intersection += rectIntersectionArea(
                  annotationRect,
                  overlayRect,
                );
              }
            }
          }
        }
        if (intersection > bestIntersection) {
          bestIntersection = intersection;
          bestOverlay = overlay;
        }
      }
      if (!bestOverlay || bestIntersection <= 0) continue;

      const source = normalizeText(bestOverlay.original);
      const target = normalizeText(bestOverlay.translation);
      if (!source || !target) continue;
      const annotationText = normalizeText(annotation.text);
      let sourceStart = annotationText
        ? source.toLocaleLowerCase().indexOf(annotationText.toLocaleLowerCase())
        : -1;
      let sourceEnd =
        sourceStart >= 0 ? sourceStart + annotationText.length : -1;
      if (sourceStart < 0) {
        [sourceStart, sourceEnd] = this.estimateAnnotationSourceRange(
          bestOverlay,
          annotationRegions,
          source.length,
        );
      }
      const [targetStart, targetEnd] = this.mapOverlaySourceRangeToTarget(
        bestOverlay,
        sourceStart,
        sourceEnd,
      );
      matches.push({
        annotation,
        overlay: bestOverlay,
        targetStart,
        targetEnd,
      });
    }
    return matches;
  }

  private estimateAnnotationSourceRange(
    overlay: TranslationOverlay,
    annotationRegions: TranslationRegion[],
    sourceLength: number,
  ): [number, number] {
    const overlayRegions = this.getOverlayRegions(overlay);
    const hits: number[] = [];
    let lineOffset = 0;
    let totalLines = 0;
    for (const overlayRegion of overlayRegions) {
      for (
        let lineIndex = 0;
        lineIndex < overlayRegion.rects.length;
        lineIndex++
      ) {
        const overlayRect = overlayRegion.rects[lineIndex];
        const overlaps = annotationRegions.some(
          (annotationRegion) =>
            annotationRegion.pageIndex === overlayRegion.pageIndex &&
            annotationRegion.rects.some(
              (annotationRect) =>
                rectIntersectionArea(annotationRect, overlayRect) > 0,
            ),
        );
        if (overlaps) hits.push(lineOffset + lineIndex);
      }
      lineOffset += overlayRegion.rects.length;
      totalLines += overlayRegion.rects.length;
    }
    if (!hits.length || !totalLines) return [0, sourceLength];
    const first = Math.min(...hits);
    const last = Math.max(...hits) + 1;
    return [
      Math.floor((first / totalLines) * sourceLength),
      Math.max(1, Math.ceil((last / totalLines) * sourceLength)),
    ];
  }

  private isOverlayTranslationVisible(
    state: ReaderState,
    overlayID: string,
  ): boolean {
    const node = state.pdfWindow.document.querySelector<HTMLElement>(
      `.${OVERLAY_NODE_CLASS}[data-rpt-id="${overlayID}"]`,
    );
    return Boolean(node && !node.classList.contains("rpt-show-original"));
  }

  private renderTranslationHitTargets(
    state: ReaderState,
    root: HTMLElement,
  ): void {
    if (!state.visible) return;
    const nodes = state.pdfWindow.document.querySelectorAll<HTMLElement>(
      `.${OVERLAY_NODE_CLASS}:not(.rpt-show-original)`,
    );
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes.item(index);
      const overlayID = node?.dataset.rptId;
      if (!node || !overlayID) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      const target = state.pdfWindow.document.createElement("div");
      target.className = TRANSLATION_HIT_TARGET_CLASS;
      target.dataset.rptId = overlayID;
      target.style.left = `${rect.left}px`;
      target.style.top = `${rect.top}px`;
      target.style.width = `${rect.width}px`;
      target.style.height = `${rect.height}px`;
      root.append(target);
    }
  }

  private findOverlayAtEventPoint(
    state: ReaderState,
    event: Event,
    translatedOnly: boolean,
  ): HTMLElement | undefined {
    try {
      const clientX = Number((event as MouseEvent).clientX);
      const clientY = Number((event as MouseEvent).clientY);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      const selector = translatedOnly
        ? `.${OVERLAY_NODE_CLASS}:not(.rpt-show-original)`
        : `.${OVERLAY_NODE_CLASS}`;
      const nodes =
        state.pdfWindow.document.querySelectorAll<HTMLElement>(selector);
      for (let index = nodes.length - 1; index >= 0; index--) {
        const node = nodes.item(index);
        const rect = node?.getBoundingClientRect();
        if (
          node &&
          rect &&
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return node;
        }
      }
    } catch {
      // Coordinate lookup is a fallback for events owned by Zotero's shadow
      // tree. Ignore it if the reader is already being destroyed.
    }
    return undefined;
  }

  private findAnnotationProxyAtEventPoint(
    state: ReaderState,
    event: Event,
  ): HTMLElement | undefined {
    try {
      const clientX = Number((event as MouseEvent).clientX);
      const clientY = Number((event as MouseEvent).clientY);
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      const proxies = state.pdfWindow.document.querySelectorAll<HTMLElement>(
        `.${ANNOTATION_PROXY_CLASS}:not(.${ANNOTATION_SELECTION_CLASS})[data-annotation-id]`,
      );
      for (let index = proxies.length - 1; index >= 0; index--) {
        const proxy = proxies.item(index);
        const rect = proxy?.getBoundingClientRect();
        if (
          proxy &&
          rect &&
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          return proxy;
        }
      }
    } catch {
      // Ignore coordinate lookup while the reader is being destroyed.
    }
    return undefined;
  }

  private updateNativeAnnotationInteraction(state: ReaderState): void {
    try {
      const translatedOverlay = state.visible
        ? state.pdfWindow.document.querySelector(
            `.${OVERLAY_NODE_CLASS}:not(.rpt-show-original)`,
          )
        : null;
      const disabled = Boolean(translatedOverlay);
      const renderRoot = state.annotationRenderRoot;
      const shadowHost = state.annotationShadowRoot?.host as
        | HTMLElement
        | undefined;
      renderRoot?.classList.toggle(NATIVE_INTERACTION_DISABLED_CLASS, disabled);
      shadowHost?.classList.toggle(NATIVE_INTERACTION_DISABLED_CLASS, disabled);

      // Zotero already uses this class to suppress its annotation hit targets.
      // Apply it to every annotation SVG too, so a React rerender cannot expose
      // a target between our synchronization passes.
      const containers = state.annotationShadowRoot?.querySelectorAll(
        ".annotation-container",
      );
      if (containers) {
        for (let index = 0; index < containers.length; index++) {
          containers
            .item(index)
            ?.classList.toggle("disable-pointer-events", disabled);
        }
      }
    } catch {
      // The annotation shadow tree may disappear while a reader is closing.
    }
  }

  private getSelectedAnnotationIDs(state: ReaderState): Set<string> {
    const selected =
      state.reader?._internalReader?._primaryView?._selectedAnnotationIDs;
    const ids = new Set<string>();
    if (!selected || typeof selected.length !== "number") return ids;
    for (let index = 0; index < selected.length; index++) {
      if (selected[index]) ids.add(String(selected[index]));
    }
    return ids;
  }

  private syncNativeAnnotationRendering(
    state: ReaderState,
    _hiddenIDs: Set<string>,
  ): void {
    // Zotero 9's PDFView.setAnnotations() replaces the complete annotation
    // array, and PDFView has no matching unsetAnnotations() API. The previous
    // compatibility path therefore never removed the source annotation, but
    // could replace the whole PDF annotation list with one item while trying
    // to restore it. Keep the native model intact at all times; source visuals
    // are suppressed only by CSS/paint masks, so the exact native annotation
    // remains available when a Chinese annotation phrase is clicked.
    state.nativeHiddenAnnotations?.clear();
  }

  private renderNativeAnnotationPaintMask(
    state: ReaderState,
    annotation: any,
  ): void {
    const position = annotation?.position;
    if (!position || !Number.isInteger(position.pageIndex)) return;
    const regions = [
      {
        pageIndex: Number(position.pageIndex),
        rects: copyRects(position.rects),
      },
      {
        pageIndex: Number(position.pageIndex) + 1,
        rects: copyRects(position.nextPageRects),
      },
    ];

    for (const region of regions) {
      if (!region.rects.length) continue;
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(
          region.pageIndex,
        );
      if (!pageView?.div || !pageView.viewport) continue;
      // Copy primitives one at a time. Zotero's PDF viewer objects live in a
      // different compartment, where destructuring the protected array may
      // throw "Permission denied to pass object to privileged code".
      const transform = pageView.viewport.transform;
      const a = Number(transform[0]);
      const b = Number(transform[1]);
      const c = Number(transform[2]);
      const d = Number(transform[3]);
      const e = Number(transform[4]);
      const f = Number(transform[5]);
      let left = Number.POSITIVE_INFINITY;
      let top = Number.POSITIVE_INFINITY;
      let right = Number.NEGATIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const rect of region.rects) {
        const x1 = a * rect[0] + c * rect[1] + e;
        const y1 = b * rect[0] + d * rect[1] + f;
        const x2 = a * rect[2] + c * rect[3] + e;
        const y2 = b * rect[2] + d * rect[3] + f;
        left = Math.min(left, x1, x2);
        top = Math.min(top, y1, y2);
        right = Math.max(right, x1, x2);
        bottom = Math.max(bottom, y1, y2);
      }
      if (!Number.isFinite(left) || !Number.isFinite(top)) continue;

      // Zotero paints the source selection directly onto the PDF page canvas,
      // including a roughly 5 px dashed border. A white mask just above that
      // canvas erases the source-coordinate paint, while the translated text
      // nodes (z-index 20) and Chinese proxy frame remain above the mask.
      const padding = 9;
      const mask = state.pdfWindow.document.createElement("div");
      mask.className = NATIVE_PAINT_MASK_CLASS;
      mask.dataset.rptPageIndex = String(region.pageIndex);
      mask.style.left = `${left - padding}px`;
      mask.style.top = `${top - padding}px`;
      mask.style.width = `${right - left + padding * 2}px`;
      mask.style.height = `${bottom - top + padding * 2}px`;
      pageView.div.append(mask);
    }
  }

  private hideNativeAnnotationVisuals(
    state: ReaderState,
    hiddenIDs: Set<string>,
    selectedIDs: Set<string>,
  ): void {
    const root = state.annotationRenderRoot;
    if (!root) return;
    const nativeNodes = root.querySelectorAll("[data-annotation-id]");
    for (let index = 0; index < nativeNodes.length; index++) {
      const node = nativeNodes.item(index);
      const id = node?.getAttribute("data-annotation-id");
      if (id && hiddenIDs.has(id)) {
        node.classList.add(NATIVE_ANNOTATION_HIDDEN_CLASS);
      }
    }
    const hidesSelectedBorder = [...selectedIDs].some((id) =>
      hiddenIDs.has(id),
    );
    root.classList.toggle(NATIVE_SELECTION_HIDDEN_CLASS, hidesSelectedBorder);
    if (hidesSelectedBorder) {
      const selectionRects = root.querySelectorAll(
        'rect[fill="none"], rect[stroke-dasharray]',
      );
      for (let index = 0; index < selectionRects.length; index++) {
        selectionRects
          .item(index)
          ?.classList.add(NATIVE_ANNOTATION_HIDDEN_CLASS);
      }
    }
  }

  private restoreNativeAnnotationVisuals(state: ReaderState): void {
    try {
      const root = state.annotationRenderRoot;
      if (!root) return;
      const hidden = root.querySelectorAll(
        `.${NATIVE_ANNOTATION_HIDDEN_CLASS}`,
      );
      for (let index = 0; index < hidden.length; index++) {
        hidden.item(index)?.classList.remove(NATIVE_ANNOTATION_HIDDEN_CLASS);
      }
      root.classList.remove(NATIVE_SELECTION_HIDDEN_CLASS);
    } catch {
      // The annotation shadow root may already be a dead object during close.
    }
  }

  private renderAnnotationProxy(
    state: ReaderState,
    root: HTMLElement,
    match: AnnotationOverlayMatch,
    selected: boolean,
  ): void {
    const nodeList = state.pdfWindow.document.querySelectorAll(
      `.${OVERLAY_NODE_CLASS}[data-rpt-id="${match.overlay.id}"]`,
    );
    const nodes: HTMLElement[] = [];
    for (let index = 0; index < nodeList.length; index++) {
      const node = nodeList.item(index);
      // `node` already comes from this PDF document. Checking it against the
      // iframe's HTMLElement constructor crosses Firefox compartments and can
      // throw "Permission denied to pass object to privileged code".
      if (node) nodes.push(node);
    }
    nodes.sort((a, b) => {
      const regionDifference =
        Number(a.dataset.rptRegionIndex) - Number(b.dataset.rptRegionIndex);
      return (
        regionDifference ||
        Number(a.dataset.rptLineIndex) - Number(b.dataset.rptLineIndex)
      );
    });
    const actualLength = nodes.reduce(
      (sum, node) => sum + (node.textContent?.length || 0),
      0,
    );
    const normalizedLength = Math.max(
      1,
      normalizeText(match.overlay.translation).length,
    );
    if (!actualLength) return;
    const actualStart = Math.max(
      0,
      Math.floor((match.targetStart / normalizedLength) * actualLength),
    );
    const actualEnd = Math.max(
      actualStart + 1,
      Math.ceil((match.targetEnd / normalizedLength) * actualLength),
    );
    const selectionBounds = new Map<
      string,
      { left: number; top: number; right: number; bottom: number }
    >();
    let offset = 0;
    for (const node of nodes) {
      const lineLength = node.textContent?.length || 0;
      const overlapStart = Math.max(actualStart, offset);
      const overlapEnd = Math.min(actualEnd, offset + lineLength);
      if (lineLength && overlapEnd > overlapStart) {
        const range = this.createDescendantTextRange(
          state.pdfWindow.document,
          node,
          overlapStart - offset,
          overlapEnd - offset,
        );
        if (!range) {
          offset += lineLength;
          continue;
        }
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const proxy = state.pdfWindow.document.createElement("div");
          proxy.className = ANNOTATION_PROXY_CLASS;
          proxy.dataset.annotationId = String(match.annotation.id);
          proxy.dataset.rptId = match.overlay.id;
          proxy.style.left = `${rect.left - 3}px`;
          proxy.style.top = `${rect.top - 2}px`;
          proxy.style.width = `${rect.width + 6}px`;
          proxy.style.height = `${rect.height + 4}px`;
          proxy.style.backgroundColor = colorWithAlpha(
            match.annotation.color,
            match.annotation.type === "underline" ? 0.08 : 0.22,
          );
          if (match.annotation.type === "underline") {
            proxy.classList.add("rpt-underline");
            proxy.style.borderBottomColor = String(
              match.annotation.color || "#ffd400",
            );
          }
          root.append(proxy);
          const pageKey = node.dataset.rptPageIndex || "page";
          const bounds = selectionBounds.get(pageKey);
          const proxyLeft = rect.left - 3;
          const proxyTop = rect.top - 2;
          const proxyRight = rect.right + 3;
          const proxyBottom = rect.bottom + 2;
          if (bounds) {
            bounds.left = Math.min(bounds.left, proxyLeft);
            bounds.top = Math.min(bounds.top, proxyTop);
            bounds.right = Math.max(bounds.right, proxyRight);
            bounds.bottom = Math.max(bounds.bottom, proxyBottom);
          } else {
            selectionBounds.set(pageKey, {
              left: proxyLeft,
              top: proxyTop,
              right: proxyRight,
              bottom: proxyBottom,
            });
          }
        }
      }
      offset += lineLength;
    }

    if (selected) {
      for (const bounds of selectionBounds.values()) {
        const selection = state.pdfWindow.document.createElement("div");
        selection.className = `${ANNOTATION_PROXY_CLASS} ${ANNOTATION_SELECTION_CLASS}`;
        selection.dataset.annotationId = String(match.annotation.id);
        selection.dataset.rptId = match.overlay.id;
        selection.style.left = `${bounds.left}px`;
        selection.style.top = `${bounds.top}px`;
        selection.style.width = `${bounds.right - bounds.left}px`;
        selection.style.height = `${bounds.bottom - bounds.top}px`;
        root.append(selection);
      }
    }
  }

  private createDescendantTextRange(
    document: Document,
    element: HTMLElement,
    requestedStart: number,
    requestedEnd: number,
  ): Range | undefined {
    // Translation lines may contain nested spans for bold/italic/CJK fallback
    // styling. Range offsets are local to one Text node, so using the full
    // element text length against `firstChild` raises IndexSizeError as soon as
    // a styled span is present. Resolve the offsets across all descendant text
    // nodes instead.
    const walker = document.createTreeWalker(element, 4); // SHOW_TEXT
    let absoluteOffset = 0;
    let startNode: Text | undefined;
    let startOffset = 0;
    let endNode: Text | undefined;
    let endOffset = 0;
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      const length = textNode.data?.length || 0;
      const nodeEnd = absoluteOffset + length;
      if (!startNode && requestedStart <= nodeEnd) {
        startNode = textNode;
        startOffset = Math.max(
          0,
          Math.min(length, requestedStart - absoluteOffset),
        );
      }
      if (requestedEnd <= nodeEnd) {
        endNode = textNode;
        endOffset = Math.max(
          0,
          Math.min(length, requestedEnd - absoluteOffset),
        );
        break;
      }
      absoluteOffset = nodeEnd;
      current = walker.nextNode();
    }
    if (!startNode || !endNode) return undefined;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  private handleNativeAnnotationEvent(state: ReaderState, event: Event): void {
    if (!state.visible) return;
    if (event.type === "pointerdown") {
      const pointerEvent = event as PointerEvent;
      if (Number(pointerEvent.button) === 0) {
        state.leftPointerStart = {
          x: Number(pointerEvent.clientX),
          y: Number(pointerEvent.clientY),
        };
        state.leftPointerDragged = false;
      }
    } else if (event.type === "pointermove" && state.leftPointerStart) {
      const pointerEvent = event as PointerEvent;
      const deltaX = Number(pointerEvent.clientX) - state.leftPointerStart.x;
      const deltaY = Number(pointerEvent.clientY) - state.leftPointerStart.y;
      if (Math.hypot(deltaX, deltaY) >= 4) {
        state.leftPointerDragged = true;
      }
    }
    if (event.type === "pointerdown") {
      const button = Number((event as PointerEvent).button);
      const clientX = Number((event as PointerEvent).clientX);
      const clientY = Number((event as PointerEvent).clientY);
      const translatedNode = this.findOverlayAtEventPoint(state, event, true);
      const proxyNodes = state.pdfWindow.document.querySelectorAll<HTMLElement>(
        `.${ANNOTATION_PROXY_CLASS}:not(.${ANNOTATION_SELECTION_CLASS})[data-annotation-id]`,
      );
      const proxyRects: Record<string, any>[] = [];
      for (let index = 0; index < proxyNodes.length; index++) {
        const proxy = proxyNodes.item(index);
        const rect = proxy?.getBoundingClientRect();
        if (!proxy || !rect) continue;
        proxyRects.push({
          annotationID: proxy.dataset.annotationId,
          overlayID: proxy.dataset.rptId,
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          contains:
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom,
        });
      }
      const translatedAnnotation =
        button === 0
          ? this.findAnnotationProxyAtEventPoint(state, event)
          : undefined;
      const annotationID = translatedAnnotation?.dataset.annotationId;
      const annotationOverlayID = translatedAnnotation?.dataset.rptId;
      const diagnostic: Record<string, any> = {
        event: "pointerdown",
        time: new Date().toISOString(),
        button,
        clientX,
        clientY,
        translatedOverlayID: translatedNode?.dataset.rptId,
        proxyHitAnnotationID: annotationID,
        proxyHitOverlayID: annotationOverlayID,
        proxyRects,
        branch: "none",
        snapshot: this.buildAnnotationDiagnosticSnapshot(
          state,
          translatedNode?.dataset.rptId,
        ),
      };
      state.annotationDiagnostic = diagnostic;
      setTimeout(() => {
        diagnostic.after = {
          sourceSelectedAnnotationID: state.sourceSelectedAnnotationID,
          proxySelectedAnnotationID: state.proxySelectedAnnotationID,
          popupExists: Boolean(
            state.reader?._iframeWindow?.document?.querySelector?.(
              ".annotation-popup",
            ),
          ),
          sourceFrameCount: state.pdfWindow.document.querySelectorAll(
            `.${ANNOTATION_SELECTION_CLASS}[data-rpt-source="true"]`,
          ).length,
          overlayStillTranslated: diagnostic.translatedOverlayID
            ? this.isOverlayTranslationVisible(
                state,
                String(diagnostic.translatedOverlayID),
              )
            : undefined,
        };
        this.recordAnnotationDiagnostic(diagnostic);
      }, 250);
      if (button === 0 && annotationID && annotationOverlayID) {
        diagnostic.branch = "annotation-proxy";
        event.preventDefault();
        event.stopImmediatePropagation();
        state.nativeAnnotationSuppressedUntil = Date.now() + 500;
        this.revealSourceAnnotation(state, annotationOverlayID, annotationID);
        return;
      }

      if (translatedNode && button === 0) {
        diagnostic.branch = "generic-translation";
        event.preventDefault();
        event.stopImmediatePropagation();
        state.nativeAnnotationSuppressedUntil = Date.now() + 500;
        const overlayID = translatedNode.dataset.rptId;
        if (overlayID) {
          try {
            this.closeAnnotationPopup(state);
          } finally {
            this.setOverlayShowsOriginal(state, overlayID, true);
          }
        }
        return;
      }
    }
    if (event.type !== "pointerdown") {
      if (Date.now() < (state.nativeAnnotationSuppressedUntil || 0)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === "mousedown" && state.proxySelectedAnnotationID) {
          const annotationID = state.proxySelectedAnnotationID;
          setTimeout(() => {
            if (
              this.isStateAlive(state) &&
              state.proxySelectedAnnotationID === annotationID
            ) {
              this.clearNativeSelectionKeepingPopup(state);
              this.openAnnotationPopupAtProxy(state, annotationID, false);
            }
          }, 0);
        }
        if (event.type === "click") {
          state.nativeAnnotationSuppressedUntil = undefined;
        }
      }
      return;
    }
    let annotationID: string | undefined;
    for (const entry of event.composedPath()) {
      const node = entry as Element;
      if (typeof node?.getAttribute !== "function") continue;
      const id = node.getAttribute("data-annotation-id");
      if (id) {
        annotationID = id;
        break;
      }
    }
    if (!annotationID) return;
    if (state.annotationDiagnostic) {
      state.annotationDiagnostic.pathAnnotationID = annotationID;
    }

    const match = this.getAnnotationOverlayMatches(state, false).find(
      (candidate) => String(candidate.annotation.id) === annotationID,
    );
    if (!match) return;
    const translated = this.isOverlayTranslationVisible(
      state,
      match.overlay.id,
    );

    if (translated) {
      if (state.annotationDiagnostic) {
        state.annotationDiagnostic.branch = "native-annotation-fallback";
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      state.nativeAnnotationSuppressedUntil = Date.now() + 500;
      this.revealSourceAnnotation(state, match.overlay.id, annotationID);
      return;
    }

    // Do not let Zotero select the source annotation. Its PDF canvas would
    // paint a blue frame and comment card at the English coordinates. Instead,
    // select only our Chinese proxy and open the same annotation popup with a
    // rect derived from that proxy.
    event.preventDefault();
    event.stopImmediatePropagation();
    state.nativeAnnotationSuppressedUntil = Date.now() + 500;
    // Cover the source-coordinate paint before asking Zotero to create the
    // popup. onSetAnnotationPopup may synchronously paint its native selected
    // frame, so waiting for the annotation observer would expose it for a
    // frame. The normal synchronization pass will replace this provisional
    // mask with the same geometry after the Chinese overlay is visible.
    this.showTranslatedAnnotation(
      state,
      match.overlay.id,
      annotationID,
      match.annotation,
    );
  }

  private showTranslatedAnnotation(
    state: ReaderState,
    overlayID: string,
    annotationID: string,
    annotation: any,
  ): void {
    this.renderNativeAnnotationPaintMask(state, annotation);
    this.closeAnnotationPopup(state);
    state.sourceSelectedAnnotationID = undefined;
    state.drawSourceSelectionProxy = undefined;
    state.proxySelectedAnnotationID = annotationID;
    this.setOverlayShowsOriginal(state, overlayID, false);
    this.syncAnnotationVisuals(state);
    this.openAnnotationPopupAfterMaskPaint(state, annotationID);
  }

  private revealSourceAnnotation(
    state: ReaderState,
    overlayID: string,
    annotationID: string,
  ): void {
    const popupAnnotationID = String(
      state.reader?._internalReader?._state?.primaryViewAnnotationPopup
        ?.annotation?.id || "",
    );
    const hadChineseAnnotationSelection =
      state.proxySelectedAnnotationID === annotationID ||
      popupAnnotationID === annotationID ||
      this.getSelectedAnnotationIDs(state).has(annotationID);
    if (state.annotationDiagnostic) {
      state.annotationDiagnostic.revealSource = {
        overlayID,
        annotationID,
        entered: true,
      };
    }
    try {
      this.closeAnnotationPopup(state);
    } finally {
      this.setOverlayShowsOriginal(state, overlayID, true);
    }
    state.sourceSelectedAnnotationID = annotationID;
    // An already-open Chinese popup leaves Zotero's own source selection frame
    // active during the language switch. Reuse that one; otherwise draw the
    // single source proxy needed when no annotation was previously selected.
    state.drawSourceSelectionProxy = !hadChineseAnnotationSelection;
    this.syncAnnotationVisuals(state);
    this.openSourceAnnotationPopup(state, annotationID);
  }

  private setOverlayShowsOriginal(
    state: ReaderState,
    overlayID: string,
    showOriginal: boolean,
  ): void {
    const nodes = state.pdfWindow.document.querySelectorAll<HTMLElement>(
      `.${OVERLAY_NODE_CLASS}[data-rpt-id="${overlayID}"]`,
    );
    for (let index = 0; index < nodes.length; index++) {
      nodes.item(index)?.classList.toggle("rpt-show-original", showOriginal);
    }
    this.updateNativeAnnotationInteraction(state);
    this.scheduleAnnotationSync(state);
  }

  private closeAnnotationPopup(state: ReaderState): void {
    this.cancelPendingAnnotationPopupOpen(state);
    try {
      const internalReader = state.reader?._internalReader;
      const view = internalReader?._primaryView;
      const ownerWindow = state.reader?._iframeWindow;
      let emptyIDs: unknown;
      let cleared = false;

      // Zotero draws the dashed selection border from Reader state. Clear that
      // state synchronously, in the Reader's own realm, before revealing the
      // English page underneath the translation overlay.
      try {
        emptyIDs = ownerWindow
          ? this.cloneIntoReaderRealm([], ownerWindow)
          : undefined;
        const clearedState = ownerWindow
          ? this.cloneIntoReaderRealm(
              {
                selectedAnnotationIDs: [],
                primaryViewAnnotationPopup: null,
                secondaryViewAnnotationPopup: null,
              },
              ownerWindow,
            )
          : undefined;
        if (
          clearedState &&
          typeof internalReader?._updateState === "function"
        ) {
          internalReader._updateState(clearedState);
          cleared = true;
        }
      } catch (error) {
        Zotero.debug(
          `[Inline Translate] Unable to clear Reader annotation state directly: ${getErrorMessage(error)}`,
        );
      }

      if (!cleared && emptyIDs) {
        try {
          internalReader?.setSelectedAnnotations?.(emptyIDs, true);
          view?.setAnnotationPopup?.(null);
        } catch (error) {
          Zotero.debug(
            `[Inline Translate] Unable to close annotation popup through Reader API: ${getErrorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to inspect annotation popup state: ${getErrorMessage(error)}`,
      );
    } finally {
      state.lastPopupPositionKey = undefined;
      state.proxySelectedAnnotationID = undefined;
      state.sourceSelectedAnnotationID = undefined;
      state.drawSourceSelectionProxy = undefined;
    }
  }

  private cloneIntoReaderRealm<T>(value: T, ownerWindow: Window): T {
    return Components.utils.cloneInto(value, ownerWindow, {
      cloneFunctions: false,
    });
  }

  private cancelPendingAnnotationPopupOpen(state: ReaderState): void {
    try {
      if (state.annotationPopupFirstFrame !== undefined) {
        state.pdfWindow.cancelAnimationFrame(state.annotationPopupFirstFrame);
      }
      if (state.annotationPopupSecondFrame !== undefined) {
        state.pdfWindow.cancelAnimationFrame(state.annotationPopupSecondFrame);
      }
    } catch {
      // The PDF window may already be closing.
    }
    clearTimeout(state.annotationPopupFallbackTimer);
    state.annotationPopupFirstFrame = undefined;
    state.annotationPopupSecondFrame = undefined;
    state.annotationPopupFallbackTimer = undefined;
  }

  private openAnnotationPopupAfterMaskPaint(
    state: ReaderState,
    annotationID: string,
  ): void {
    this.cancelPendingAnnotationPopupOpen(state);

    const stabilizeProxySelection = () => {
      if (
        this.isStateAlive(state) &&
        state.proxySelectedAnnotationID === annotationID
      ) {
        this.clearNativeSelectionKeepingPopup(state);
        this.openAnnotationPopupAtProxy(state, annotationID, false);
      }
    };
    const openPopup = () => {
      state.annotationPopupFirstFrame = undefined;
      state.annotationPopupSecondFrame = undefined;
      state.annotationPopupFallbackTimer = undefined;
      if (
        !this.isStateAlive(state) ||
        state.proxySelectedAnnotationID !== annotationID
      ) {
        return;
      }
      this.openAnnotationPopupAtProxy(state, annotationID, true);
      stabilizeProxySelection();
      void Promise.resolve().then(stabilizeProxySelection);
      for (const delay of [30, 80, 160]) {
        setTimeout(stabilizeProxySelection, delay);
      }
    };

    try {
      // A double requestAnimationFrame deliberately separates the visual
      // transition into two commits. The first frame paints the Chinese text
      // and source-coordinate mask. Only in the second frame do we ask Zotero
      // to create its native popup, so any asynchronous canvas selection is
      // born underneath an already-composited mask and cannot flash through.
      state.annotationPopupFirstFrame = state.pdfWindow.requestAnimationFrame(
        () => {
          state.annotationPopupFirstFrame = undefined;
          if (
            !this.isStateAlive(state) ||
            state.proxySelectedAnnotationID !== annotationID
          ) {
            return;
          }
          state.annotationPopupSecondFrame =
            state.pdfWindow.requestAnimationFrame(openPopup);
        },
      );
    } catch {
      // Older reader compartments can reject a privileged callback. A short
      // timeout still gives the browser enough time to commit the mask first.
      state.annotationPopupFallbackTimer = setTimeout(openPopup, 50);
    }
  }

  private clearNativeSelectionKeepingPopup(state: ReaderState): void {
    try {
      const internalReader = state.reader?._internalReader;
      const view = internalReader?._primaryView;
      const ownerWindow = state.reader?._iframeWindow;
      const emptyIDs = ownerWindow?.JSON.parse("[]");
      if (!view || !emptyIDs) return;

      // Do not call setSelectedAnnotationIDs(): Zotero closes the correctly
      // positioned popup from inside that method. Clear the two backing fields
      // directly and repaint only the PDF annotation layer.
      try {
        internalReader._state.selectedAnnotationIDs = emptyIDs;
      } catch {
        // Clearing the view field below is sufficient for the PDF canvas.
      }
      try {
        view._selectedAnnotationIDs = emptyIDs;
      } catch {
        // Some PDF-view revisions keep selection in their inner renderer.
      }
      try {
        view._view._selectedAnnotationIDs = emptyIDs;
      } catch {
        // Not every Zotero PDF view has an additional inner view object.
      }
      view._renderAnnotations?.();
      view._render?.();
      view._view?._render?.();
      this.syncAnnotationVisuals(state);
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to clear native selection paint: ${getErrorMessage(error)}`,
      );
    }
  }

  private openAnnotationPopupAtProxy(
    state: ReaderState,
    annotationID: string,
    create: boolean,
  ): void {
    const readerAnnotations = this.getReaderAnnotations(state);
    const view = state.reader?._internalReader?._primaryView;
    let annotation: any;
    if (readerAnnotations && typeof readerAnnotations.length === "number") {
      for (let index = 0; index < readerAnnotations.length; index++) {
        const candidate = readerAnnotations[index];
        if (String(candidate?.id) === annotationID) {
          annotation = candidate;
          break;
        }
      }
    }
    const proxies = state.pdfWindow.document.querySelectorAll<HTMLElement>(
      `.${ANNOTATION_PROXY_CLASS}:not(.${ANNOTATION_SELECTION_CLASS})[data-annotation-id="${annotationID}"]`,
    );
    if (!view || !annotation || !proxies.length) return;

    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < proxies.length; index++) {
      const rect = proxies.item(index)?.getBoundingClientRect();
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const positionKey = [annotationID, left, top, right, bottom]
      .map((value) =>
        typeof value === "number" ? Math.round(value * 2) / 2 : value,
      )
      .join(":");

    try {
      const popupDocument = state.reader?._iframeWindow?.document as
        | Document
        | undefined;
      const iframeRect = view._iframe?.getBoundingClientRect();
      const containerRect = view._container?.getBoundingClientRect();
      if (!iframeRect || !containerRect) return;
      const scale = Number(view._iframeCoordScaleFactor) || 1;
      const targetLeft =
        (left + Number(iframeRect.left) - Number(containerRect.left)) * scale;
      const targetTop =
        (top + Number(iframeRect.top) - Number(containerRect.top)) * scale;
      const targetRight = targetLeft + (right - left) * scale;
      const targetBottom = targetTop + (bottom - top) * scale;

      if (create) {
        const ownerWindow = state.reader?._iframeWindow;
        const serializedAnnotation = JSON.stringify(annotation);
        if (ownerWindow && serializedAnnotation) {
          const popupState = this.cloneIntoReaderRealm(
            {
              rect: [targetLeft, targetTop, targetRight, targetBottom],
              annotation: JSON.parse(serializedAnnotation),
            },
            ownerWindow,
          );
          view._options?.onSetAnnotationPopup?.(popupState);
        }
      }

      const popup =
        popupDocument?.querySelector<HTMLElement>(".annotation-popup");
      if (!popup) return;
      this.positionPopupElement(
        popup,
        targetLeft,
        targetTop,
        targetRight,
        targetBottom,
      );
      state.lastPopupPositionKey = positionKey;
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to reposition annotation popup: ${getErrorMessage(error)}`,
      );
    }
  }

  private findReaderAnnotation(
    state: ReaderState,
    annotationID: string,
  ): any | undefined {
    const annotations = this.getReaderAnnotations(state);
    if (!annotations || typeof annotations.length !== "number") return;
    for (let index = 0; index < annotations.length; index++) {
      const annotation = annotations[index];
      if (String(annotation?.id) === annotationID) return annotation;
    }
    return undefined;
  }

  private getSourceAnnotationRectBounds(
    state: ReaderState,
    annotation: any,
  ): ClientBounds[] {
    const position = annotation?.position;
    if (!position || !Number.isInteger(position.pageIndex)) return [];
    const regions = [
      {
        pageIndex: Number(position.pageIndex),
        rects: copyRects(position.rects),
      },
      {
        pageIndex: Number(position.pageIndex) + 1,
        rects: copyRects(position.nextPageRects),
      },
    ];
    const result: ClientBounds[] = [];
    for (const region of regions) {
      if (!region.rects.length) continue;
      const pageView =
        state.pdfWindow.PDFViewerApplication?.pdfViewer?.getPageView(
          region.pageIndex,
        );
      if (!pageView?.div || !pageView.viewport) continue;
      const transform = pageView.viewport.transform;
      const a = Number(transform[0]);
      const b = Number(transform[1]);
      const c = Number(transform[2]);
      const d = Number(transform[3]);
      const e = Number(transform[4]);
      const f = Number(transform[5]);
      for (const rect of region.rects) {
        const x1 = a * rect[0] + c * rect[1] + e;
        const y1 = b * rect[0] + d * rect[1] + f;
        const x2 = a * rect[2] + c * rect[3] + e;
        const y2 = b * rect[2] + d * rect[3] + f;
        const localLeft = Math.min(x1, x2);
        const localTop = Math.min(y1, y2);
        const localRight = Math.max(x1, x2);
        const localBottom = Math.max(y1, y2);
        if (!Number.isFinite(localLeft) || !Number.isFinite(localTop)) continue;
        const pageRect = pageView.div.getBoundingClientRect();
        result.push({
          pageIndex: region.pageIndex,
          left: Number(pageRect.left) + localLeft,
          top: Number(pageRect.top) + localTop,
          right: Number(pageRect.left) + localRight,
          bottom: Number(pageRect.top) + localBottom,
        });
      }
    }
    return result;
  }

  private getSourceAnnotationBounds(
    state: ReaderState,
    annotation: any,
  ): ClientBounds[] {
    const byPage = new Map<number, ClientBounds>();
    for (const rect of this.getSourceAnnotationRectBounds(state, annotation)) {
      const bounds = byPage.get(rect.pageIndex);
      if (bounds) {
        bounds.left = Math.min(bounds.left, rect.left);
        bounds.top = Math.min(bounds.top, rect.top);
        bounds.right = Math.max(bounds.right, rect.right);
        bounds.bottom = Math.max(bounds.bottom, rect.bottom);
      } else {
        byPage.set(rect.pageIndex, { ...rect });
      }
    }
    return [...byPage.values()];
  }

  private findSourceAnnotationMatchAtEventPoint(
    state: ReaderState,
    overlayID: string,
    event: Event,
  ): AnnotationOverlayMatch | undefined {
    const clientX = Number((event as MouseEvent).clientX);
    const clientY = Number((event as MouseEvent).clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const padding = 5;
    for (const match of this.getAnnotationOverlayMatches(state, false)) {
      if (match.overlay.id !== overlayID) continue;
      for (const bounds of this.getSourceAnnotationRectBounds(
        state,
        match.annotation,
      )) {
        if (
          clientX >= bounds.left - padding &&
          clientX <= bounds.right + padding &&
          clientY >= bounds.top - padding &&
          clientY <= bounds.bottom + padding
        ) {
          return match;
        }
      }
    }
    return undefined;
  }

  private renderSourceAnnotationSelection(
    state: ReaderState,
    root: HTMLElement,
    annotationID: string,
  ): void {
    if (state.drawSourceSelectionProxy === false) return;
    const annotation = this.findReaderAnnotation(state, annotationID);
    if (!annotation) return;
    for (const bounds of this.getSourceAnnotationBounds(state, annotation)) {
      const selection = state.pdfWindow.document.createElement("div");
      selection.className = `${ANNOTATION_PROXY_CLASS} ${ANNOTATION_SELECTION_CLASS}`;
      selection.dataset.annotationId = annotationID;
      selection.dataset.rptSource = "true";
      selection.style.left = `${bounds.left - 3}px`;
      selection.style.top = `${bounds.top - 3}px`;
      selection.style.width = `${bounds.right - bounds.left + 6}px`;
      selection.style.height = `${bounds.bottom - bounds.top + 6}px`;
      root.append(selection);
    }
  }

  private getSourcePopupBounds(
    state: ReaderState,
    annotation: any,
  ): { left: number; top: number; right: number; bottom: number } | undefined {
    const clientBounds = this.getSourceAnnotationBounds(state, annotation);
    if (!clientBounds.length) return;
    const bounds = clientBounds[0];
    const view = state.reader?._internalReader?._primaryView;
    const iframeRect = view?._iframe?.getBoundingClientRect();
    const containerRect = view?._container?.getBoundingClientRect();
    if (!iframeRect || !containerRect) return;
    const scale = Number(view._iframeCoordScaleFactor) || 1;
    const left =
      (bounds.left + Number(iframeRect.left) - Number(containerRect.left)) *
      scale;
    const top =
      (bounds.top + Number(iframeRect.top) - Number(containerRect.top)) * scale;
    return {
      left,
      top,
      right: left + (bounds.right - bounds.left) * scale,
      bottom: top + (bounds.bottom - bounds.top) * scale,
    };
  }

  private openSourceAnnotationPopup(
    state: ReaderState,
    annotationID: string,
  ): void {
    try {
      const annotation = this.findReaderAnnotation(state, annotationID);
      const bounds = annotation
        ? this.getSourcePopupBounds(state, annotation)
        : undefined;
      const view = state.reader?._internalReader?._primaryView;
      const ownerWindow = state.reader?._iframeWindow;
      if (state.annotationDiagnostic) {
        state.annotationDiagnostic.openSource = {
          annotationFound: Boolean(annotation),
          bounds,
          viewFound: Boolean(view),
          ownerWindowFound: Boolean(ownerWindow),
        };
      }
      if (!annotation || !bounds || !view || !ownerWindow) return;
      const serializedAnnotation = JSON.stringify(annotation);
      const popupState = this.cloneIntoReaderRealm(
        {
          rect: [bounds.left, bounds.top, bounds.right, bounds.bottom],
          annotation: JSON.parse(serializedAnnotation),
        },
        ownerWindow,
      );
      view._options?.onSetAnnotationPopup?.(popupState);
      if (state.annotationDiagnostic?.openSource) {
        state.annotationDiagnostic.openSource.onSetAnnotationPopupCalled = true;
      }
      const reposition = () =>
        this.positionSourceAnnotationPopup(state, annotationID);
      reposition();
      for (const delay of [0, 30, 80, 160]) {
        setTimeout(reposition, delay);
      }
    } catch (error) {
      if (state.annotationDiagnostic) {
        state.annotationDiagnostic.openSourceError = getErrorMessage(error);
      }
      Zotero.debug(
        `[Inline Translate] Unable to open source annotation proxy: ${getErrorMessage(error)}`,
      );
    }
  }

  private positionSourceAnnotationPopup(
    state: ReaderState,
    annotationID: string,
  ): void {
    try {
      if (state.sourceSelectedAnnotationID !== annotationID) return;
      const annotation = this.findReaderAnnotation(state, annotationID);
      const bounds = annotation
        ? this.getSourcePopupBounds(state, annotation)
        : undefined;
      const popup = state.reader?._iframeWindow?.document?.querySelector?.(
        ".annotation-popup",
      ) as HTMLElement | null;
      if (!bounds || !popup) return;
      this.positionPopupElement(
        popup,
        bounds.left,
        bounds.top,
        bounds.right,
        bounds.bottom,
      );
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to position source annotation proxy: ${getErrorMessage(error)}`,
      );
    }
  }

  private positionPopupElement(
    popup: HTMLElement,
    rectLeft: number,
    rectTop: number,
    rectRight: number,
    rectBottom: number,
  ): void {
    const padding = 20;
    const parentRect = (popup.parentElement || popup).getBoundingClientRect();
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const center = rectLeft + (rectRight - rectLeft) / 2;
    let left = center - width / 2;
    let top: number;
    let side: "top" | "bottom" | "left" | "right";

    if (left < 0) {
      side = "right";
      left = rectRight + padding;
      top = rectTop + (rectBottom - rectTop - height) / 2;
    } else if (left + width > parentRect.width) {
      side = "left";
      left = rectLeft - width - padding;
      top = rectTop + (rectBottom - rectTop - height) / 2;
    } else if (rectBottom + height + padding < parentRect.height) {
      side = "bottom";
      top = rectBottom + padding;
    } else {
      side = "top";
      top = rectTop - height - padding;
    }

    left = Math.max(
      padding,
      Math.min(parentRect.width - width - padding, left),
    );
    top = Math.max(
      padding,
      Math.min(parentRect.height - height - padding, top),
    );
    for (const name of ["top", "bottom", "left", "right"]) {
      popup.classList.remove(`page-popup-${name}-center`);
    }
    popup.classList.add(`page-popup-${side}-center`);
    popup.style.transform = `translate(${left}px, ${top}px)`;
  }

  private handleOverlayClick(state: ReaderState, event: Event): void {
    try {
      const wasPointerDrag = state.leftPointerDragged === true;
      state.leftPointerStart = undefined;
      state.leftPointerDragged = undefined;
      if (wasPointerDrag || this.hasActivePdfTextSelection(state)) return;

      const target = event.target as Element | null;
      const overlayElement =
        (typeof target?.closest === "function"
          ? target.closest(
              `.${OVERLAY_CLASS}, .${TRANSLATION_HIT_TARGET_CLASS}`,
            )
          : null) || this.findOverlayAtEventPoint(state, event, false);
      const id = overlayElement?.getAttribute("data-rpt-id");
      if (!id) return;

      event.preventDefault();
      event.stopPropagation();
      const nodes = state.pdfWindow.document.querySelectorAll<HTMLElement>(
        `.${OVERLAY_NODE_CLASS}[data-rpt-id="${id}"]`,
      );
      const showOriginal = !nodes
        .item(0)
        ?.classList.contains("rpt-show-original");
      if (showOriginal) {
        const annotationProxy = this.findAnnotationProxyAtEventPoint(
          state,
          event,
        );
        const annotationID = annotationProxy?.dataset.annotationId;
        const annotationOverlayID = annotationProxy?.dataset.rptId;
        const diagnostic: Record<string, any> = {
          event: "overlay-click",
          time: new Date().toISOString(),
          clientX: Number((event as MouseEvent).clientX),
          clientY: Number((event as MouseEvent).clientY),
          overlayID: id,
          annotationID,
          annotationOverlayID,
          branch:
            annotationID && annotationOverlayID === id
              ? "annotation-proxy"
              : "generic-translation",
          snapshot: this.buildAnnotationDiagnosticSnapshot(state, id),
        };
        state.annotationDiagnostic = diagnostic;
        if (annotationID && annotationOverlayID === id) {
          this.revealSourceAnnotation(state, id, annotationID);
        } else {
          try {
            this.closeAnnotationPopup(state);
          } finally {
            this.setOverlayShowsOriginal(state, id, true);
          }
        }
        setTimeout(() => {
          diagnostic.after = {
            sourceSelectedAnnotationID: state.sourceSelectedAnnotationID,
            popupExists: Boolean(
              state.reader?._iframeWindow?.document?.querySelector?.(
                ".annotation-popup",
              ),
            ),
            sourceFrameCount: state.pdfWindow.document.querySelectorAll(
              `.${ANNOTATION_SELECTION_CLASS}[data-rpt-source="true"]`,
            ).length,
          };
          this.recordAnnotationDiagnostic(diagnostic);
        }, 250);
      } else {
        // The source text is still covered by our transparent overlay node, so
        // Zotero's native annotation target never appears in composedPath().
        // Hit-test the original PDF annotation rectangles directly instead.
        const annotationMatch = this.findSourceAnnotationMatchAtEventPoint(
          state,
          id,
          event,
        );
        const diagnostic: Record<string, any> = {
          event: "source-overlay-click",
          time: new Date().toISOString(),
          clientX: Number((event as MouseEvent).clientX),
          clientY: Number((event as MouseEvent).clientY),
          overlayID: id,
          annotationID: annotationMatch
            ? String(annotationMatch.annotation.id)
            : undefined,
          branch: annotationMatch
            ? "source-annotation-coordinate-hit"
            : "source-generic",
          snapshot: this.buildAnnotationDiagnosticSnapshot(state, id),
        };
        state.annotationDiagnostic = diagnostic;
        if (annotationMatch) {
          this.showTranslatedAnnotation(
            state,
            id,
            String(annotationMatch.annotation.id),
            annotationMatch.annotation,
          );
        } else {
          this.closeAnnotationPopup(state);
          state.sourceSelectedAnnotationID = undefined;
          state.drawSourceSelectionProxy = undefined;
          state.proxySelectedAnnotationID = undefined;
          this.setOverlayShowsOriginal(state, id, false);
        }
        setTimeout(() => {
          diagnostic.after = {
            proxySelectedAnnotationID: state.proxySelectedAnnotationID,
            popupExists: Boolean(
              state.reader?._iframeWindow?.document?.querySelector?.(
                ".annotation-popup",
              ),
            ),
            overlayStillTranslated: this.isOverlayTranslationVisible(state, id),
          };
          this.recordAnnotationDiagnostic(diagnostic);
        }, 250);
      }
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to toggle overlay: ${getErrorMessage(error)}`,
      );
    }
  }

  private hasActivePdfTextSelection(state: ReaderState): boolean {
    try {
      const selection = state.pdfWindow.getSelection?.();
      if (
        selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        selection.toString().trim().length > 0
      ) {
        return true;
      }

      const internalReader = state.reader?._internalReader;
      return Boolean(
        internalReader?._primaryView?._selectionPopup ||
        internalReader?._state?.primaryViewSelectionPopup ||
        internalReader?._state?.secondaryViewSelectionPopup,
      );
    } catch {
      return false;
    }
  }

  private handleOverlayContextMenu(state: ReaderState, event: Event): void {
    try {
      const target = event.target as Element | null;
      const overlayElement =
        (typeof target?.closest === "function"
          ? target.closest(
              `.${OVERLAY_CLASS}, .${TRANSLATION_HIT_TARGET_CLASS}`,
            )
          : null) || this.findOverlayAtEventPoint(state, event, false);
      const id = overlayElement?.getAttribute("data-rpt-id");
      const pageIndex = Number(
        overlayElement?.getAttribute("data-rpt-page-index"),
      );
      if (!id) return;

      event.preventDefault();
      event.stopPropagation();
      if (!state.pdfWindow.confirm("删除这段页面内译文？")) return;
      void this.store.removeSelection(id).then(() => {
        this.scheduleRender(
          state,
          Number.isInteger(pageIndex) ? pageIndex : undefined,
        );
      });
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to delete overlay: ${getErrorMessage(error)}`,
      );
    }
  }

  private updatePopupButton(
    button: HTMLButtonElement,
    text: string,
    title?: string,
    enabled = true,
  ): void {
    try {
      button.textContent = text;
      if (title) button.title = title;
      if (enabled) button.removeAttribute("disabled");
      else button.setAttribute("disabled", "true");
    } catch {
      // The selection popup is intentionally destroyed after a click. Its
      // button is only status UI and must never block persistence or drawing.
    }
  }

  private isStateAlive(state: ReaderState): boolean {
    try {
      return Boolean(
        !state.pdfWindow.closed &&
        state.pdfWindow.document?.documentElement &&
        state.pdfWindow.PDFViewerApplication?.pdfViewer,
      );
    } catch {
      return false;
    }
  }

  private detachState(state: ReaderState): void {
    clearTimeout(state.redrawTimer);
    clearTimeout(state.annotationSyncTimer);
    clearTimeout(state.annotationBridgeRetryTimer);
    this.cancelPendingAnnotationPopupOpen(state);
    try {
      state.annotationObserver?.disconnect();
      for (const eventName of [
        "pointerdown",
        "pointermove",
        "pointerup",
        "mousedown",
        "mouseup",
        "click",
      ]) {
        state.pdfWindow.removeEventListener(
          eventName,
          state.onNativeAnnotationEvent,
          true,
        );
      }
      state.annotationProxyRoot?.remove();
      state.viewerContainer?.removeEventListener(
        "scroll",
        state.onViewerScroll,
      );
      this.syncNativeAnnotationRendering(state, new Set());
      this.restoreNativeAnnotationVisuals(state);
      state.annotationRenderRoot?.classList.remove(
        NATIVE_INTERACTION_DISABLED_CLASS,
      );
      (
        state.annotationShadowRoot?.host as HTMLElement | undefined
      )?.classList.remove(NATIVE_INTERACTION_DISABLED_CLASS);
      state.eventBus?.off?.("pagerendered", state.onPageRendered);
      state.eventBus?.off?.("textlayerrendered", state.onPageRendered);
      state.eventBus?.off?.("scalechanging", state.onViewChanged);
      state.eventBus?.off?.("rotationchanging", state.onViewChanged);
      state.pdfWindow.removeEventListener("click", state.onOverlayClick, true);
      state.pdfWindow.removeEventListener(
        "contextmenu",
        state.onOverlayContextMenu,
        true,
      );
      if (this.stateByPdfWindow.get(state.pdfWindow) === state) {
        this.stateByPdfWindow.delete(state.pdfWindow);
      }
    } catch {
      // A closed PDF iframe becomes a protected dead object in Zotero.
    }
    this.states.delete(state);
    try {
      this.stateByReader.delete(state.reader);
    } catch {
      // The reader wrapper can be dead at the same time as its iframe.
    }
  }

  private fitText(element: HTMLElement, minimumFontSize = 7): void {
    let fontSize = Number.parseFloat(element.style.fontSize);
    while (
      fontSize > minimumFontSize &&
      (element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1)
    ) {
      fontSize = Math.max(minimumFontSize, fontSize - 0.5);
      element.style.fontSize = `${fontSize}px`;
    }
  }

  private clearTextSelection(state: ReaderState): void {
    try {
      state.pdfWindow.getSelection()?.removeAllRanges();
    } catch (error) {
      Zotero.debug(
        `[Inline Translate] Unable to clear PDF selection: ${getErrorMessage(error)}`,
      );
    }
  }

  private removeNodes(doc: Document, selector: string): void {
    const nodes = doc.querySelectorAll(selector);
    for (let index = nodes.length - 1; index >= 0; index--) {
      nodes.item(index)?.remove();
    }
  }

  private ensureStyles(doc: Document): void {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${OVERLAY_CLASS} {
        position: absolute;
        z-index: 20;
        box-sizing: border-box;
        overflow: hidden;
        padding: 0 1px;
        background: #fff;
        color: #111;
        font-family: system-ui, "Microsoft YaHei", "PingFang SC", sans-serif;
        font-weight: 400;
        line-height: 1.28;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        pointer-events: auto;
        border: 0;
        outline: 0;
        box-shadow: none;
      }
      .${OVERLAY_CLASS} .${OVERLAY_TEXT_CLASS} {
        display: inline-block;
        transform-origin: left center;
      }
      .${OVERLAY_CLASS} .${OVERLAY_ITALIC_TEXT_CLASS} {
        /* CJK families often do not ship an italic face. A small geometric
           slant makes the translated phrase visibly match the source italic
           while leaving the overlay's coordinates and white mask unchanged. */
        padding-right: 0.14em;
        transform: skewX(-11deg);
      }
      .${OVERLAY_CLASS}.rpt-show-original {
        background: transparent;
        color: transparent;
        box-shadow: none;
      }
      .rpt-hide-translations .${OVERLAY_CLASS} {
        background: transparent;
        color: transparent;
        box-shadow: none;
        pointer-events: none;
      }
      .${PENDING_SELECTION_CLASS} {
        position: absolute;
        z-index: 19;
        box-sizing: border-box;
        background: rgba(46, 168, 229, 0.24);
        border-bottom: 2px solid rgba(23, 126, 184, 0.9);
        pointer-events: none;
      }
      .${NATIVE_PAINT_MASK_CLASS} {
        position: absolute;
        z-index: 19;
        box-sizing: border-box;
        background: #fff;
        border: 0;
        outline: 0;
        box-shadow: none;
        pointer-events: none;
      }
      #${ANNOTATION_PROXY_ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        overflow: visible;
        pointer-events: none;
      }
      .${ANNOTATION_PROXY_CLASS} {
        position: fixed;
        box-sizing: border-box;
        border: 0;
        border-radius: 1px;
        outline: 0;
        pointer-events: none;
      }
      .${TRANSLATION_HIT_TARGET_CLASS} {
        position: fixed;
        box-sizing: border-box;
        background: transparent;
        cursor: pointer;
        pointer-events: auto;
      }
      .${ANNOTATION_PROXY_CLASS}.rpt-underline {
        background: transparent !important;
        border-bottom: 2px solid;
      }
      .${ANNOTATION_SELECTION_CLASS} {
        box-sizing: border-box;
        border: 2px dashed #6d95e0;
        border-radius: 0;
        background: transparent !important;
      }
      .rpt-hide-translations #${ANNOTATION_PROXY_ROOT_ID} {
        display: none;
      }
    `;
    doc.documentElement?.append(style);
  }
}
