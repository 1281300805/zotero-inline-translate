import { ReaderOverlayManager } from "./modules/readerOverlays";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { getString, initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";

async function onStartup(): Promise<void> {
  try {
    await initialize();
  } catch (error) {
    addon.data.startupError =
      error instanceof Error ? error.stack || error.message : String(error);
    addon.data.initialized = true;
    Zotero.logError(error as Error);
    throw error;
  }
}

async function initialize(): Promise<void> {
  await Promise.all([Zotero.initializationPromise, Zotero.uiReadyPromise]);

  initLocale();
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });

  addon.data.readerOverlays = new ReaderOverlayManager();
  await addon.data.readerOverlays.startup();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();
  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );
}

async function onMainWindowUnload(_win: Window): Promise<void> {}

function onShutdown(): void {
  addon.data.readerOverlays?.shutdown();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(
  type: string,
  data: { [key: string]: any },
): Promise<void> {
  if (type === "load") {
    await registerPrefsScripts(data.window);
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
