export type PdfRect = [number, number, number, number];

export interface TranslationSourceStyle {
  fontCategory: "serif" | "sans" | "mono";
  fontWeight: number;
  fontStyle: "normal" | "italic";
  fontSize?: number;
}

export interface TranslationRegion {
  pageIndex: number;
  rects: PdfRect[];
  original: string;
}

export interface TranslationOverlay {
  id: string;
  attachmentKey: string;
  pageIndex: number;
  rects: PdfRect[];
  nextPageRects?: PdfRect[];
  original: string;
  translation: string;
  createdAt: string;
  regions?: TranslationRegion[];
  /** Flattened in regions/rects order so every translated line keeps the
   * source style captured at translation time across redraws and restarts. */
  sourceStyles?: TranslationSourceStyle[];
}

interface StoreData {
  version: 1;
  overlays: TranslationOverlay[];
}

const EMPTY_STORE: StoreData = { version: 1, overlays: [] };

function rectArea(rect: PdfRect): number {
  return Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]);
}

function intersectionArea(a: PdfRect, b: PdfRect): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return width * height;
}

function selectionCoverage(
  a: TranslationOverlay,
  b: TranslationOverlay,
): number {
  if (a.attachmentKey !== b.attachmentKey) return 0;
  const regionsA = getRegions(a);
  const regionsB = getRegions(b);
  const areaA = regionsA.reduce(
    (sum, region) =>
      sum + region.rects.reduce((area, rect) => area + rectArea(rect), 0),
    0,
  );
  const areaB = regionsB.reduce(
    (sum, region) =>
      sum + region.rects.reduce((area, rect) => area + rectArea(rect), 0),
    0,
  );
  if (!areaA || !areaB) return 0;
  let intersection = 0;
  for (const regionA of regionsA) {
    for (const regionB of regionsB) {
      if (regionA.pageIndex !== regionB.pageIndex) continue;
      for (const rectA of regionA.rects) {
        for (const rectB of regionB.rects) {
          intersection += intersectionArea(rectA, rectB);
        }
      }
    }
  }
  // Treat selections as duplicates only when they cover nearly the same full
  // area in both directions. Dividing by the smaller area made any small new
  // selection inside one region of a large/multi-region overlay look like a
  // 100% duplicate, which deleted the entire older translation.
  return Math.min(1, intersection / Math.max(areaA, areaB));
}

function getRegions(overlay: TranslationOverlay): TranslationRegion[] {
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

function positionKey(overlay: TranslationOverlay): string {
  const rounded = (value: number) => Math.round(value * 100) / 100;
  const regions = getRegions(overlay).map((region) => [
    region.pageIndex,
    region.rects.map((rect) => rect.map(rounded)),
  ]);
  return JSON.stringify([overlay.attachmentKey, regions]);
}

export class OverlayStore {
  private data: StoreData = { ...EMPTY_STORE, overlays: [] };
  private loaded = false;
  private loadPromise?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();

  private get path(): string {
    const separator = Zotero.isWin ? "\\" : "/";
    return `${Zotero.DataDirectory.dir}${separator}inline-translate-overlays.json`;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      if (!Zotero.File.pathToFile(this.path).exists()) return;
      const raw = await Zotero.File.getContentsAsync(this.path);
      if (typeof raw !== "string") return;
      const parsed = JSON.parse(raw) as StoreData;
      if (parsed.version === 1 && Array.isArray(parsed.overlays)) {
        this.data = parsed;
        if (this.deduplicate()) await this.save();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("does not exist") &&
        !message.includes("NS_ERROR_FILE_NOT_FOUND")
      ) {
        Zotero.logError(error as Error);
      }
    } finally {
      this.loaded = true;
    }
  }

  getForAttachment(attachmentKey: string): TranslationOverlay[] {
    return this.data.overlays.filter(
      (overlay) => overlay.attachmentKey === attachmentKey,
    );
  }

  async upsert(overlay: TranslationOverlay): Promise<string[]> {
    return this.enqueueMutation(async () => {
      await this.load();
      const removed = this.data.overlays
        .filter(
          (existing) =>
            positionKey(existing) === positionKey(overlay) ||
            selectionCoverage(existing, overlay) >= 0.82,
        )
        .map((existing) => existing.id);
      this.data.overlays = this.data.overlays.filter(
        (existing) => !removed.includes(existing.id),
      );
      this.data.overlays.push(overlay);
      await this.save();
      return removed;
    });
  }

  async removeSelection(id: string): Promise<string[]> {
    return this.enqueueMutation(async () => {
      await this.load();
      const target = this.data.overlays.find((overlay) => overlay.id === id);
      if (!target) return [];
      const removed = this.data.overlays
        .filter(
          (overlay) =>
            overlay.id === id ||
            positionKey(overlay) === positionKey(target) ||
            selectionCoverage(overlay, target) >= 0.95,
        )
        .map((overlay) => overlay.id);
      this.data.overlays = this.data.overlays.filter(
        (overlay) => !removed.includes(overlay.id),
      );
      await this.save();
      return removed;
    });
  }

  async clearAttachment(attachmentKey: string): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      this.data.overlays = this.data.overlays.filter(
        (overlay) => overlay.attachmentKey !== attachmentKey,
      );
      await this.save();
    });
  }

  async updateSourceStyles(
    id: string,
    sourceStyles: TranslationSourceStyle[],
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.load();
      const overlay = this.data.overlays.find(
        (candidate) => candidate.id === id,
      );
      if (!overlay) return;
      overlay.sourceStyles = sourceStyles.map((style) => ({ ...style }));
      await this.save();
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    // Keep the queue usable after an individual failed write while returning
    // that failure to the caller that initiated it.
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async save(): Promise<void> {
    await Zotero.File.putContentsAsync(
      this.path,
      JSON.stringify(this.data, null, 2),
    );
  }

  private deduplicate(): boolean {
    const originalLength = this.data.overlays.length;
    const latestByPosition = new Map<string, TranslationOverlay>();
    for (const overlay of this.data.overlays) {
      const key = positionKey(overlay);
      const existing = latestByPosition.get(key);
      if (!existing || overlay.createdAt >= existing.createdAt) {
        latestByPosition.set(key, overlay);
      }
    }
    this.data.overlays = Array.from(latestByPosition.values());
    return this.data.overlays.length !== originalLength;
  }
}
