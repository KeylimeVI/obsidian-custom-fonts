import {
  App,
  FileSystemAdapter,
  MarkdownPostProcessorContext,
  MarkdownRenderer,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
} from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FontEntry {
  name: string;
  filename: string;
  blockName: string;
  size: string;
  weight: string;
  style: string;
  color: string;
  lineHeight: string;
  align: string;
  letterSpacing: string;
}

interface CustomFontsSettings {
  fonts: FontEntry[];
}

const DEFAULT_SETTINGS: CustomFontsSettings = {
  fonts: [],
};

const BLANK_FONT: Omit<FontEntry, "name" | "filename"> = {
  blockName: "",
  size: "",
  weight: "",
  style: "",
  color: "",
  lineHeight: "",
  align: "",
  letterSpacing: "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FONT_FORMATS: Record<string, string> = {
  woff2: "woff2",
  woff: "woff",
  ttf: "truetype",
  otf: "opentype",
};

function fontFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return FONT_FORMATS[ext] ?? "truetype";
}

function parseBlock(source: string): {
  config: Record<string, string>;
  content: string;
} {
  const lines = source.split("\n");
  const config: Record<string, string> = {};
  let i = 0;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { i++; break; }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) break;
    config[m[1]] = m[2].trim();
  }

  return { config, content: lines.slice(i).join("\n") };
}

function applyStyles(el: HTMLElement, cfg: Record<string, string>) {
  if (cfg.family) el.style.fontFamily = `"${cfg.family}", sans-serif`;
  if (cfg.size) el.style.fontSize = cfg.size;
  if (cfg.color) el.style.color = cfg.color;
  if (cfg.weight) el.style.fontWeight = cfg.weight;
  if (cfg.style) el.style.fontStyle = cfg.style;
  const lh = cfg["line-height"] ?? cfg.lineHeight;
  if (lh) el.style.lineHeight = lh;
  if (cfg.align) el.style.textAlign = cfg.align as CanvasTextAlign;
  const ls = cfg["letter-spacing"] ?? cfg.letterSpacing;
  if (ls) el.style.letterSpacing = ls;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class CustomFontsPlugin extends Plugin {
  settings: CustomFontsSettings;
  private styleEl: HTMLStyleElement;
  private registeredBlocks = new Set<string>();

  async onload() {
    await this.loadSettings();
    await this.ensureFontsDir();

    this.styleEl = document.createElement("style");
    this.styleEl.id = "custom-fonts-plugin-faces";
    document.head.appendChild(this.styleEl);
    this.refreshFontFaces();

    // Generic ```font block
    this.registerMarkdownCodeBlockProcessor("font", async (source, el, ctx) => {
      await this.renderBlock(source, el, ctx, {});
    });

    // Per-font named blocks
    for (const font of this.settings.fonts) {
      if (font.blockName) this.registerFontProcessor(font.blockName);
    }

    this.addSettingTab(new CustomFontsSettingTab(this.app, this));
  }

  onunload() {
    this.styleEl?.remove();
  }

  // -------------------------------------------------------------------------
  // Font-face management
  // -------------------------------------------------------------------------

  get fontsDir(): string {
    return normalizePath(`${this.manifest.dir}/fonts`);
  }

  private async ensureFontsDir() {
    if (!(await this.app.vault.adapter.exists(this.fontsDir))) {
      await this.app.vault.adapter.mkdir(this.fontsDir);
    }
  }

  private getFontUrl(filename: string): string {
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    return adapter.getResourcePath(normalizePath(`${this.fontsDir}/${filename}`));
  }

  refreshFontFaces() {
    this.styleEl.textContent = this.settings.fonts
      .map(
        (f) =>
          `@font-face { font-family: "${f.name}"; src: url("${this.getFontUrl(f.filename)}") format("${fontFormat(f.filename)}"); }`
      )
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // Code-block rendering
  // -------------------------------------------------------------------------

  registerFontProcessor(blockName: string) {
    if (this.registeredBlocks.has(blockName)) return;
    this.registeredBlocks.add(blockName);

    this.registerMarkdownCodeBlockProcessor(blockName, async (source, el, ctx) => {
      const font = this.settings.fonts.find((f) => f.blockName === blockName);
      if (!font) {
        el.createEl("p", {
          text: `Font block "${blockName}" is no longer registered. Reload the plugin.`,
          cls: "custom-font-error",
        });
        return;
      }
      const defaults: Record<string, string> = { family: font.name };
      if (font.size) defaults.size = font.size;
      if (font.weight) defaults.weight = font.weight;
      if (font.style) defaults.style = font.style;
      if (font.color) defaults.color = font.color;
      if (font.lineHeight) defaults["line-height"] = font.lineHeight;
      if (font.align) defaults.align = font.align;
      if (font.letterSpacing) defaults["letter-spacing"] = font.letterSpacing;
      await this.renderBlock(source, el, ctx, defaults);
    });
  }

  private async renderBlock(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    defaults: Record<string, string>
  ) {
    const { config, content } = parseBlock(source);
    const merged: Record<string, string> = { ...defaults, ...config };

    const wrapper = el.createDiv({ cls: "custom-font-block" });
    applyStyles(wrapper, merged);

    if (!merged.family) {
      wrapper.createEl("p", {
        text: '⚠ No font specified. Add "family: Your Font Name" at the top of the block.',
        cls: "custom-font-error",
      });
    }

    const text = content.trim();
    if (text) {
      await MarkdownRenderer.render(this.app, text, wrapper, ctx.sourcePath, this);
    }
  }

  // -------------------------------------------------------------------------
  // Font file management
  // -------------------------------------------------------------------------

  async installFont(file: File): Promise<FontEntry> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!["ttf", "otf", "woff", "woff2"].includes(ext)) {
      throw new Error("Unsupported format. Use TTF, OTF, WOFF, or WOFF2.");
    }

    const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const buf = await file.arrayBuffer();
    await this.app.vault.adapter.writeBinary(
      normalizePath(`${this.fontsDir}/${filename}`),
      buf
    );

    const raw = filename.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const blockName = raw.toLowerCase().replace(/\s+/g, "-");

    const entry: FontEntry = { ...BLANK_FONT, name, filename, blockName };

    if (!this.settings.fonts.find((f) => f.filename === filename)) {
      this.settings.fonts.push(entry);
      await this.saveSettings();
    }

    if (blockName) this.registerFontProcessor(blockName);
    return entry;
  }

  async removeFont(filename: string) {
    try {
      await this.app.vault.adapter.remove(normalizePath(`${this.fontsDir}/${filename}`));
    } catch { /* already gone */ }
    this.settings.fonts = this.settings.fonts.filter((f) => f.filename !== filename);
    await this.saveSettings();
  }

  // -------------------------------------------------------------------------
  // Settings persistence
  // -------------------------------------------------------------------------

  async loadSettings() {
    const data = await this.loadData();
    // Migrate: merge any saved font entries with BLANK_FONT defaults for new fields
    const fonts: FontEntry[] = ((data?.fonts ?? []) as any[]).map((f) => ({
      ...BLANK_FONT,
      ...f,
    }));
    this.settings = { fonts };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshFontFaces();
  }
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------

class CustomFontsSettingTab extends PluginSettingTab {
  plugin: CustomFontsPlugin;

  constructor(app: App, plugin: CustomFontsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Custom Fonts" });

    // Font cards
    for (const font of this.plugin.settings.fonts) {
      this.renderFontCard(containerEl, font);
    }

    if (this.plugin.settings.fonts.length === 0) {
      containerEl.createEl("p", {
        text: "No fonts yet — click Upload to add one.",
        cls: "setting-item-description",
      });
    }

    // Upload button
    new Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Upload font…").setCta().onClick(() => this.pickFontFile())
    );

    // Demo gif (placeholder until user drops in the real recording)
    const gifPath = (this.plugin.app.vault.adapter as FileSystemAdapter)
      .getResourcePath(normalizePath(`${this.plugin.manifest.dir}/demo.gif`));
    const gif = containerEl.createEl("img", { cls: "custom-fonts-demo-gif" });
    gif.src = gifPath;
    gif.alt = "Demo";

    // Extra info (usage docs) — collapsed
    const info = containerEl.createEl("details", { cls: "custom-fonts-advanced custom-fonts-advanced--top" });
    info.createEl("summary", { text: "How to use font blocks", cls: "custom-fonts-advanced-summary" });
    this.renderUsageDocs(info);
  }

  // ---- Font card -----------------------------------------------------------

  private renderFontCard(root: HTMLElement, font: FontEntry) {
    const card = root.createDiv({ cls: "custom-fonts-card" });

    // Header: font name + delete button
    new Setting(card)
      .setName(font.name)
      .addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Remove font")
          .onClick(async () => {
            await this.plugin.removeFont(font.filename);
            new Notice("Font removed.");
            this.display();
          })
      );

    // Block name field
    new Setting(card)
      .setName("Block name")
      .addText((t) =>
        t
          .setValue(font.blockName)
          .setPlaceholder("e.g. tengwar")
          .onChange(async (v) => {
            const safe = v.replace(/[^a-zA-Z0-9-]/g, "");
            font.blockName = safe;
            await this.plugin.saveSettings();
            if (safe) this.plugin.registerFontProcessor(safe);
          })
      );

    // Preview
    const preview = card.createDiv({ cls: "custom-fonts-card-preview" });
    preview.style.fontFamily = `"${font.name}", sans-serif`;
    preview.textContent = "The quick brown fox jumps over the lazy dog.";

    // Advanced dropdown
    const adv = card.createEl("details", { cls: "custom-fonts-advanced" });
    adv.createEl("summary", { text: "Advanced", cls: "custom-fonts-advanced-summary" });

    new Setting(adv)
      .setName("Rename font")
      .setDesc("Updates the name used in family: headers")
      .addText((t) =>
        t
          .setValue(font.name)
          .setPlaceholder("Font name")
          .onChange(async (v) => {
            font.name = v;
            preview.style.fontFamily = `"${v}", sans-serif`;
            await this.plugin.saveSettings();
          })
      );

    new Setting(adv).setName("Size").addText((t) =>
      t.setPlaceholder("e.g. 20px").setValue(font.size).onChange(async (v) => { font.size = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Weight").addText((t) =>
      t.setPlaceholder("e.g. bold").setValue(font.weight).onChange(async (v) => { font.weight = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Style").addText((t) =>
      t.setPlaceholder("e.g. italic").setValue(font.style).onChange(async (v) => { font.style = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Color").addText((t) =>
      t.setPlaceholder("e.g. #333").setValue(font.color).onChange(async (v) => { font.color = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Line height").addText((t) =>
      t.setPlaceholder("e.g. 1.6").setValue(font.lineHeight).onChange(async (v) => { font.lineHeight = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Align").addText((t) =>
      t.setPlaceholder("e.g. center").setValue(font.align).onChange(async (v) => { font.align = v; await this.plugin.saveSettings(); })
    );
    new Setting(adv).setName("Letter spacing").addText((t) =>
      t.setPlaceholder("e.g. 0.05em").setValue(font.letterSpacing).onChange(async (v) => { font.letterSpacing = v; await this.plugin.saveSettings(); })
    );
  }

  // ---- Upload --------------------------------------------------------------

  private pickFontFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ttf,.otf,.woff,.woff2";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const entry = await this.plugin.installFont(file);
        new Notice(`"${entry.name}" installed. Block name: ${entry.blockName}`);
        this.display();
      } catch (e: any) {
        new Notice(`Error: ${e.message}`);
      }
    });
    input.click();
  }

  // ---- Usage docs ----------------------------------------------------------

  private renderUsageDocs(root: HTMLElement) {
    root.createEl("p", { text: "Named block (no header needed):" });
    root.createEl("pre").createEl("code", {
      text: "```tengwar\nYour text here.\n```",
    });

    root.createEl("p", { text: "Generic block with explicit font:" });
    root.createEl("pre").createEl("code", {
      text: "```font\nfamily: Tengwar\n\nYour text here.\n```",
    });

    root.createEl("p", {
      text: "You can override any advanced style on a per-block basis by adding header lines:",
      cls: "setting-item-description",
    });
    root.createEl("pre").createEl("code", {
      text: "```tengwar\nsize: 24px\ncolor: #5a3e8a\n\nOverridden style for this block only.\n```",
    });
  }
}
